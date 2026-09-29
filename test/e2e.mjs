// End-to-end test: fixtures and mock responses are validated against StaffSavvy's published OpenAPI
// schemas, then the built MCP server is driven over stdio by a real MCP client against a local mock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_USER, API_KEY, PREFIX, PER_PAGE, EMPTY_SHIFT } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the API documents).
const SPEC_URL = "https://api.swaggerhub.com/apis/SmartBlue/StaffSavvy/1.1.0";
if (!existsSync(`${root}spec.json`)) {
  try {
    const res = await fetch(SPEC_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(`${root}spec.json`, await res.text());
  } catch (err) {
    console.error(`Could not download the StaffSavvy spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.openapi, "3.0.0");
assert.equal(spec.info.version, "1.1.0");
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "ss", components: spec.components });
const local = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"ss#/components/'));
const componentSchema = (name) => ({ $ref: `ss#/components/schemas/${name}` });
const responseSchema = (path, code = "200") => local(spec.paths[path].get.responses[code].content["application/json"].schema);
const itemSchema = (path) => local(spec.paths[path].get.responses["200"].content["application/json"].schema.properties.data.items);
const validateWith = (schema, obj, label) => {
  const v = ajv.compile(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};

// The spec's schemas set no additionalProperties: false, so Ajv alone would accept any key. Every fixture
// is also walked key by key against its schema (following $ref, allOf and items); a key the schema does
// not declare fails, unless it is one of the documented-by-inference keys in fx.INFERRED_KEYS.
const deref = (s) => {
  let cur = s;
  while (cur && cur.$ref) cur = cur.$ref.replace(/^(ss)?#\/components\/schemas\//, "").split("/").reduce((o, k) => o?.[k], spec.components.schemas);
  return cur;
};
function walkKeys(obj, schema, label, extra = []) {
  const s = deref(schema);
  if (!s || obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    if (s.items) obj.forEach((x, i) => walkKeys(x, s.items, `${label}[${i}]`));
    return;
  }
  const props = {};
  for (const part of [s, ...(s.allOf ?? []).map(deref)]) Object.assign(props, part?.properties ?? {});
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in props)) {
      assert.ok(extra.includes(k), `${label}: key "${k}" is not declared in the spec's schema`);
      continue;
    }
    walkKeys(v, props[k], `${label}.${k}`);
  }
}

// Shift fields are not in the spec (its Shift schema declares only arrival-info). This schema is written
// from the documented /shifts filter and parameter names (see fixtures.mjs) and is an assumption.
const INFERRED_SHIFT_SCHEMA = {
  type: "object",
  required: ["id", "start", "end", "venue", "group", "account"],
  additionalProperties: false,
  properties: {
    id: { type: "integer" },
    start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$" },
    end: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$" },
    venue: { type: "integer" },
    group: { type: "integer" },
    account: { type: "integer" },
    task: { type: "integer" },
    event: { type: "integer" },
    "arrival-info": { type: "string" },
    "external-worker-name": { type: "string" },
  },
};

console.log("fixtures vs OpenAPI spec");
await check("venues, groups, absence types, accounts, shifts, absences, time entries and venue events match the spec's schemas, key by key", async () => {
  const each = (items, schema, name, extra = []) =>
    items.forEach((x) => {
      validateWith(schema, x, `${name} ${x.id ?? ""}`);
      walkKeys(x, schema, `${name} ${x.id ?? ""}`, extra);
    });
  each(fx.venues, componentSchema("Venue"), "Venue");
  each(fx.groups, itemSchema("/groups"), "GET /groups item", fx.INFERRED_KEYS.GroupItem);
  each(fx.absenceTypes, itemSchema("/absence-types"), "GET /absence-types item");
  each(fx.accounts, componentSchema("AccountItem"), "AccountItem");
  each(fx.accounts, itemSchema("/accounts/{accountid}"), "GET /accounts/{accountid} item");
  each(fx.shifts, componentSchema("Shift"), "Shift", fx.INFERRED_KEYS.Shift);
  fx.shifts.forEach((s) => validateWith(INFERRED_SHIFT_SCHEMA, s, `inferred shift ${s.id}`));
  each([...fx.absences, fx.deletedAbsence], componentSchema("AbsenceItem"), "AbsenceItem", fx.INFERRED_KEYS.AbsenceItem);
  each(fx.timeEntries, componentSchema("TimeEntry"), "TimeEntry");
  each(fx.venueEvents, componentSchema("VenueEventItem"), "VenueEventItem", fx.INFERRED_KEYS.VenueEventItem);
  validateWith(itemSchema("/info"), fx.info, "GET /info item");
  walkKeys(fx.info, itemSchema("/info"), "GET /info item");
  // Negative controls: the schemas and the key walk still reject what they should.
  assert.equal(ajv.compile(componentSchema("AbsenceItem"))({ account: { id: 1 } }), false, "AbsenceItem without its required id must fail");
  assert.equal(ajv.compile(componentSchema("AccountItem"))({ id: 1, email: "not an email" }), false, "a malformed email must fail");
  assert.throws(() => walkKeys({ id: 1, salary: 1 }, componentSchema("AccountItem"), "control"), /key "salary" is not declared/);
  assert.throws(() => walkKeys({ id: 1, account: { id: 1, nope: 1 } }, componentSchema("TimeEntry"), "control"), /key "nope" is not declared/);
});

// 2. The mock's responses match the documented response schemas.
const mock = await startMock();
const { port, requests } = mock;
const base = `http://127.0.0.1:${port}${PREFIX}`;
const raw = async (path, headers = {}) => {
  const res = await fetch(base + path, { headers });
  return { status: res.status, json: await res.json().catch(() => undefined) };
};
await check("mock /auth, list, detail and error responses match the documented response schemas", async () => {
  const auth = await raw("/auth", { "x-user": API_USER, "x-auth": API_KEY });
  assert.equal(auth.status, 200);
  validateWith(responseSchema("/auth"), auth.json, "GET /auth 200");
  walkKeys(auth.json, responseSchema("/auth"), "GET /auth 200");
  const bearer = { Authorization: `Bearer ${auth.json.token}` };
  const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `response is missing "${k}"`));
  for (const path of ["/info", "/venues", "/groups", "/absence-types", "/accounts", "/shifts", "/absences", "/time-entries", "/venue-events", `/shifts/${fx.shifts[0].id}`]) {
    const r = await raw(path, bearer);
    assert.equal(r.status, 200, path);
    const specPath = path.startsWith("/shifts/") ? "/shifts/{shiftid}" : path;
    validateWith(responseSchema(specPath), r.json, `GET ${path} 200`);
    keys(r.json, "success", "message", "data", "paging");
    validateWith(componentSchema("Paging"), r.json.paging, `GET ${path} paging`);
    walkKeys(r.json.paging, componentSchema("Paging"), `GET ${path} paging`);
  }
  // /venues: the spec's 200 schema has no data array; the mock's data items are checked against Venue.
  const venues = await raw("/venues", bearer);
  venues.json.data.forEach((v) => validateWith(componentSchema("Venue"), v, `GET /venues data ${v.id}`));
  const shiftsPage2 = await raw("/shifts?page=2", bearer);
  assert.deepEqual(shiftsPage2.json.paging, { "total-data-count": 60, "page-count": 3, "per-page": PER_PAGE, current: 2, last: 3 });
  // Errors: the spec documents 401 and 400 without a body; the mock's {success, message} fits the
  // documented envelope's types.
  const envelope = { type: "object", properties: { success: { type: "boolean" }, message: { type: "string" } }, required: ["success", "message"] };
  const noToken = await raw("/shifts");
  assert.equal(noToken.status, 401);
  validateWith(envelope, noToken.json, "401 body");
  const badAuth = await raw("/auth", { "x-user": API_USER, "x-auth": "ss-wrong-key-not-real" });
  assert.equal(badAuth.status, 401);
  const unknown = await raw("/shifts/424242", bearer);
  assert.equal(unknown.status, 404);
  validateWith(envelope, unknown.json, "404 body");
  const badParam = await raw("/shifts?colour=red", bearer);
  assert.equal(badParam.status, 400);
  validateWith(envelope, badParam.json, "400 body");
  const empty = await raw(`/shifts/${EMPTY_SHIFT}`, bearer);
  validateWith(responseSchema("/shifts/{shiftid}"), empty.json, "empty get-by-id");
  assert.deepEqual(empty.json.data, []);
  // The mock compares strictly: a date-only upper bound does not reach into that day's date-times, so
  // the server's filters cannot pass here on a lenient reading of the docs.
  const dateOnly = await raw(`/shifts?start=${encodeURIComponent("lte:2026-10-01")}`, bearer);
  assert.equal(dateOnly.json.data.length, 0, "lte:2026-10-01 must not match shifts starting on 1 October");
  const wholeDay = await raw(`/shifts?start=${encodeURIComponent("lte:2026-10-01 23:59:59")}`, bearer);
  assert.equal(wholeDay.json.data.length, 6);
  const dateOnlyBetween = await raw(`/shifts?start=${encodeURIComponent("[2026-10-03:2026-10-03]")}`, bearer);
  assert.equal(dateOnlyBetween.json.data.length, 0, "[d:d] must not match shifts starting on d");
});
requests.length = 0; // only count what the MCP server does from here on
mock.expireTokens();
// The first GET /venues the server makes gets a 429 with Retry-After: 1.
mock.arm({ path: "/venues", status: 429, headers: { "Retry-After": "1" }, body: { success: false, message: "Too many requests" } });

// 3. Drive the server through MCP.
const connect = async ({ user = API_USER, key = API_KEY, writes = null, baseUrl = base, extraEnv = {} } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, STAFFSAVVY_API_USER: user, STAFFSAVVY_API_KEY: key, STAFFSAVVY_BASE_URL: baseUrl, ...extraEnv };
  delete env.STAFFSAVVY_ALLOW_WRITES;
  if (!("STAFFSAVVY_TOOL_BUDGET_S" in extraEnv)) delete env.STAFFSAVVY_TOOL_BUDGET_S;
  if (writes !== null) env.STAFFSAVVY_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const api = (rs) => rs.filter((r) => r.path !== "/auth");

const TOOLS = ["get_info", "get_shift", "list_absence_types", "list_absences", "list_accounts", "list_groups", "list_shifts", "list_time_entries", "list_venue_events", "list_venues"];
const client = await connect({ writes: "true" });
console.log("mcp tools");

await check("tools/list exposes 10 read-only tools, and STAFFSAVVY_ALLOW_WRITES=true adds no write tool", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
  }
});

