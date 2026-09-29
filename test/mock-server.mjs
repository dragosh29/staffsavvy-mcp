// Local stand-in for a StaffSavvy instance's API (<instance url>/api/v1), serving the fixtures with the
// documented `page` pagination, the documented filter operators, and the GET /auth token exchange.
//
// What is documented and what is assumed here:
// - GET /auth takes x-user and x-auth (the support article: "They can be passed in the GET, POST or
//   REQUEST HEADER") and answers {success, token}; the token then goes in "Authorization: Bearer ...".
//   The mock accepts them as headers only, so a client that put the key in the URL would fail.
// - Every list and get-by-id answers {success, message, data[], paging} (the documented 200 schemas).
//   Paging has total-data-count, page-count, per-page, current and last; the mock serves 25 per page
//   (the spec's per-page example) and sets both page-count and last to the number of pages.
// - The spec documents 401 "Unauthorised" and 400 "bad input parameter" as descriptions only, with no
//   body, and no 404 or 429 at all. The mock answers errors with {success: false, message} (the fields
//   every documented body has), 404 for an unknown ID, and a 429 with Retry-After when armed.
// - GET /venues: the spec's 200 schema has no `data` array (only allowed-groups, allowed-shift-actions
//   and _available_actions at the top level). The mock answers with data: Venue[] like every other list.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const API_USER = "ss-test-user-not-real";
export const API_KEY = "ss-test-key-not-real";
export const PREFIX = "/api/v1";
export const PER_PAGE = 25;
// A shift ID the mock answers with 200 and an empty data array (how the live API reports an unknown ID
// is not documented; both this and a 404 are handled by the server).
export const EMPTY_SHIFT = 9999;

const errBody = (message) => ({ success: false, message });

// Documented filter operators ("please use variable name as the parameter"): equals, not:x, gt:x, lt:x,
// gte:x, lte:x, [a:b] and [a~b] (between, inclusive here), [a,b,c] (one of). Values are compared as
// numbers when both sides are numeric and otherwise as plain text, strictly: a date-only bound is NOT
// widened to the whole day, so "2026-10-03 19:00:00" is not lte:2026-10-03. That is the least favourable
// reading of the docs for a client, so a client that only works with a lenient API fails here.
function matches(raw, op) {
  if (raw === undefined || raw === null) return false;
  const cmp = (a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    const sa = String(a);
    return sa < b ? -1 : sa > b ? 1 : 0;
  };
  let m;
  if ((m = /^\[(.*)\]$/.exec(op))) {
    const inner = m[1];
    if (inner.includes(",") || !/[:~]/.test(inner)) return inner.split(",").some((v) => cmp(raw, v) === 0);
    const [a, b] = inner.includes("~") ? inner.split("~") : inner.split(/:(?=\d{4}-|\d+$|[^:]*$)/);
    return cmp(raw, a) >= 0 && cmp(raw, b) <= 0;
  }
  if ((m = /^(not|gte|lte|gt|lt):(.*)$/.exec(op))) {
    const c = cmp(raw, m[2]);
    return { not: c !== 0, gte: c >= 0, lte: c <= 0, gt: c > 0, lt: c < 0 }[m[1]];
  }
  return cmp(raw, op) === 0;
}

// Per collection: the query parameters it accepts (anything else is a 400) and how each reads a record.
const idOf = (v) => (v && typeof v === "object" ? v.id : v);
const COLLECTIONS = {
  "/venues": { items: () => fx.venues, fields: {} },
  "/groups": { items: () => fx.groups, fields: {} },
  "/absence-types": { items: () => fx.absenceTypes, fields: {} },
  "/accounts": {
    items: () => fx.accounts,
    fields: { id: (a) => a.id, firstname: (a) => a.firstname, lastname: (a) => a.lastname, _last_history_record: (a) => fx.accountChanged[a.id] },
  },
  "/shifts": {
    items: () => fx.shifts,
    fields: { start: (s) => s.start, venue: (s) => s.venue, group: (s) => s.group, event: (s) => s.event, account: (s) => s.account },
  },
  "/absences": {
    items: (q) => (q.get("inc-deleted") === "1" ? [...fx.absences, fx.deletedAbsence] : fx.absences),
    // The documented absence filter examples use `start` and `account`; the record's own fields are
    // period_start and account.id.
    fields: { start: (a) => a.period_start, account: (a) => idOf(a.account), "inc-deleted": () => true },
  },
  "/time-entries": {
    items: () => fx.timeEntries,
    fields: { start: (e) => e.start, account: (e) => idOf(e.account), event: (e) => fx.timeEntryEvent[e.id] },
  },
  "/venue-events": { items: () => fx.venueEvents, fields: { date: (e) => e.date, venue: (e) => e.venue } },
};

