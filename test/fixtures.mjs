// Fake StaffSavvy data shaped like the schemas in the published OpenAPI document (validated in e2e.mjs).
// Every name, email address and phone number here is invented; phone numbers use the Ofcom drama ranges
// (07700 900xxx, 0117 496 0xxx) and emails use example.com / example.net.
//
// Field names come from the spec's component schemas (AccountItem, Venue, TitledItem, AbsenceItem,
// Absence-Types, TimeEntry, VenueEventItem, Paging) and the inline items of GET /groups, /absence-types
// and /info. Four kinds of record carry keys the spec does not declare, listed in INFERRED_KEYS below:
// shifts (the Shift schema declares only `arrival-info`), groups and venue events (no `id` in their
// schemas), and the deleted absence (`approved`, not in AbsenceItem). Date-times use "YYYY-MM-DD HH:MM:SS", the format of the documented write parameters and of
// the TimeEntry examples ("2013-09-09 09:00:00").

// Keys used in fixtures that the vendor's schemas do not declare, with the documentation they are inferred from.
export const INFERRED_KEYS = {
  // GET /shifts filter examples use group, start and venue; PUT /shifts/new and PUT /shifts/{shiftid}
  // take start, end, account, group, venue and task; GET /shifts takes an `event` query parameter;
  // `id` is the {shiftid} path variable. `external-worker-name` is a documented parameter of
  // PUT /my/shifts/{shiftid}; it is here only so the suite can prove that a key the server does not read
  // is reported by name in `other_fields` and its value never returned.
  Shift: ["id", "start", "end", "venue", "group", "account", "task", "event", "external-worker-name"],
  // GET /groups filter examples use id (id=gt:10, id=[3,9,20]).
  GroupItem: ["id"],
  // {venueeventid} path variable of GET /venue-events/{venueeventid}.
  VenueEventItem: ["id"],
  // GET /absences filters: "inc-deleted=1 ~ include deleted/rejected absences. Denoted by a negative
  // approved integer". Only the deleted fixture carries it: what an active absence's value is, or whether
  // it has one, is not documented.
  AbsenceItem: ["approved"],
};

export const info = { "software-version": "2024.2.0", "api-version": "1.0.3" }; // the spec's own examples

// ---- Venues (Venue) ----
const titled = (id, title) => ({ id, title });
export const venues = [
  { id: 1, title: "Main Theatre", "allowed-groups": [titled(1, "Usher"), titled(2, "Bar"), titled(3, "Supervisor")], "allowed-shift-actions": [titled(1, "Cleaning")] },
  { id: 2, title: "Studio", "allowed-groups": [titled(1, "Usher"), titled(2, "Bar")], "allowed-shift-actions": [] },
  // A venue title with a phone number typed into it, to prove titles are redacted.
  { id: 3, title: "Box Office (queries 0117 496 0000)", "allowed-groups": [titled(3, "Supervisor")], "allowed-shift-actions": [titled(2, "Cash up")] },
];

// ---- Groups (GET /groups inline item: title, shifts[{arrival-info}]; id inferred) ----
export const groups = [
  { id: 1, title: "Usher", shifts: [{ "arrival-info": "Please report to reception" }] },
  { id: 2, title: "Bar", shifts: [] },
  { id: 3, title: "Supervisor", shifts: [] },
  // A group title with a phone number typed into it, to prove titles are redacted.
  { id: 4, title: "Security (radio 07700 900222)", shifts: [] },
];

// ---- Absence types (GET /absence-types inline item) ----
export const absenceTypes = [
  { id: -3, title: "Jury Duty", type: "absence" }, // the spec's example
  { id: -2, title: "Sickness", type: "absence" },
  { id: -1, title: "Annual Leave", type: "holiday" },
  // An absence type title with an email typed into it, to prove titles are redacted.
  { id: 7, title: "Compassionate leave (ask hr@example.com)", type: "absence" },
];

// ---- Accounts (AccountItem) ----
const mkAccount = (id, first, last, extra = {}) => ({
  id,
  legal_firstname: first,
  middlenames: "",
  legal_lastname: last,
  firstname: first,
  lastname: last,
  nickname: first,
  email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
  phone: `07700 900${String(id).padStart(3, "0").slice(-3)}`,
  defaut_venue: [{ title: "Main Theatre" }],
  ...extra,
});
export const SAM = 101;
export const PRIYA = 102;
export const LEE = 103;
export const accounts = [
  mkAccount(100, "Jo", "Bloggs"),
  mkAccount(SAM, "Sam", "Evans", { legal_firstname: "Samantha", middlenames: "Jane", nickname: "Sam" }),
  mkAccount(PRIYA, "Priya", "Shah", { nickname: "Pri", defaut_venue: [{ title: "Studio" }] }),
  // A known-as name with an email typed into it, to prove names are redacted by default.
  mkAccount(LEE, "Lee", "Chen", { nickname: "Lee (lee.chen@example.net)" }),
  ...Array.from({ length: 56 }, (_, i) => mkAccount(110 + i, `Person${i}`, `Surname${i}`)),
];
// Side data for the documented `_last_history_record` filter (not a field of AccountItem).
export const accountChanged = Object.fromEntries(accounts.map((a) => [a.id, a.id === PRIYA || a.id === LEE ? "2026-09-20" : "2026-01-15"]));