await check("get_info fetches a token from GET /auth with x-user/x-auth headers (never in the URL) and reuses it", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_info");
  assert.deepEqual([data.connected, data.software_version, data.api_version], [true, "2024.2.0", "1.0.3"]);
  const rs = since(n);
  assert.deepEqual(rs.map((r) => r.path), ["/auth", "/info"]);
  assert.equal(rs[0].headers["x-user"], API_USER);
  assert.equal(rs[0].headers["x-auth"], API_KEY);
  assert.deepEqual(rs[0].query, {}, "no credentials in the query string");
  assert.equal(rs[0].headers.authorization, undefined);
  assert.equal(rs[1].headers.authorization, `Bearer ${mock.issued.at(-1)}`);
  assert.equal(rs[1].headers["x-auth"], undefined, "the API key is only sent to /auth");
  const again = await call(client, "get_info");
  assert.ok(!again.res.isError);
  assert.deepEqual(since(n).map((r) => r.path), ["/auth", "/info", "/info"], "token cached across calls");
});

await check("list_venues retries a 429 after the Retry-After of 1 s; venue titles are redacted", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_venues");
  const tries = since(n).filter((r) => r.path === "/venues");
  assert.equal(tries.length, 2, "one retry after the 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(data.venues.map((v) => [v.id, v.title]), [[1, "Main Theatre"], [2, "Studio"], [3, "Box Office (queries [phone redacted])"]]);
  assert.deepEqual(data.venues[0].allowed_groups, [{ id: 1, title: "Usher" }, { id: 2, title: "Bar" }, { id: 3, title: "Supervisor" }]);
  assert.deepEqual(data.venues[0].allowed_shift_actions, [{ id: 1, title: "Cleaning" }]);
  assert.equal(data.complete, true);
});

