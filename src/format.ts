// Turn StaffSavvy API records into compact objects an assistant can read quickly.
// Field names follow the schemas in StaffSavvy's OpenAPI 3.0 document (SwaggerHub SmartBlue/StaffSavvy
// 1.1.0): AccountItem, Venue, TitledItem, AbsenceItem, Absence-Types, TimeEntry, VenueEventItem, and the
// inline items of GET /groups, /absence-types and /info. The Shift schema documents only
// `arrival-info`; the other shift fields read here are inferred from the documented filter and
// parameter names of /shifts (see shift() below and the README).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic (the same pattern as the other servers in this series).
// Three shapes, digits optionally separated by a space, dot or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so numeric IDs, dates such as
// 2026-10-01 and hyphenated references are left alone. Any other 9-11 digit string starting with 0 is
// redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;
// Two more phone shapes, same bounds: a UK number in international form written without "+" or "00"
// ("44" then 9 or 10 digits, like the spec's AccountItem.phone example 447815000000), and a UK mobile
// written without its leading 0 ("7" then 9 digits, 7700 900123). Any other 11-12 digit string starting
// with 44, or 10-digit string starting with 7, is redacted too.
const PHONE_BARE = /(?<![\w-])(?:44(?:[ .-]?\d){9,10}|7\d{3}[ .-]?\d{3}[ .-]?\d{3})(?![\w-])/g;
// UK postcodes (BH9 2SQ, SW1A 1AA, M1 1AE, EC1A1BB): one or two capitals, a digit, an optional letter or
// digit, an optional space, a digit and two capitals, not touching other letters or digits (the pattern
// used by the other servers in this series). Upper case only, so ordinary words are left alone; a code
// written in the same shape would be redacted too.
const POSTCODE = /(?<![A-Za-z0-9])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Za-z0-9])/g;
// A date of birth: a date written after "DOB", "D.O.B.", "date of birth" or "born (on)". Only dates
// introduced by one of those words are touched; other dates in free text are left alone.
const DOB = /\b(?:D\.?O\.?B\.?|date of birth|born(?: on)?)\s*[:\-]?\s*(?:\d{1,2}[\/.\- ]\d{1,2}[\/.\- ]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)? [A-Za-z]{3,9},? \d{4})/gi;
// A payment card number typed into free text: 13 to 19 digits, optionally in groups separated by spaces
// or hyphens, bounded like the phone pattern, that pass the Luhn check (which one arbitrary digit string
// in ten also passes, so a long reference number can be caught too). Runs first, so a card number is
// never partly consumed by the phone patterns, and runs even when contact details were requested: no
// tool of this server has a reason to return card data.
const CARD = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};
const redactCards = (text: string) => text.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number redacted]" : m));

const redactString = (text: string) =>
  redactCards(text)
    .replace(EMAIL, "[email redacted]")
    .replace(DOB, "[date of birth redacted]")
    .replace(PHONE, "[phone redacted]")
    .replace(PHONE_BARE, "[phone redacted]")
    .replace(POSTCODE, "[postcode redacted]");

/**
 * Replace email addresses, phone-number-like sequences, UK postcodes and dates of birth inside free
 * text (arrival information, notes, titles, names, codes, error messages) unless contact details were
 * requested. Luhn-valid card numbers are replaced either way.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  return includeContact ? redactCards(text) : redactString(text);
}

export const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
export const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || typeof v === "boolean" || !Number.isFinite(n) ? undefined : n;
};

/**
 * An ID that may come back as a number, a numeric string or an object with an `id` (the spec's
 * `Account` is `{id, access}`; the shape of `account`, `venue` and `group` on a shift is not documented).
 */
export function idOf(v: unknown): number | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return num((v as Rec).id);
  return num(v);
}

/** {id, title} from a TitledItem-like object, or just the id when the value is a bare number. */
function ref(v: unknown, includeContact: boolean): { id?: number; title?: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "object" && !Array.isArray(v)) {
    const r = v as Rec;
    const out = { id: num(r.id), title: redactContacts(r.title, includeContact) };
    return out.id === undefined && out.title === undefined ? undefined : out;
  }
  const id = num(v);
  return id === undefined ? undefined : { id };
}

