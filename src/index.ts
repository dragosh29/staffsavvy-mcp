#!/usr/bin/env node
// StaffSavvy MCP server: lets Claude, ChatGPT and other MCP clients read a StaffSavvy rota and
// time-and-attendance account (venues, groups, shifts, absences, time entries, venue events, staff names).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_CALL_BUDGET_S, StaffSavvyClient, StaffSavvyError, budgetLeftMs, withBudget, type ListResult, type QueryValue } from "./client.js";
import * as fmt from "./format.js";

const apiUser = process.env.STAFFSAVVY_API_USER?.trim();
const apiKey = process.env.STAFFSAVVY_API_KEY?.trim();
const baseUrl = process.env.STAFFSAVVY_BASE_URL?.trim();
const missing = [!baseUrl && "STAFFSAVVY_BASE_URL", !apiUser && "STAFFSAVVY_API_USER", !apiKey && "STAFFSAVVY_API_KEY"].filter(Boolean);
if (missing.length) {
  console.error(
    `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. STAFFSAVVY_BASE_URL is your StaffSavvy instance URL followed by /api/v1; the API User ID and API Key are under My Account > API Access in StaffSavvy.`,
  );
  process.exit(1);
}
let parsedBase: URL | undefined;
try {
  parsedBase = new URL(baseUrl!);
} catch {
  parsedBase = undefined;
}
if (!parsedBase || !/^https?:$/.test(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search) {
  console.error("STAFFSAVVY_BASE_URL must be an http(s) URL without a username, password or query string: your StaffSavvy instance URL followed by /api/v1.");
  process.exit(1);
}
// Time budget per tool call, shared by all its requests (client.ts, withBudget). Lowered by the tests.
const budgetRaw = process.env.STAFFSAVVY_TOOL_BUDGET_S?.trim();
const budgetS = budgetRaw ? Number(budgetRaw) : DEFAULT_CALL_BUDGET_S;
if (!Number.isFinite(budgetS) || budgetS <= 0 || budgetS > 3600) {
  console.error(`STAFFSAVVY_TOOL_BUDGET_S must be a number of seconds above 0 and at most 3600 (got "${budgetRaw}").`);
  process.exit(1);
}
// This version has no write tools (see README, "Why there are no write tools"). The variable is only
// mentioned in the start-up log so that setting it does not look like it enabled anything.
const writesRequested = process.env.STAFFSAVVY_ALLOW_WRITES !== undefined && process.env.STAFFSAVVY_ALLOW_WRITES !== "";
const api = new StaffSavvyClient(apiUser!, apiKey!, baseUrl!);

const server = new McpServer(
  { name: "staffsavvy", version: "0.1.0" },
  {
    instructions: [
      "Tools for a StaffSavvy rota and time-and-attendance account: venues, groups (skills or roles), shifts, absences and absence types, time entries (clock-ins), venue events and staff names.",
      "All IDs are whole numbers. Dates are YYYY-MM-DD; the API's own date-times are local time, YYYY-MM-DD HH:MM:SS.",
      "Typical flow for 'who is on shift tonight at the Grand?': list_venues to get the venue id, then list_shifts with from/to set to today's date and venue_id. Staff names are looked up automatically.",
      "Lists are paged by the API. When a result says complete: false, call again with the page it names (next_page); if there is no next_page, read the note.",
      "list_absences returns absences that overlap the from/to range, including ones that started up to lookback_days (default 31) before from; raise lookback_days for long absences such as long-term sickness or parental leave.",
      "Staff email addresses, phone numbers and legal names, and the free-text reasons on absences, are only returned when include_contact_details is true. Pay, salary and wage-sheet data is never available through this server.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof StaffSavvyError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await withBudget(budgetS * 1000, () => fn(args)));
  } catch (err) {
    return fail(err);
  }
};

// Every path ID in the spec is an integer; only positive whole numbers are accepted.
const id = (what: string) => z.number().int().positive().max(2_147_483_647).describe(`${what} ID (a positive whole number)`);
// A real calendar date: 2026-02-30 is refused rather than rolled over.
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD, e.g. 2026-10-01")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real calendar date");
const pageArgs = {
  page: z.number().int().min(1).max(10_000).default(1).describe("Page to start from (1 = first). Use the next_page of a previous call to continue."),
  max_pages: z.number().int().min(1).max(20).default(4).describe("How many API pages to fetch in this call (the page size is set by StaffSavvy)"),
};
const contactArg = (what: string) => z.boolean().default(false).describe(what);

/**
 * The documented filter operators ("filters, please use variable name as the parameter"), for a field
 * that holds a date (absence period_start, venue event date): both ends -> between,
 * `start=[2025-01-01:2025-12-31]`; one end -> `start=gte:2025-01-01` or `start=lte:2025-01-01`.
 */
function dateFilter(from?: string, to?: string): string | undefined {
  if (from && to) return `[${from}:${to}]`;
  if (from) return `gte:${from}`;
  if (to) return `lte:${to}`;
  return undefined;
}
/**
 * The same for a field that holds a date-time (shift start, time-entry start). A date-only upper bound
 * could exclude everything after midnight on the last day, so the bounds are whole days written as
 * date-times, in the documented date-time "between" form `start=[2025-01-01 01:30:00~2026-01-01 16:00:00]`
 * (the "~" separates bounds that contain colons), and `lte:<to> 23:59:59` for an upper bound alone. A
 * lower bound alone stays `gte:<from>`, the documented example, which includes the whole first day
 * whether the API compares it as a date-time (midnight) or as text.
 */
function dateTimeFilter(from?: string, to?: string): string | undefined {
  if (from && to) return `[${from} 00:00:00~${to} 23:59:59]`;
  if (from) return `gte:${from}`;
  if (to) return `lte:${to} 23:59:59`;
  return undefined;
}
/** A YYYY-MM-DD day moved by a number of days. */
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function checkRange(from?: string, to?: string) {
  if (from && to && from > to) throw new StaffSavvyError(`"from" (${from}) is after "to" (${to}). Swap them.`);
}

const pageInfo = (r: ListResult, page: number) => ({
  page,
  pages_fetched: r.pages_fetched,
  total: r.total,
  complete: r.complete,
  next_page: r.next_page,
  note: r.note ?? (r.complete ? undefined : `More results exist; call again with page ${r.next_page} to continue.`),
});

/**
 * Look up staff names for account IDs with the documented "one of the options" filter on /accounts
 * (`id=[1,7,15]`), 50 IDs per query, following each query's pages to the end. Names are returned by
 * default (contact details are not). If the API user may not read accounts, the tool still answers,
 * with IDs only and a note; if the lookup is cut short (the tool call's time budget ran out, or the
 * API's paging could not be followed), the note says which IDs were not looked up rather than claiming
 * they have no account.
 */
async function staffNames(ids: (number | undefined)[], includeContact: boolean): Promise<{ names?: Map<number, fmt.NameInfo>; note?: string }> {
  const unique = [...new Set(ids.filter((x): x is number => x !== undefined))];
  if (!unique.length) return {};
  const names = new Map<number, fmt.NameInfo>();
  const outOfTime = "the tool call ran out of its time budget (StaffSavvy was slow or rate-limiting)";
  let cutShort: string | undefined;
  try {
    chunks: for (let i = 0; i < unique.length; i += 50) {
      if ((budgetLeftMs() ?? 1) <= 0) {
        cutShort = outOfTime;
        break;
      }
      const chunk = unique.slice(i, i + 50);
      for (let page = 1; ; ) {
        const r = await api.list("/accounts", { query: { id: `[${chunk.join(",")}]` }, page, maxPages: 5 });
        for (const a of r.items) {
          const aid = fmt.num(a?.id);
          if (aid !== undefined) names.set(aid, fmt.nameInfo(a, includeContact));
        }
        if (r.complete) break;
        if (r.next_page === undefined || r.stopped === "time" || (budgetLeftMs() ?? 1) <= 0) {
          cutShort = r.stopped === "paging" ? (r.note ?? "the API's paging could not be followed") : outOfTime;
          break chunks;
        }
        page = r.next_page;
      }
    }
  } catch (err) {
    if (err instanceof StaffSavvyError && (err.status === 403 || err.status === 400)) {
      return { note: `Staff names could not be looked up (${err.message}). Staff are shown by account ID only.` };
    }
    if (!(err instanceof StaffSavvyError && err.outOfTime)) throw err;
    cutShort = outOfTime;
  }
  const unknown = unique.filter((u) => !names.has(u));
  if (!unknown.length) return { names };
  const list = `staff ID${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`;
  if (cutShort) return { names, note: `The staff-name lookup was cut short, so no name was looked up for ${list}: ${cutShort}.` };
  return { names, note: `No account record was returned for ${list}.` };
}

server.registerTool(
  "get_info",
  {
    title: "Check the connection",
    description:
      "Check that the StaffSavvy credentials work and return the instance's software and API version numbers. The API has no endpoint that says which user the credentials belong to.",
    inputSchema: {},
    annotations: READ,
  },
  safe(async () => {
    const res = await api.get("/info");
    const first = Array.isArray(res.data) ? res.data[0] : undefined;
    return { connected: true, base_url: api.base, ...fmt.info(first ?? {}) };
  }),
);

server.registerTool(
  "list_venues",
  {
    title: "List venues",
    description: "Venues this API user can see, with the groups (skills or roles) and shift actions allowed at each. Use the venue id with list_shifts and list_venue_events.",
    inputSchema: { ...pageArgs },
    annotations: READ,
  },
  safe(async ({ page, max_pages }) => {
    const r = await api.list("/venues", { page, maxPages: max_pages });
    return { count: r.items.length, ...pageInfo(r, page), venues: r.items.map(fmt.venue) };
  }),
);

server.registerTool(
  "list_groups",
  {
    title: "List groups",
    description: "Groups (often called skills or roles, e.g. Usher, Bar, Supervisor) this API user can see. Use the group id with list_shifts. Pay rates attached to groups are not returned.",
    inputSchema: { ...pageArgs },
    annotations: READ,
  },
  safe(async ({ page, max_pages }) => {
    const r = await api.list("/groups", { page, maxPages: max_pages });
    return { count: r.items.length, ...pageInfo(r, page), groups: r.items.map(fmt.group) };
  }),
);

server.registerTool(
  "list_shifts",
  {
    title: "List shifts",
    description:
      "Shifts on the rota, filtered by date range (on the shift start, whole days), venue, group and event, with the staff member's name. For 'who is working on 3 October at venue 2' pass from and to as 2026-10-03 and venue_id 2.",
    inputSchema: {
      from: day.optional().describe("First day (YYYY-MM-DD), compared with the shift start"),
      to: day.optional().describe("Last day (YYYY-MM-DD), compared with the shift start"),
      venue_id: id("Venue").optional(),
      group_id: id("Group (skill or role)").optional(),
      event_id: id("Venue event").optional(),
      include_staff_names: z.boolean().default(true).describe("Look up staff names (one extra call per 50 staff)"),
      include_contact_details: contactArg("Stop redacting email addresses and phone numbers in arrival information and names"),
      ...pageArgs,
    },
    annotations: READ,
  },
  safe(async ({ from, to, venue_id, group_id, event_id, include_staff_names, include_contact_details, page, max_pages }) => {
    checkRange(from, to);
    // GET /shifts: `event` is a documented query parameter; start, venue and group are the filter
    // variables its documentation uses (start=[a~b], venue=5, group=5). start is a date-time.
    const query: Record<string, QueryValue> = { event: event_id, start: dateTimeFilter(from, to), venue: venue_id, group: group_id };
    const r = await api.list("/shifts", { query, page, maxPages: max_pages });
    const { names, note } = include_staff_names ? await staffNames(r.items.map((s) => fmt.idOf(s?.account)), include_contact_details) : {};
    return { count: r.items.length, ...pageInfo(r, page), staff_note: note, shifts: r.items.map((s) => fmt.shift(s, names, include_contact_details)) };
  }),
);

server.registerTool(
  "get_shift",
  {
    title: "Get a shift",
    description: "One shift by ID: start, end, venue, group, staff member, task, event and arrival information.",
    inputSchema: {
      shift_id: id("Shift"),
      include_staff_names: z.boolean().default(true).describe("Look up the staff member's name"),
      include_contact_details: contactArg("Stop redacting email addresses and phone numbers in arrival information and names"),
    },
    annotations: READ,
  },
  safe(async ({ shift_id, include_staff_names, include_contact_details }) => {
    const s = await api.getOne(`/shifts/${shift_id}`);
    const { names, note } = include_staff_names ? await staffNames([fmt.idOf(s?.account)], include_contact_details) : {};
    return { shift: fmt.shift(s, names, include_contact_details), staff_note: note };
  }),
);

server.registerTool(
  "list_absences",
  {
    title: "List absences",
    description:
      "Absences and holidays (sickness, annual leave, jury duty and so on) with the staff member's name, type, dates and hours, filtered by staff member and by date range. With from, an absence is returned when it overlaps the range: it starts on or before to and ends on or after from, and it started at most lookback_days before from (StaffSavvy filters absences on their start only). For 'who is off this week' pass this week's Monday and Sunday. The free-text category, title and shift excuse can hold health or personal information and are only returned with include_contact_details. With include_deleted, deleted or rejected absences are marked deleted_or_rejected: true.",
    inputSchema: {
      from: day.optional().describe("First day (YYYY-MM-DD) of the range; absences still running on this day are included"),
      to: day.optional().describe("Last day (YYYY-MM-DD) of the range, compared with the absence start"),
      lookback_days: z.number().int().min(0).max(366).default(31).describe("With from: also look for absences that started up to this many days before from and run into the range (0 = only absences starting on or after from)"),
      account_id: id("Staff account").optional().describe("Only this staff member's absences"),
      include_deleted: z.boolean().default(false).describe("Also include deleted or rejected absences"),
      include_staff_names: z.boolean().default(true).describe("Look up staff names"),
      include_contact_details: contactArg("Include the free-text category, title and shift excuse of each absence, and stop redacting email addresses and phone numbers in names"),
      ...pageArgs,
    },
    annotations: READ,
  },
  safe(async ({ from, to, lookback_days, account_id, include_deleted, include_staff_names, include_contact_details, page, max_pages }) => {
    checkRange(from, to);
    // GET /absences: the documented examples filter on start (start=gte:2025-01-01, start=[a:b]) and
    // account (account=10); "inc-deleted=1 ~ include deleted/rejected absences" is a documented custom
    // filter. No filter on the absence end is documented, so an absence that started before `from` and
    // runs into the range is found by asking for starts from `lookback_days` earlier and keeping those
    // whose period_end reaches `from`.
    const apiFrom = from ? addDays(from, -lookback_days) : undefined;
    const query: Record<string, QueryValue> = { start: dateFilter(apiFrom, to), account: account_id, "inc-deleted": include_deleted ? 1 : undefined };
    const r = await api.list("/absences", { query, page, maxPages: max_pages });
    const kept = from ? r.items.filter((a) => fmt.absenceReaches(a, from)) : r.items;
    const { names, note } = include_staff_names ? await staffNames(kept.map((a) => fmt.idOf(a?.account)), include_contact_details) : {};
    const widened = from && lookback_days > 0;
    return {
      count: kept.length,
      ...pageInfo(r, page),
      // total counts what StaffSavvy matched for the widened start range, before ended absences were dropped.
      total: widened ? undefined : r.total,
      range_note: widened
        ? `Asked StaffSavvy for absences starting from ${apiFrom} (${lookback_days} days before ${from}); ${r.items.length - kept.length} that ended before ${from} were left out. An absence that started before ${apiFrom} is not included; raise lookback_days to find one.`
        : undefined,
      staff_note: note,
      absences: kept.map((a) => fmt.absence(a, names, include_contact_details)),
    };
  }),
);

server.registerTool(
  "list_absence_types",
  {
    title: "List absence types",
    description: "The absence types enabled on this instance (id, title, and whether each counts as an absence or a holiday).",
    inputSchema: { ...pageArgs },
    annotations: READ,
  },
  safe(async ({ page, max_pages }) => {
    const r = await api.list("/absence-types", { page, maxPages: max_pages });
    return { count: r.items.length, ...pageInfo(r, page), absence_types: r.items.map(fmt.absenceType) };
  }),
);

server.registerTool(
  "list_time_entries",
  {
    title: "List time entries",
    description:
      "Time entries (clocked time) with the staff member, start, end, venue, role, status, approval and notes, filtered by date range (on the entry start, whole days), staff member and event. Pay elements and pay values are never returned.",
    inputSchema: {
      from: day.optional().describe("First day (YYYY-MM-DD), compared with the entry start"),
      to: day.optional().describe("Last day (YYYY-MM-DD), compared with the entry start"),
      account_id: id("Staff account").optional().describe("Only this staff member's entries"),
      event_id: id("Venue event").optional(),
      include_staff_names: z.boolean().default(true).describe("Look up staff names"),
      include_contact_details: contactArg("Stop redacting email addresses and phone numbers in notes and names"),
      ...pageArgs,
    },
    annotations: READ,
  },
  safe(async ({ from, to, account_id, event_id, include_staff_names, include_contact_details, page, max_pages }) => {
    checkRange(from, to);
    // GET /time-entries: `event` is a documented query parameter; account=10 is the documented filter
    // example and start is a TimeEntry date-time field, filtered with the documented operators (the
    // "~" date-time between form is documented on /shifts, /absences and /venue-events).
    const query: Record<string, QueryValue> = { event: event_id, start: dateTimeFilter(from, to), account: account_id };
    const r = await api.list("/time-entries", { query, page, maxPages: max_pages });
    const ids = r.items.flatMap((e) => [fmt.idOf(e?.account), fmt.idOf(e?.["approved-account"])]);
    const { names, note } = include_staff_names ? await staffNames(ids, include_contact_details) : {};
    return { count: r.items.length, ...pageInfo(r, page), staff_note: note, time_entries: r.items.map((e) => fmt.timeEntry(e, names, include_contact_details)) };
  }),
);

server.registerTool(
  "list_venue_events",
  {
    title: "List venue events",
    description: "Events at venues (performances, matches, functions) with date, start hour, venue, title and cost codes, filtered by date range and venue. Use the event id with list_shifts or list_time_entries.",
    inputSchema: {
      from: day.optional().describe("First day (YYYY-MM-DD) of the event date"),
      to: day.optional().describe("Last day (YYYY-MM-DD) of the event date"),
      venue_id: id("Venue").optional(),
      ...pageArgs,
    },
    annotations: READ,
  },
  safe(async ({ from, to, venue_id, page, max_pages }) => {
    checkRange(from, to);
    // GET /venue-events: filters take the record's variable name as the parameter; VenueEventItem's
    // fields are `date` and `venue`, used with the documented operators.
    const query: Record<string, QueryValue> = { date: dateFilter(from, to), venue: venue_id };
    const r = await api.list("/venue-events", { query, page, maxPages: max_pages });
    return { count: r.items.length, ...pageInfo(r, page), venue_events: r.items.map(fmt.venueEvent) };
  }),
);

server.registerTool(
  "list_accounts",
  {
    title: "List staff accounts",
    description:
      "Staff accounts with their names, known-as name and default venues. Email address, phone number and legal name are only returned with include_contact_details. Filter by first name, last name, a list of IDs, or accounts changed since a date.",
    inputSchema: {
      firstname: z.string().trim().min(1).max(100).regex(/^[^\[\]:~,]+$/, "Plain names only; [ ] : ~ and , are filter operators").optional().describe("First name (sent as the documented equals filter)"),
      lastname: z.string().trim().min(1).max(100).regex(/^[^\[\]:~,]+$/, "Plain names only; [ ] : ~ and , are filter operators").optional().describe("Last name (sent as the documented equals filter)"),
      ids: z.array(id("Staff account")).min(1).max(100).optional().describe("Only these account IDs"),
      changed_since: day.optional().describe("Only accounts changed on or after this day (YYYY-MM-DD)"),
      include_contact_details: contactArg("Include email address, phone number and legal name, and stop redacting names"),
      ...pageArgs,
    },
    annotations: READ,
  },
  safe(async ({ firstname, lastname, ids, changed_since, include_contact_details, page, max_pages }) => {
    // GET /accounts documented filters: firstname=Bob (equals), firstname=[Bob,Bill,Rob] (one of),
    // and "_last_history_record=gte:2024-01-01" for a changed-since date.
    const query: Record<string, QueryValue> = {
      firstname,
      lastname,
      id: ids ? `[${ids.join(",")}]` : undefined,
      _last_history_record: changed_since ? `gte:${changed_since}` : undefined,
    };
    const r = await api.list("/accounts", { query, page, maxPages: max_pages });
    return { count: r.items.length, ...pageInfo(r, page), accounts: r.items.map((a) => fmt.account(a, include_contact_details)) };
  }),
);

await server.connect(new StdioServerTransport());
console.error(`StaffSavvy MCP server running, read-only${writesRequested ? " (STAFFSAVVY_ALLOW_WRITES is set but this version has no write tools)" : ""}.`);