await check("list_groups and list_absence_types return ids and redacted titles; a pay rate on a group is never returned", async () => {
  const groups = await call(client, "list_groups");
  assert.deepEqual(groups.data.groups, [{ id: 1, title: "Usher" }, { id: 2, title: "Bar" }, { id: 3, title: "Supervisor" }, { id: 4, title: "Security (radio [phone redacted])" }]);
  const types = await call(client, "list_absence_types");
  assert.deepEqual(types.data.absence_types, [{ id: -3, title: "Jury Duty", type: "absence" }, { id: -2, title: "Sickness", type: "absence" }, { id: -1, title: "Annual Leave", type: "holiday" }, { id: 7, title: "Compassionate leave (ask [email redacted])", type: "absence" }]);
  // The spec's Groups component carries a pay-element with a rate; if /groups ever returned one, it must not come through.
  mock.arm({ path: "/groups", status: 200, body: { success: true, message: "", data: [{ id: 9, title: "Duty manager", active: true, "pay-element": { id: 1, title: "VM", rate: 12.75 } }], paging: { "total-data-count": 1, "page-count": 1, "per-page": 25, current: 1, last: 1 } } });
  const paid = await call(client, "list_groups");
  assert.deepEqual(paid.data.groups, [{ id: 9, title: "Duty manager" }]);
  assert.ok(!paid.text.includes("12.75") && !paid.text.includes("VM"));
  mock.disarm();
});

await check("list_shifts pages 1, 2, 3 to paging.last and stops; staff names come from /accounts?id=[...] queries of at most 50 IDs; requests are spaced at least 250 ms apart", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_shifts");
  const pages = api(since(n)).filter((r) => r.path === "/shifts").map((r) => r.query.page);
  assert.deepEqual(pages, ["1", "2", "3"], "three pages, no fourth call once current reached last");
  assert.equal(data.count, 60);
  assert.equal(data.total, 60);
  assert.equal(data.complete, true);
  const lookups = api(since(n)).filter((r) => r.path === "/accounts");
  assert.deepEqual(lookups.map((r) => r.query.page), ["1", "2", "1"], "60 staff: 50 IDs (two pages of 25), then 10 IDs (one page)");
  assert.equal(lookups[1].query.id, lookups[0].query.id);
  for (const r of lookups) assert.match(r.query.id, /^\[\d+(,\d+)*\]$/, "documented one-of filter id=[a,b,c]");
  assert.deepEqual([lookups[0].query.id, lookups[2].query.id].map((q) => q.slice(1, -1).split(",").length), [50, 10]);
  assert.equal(new Set([lookups[0].query.id, lookups[2].query.id].flatMap((q) => q.slice(1, -1).split(","))).size, 60, "each staff member looked up once");
  assert.ok(data.shifts.every((s) => typeof s.staff.name === "string"), "every shift has a name");
  const first = data.shifts[0];
  assert.deepEqual(first, {
    id: 5000, start: "2026-10-01 17:00:00", end: "2026-10-01 22:30:00", venue: { id: 1 }, group: { id: 1 },
    staff: { id: fx.SAM, name: "Sam Evans" }, task: { id: 1 }, event: { id: 700 }, arrival_info: "On arrival please report to reception",
  });
  assert.equal(data.shifts.find((s) => s.staff.id === fx.PRIYA).staff.known_as, "Pri");
  assert.equal(data.staff_note, undefined);
  // The throttle: six requests in a row (three /shifts pages, three /accounts pages), each at least
  // about 250 ms after the one before (240 ms allows for timer granularity).
  const rs = api(since(n));
  assert.equal(rs.length, 6);
  const gaps = rs.slice(1).map((r, i) => r.t - rs[i].t);
  assert.ok(gaps.every((g) => g >= 240), `requests should be spaced about 250 ms apart (gaps ${gaps.join(", ")} ms)`);
});

await check("list_shifts sends whole-day date-time bounds for start (documented [a~b] form, lte:<day> 23:59:59), and venue, group and event, as documented", async () => {
  const cases = [
    [{ from: "2026-10-03", to: "2026-10-04" }, { start: "[2026-10-03 00:00:00~2026-10-04 23:59:59]" }],
    [{ from: "2026-10-09" }, { start: "gte:2026-10-09" }],
    [{ to: "2026-10-01" }, { start: "lte:2026-10-01 23:59:59" }],
    [{ from: "2026-10-03", to: "2026-10-03", venue_id: 1, group_id: 1 }, { start: "[2026-10-03 00:00:00~2026-10-03 23:59:59]", venue: "1", group: "1" }],
    [{ event_id: 700 }, { event: "700" }],
  ];
  for (const [args, query] of cases) {
    const n = requests.length;
    const { data, text } = await call(client, "list_shifts", { ...args, include_staff_names: false });
    assert.ok(data, text);
    const reqs = api(since(n));
    assert.deepEqual(reqs.map((r) => r.path), ["/shifts"], "no /accounts call when include_staff_names is false");
    assert.deepEqual(reqs[0].query, { ...query, page: "1" });
    const expected = fx.shifts.filter((s) =>
      (!args.from || s.start.slice(0, 10) >= args.from) && (!args.to || s.start.slice(0, 10) <= args.to) &&
      (!args.venue_id || s.venue === args.venue_id) && (!args.group_id || s.group === args.group_id) && (!args.event_id || s.event === args.event_id));
    assert.deepEqual(data.shifts.map((s) => s.id), expected.map((s) => s.id), JSON.stringify(args));
    assert.ok(expected.length > 0);
    assert.equal(data.shifts[0].staff.name, undefined);
  }
  const reversed = await call(client, "list_shifts", { from: "2026-10-05", to: "2026-10-01" });
  assert.ok(reversed.res.isError);
  assert.match(reversed.text, /is after "to"/);
});

await check("max_pages stops early and reports the next page; page continues from it", async () => {
  const { data } = await call(client, "list_shifts", { max_pages: 1, include_staff_names: false });
  assert.deepEqual([data.count, data.complete, data.next_page], [PER_PAGE, false, 2]);
  assert.match(data.note, /page 2/);
  const next = await call(client, "list_shifts", { page: 2, max_pages: 5, include_staff_names: false });
  assert.deepEqual([next.data.count, next.data.complete, next.data.next_page], [35, true, undefined]);
  assert.equal(next.data.shifts[0].id, fx.shifts[PER_PAGE].id);
});

await check("get_shift redacts arrival information by default, lists unread keys by name only, and returns the raw text on request", async () => {
  const { data } = await call(client, "get_shift", { shift_id: fx.SHIFT_WITH_CONTACT });
  assert.equal(data.shift.arrival_info, "Ask for Dana on [phone redacted] or [email redacted]");
  assert.ok(!JSON.stringify(data).includes("07700 900456") && !JSON.stringify(data).includes("dana@"));
  const raw = await call(client, "get_shift", { shift_id: fx.SHIFT_WITH_CONTACT, include_contact_details: true });
  assert.equal(raw.data.shift.arrival_info, "Ask for Dana on 07700 900456 or dana@example.com");
  const extra = await call(client, "get_shift", { shift_id: fx.SHIFT_WITH_EXTRA, include_contact_details: true });
  assert.deepEqual(extra.data.shift.other_fields, ["external-worker-name"]);
  assert.ok(!extra.text.includes("Agency worker"), "the value of an unread field is never returned");
  assert.equal(extra.data.shift.staff.name, "Person0 Surname0");
});