// ---- Lookups ----

// Spec GET /info: data[] of {"software-version", "api-version"}.
export function info(r: Rec) {
  return { software_version: str(r?.["software-version"]), api_version: str(r?.["api-version"]) };
}

// Spec Venue: id, title, allowed-groups (TitledItem[]), allowed-shift-actions (TitledItem[]).
export function venue(v: Rec) {
  return {
    id: num(v.id),
    title: redactContacts(v.title, false),
    allowed_groups: Array.isArray(v["allowed-groups"]) ? v["allowed-groups"].map((g: Rec) => ref(g, false)) : undefined,
    allowed_shift_actions: Array.isArray(v["allowed-shift-actions"]) ? v["allowed-shift-actions"].map((a: Rec) => ref(a, false)) : undefined,
  };
}

// Spec GET /groups inline item: title and shifts[] ({arrival-info}). `id` is not in that schema but is
// the variable the documented filter examples use (id=gt:10, id=[3,9,20]), so it is read when present.
// Pay elements (the spec's Groups component carries a pay-element rate) are never read.
export function group(g: Rec) {
  return { id: num(g.id), title: redactContacts(g.title, false) };
}

// Spec GET /absence-types inline item: id (negative in the example), title, type ("absence" or "holiday").
export function absenceType(t: Rec) {
  return { id: num(t.id), title: redactContacts(t.title, false), type: redactContacts(t.type, false) };
}

// ---- Accounts (staff) ----

export interface NameInfo {
  name?: string;
  known_as?: string;
}

// Spec AccountItem: id, legal_firstname, middlenames, legal_lastname, firstname, lastname, nickname,
// email, phone, defaut_venue (sic, VenueShift[]). Names by default; email, phone and legal names only
// on request.
export function account(a: Rec, includeContact: boolean) {
  const name = [a.firstname, a.lastname].filter((x) => typeof x === "string" && x.trim()).join(" ") || undefined;
  const nick = str(a.nickname);
  return {
    id: num(a.id),
    name: redactContacts(name, includeContact),
    known_as: nick && nick !== str(a.firstname) ? redactContacts(nick, includeContact) : undefined,
    default_venues: Array.isArray(a.defaut_venue) ? a.defaut_venue.map((v: Rec) => redactContacts(v?.title, includeContact)).filter(Boolean) : undefined,
    ...(includeContact
      ? {
          email: str(a.email),
          phone: str(a.phone),
          legal_name: [a.legal_firstname, a.middlenames, a.legal_lastname].filter((x) => typeof x === "string" && x.trim()).join(" ") || undefined,
        }
      : {}),
  };
}

export function nameInfo(a: Rec, includeContact: boolean): NameInfo {
  const f = account(a, includeContact);
  return { name: f.name, known_as: f.known_as };
}

const staff = (id: number | undefined, names: Map<number, NameInfo> | undefined) => {
  if (id === undefined) return undefined;
  const n = names?.get(id);
  return { id, ...(n ? { name: n.name, known_as: n.known_as } : {}) };
};

// ---- Shifts ----

// Shift fields this server reads. The spec's Shift schema documents only `arrival-info`. The others are
// the variable names used by the documented /shifts filters (group, start, venue), the documented
// write parameters of PUT /shifts/new and PUT /shifts/{shiftid} (start, end, account, group, venue,
// task) and the `event` query parameter of GET /shifts; `id` is the path variable. They are assumptions
// until checked on a live account; any other key the API returns is listed by name (not value) in
// `other_fields`, so a live run shows what is missing.
export const SHIFT_FIELDS = ["id", "start", "end", "venue", "group", "account", "task", "event", "arrival-info"] as const;