// ---- Shifts (Shift: arrival-info; other keys inferred, see INFERRED_KEYS) ----
const pad = (n) => String(n).padStart(2, "0");
// 60 shifts, 60 different staff members, so the name lookup needs two queries (50 IDs, then 10).
const staffIds = [SAM, PRIYA, LEE, 100, ...Array.from({ length: 56 }, (_, i) => 110 + i)];
export const shifts = Array.from({ length: 60 }, (_, i) => {
  const d = 1 + (i % 10); // 1..10 October 2026
  const s = {
    id: 5000 + i,
    start: `2026-10-${pad(d)} ${pad(17 + (i % 3))}:00:00`,
    end: `2026-10-${pad(d)} ${pad(22 + (i % 2))}:30:00`,
    venue: 1 + (i % 2),
    group: 1 + (i % 3),
    account: staffIds[i % staffIds.length],
    "arrival-info": "On arrival please report to reception",
  };
  if (i % 5 === 0) s.event = 700 + (i % 4);
  if (i % 7 === 0) s.task = 1;
  return s;
});
export const SHIFT_WITH_CONTACT = 5003;
shifts[3]["arrival-info"] = "Ask for Dana on 07700 900456 or dana@example.com";
export const SHIFT_WITH_EXTRA = 5004;
shifts[4]["external-worker-name"] = "Agency worker Alex Example";

// ---- Absences (AbsenceItem) ----
const mkAbsence = (id, accountId, typeRef, start, end, extra = {}) => ({
  id,
  account: { id: accountId, access: true },
  type: typeRef.id,
  absence_type: { ...typeRef },
  period_Category: "Sinus infection",
  period_title: "Off sick",
  period_start: start,
  period_start_hour: "09:00",
  period_end: end,
  period_end_hour: "17:00",
  period_end_least: start,
  absence_shift_excuse: "Cancel with reason: Illness",
  absence_shift_repost: "No, do not replace with another staff member",
  ...extra,
});
export const absences = [
  mkAbsence(1, SAM, absenceTypes[1], "2026-10-02", "2026-10-03"),
  mkAbsence(2, PRIYA, absenceTypes[2], "2026-10-05", "2026-10-09", { period_Category: "Family holiday", period_title: "Holiday", absence_shift_excuse: "", absence_shift_repost: "Yes, repost the shifts" }),
  mkAbsence(3, LEE, absenceTypes[0], "2026-10-12", "2026-10-12", { period_Category: "Jury service, court contact 0117 496 0123", period_title: "Jury Duty" }),
  mkAbsence(4, SAM, absenceTypes[2], "2026-09-20", "2026-09-21", { period_Category: "Weekend away", period_title: "Holiday" }),
];
// A deleted/rejected absence, only returned with the documented custom filter inc-deleted=1, and marked
// by a negative `approved` as that filter's documentation says.
export const deletedAbsence = mkAbsence(5, 100, absenceTypes[2], "2026-10-04", "2026-10-04", { period_Category: "Cancelled", period_title: "Holiday", approved: -1 });

// ---- Time entries (TimeEntry) ----
const payElement = { id: 1, title: "Standard hourly", type: "hourly", value: 11.44, references: [{ id: 1, reference: "PAY01" }] };
const mkEntry = (id, accountId, start, end, extra = {}) => ({
  id,
  account: { id: accountId, access: true },
  start,
  end,
  venue: { title: "Main Theatre" },
  role: { id: 1, title: "Usher", references: [{ id: 1, reference: "USH" }] },
  "pay-element": payElement,
  "pay-element-value": 11.44,
  status: "normal",
  approved: 1,
  "approved-account": { id: 100, access: true },
  notes: "Entry has been modified", // the spec's example
  shift: { "arrival-info": "On arrival please report to reception" },
  available_actions: {},
  ...extra,
});
export const timeEntries = [
  mkEntry(9001, SAM, "2026-10-01 17:02:00", "2026-10-01 22:31:00"),
  mkEntry(9002, PRIYA, "2026-10-01 17:55:00", "2026-10-01 23:05:00", { notes: "Left early, call 07700 900789 if queried", approved: 0 }),
  mkEntry(9003, SAM, "2026-10-03 16:58:00", "2026-10-03 22:30:00"),
  mkEntry(9004, LEE, "2026-10-06 18:00:00", "2026-10-06 23:00:00"),
];
// Side data for the documented `event` query parameter of GET /time-entries (TimeEntry has no event field).
export const timeEntryEvent = { 9001: 700, 9002: 700, 9003: 701 };

// ---- Venue events (VenueEventItem; id inferred) ----
const mkEvent = (id, date, venue, hour, title, uuid = "") => ({ id, date, venue, hour, uuid, title, costcode1: "THEA", costcode2: `EV${id}`, costcode3: "", costcode4: "" });
export const venueEvents = [
  mkEvent(700, "2026-10-01", 1, 19, "Macbeth"),
  mkEvent(701, "2026-10-03", 1, 19, "Macbeth"),
  mkEvent(702, "2026-10-04", 2, 14, "Jazz matinee"),
  mkEvent(703, "2026-10-11", 1, 19, "Private hire (organiser 07700 900321)"),
];