await check("bad IDs and dates are rejected before any API call; unknown IDs give a clear not-found message", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_shift", { shift_id: 0 }],
    ["get_shift", { shift_id: -5 }],
    ["get_shift", { shift_id: 1.5 }],
    ["get_shift", { shift_id: "5000/history" }],
    ["list_shifts", { from: "2026-02-30" }],
    ["list_shifts", { to: "01/10/2026" }],
    ["list_accounts", { firstname: "[Bob,Bill]" }],
    ["list_accounts", { lastname: "gte:A" }],
    ["list_absences", { account_id: 0 }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
  const missing = await call(client, "get_shift", { shift_id: 424242 });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/shifts\/424242\. Check the ID.*Shift not found/);
  const empty = await call(client, "get_shift", { shift_id: EMPTY_SHIFT });
  assert.ok(empty.res.isError, "a 200 with an empty data array is not a shift");
  assert.match(empty.text, /Not found: \/shifts\/9999\. StaffSavvy answered with no record/);
});

await check("list_absences returns absences overlapping the range (lookback on start, then period_end), filters by account and inc-deleted, marks deleted ones; reasons only on request", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_absences", { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(api(since(n)).find((r) => r.path === "/absences").query, { start: "[2026-08-31:2026-10-31]", page: "1" }, "31 days of lookback by default");
  assert.deepEqual(data.absences.map((a) => a.id), [1, 2, 3], "absence 4 (20-21 September) started in the lookback but ended before from");
  assert.equal(data.total, undefined, "the API total counts the widened range, so it is not reported");
  assert.match(data.range_note, /starting from 2026-08-31 \(31 days before 2026-10-01\); 1 that ended before 2026-10-01 were left out/);
  const sam = data.absences[0];
  assert.deepEqual(sam, {
    id: 1, staff: { id: fx.SAM, name: "Sam Evans" }, type_id: -2, absence_type: { id: -2, title: "Sickness", type: "absence" },
    start: "2026-10-02", start_hour: "09:00", end: "2026-10-03", end_hour: "17:00", period_end_least: "2026-10-02",
    shift_repost: "No, do not replace with another staff member",
  });
  for (const leak of ["Sinus infection", "Off sick", "Illness", "Family holiday", "0117 496 0123", "Jury service"]) assert.ok(!JSON.stringify(data).includes(leak), `${leak} leaked by default`);
  const detailed = await call(client, "list_absences", { from: "2026-10-01", to: "2026-10-31", include_contact_details: true });
  assert.deepEqual([detailed.data.absences[0].category, detailed.data.absences[0].title, detailed.data.absences[0].shift_excuse], ["Sinus infection", "Off sick", "Cancel with reason: Illness"]);
  assert.equal(detailed.data.absences[2].category, "Jury service, court contact 0117 496 0123");
  const m = requests.length;
  const bySam = await call(client, "list_absences", { account_id: fx.SAM, include_staff_names: false });
  assert.deepEqual(api(since(m))[0].query, { account: String(fx.SAM), page: "1" });
  assert.deepEqual(bySam.data.absences.map((a) => a.id), [1, 4]);
  // "Who is off on 6-8 October": Priya's leave (5-9 October) started before from and must be found.
  const w = requests.length;
  const week = await call(client, "list_absences", { from: "2026-10-06", to: "2026-10-08" });
  assert.deepEqual(api(since(w)).find((r) => r.path === "/absences").query, { start: "[2026-09-05:2026-10-08]", page: "1" });
  assert.deepEqual(week.data.absences.map((a) => [a.id, a.staff.name, a.start, a.end]), [[2, "Priya Shah", "2026-10-05", "2026-10-09"]]);
  const noLookback = await call(client, "list_absences", { from: "2026-10-06", to: "2026-10-08", lookback_days: 0 });
  assert.deepEqual(noLookback.data.absences, [], "lookback_days 0 asks for absences starting in the range only");
  assert.equal(noLookback.data.range_note, undefined);
  const k = requests.length;
  const withDeleted = await call(client, "list_absences", { from: "2026-10-04", to: "2026-10-04", include_deleted: true, include_staff_names: false });
  assert.deepEqual(api(since(k))[0].query, { start: "[2026-09-03:2026-10-04]", "inc-deleted": "1", page: "1" });
  assert.deepEqual(withDeleted.data.absences.map((a) => a.id), [5]);
  assert.deepEqual([withDeleted.data.absences[0].approved, withDeleted.data.absences[0].deleted_or_rejected], [-1, true], "a negative approved marks a deleted or rejected absence");
  assert.ok(data.absences.every((a) => a.deleted_or_rejected === undefined && a.approved === undefined), "no marker where the record has no approved value");
});

await check("list_time_entries filters by start, account and event; pay data is never returned, notes are redacted by default", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_time_entries", { from: "2026-10-01", to: "2026-10-01" });
  assert.deepEqual(api(since(n)).find((r) => r.path === "/time-entries").query, { start: "[2026-10-01 00:00:00~2026-10-01 23:59:59]", page: "1" });
  assert.deepEqual(data.time_entries.map((e) => e.id), [9001, 9002]);
  assert.deepEqual(data.time_entries[0], {
    id: 9001, staff: { id: fx.SAM, name: "Sam Evans" }, start: "2026-10-01 17:02:00", end: "2026-10-01 22:31:00", venue: "Main Theatre",
    role: { id: 1, title: "Usher" }, status: "normal", approved: 1, approved_by: { id: 100, name: "Jo Bloggs" }, notes: "Entry has been modified",
  });
  assert.equal(data.time_entries[1].notes, "Left early, call [phone redacted] if queried");
  const full = await call(client, "list_time_entries", { from: "2026-10-01", to: "2026-10-01", include_contact_details: true });
  assert.equal(full.data.time_entries[1].notes, "Left early, call 07700 900789 if queried");
  for (const out of [data, full.data]) {
    const text = JSON.stringify(out);
    for (const pay of ["11.44", "pay", "Standard hourly", "PAY01"]) assert.ok(!text.includes(pay), `pay data "${pay}" returned`);
  }
  const m = requests.length;
  const byEvent = await call(client, "list_time_entries", { event_id: 700, account_id: fx.PRIYA, include_staff_names: false });
  assert.deepEqual(api(since(m))[0].query, { event: "700", account: String(fx.PRIYA), page: "1" });
  assert.deepEqual(byEvent.data.time_entries.map((e) => e.id), [9002]);
});