export function startMock() {
  const requests = [];
  const issued = [];
  const valid = new Set();
  let refuseAllTokens = false;
  // Injected answers: { path, query, status, times, headers, body, delayMs }. Each request to `path`
  // whose query includes every key of `query` consumes one "time". It waits delayMs, then gets that
  // status and body instead of the normal answer (body undefined = an HTML gateway page), or the normal
  // answer when no status is given. Several armed answers for one path are used in the order armed.
  let failures = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : `(outside ${PREFIX}) ${url.pathname}`;
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body: body || undefined, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.path === path && Object.entries(f.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v));
    if (failure) failure.times--;
    if (failure?.delayMs) await new Promise((r) => setTimeout(r, failure.delayMs));
    if (failure && failure.status !== undefined) {
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    if (!url.pathname.startsWith(PREFIX + "/")) return send(404, errBody("Not found"));
    if (req.method !== "GET") return send(405, errBody("Method not allowed"));

    if (path === "/auth") {
      if (req.headers["x-user"] !== API_USER || req.headers["x-auth"] !== API_KEY) return send(401, errBody("Unauthorised"));
      const token = `ss-test-token-${issued.length + 1}`;
      issued.push(token);
      valid.add(token);
      return send(200, { success: true, token });
    }

    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token || !valid.has(token) || refuseAllTokens) return send(401, errBody("Unauthorised"));

    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const paged = (items) => {
      const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
      const data = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      return { success: true, message: "", data, paging: { "total-data-count": items.length, "page-count": pages, "per-page": PER_PAGE, current: page, last: pages } };
    };
    const one = (item) => ({ success: true, message: "", data: item ? [item] : [], paging: { "total-data-count": item ? 1 : 0, "page-count": 1, "per-page": PER_PAGE, current: 1, last: 1 } });

    if (path === "/info") return send(200, one(fx.info));

    const coll = COLLECTIONS[path];
    if (coll) {
      for (const k of url.searchParams.keys()) if (k !== "page" && !(k in coll.fields)) return send(400, errBody(`bad input parameter: ${k}`));
      let items = coll.items(url.searchParams);
      for (const [k, v] of url.searchParams) {
        if (k === "page" || k === "inc-deleted") continue;
        items = items.filter((it) => matches(coll.fields[k](it), v));
      }
      return send(200, paged(items));
    }

    const m = /^\/shifts\/(\d+)$/.exec(path);
    if (m) {
      const shiftId = Number(m[1]);
      if (shiftId === EMPTY_SHIFT) return send(200, one(undefined));
      const s = fx.shifts.find((x) => x.id === shiftId);
      return s ? send(200, one(s)) : send(404, errBody("Shift not found"));
    }

    return send(404, errBody("Not found"));
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        requests,
        issued,
        /** Forget every token issued so far (a token that expired through inactivity). */
        expireTokens: () => valid.clear(),
        /** Answer 401 to every bearer token, fresh or not. */
        setRefuseAllTokens: (v) => {
          refuseAllTokens = v;
        },
        arm: ({ path, query, status, times = 1, headers, body, delayMs }) => failures.push({ path, query, status, times, headers, body, delayMs }),
        disarm: () => {
          failures = [];
        },
      }),
    ),
  );
}