export function shift(s: Rec, names: Map<number, NameInfo> | undefined, includeContact: boolean) {
  const other = Object.keys(s).filter((k) => !(SHIFT_FIELDS as readonly string[]).includes(k));
  return {
    id: num(s.id),
    start: str(s.start),
    end: str(s.end),
    venue: ref(s.venue, includeContact),
    group: ref(s.group, includeContact),
    staff: staff(idOf(s.account), names),
    task: ref(s.task, includeContact),
    event: ref(s.event, includeContact),
    arrival_info: redactContacts(s["arrival-info"], includeContact),
    other_fields: other.length ? other : undefined,
  };
}

// ---- Absences ----

// Spec AbsenceItem. `approved` is not in that schema; the GET /absences filter documentation reads
// "inc-deleted=1 ~ include deleted/rejected absences. Denoted by a negative approved integer", so it is
// read when present and a negative value is reported as deleted_or_rejected: true.
// period_Category (example "Sinus infection"), period_title (example "Funeral") and
// absence_shift_excuse (example "Cancel with reason: Arrived Late") are free text that can hold health
// or other personal information, so they are only returned on request.
export function absence(a: Rec, names: Map<number, NameInfo> | undefined, includeContact: boolean) {
  const t = a.absence_type && typeof a.absence_type === "object" ? absenceType(a.absence_type) : undefined;
  const approved = num(a.approved);
  return {
    id: num(a.id),
    staff: staff(idOf(a.account), names),
    type_id: num(a.type),
    absence_type: t,
    start: str(a.period_start),
    start_hour: str(a.period_start_hour),
    end: str(a.period_end),
    end_hour: str(a.period_end_hour),
    period_end_least: str(a.period_end_least),
    shift_repost: redactContacts(a.absence_shift_repost, includeContact),
    approved,
    deleted_or_rejected: approved === undefined ? undefined : approved < 0,
    ...(includeContact
      ? { category: str(a.period_Category), title: str(a.period_title), shift_excuse: str(a.absence_shift_excuse) }
      : {}),
  };
}

/**
 * Whether an absence may still be running on `day` (YYYY-MM-DD): its period_end is on or after that day.
 * An absence whose period_end is missing or not a date is kept, since it cannot be ruled out.
 */
export function absenceReaches(a: Rec, day: string): boolean {
  const end = typeof a?.period_end === "string" ? a.period_end.slice(0, 10) : "";
  return !/^\d{4}-\d{2}-\d{2}$/.test(end) || end >= day;
}

// ---- Time entries ----

// Spec TimeEntry. `pay-element` (with its `value`) and `pay-element-value` are pay data and are never
// returned, with or without include_contact_details. `notes` is free text, redacted by default.
export function timeEntry(e: Rec, names: Map<number, NameInfo> | undefined, includeContact: boolean) {
  const role = e.role && typeof e.role === "object" ? { id: num(e.role.id), title: redactContacts(e.role.title, includeContact) } : undefined;
  return {
    id: num(e.id),
    staff: staff(idOf(e.account), names),
    start: str(e.start),
    end: str(e.end),
    venue: redactContacts(e.venue?.title, includeContact),
    role,
    status: redactContacts(e.status, includeContact),
    approved: num(e.approved),
    approved_by: staff(idOf(e["approved-account"]), names),
    notes: redactContacts(e.notes, includeContact),
  };
}

// ---- Venue events ----

// Spec VenueEventItem: date, venue (id), hour (0-23), uuid, title, costcode1..costcode4. `id` is not in
// the schema but is the path variable of GET /venue-events/{venueeventid}; read when present. uuid and
// the cost codes are plain strings in the spec, so they are redacted like the title.
export function venueEvent(e: Rec) {
  const codes = [e.costcode1, e.costcode2, e.costcode3, e.costcode4].map((c) => redactContacts(str(c), false));
  return {
    id: num(e.id),
    date: str(e.date),
    hour: num(e.hour),
    venue_id: num(e.venue),
    uuid: redactContacts(str(e.uuid), false),
    title: redactContacts(e.title, false),
    cost_codes: codes.some(Boolean) ? codes : undefined,
  };
}