await check("list_venue_events filters by date and venue; titles are redacted", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_venue_events", { from: "2026-10-01", to: "2026-10-31", venue_id: 1 });
  assert.deepEqual(since(n).filter((r) => r.path === "/venue-events")[0].query, { date: "[2026-10-01:2026-10-31]", venue: "1", page: "1" });
  assert.deepEqual(data.venue_events.map((e) => e.id), [700, 701, 703]);
  assert.deepEqual(data.venue_events[0], { id: 700, date: "2026-10-01", hour: 19, venue_id: 1, title: "Macbeth", cost_codes: ["THEA", "EV700", undefined, undefined].map((x) => x ?? null) });
  assert.equal(data.venue_events[2].title, "Private hire (organiser [phone redacted])");
});

await check("list_accounts returns names only by default, contact details and legal names on request, and passes the documented filters", async () => {
  const { data } = await call(client, "list_accounts", { max_pages: 2 });
  assert.deepEqual([data.count, data.total, data.complete, data.next_page], [50, 60, false, 3]);
  assert.deepEqual(data.accounts[1], { id: fx.SAM, name: "Sam Evans", default_venues: ["Main Theatre"] });
  assert.equal(data.accounts[3].known_as, "Lee ([email redacted])");
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example") && !text.includes("07700") && !text.includes("Samantha"), "no email, phone or legal name by default");
  const n = requests.length;
  const full = await call(client, "list_accounts", { firstname: "Sam", lastname: "Evans", include_contact_details: true });
  assert.deepEqual(since(n)[0].query, { firstname: "Sam", lastname: "Evans", page: "1" });
  assert.deepEqual(full.data.accounts, [{ id: fx.SAM, name: "Sam Evans", default_venues: ["Main Theatre"], email: "sam.evans@example.com", phone: "07700 900101", legal_name: "Samantha Jane Evans" }]);
  const m = requests.length;
  const byIds = await call(client, "list_accounts", { ids: [fx.PRIYA, fx.LEE] });
  assert.deepEqual(since(m)[0].query, { id: `[${fx.PRIYA},${fx.LEE}]`, page: "1" });
  assert.deepEqual(byIds.data.accounts.map((a) => a.id), [fx.PRIYA, fx.LEE]);
  const leeRaw = await call(client, "list_accounts", { ids: [fx.LEE], include_contact_details: true });
  assert.equal(leeRaw.data.accounts[0].known_as, "Lee (lee.chen@example.net)", "names as stored on request");
  const k = requests.length;
  const changed = await call(client, "list_accounts", { changed_since: "2026-09-01" });
  assert.deepEqual(since(k)[0].query, { _last_history_record: "gte:2026-09-01", page: "1" });
  assert.deepEqual(changed.data.accounts.map((a) => a.id), [fx.PRIYA, fx.LEE]);
});

await check("an expired token is fetched again once; a token refused even when fresh gives an actionable message", async () => {
  mock.expireTokens();
  const n = requests.length;
  const { res } = await call(client, "list_groups");
  assert.ok(!res.isError);
  assert.deepEqual(since(n).map((r) => [r.path, r.headers.authorization ?? null]), [
    ["/groups", `Bearer ${mock.issued.at(-2)}`],
    ["/auth", null],
    ["/groups", `Bearer ${mock.issued.at(-1)}`],
  ]);
  mock.setRefuseAllTokens(true);
  const m = requests.length;
  const refused = await call(client, "list_groups");
  assert.ok(refused.res.isError);
  assert.deepEqual(since(m).map((r) => r.path), ["/groups", "/auth", "/groups"], "one refresh, then give up");
  assert.match(refused.text, /rejected the bearer token \(401\) for GET \/groups, even after fetching a fresh one\. Check that the API user still has API permission/);
  mock.setRefuseAllTokens(false);
});

await check("a persistent 429 gives up after 3 attempts; a Retry-After above 10 s gives up at once", async () => {
  mock.arm({ path: "/groups", status: 429, times: 3, headers: { "Retry-After": "0" }, body: { success: false, message: "Too many requests" } });
  let n = requests.length;
  const persistent = await call(client, "list_groups");
  assert.ok(persistent.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/groups").length, 3);
  assert.match(persistent.text, /StaffSavvy rate limit reached \(429; no limit is documented\)\. Wait a minute and try again\./);
  mock.disarm();
  mock.arm({ path: "/groups", status: 429, headers: { "Retry-After": "600" }, body: { success: false, message: "Too many requests" } });
  n = requests.length;
  const long = await call(client, "list_groups");
  assert.ok(long.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/groups").length, 1);
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/groups \(HTTP 429\)/);
  mock.disarm();
});

await check("an HTTP-date and a fractional Retry-After are honoured; without one the retries wait 2 s then 4 s", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  mock.arm({ path: "/groups", status: 429, headers: { "Retry-After": new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() }, body: { success: false, message: "Too many requests" } });
  let n = requests.length;
  assert.ok(!(await call(client, "list_groups")).res.isError);
  let tries = since(n).filter((r) => r.path === "/groups");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (waited ${gap} ms)`);
  mock.disarm();
  mock.arm({ path: "/groups", status: 429, headers: { "Retry-After": "1.5" }, body: { success: false, message: "Too many requests" } });
  n = requests.length;
  assert.ok(!(await call(client, "list_groups")).res.isError);
  tries = since(n).filter((r) => r.path === "/groups");
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  mock.disarm();
  mock.arm({ path: "/groups", status: 429, times: 2, body: { success: false, message: "Too many requests" } }); // no Retry-After: 2 s, then 4 s
  n = requests.length;
  assert.ok(!(await call(client, "list_groups")).res.isError);
  tries = since(n).filter((r) => r.path === "/groups");
  assert.equal(tries.length, 3);
  const gaps = [tries[1].t - tries[0].t, tries[2].t - tries[1].t];
  assert.ok(gaps[0] >= 1950 && gaps[0] < 2600 && gaps[1] >= 3950 && gaps[1] < 4600, `retries without Retry-After should wait 2 s then 4 s (waited ${gaps.join(" and ")} ms)`);
  mock.disarm();
});

await check("a 502 on a GET is retried; three 503s are reported with advice and without the gateway HTML", async () => {
  mock.arm({ path: "/absence-types", status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  const once = await call(client, "list_absence_types");
  assert.ok(!once.res.isError, once.text);
  assert.equal(since(n).filter((r) => r.path === "/absence-types").length, 2);
  mock.disarm();
  mock.arm({ path: "/absence-types", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "list_absence_types");
  assert.ok(down.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/absence-types").length, 3);
  assert.match(down.text, /StaffSavvy returned 503 for GET \/absence-types 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!down.text.includes("<html>"));
  mock.disarm();
});

await check("a non-JSON 200 and a 200 with success:false are errors, not empty lists", async () => {
  mock.arm({ path: "/venue-events", status: 200 });
  const html = await call(client, "list_venue_events");
  assert.ok(html.res.isError);
  assert.match(html.text, /returned 200 for GET \/venue-events but the body was not a JSON object \(starts with: "<html>.*Check STAFFSAVVY_BASE_URL/);
  mock.disarm();
  mock.arm({ path: "/venue-events", status: 200, body: { success: false, message: "Permission denied for venue events" } });
  const refused = await call(client, "list_venue_events");
  assert.ok(refused.res.isError);
  assert.match(refused.text, /reported a failure for GET \/venue-events \(success: false\)\. Permission denied for venue events/);
  mock.disarm();
});

await check("error messages from StaffSavvy are passed on with contact details redacted and the API key and token scrubbed", async () => {
  const token = mock.issued.at(-1);
  mock.arm({ path: "/absences", status: 400, body: { success: false, message: `bad input parameter; ask ops@example.com or 07700 900999; key ${API_KEY} token ${token}` } });
  const { res, text } = await call(client, "list_absences");
  assert.ok(res.isError);
  assert.match(text, /rejected GET \/absences \(400 bad input parameter\)\. bad input parameter; ask \[email redacted\] or \[phone redacted\]; key \[redacted\] token \[redacted\]/);
  assert.ok(!text.includes(API_KEY) && !text.includes(token));
  mock.disarm();
});

await check("a 403 or a 400 on the staff-name lookup still answers, with IDs and a note", async () => {
  mock.arm({ path: "/accounts", status: 400, body: { success: false, message: "bad input parameter" } });
  const four = await call(client, "get_shift", { shift_id: 5000 });
  assert.deepEqual(four.data.shift.staff, { id: fx.SAM });
  assert.match(four.data.staff_note, /Staff names could not be looked up \(StaffSavvy rejected GET \/accounts \(400 bad input parameter\)/);
  mock.disarm();
  mock.arm({ path: "/accounts", status: 403, body: { success: false, message: "Permission denied" } });
  const { res, data } = await call(client, "get_shift", { shift_id: 5000 });
  assert.ok(!res.isError);
  assert.deepEqual(data.shift.staff, { id: fx.SAM });
  assert.match(data.staff_note, /Staff names could not be looked up \(StaffSavvy refused GET \/accounts \(403\)/);
  mock.disarm();
});

const PII = "Home 12 Acacia Ave BH9 2SQ; DOB 01/02/1990; call 447815000000, 7700 900123 or +44 7700 900123; card 4111 1111 1111 1111; jo@example.com";
const PII_PARTS = ["BH9 2SQ", "01/02/1990", "447815000000", "7700 900123", "4111 1111 1111 1111", "jo@example.com"];
const noPii = (text, where) => PII_PARTS.forEach((p) => assert.ok(!text.includes(p), `${where}: "${p}" not redacted`));
const envelope = (data, paging) => ({ success: true, message: "", data, ...(paging === undefined ? {} : { paging }) });
const onePage = (data) => envelope(data, { "total-data-count": data.length, "page-count": 1, "per-page": 25, current: 1, last: 1 });

await check("free text is redacted by default: emails, phones (incl. 44… and 7… without a prefix), UK postcodes, dates of birth and card numbers, in every tool and in error messages", async () => {
  mock.arm({ path: "/shifts/5000", status: 200, body: onePage([{ ...fx.shifts[0], "arrival-info": PII }]) });
  const shift = await call(client, "get_shift", { shift_id: 5000 });
  noPii(shift.text, "get_shift arrival_info");
  assert.equal(shift.data.shift.arrival_info, "Home 12 Acacia Ave [postcode redacted]; [date of birth redacted]; call [phone redacted], [phone redacted] or [phone redacted]; card [card number redacted]; [email redacted]");
  mock.arm({ path: "/shifts/5000", status: 200, body: onePage([{ ...fx.shifts[0], "arrival-info": PII }]) });
  const shiftRaw = await call(client, "get_shift", { shift_id: 5000, include_contact_details: true });
  assert.equal(shiftRaw.data.shift.arrival_info, PII.replace("4111 1111 1111 1111", "[card number redacted]"), "as stored on request, except a card number");
  mock.arm({ path: "/venue-events", status: 200, body: onePage([{ id: 1, date: "2026-10-01", venue: 1, hour: 19, uuid: PII, title: PII, costcode1: PII, costcode2: "EV1", costcode3: "", costcode4: "" }]) });
  const events = await call(client, "list_venue_events");
  noPii(events.text, "list_venue_events uuid, title and cost codes");
  assert.equal(events.data.venue_events[0].cost_codes[1], "EV1");
  mock.arm({ path: "/time-entries", status: 200, body: onePage([{ ...fx.timeEntries[0], status: PII, notes: PII, role: { id: 1, title: PII } }]) });
  noPii((await call(client, "list_time_entries", { include_staff_names: false })).text, "list_time_entries status, notes and role");
  mock.arm({ path: "/absence-types", status: 200, body: onePage([{ id: 1, title: PII, type: PII }]) });
  noPii((await call(client, "list_absence_types")).text, "list_absence_types title and type");
  mock.arm({ path: "/groups", status: 200, body: onePage([{ id: 1, title: PII }]) });
  noPii((await call(client, "list_groups")).text, "list_groups title");
  mock.arm({ path: "/venues", status: 200, body: onePage([{ id: 1, title: PII, "allowed-groups": [{ id: 1, title: PII }], "allowed-shift-actions": [] }]) });
  noPii((await call(client, "list_venues")).text, "list_venues titles");
  mock.arm({ path: "/accounts", status: 200, body: onePage([{ ...fx.accounts[1], firstname: PII, nickname: PII }]) });
  noPii((await call(client, "list_accounts")).text, "list_accounts names");
  mock.arm({ path: "/absences", status: 200, body: onePage([{ ...fx.absences[0], absence_shift_repost: PII, absence_type: { id: -2, title: PII, type: PII } }]) });
  noPii((await call(client, "list_absences", { include_staff_names: false })).text, "list_absences repost and type");
  mock.arm({ path: "/absences", status: 400, body: { success: false, message: PII } });
  const err = await call(client, "list_absences");
  assert.ok(err.res.isError);
  noPii(err.text, "error message");
  // Ordinary values survive: dates, date-times, IDs and hyphenated references.
  assert.equal(shift.data.shift.start, fx.shifts[0].start);
  assert.equal(events.data.venue_events[0].date, "2026-10-01");
  mock.disarm();
});

await check("paging fallbacks: no paging is one page; total-data-count alone, page-count alone, and an empty page each end the listing", async () => {
  const pagesOf = async (args) => {
    const n = requests.length;
    const r = await call(client, "list_venues", args);
    mock.disarm();
    return { data: r.data, pages: since(n).filter((q) => q.path === "/venues").map((q) => q.query.page) };
  };
  const v = (id) => ({ id, title: `V${id}` });
  mock.arm({ path: "/venues", status: 200, times: 5, body: envelope([v(1)]) });
  let r = await pagesOf({});
  assert.deepEqual([r.pages, r.data.complete, r.data.count], [["1"], true, 1], "no paging object: a single, complete page");
  mock.arm({ path: "/venues", status: 200, body: envelope([v(1), v(2)], { "total-data-count": 3 }) });
  mock.arm({ path: "/venues", status: 200, times: 5, body: envelope([v(3)], { "total-data-count": 3 }) });
  r = await pagesOf({});
  assert.deepEqual([r.pages, r.data.complete, r.data.count, r.data.total], [["1", "2"], true, 3, 3], "total-data-count only: stop once that many are collected");
  mock.arm({ path: "/venues", status: 200, body: envelope([v(1)], { "page-count": 2 }) });
  mock.arm({ path: "/venues", status: 200, times: 5, body: envelope([v(2)], { "page-count": 2 }) });
  r = await pagesOf({});
  assert.deepEqual([r.pages, r.data.complete, r.data.count], [["1", "2"], true, 2], "page-count only: stop at that page");
  mock.arm({ path: "/venues", status: 200, body: envelope([v(1), v(2)], { "total-data-count": 3 }) });
  mock.arm({ path: "/venues", status: 200, times: 5, body: envelope([], { "total-data-count": 3 }) });
  r = await pagesOf({ page: 2 });
  assert.deepEqual([r.pages, r.data.complete, r.data.count], [["2", "3"], true, 2], "starting at page 2 with a total only: an empty page is the end");
});

await check("an API that ignores page (current stays 1) stops the listing with a note instead of repeating records", async () => {
  const n = requests.length;
  mock.arm({ path: "/venues", status: 200, times: 10, body: envelope([{ id: 1, title: "A" }, { id: 2, title: "B" }], { "total-data-count": 6, "page-count": 3, "per-page": 2, current: 1, last: 3 }) });
  const { data } = await call(client, "list_venues");
  mock.disarm();
  assert.deepEqual(since(n).filter((q) => q.path === "/venues").map((q) => q.query.page), ["1", "2"]);
  assert.deepEqual(data.venues.map((x) => x.id), [1, 2], "no duplicates");
  assert.deepEqual([data.complete, data.next_page], [false, undefined]);
  assert.match(data.note, /answered a request for page 2 of \/venues with page 1, so its paging cannot be followed; 2 records from earlier pages are returned/);
});

await check("staff-name notes: an ID with no account says so; a lookup cut short names the IDs it did not look up", async () => {
  mock.arm({ path: "/shifts/5000", status: 200, body: onePage([{ ...fx.shifts[0], account: 999 }]) });
  const unknown = await call(client, "get_shift", { shift_id: 5000 });
  assert.deepEqual(unknown.data.shift.staff, { id: 999 });
  assert.equal(unknown.data.staff_note, "No account record was returned for staff ID 999.");
  mock.arm({ path: "/accounts", status: 200, body: envelope([{ id: 555, firstname: "Other", lastname: "Person" }], { current: 1, last: 3 }) });
  mock.arm({ path: "/accounts", status: 200, body: envelope([{ id: 556, firstname: "Other", lastname: "Person" }], { current: 1, last: 3 }) });
  const cut = await call(client, "get_shift", { shift_id: 5000 });
  mock.disarm();
  assert.deepEqual(cut.data.shift.staff, { id: fx.SAM });
  assert.match(cut.data.staff_note, /^The staff-name lookup was cut short, so no name was looked up for staff ID 101: StaffSavvy answered a request for page 2 of \/accounts with page 1/);
});

await check("each tool call has a time budget shared by all its requests (3 s here): retries that would pass it are not attempted, and lists return what they have", async () => {
  const quick = await connect({ extraEnv: { STAFFSAVVY_TOOL_BUDGET_S: "3" } });
  const timed = async (name, args) => {
    const t0 = Date.now();
    const r = await call(quick, name, args);
    return { ...r, ms: Date.now() - t0 };
  };
  // Waits add up across requests: two 1 s waits on /auth, then a 1.5 s wait on /shifts would pass 3 s.
  // Each wait alone is well under the 10 s cap, so without the shared budget the call would succeed.
  mock.arm({ path: "/auth", status: 429, times: 2, headers: { "Retry-After": "1" }, body: { success: false, message: "Too many requests" } });
  mock.arm({ path: "/shifts", status: 429, headers: { "Retry-After": "1.5" }, body: { success: false, message: "Too many requests" } });
  let n = requests.length;
  const shared = await timed("list_shifts", { max_pages: 1, include_staff_names: false });
  mock.disarm();
  assert.ok(shared.res.isError);
  assert.match(shared.text, /answered GET \/shifts with HTTP 429, and waiting 2 more seconds to retry would take this tool call past its time budget/);
  assert.deepEqual(since(n).map((q) => q.path), ["/auth", "/auth", "/auth", "/shifts"]);
  assert.ok(shared.ms < 3500, `gave up within the budget (${shared.ms} ms)`);
  // Page 2 keeps being rate-limited: the list returns page 1 with complete: false and the page to continue from.
  mock.arm({ path: "/shifts", query: { page: "2" }, status: 429, times: 3, headers: { "Retry-After": "2" }, body: { success: false, message: "Too many requests" } });
  n = requests.length;
  const partial = await timed("list_shifts", { max_pages: 3, include_staff_names: false });
  mock.disarm();
  assert.ok(!partial.res.isError, partial.text);
  assert.deepEqual([partial.data.count, partial.data.complete, partial.data.next_page, partial.data.pages_fetched], [PER_PAGE, false, 2, 1]);
  assert.match(partial.data.note, /Stopped after 1 page to keep this tool call within its time budget.*Call again with page 2/);
  assert.deepEqual(since(n).map((q) => q.query.page), ["1", "2", "2"]);
  assert.ok(partial.ms < 3500, `returned within the budget (${partial.ms} ms)`);
  // A slow first page uses up the budget: no second page is requested.
  mock.arm({ path: "/shifts", query: { page: "1" }, delayMs: 3200 });
  n = requests.length;
  const slow = await timed("list_shifts", { max_pages: 3, include_staff_names: false });
  mock.disarm();
  assert.deepEqual([slow.data.count, slow.data.complete, slow.data.next_page], [PER_PAGE, false, 2]);
  assert.deepEqual(since(n).map((q) => q.query.page), ["1"]);
  // The staff-name lookup runs out of budget: the shifts still come back, by staff ID, with a note.
  mock.arm({ path: "/accounts", status: 429, times: 3, headers: { "Retry-After": "2" }, body: { success: false, message: "Too many requests" } });
  const names = await timed("list_shifts", { max_pages: 1 });
  mock.disarm();
  assert.ok(!names.res.isError, names.text);
  assert.equal(names.data.count, PER_PAGE);
  assert.deepEqual(names.data.shifts[0].staff, { id: fx.SAM });
  assert.match(names.data.staff_note, /^The staff-name lookup was cut short, so no name was looked up for staff IDs 101, .*: the tool call ran out of its time budget/);
  assert.ok(names.ms < 3500, `returned within the budget (${names.ms} ms)`);
  await quick.close();
});
await client.close();

await check("wrong credentials and a wrong base URL give actionable messages", async () => {
  const bad = await connect({ key: "ss-wrong-key-not-real" });
  const { res, text } = await call(bad, "get_info");
  assert.ok(res.isError);
  assert.match(text, /rejected the API User and API Key at .*\/auth \(401\)\. Check STAFFSAVVY_API_USER and STAFFSAVVY_API_KEY: they are the API User ID and API Key shown under My Account > API Access/);
  assert.ok(!text.includes("ss-wrong-key-not-real"));
  await bad.close();
  const wrongBase = await connect({ baseUrl: `http://127.0.0.1:${port}/api/v2` });
  const w = await call(wrongBase, "get_info");
  assert.match(w.text, /No StaffSavvy API was found at .*\/api\/v2\/auth \(404\)\. Check STAFFSAVVY_BASE_URL: it must be your StaffSavvy instance URL followed by \/api\/v1/);
  await wrongBase.close();
});

await check("start-up is refused without the three variables, or with a base URL that is not http(s), has credentials or a query string", async () => {
  const run = (env) => spawnSync(process.execPath, [`${root}dist/index.js`], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", input: "" });
  const none = run({});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /STAFFSAVVY_BASE_URL, STAFFSAVVY_API_USER, STAFFSAVVY_API_KEY are not set/);
  // Built at runtime so no literal user:password URL sits in the source (secret scanners flag those).
  const userinfo = run({ STAFFSAVVY_API_USER: API_USER, STAFFSAVVY_API_KEY: API_KEY, STAFFSAVVY_BASE_URL: `https://${["someone", "not-real-pw"].join(":")}@example.invalid/api/v1` });
  assert.equal(userinfo.status, 1);
  assert.match(userinfo.stderr, /must be an http\(s\) URL without a username, password or query string/);
  assert.ok(!userinfo.stderr.includes("not-real-pw"));
  for (const bad of ["ftp://example.invalid/api/v1", "https://example.invalid/api/v1?x=1", "not a url"]) {
    const r = run({ STAFFSAVVY_API_USER: API_USER, STAFFSAVVY_API_KEY: API_KEY, STAFFSAVVY_BASE_URL: bad });
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /STAFFSAVVY_BASE_URL must be an http\(s\) URL/);
  }
});

await check("every request of the whole run was a GET to a documented path; credentials only as /auth headers; bearer token and no x-user/x-auth everywhere else; no pay endpoint called", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 40);
  // The wrong-base-URL check's one request lands outside /api/v1 by design; everything else must be documented.
  const WRONG_BASE_AUTH = "(outside /api/v1) /api/v2/auth";
  assert.equal(requests.filter((r) => r.path === WRONG_BASE_AUTH).length, 1);
  for (const r of requests) {
    assert.equal(r.method, "GET");
    if (r.path === WRONG_BASE_AUTH) {
      assert.deepEqual([r.headers["x-user"], r.headers["x-auth"], r.query], [API_USER, API_KEY, {}]);
      continue;
    }
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
    assert.ok(!("x-auth" in r.query) && !("x-user" in r.query), "credentials never in a query string");
    assert.ok(!/salar|wagesheet|report/.test(r.path), `pay or report endpoint called: ${r.path}`);
    if (r.path === "/auth") {
      assert.equal(r.headers["x-user"], API_USER);
      assert.ok([API_KEY, "ss-wrong-key-not-real"].includes(r.headers["x-auth"]), "the key only in the x-auth header");
      assert.equal(r.headers.authorization, undefined);
    } else {
      assert.ok(mock.issued.map((t) => `Bearer ${t}`).includes(r.headers.authorization), `${r.path} without an issued bearer token`);
      assert.equal(r.headers["x-auth"], undefined, `${r.path} carried x-auth`);
      assert.equal(r.headers["x-user"], undefined, `${r.path} carried x-user`);
    }
  }
  const used = new Set(requests.filter((r) => r.path !== WRONG_BASE_AUTH).map((r) => r.path.replace(/\/\d+$/, "/{id}")));
  assert.deepEqual([...used].sort(), ["/absence-types", "/absences", "/accounts", "/auth", "/groups", "/info", "/shifts", "/shifts/{id}", "/time-entries", "/venue-events", "/venues"]);
});
mock.server.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
