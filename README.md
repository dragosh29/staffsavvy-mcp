# StaffSavvy MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients read a StaffSavvy rota and time-and-attendance account: venues, groups (skills or roles), shifts, absences and absence types, time entries, venue events and staff names. It is built from StaffSavvy's public documentation: the OpenAPI 3.0 document "StaffSavvy REST API" 1.1.0 published on SwaggerHub (`SmartBlue/StaffSavvy`) and the support article [StaffSavvy Open API](https://support.staffsavvy.com/hc/en-gb/articles/7903636975389-StaffSavvy-Open-API).

Once it's connected, a manager can ask things like:

- "Who's working in the Main Theatre on Saturday, and in which roles?"
- "Who is off this week, and is it sickness or holiday?"
- "What events are on at the Studio in October, and how many shifts are rostered for the Macbeth performance?"
- "Show Sam Evans's clocked hours for last week and whether they've been approved."
- "Which staff records changed since the start of the month?"

This version is read-only. There are no write tools at all (see "Why there are no write tools" below), and no tool returns pay data: `/salaries` and `/wagesheets` are never called, and the pay elements that StaffSavvy includes in time-entry responses are dropped, never returned.

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `get_info` | Checks that the credentials work and returns the software and API version numbers. The API has no endpoint that says which user the credentials belong to. | `GET /auth` (first call only), `GET /info` |
| `list_venues` | Venues with the groups and shift actions allowed at each. | `GET /venues` |
| `list_groups` | Groups (skills or roles) with id and title. | `GET /groups` |
| `list_shifts` | Shifts filtered by date range (on the shift start, whole days), venue, group and venue event, with the staff member's name. | `GET /shifts`, `GET /accounts` (names) |
| `get_shift` | One shift by ID. | `GET /shifts/{shiftid}`, `GET /accounts` (name) |
| `list_absences` | Absences and holidays with the staff member's name, type, dates and hours, filtered by staff member and by date range, and optionally including deleted or rejected ones (marked `deleted_or_rejected: true`). The date range finds absences that overlap it, including ones that started up to `lookback_days` (default 31) before `from`; see below. | `GET /absences`, `GET /accounts` (names) |
| `list_absence_types` | Absence types with id, title and whether each is an absence or a holiday. | `GET /absence-types` |
| `list_time_entries` | Clocked time with staff member, start, end, venue, role, status, approval and notes, filtered by date range (on the entry start, whole days), staff member and venue event. | `GET /time-entries`, `GET /accounts` (names) |
| `list_venue_events` | Events at venues with date, start hour, venue, title and cost codes, filtered by date range and venue. | `GET /venue-events` |
| `list_accounts` | Staff accounts: name, known-as name, default venues; email, phone and legal name only on request. Filters by first name and last name (the documented equals filter), a list of IDs, or changed since a date. | `GET /accounts` |

Every list tool takes `page` (where to start) and `max_pages` (how many API pages to fetch, default 4, at most 20). StaffSavvy sets the page size; a result with `complete: false` names the `next_page` to continue from, or, when the listing cannot be continued, says why in `note`.

Date filters. Shift and time-entry starts are date-times, so `from`/`to` are sent as whole days in the date-time "between" form the docs show for `/shifts` (`start=[2026-10-03 00:00:00~2026-10-03 23:59:59]`), with `lte:2026-10-03 23:59:59` for `to` alone and the documented `gte:2026-10-03` for `from` alone. Absence starts and venue-event dates are dates, so those use the date form (`[2026-10-01:2026-10-31]`). StaffSavvy documents absence filters on the start only, so an absence that began before `from` (Monday's "who is off this week" when someone's leave started on Friday) would be missed by a plain start filter. `list_absences` therefore asks for absences starting from `lookback_days` before `from` up to `to`, drops the ones whose `period_end` is before `from`, and says in `range_note` how many it dropped. An absence that started more than `lookback_days` before `from` (long-term sickness, parental leave) is not found unless `lookback_days` is raised (at most 366). In that mode `total` is left out, because StaffSavvy's total counts the wider start range.

The staff-name lookup uses the documented "one of the options" filter on `/accounts` (`id=[101,102,103]`), 50 IDs per query, following each query's pages to the end, and can be switched off with `include_staff_names: false`. If the API user may not read accounts (a 403, or a 400), the tool still answers, with staff IDs only and a note. If the lookup is cut short (the time budget ran out, or the paging could not be followed), the note names the IDs that were not looked up; only when the lookup finished does it say that no account record was returned for an ID.

Not covered on purpose: `/salaries`, `/wagesheets/*` and the pay elements on time entries and groups (pay data, never exposed); `/reports/*` and `/report/*` (custom reports); `/my/shifts` (the API user's own shifts); the shift and time-entry histories; the `/help` endpoints; get-by-id for absences, time entries, venue events and accounts; `/shift-actions`; and every `PUT` and `PATCH`.

### Why there are no write tools

The candidates were creating an absence and accepting or rejecting a shift. Neither is documented clearly enough to ship without testing on a real account:

- `PUT /absences/new` takes everything as query parameters. It requires `repeat`, whose values are not documented; it has no parameter that says whose absence it is; `absence-type` is typed as a string although absence types have integer IDs; and the only documented answers are `201` ("absence updated") and `304`, with no body.
- `PATCH /my/shifts/{shiftid}/action` takes a required `_action` query parameter typed as an object with `accept`, `reject` and `request-cover` booleans, without saying how that object is written into the URL.

A write that sends the wrong thing to a live rota is worse than no write, so these wait for an account to test on (see "Going to production"). `STAFFSAVVY_ALLOW_WRITES` is accepted but has no effect in this version.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an API User and API Key for your StaffSavvy instance. From the support article: give the account's level the API permissions it needs (System > Levels & Permissions > Manage Permissions; a dedicated level can be set to "API only" so the account cannot log in to the main interface), then open **My Account > API Access** as that account to see the API User and API Key. The same page can restrict the key to certain IP addresses, and a replaced key keeps working for 14 days unless it is cancelled.

The base URL is your instance's address followed by `/api/v1` (the article: "The API endpoint is [your instance url]/api/v1/").

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "staffsavvy": {
      "command": "node",
      "args": ["/absolute/path/to/staffsavvy-mcp/dist/index.js"],
      "env": {
        "STAFFSAVVY_BASE_URL": "https://your-instance-address/api/v1",
        "STAFFSAVVY_API_USER": "your-api-user-id",
        "STAFFSAVVY_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add staffsavvy -e STAFFSAVVY_BASE_URL=https://your-instance-address/api/v1 -e STAFFSAVVY_API_USER=your-api-user-id -e STAFFSAVVY_API_KEY=your-api-key -- node /absolute/path/to/staffsavvy-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `STAFFSAVVY_BASE_URL` | yes | Your instance address followed by `/api/v1`. There is no default. Must be `http(s)` without a username, password or query string; the server refuses to start otherwise. The tests point it at a local mock. |
| `STAFFSAVVY_API_USER` | yes | The API User ID from My Account > API Access, sent as the `x-user` header to `GET /auth`. |
| `STAFFSAVVY_API_KEY` | yes | The API Key from the same page, sent as the `x-auth` header to `GET /auth`. |
| `STAFFSAVVY_ALLOW_WRITES` | no | Has no effect: this version has no write tools. |
| `STAFFSAVVY_TOOL_BUDGET_S` | no | Seconds a tool call may spend on retry waits and further pages (default 45; see Safety defaults). Lowered by the tests. |

## Safety defaults

- Read-only. Every tool carries the MCP `readOnlyHint` annotation (and `destructiveHint: false`), and the server only sends `GET` requests.
- The API User and API Key are sent only to `GET /auth`, as the `x-user` and `x-auth` request headers, never in a URL. The spec lists them as query parameters on `GET /auth`; the support article says they "can be passed in the GET, POST or REQUEST HEADER", and headers keep the key out of proxy and server logs. The token that comes back is sent as `Authorization: Bearer …` on every other request. It is kept until a call answers 401 (the article: tokens "expire after a period of inactivity"), then fetched again once; if the fresh token is refused too, the error says to check the API user's permissions. The API key and every token issued are replaced with `[redacted]` in any message passed on from StaffSavvy.
- Staff are identified by ID and name by default. Email addresses, phone numbers and legal names (`legal_firstname`, `middlenames`, `legal_lastname`) are only returned by `list_accounts` with `include_contact_details=true`.
- On absences, the free-text `period_Category` (the spec's example is "Sinus infection"), `period_title` and `absence_shift_excuse` can hold health or other personal information and are only returned with `include_contact_details=true`. The absence type (for example "Sickness") is returned by default, since that is what the tool is for.
- Pay data is never returned, with or without `include_contact_details`: the `pay-element` and `pay-element-value` of time entries are dropped, the group formatter reads only `id` and `title` (the spec's `Groups` component carries a pay rate), and `/salaries` and `/wagesheets` are never called.
- In free text (shift arrival information, time-entry notes, status and role titles, staff names, absence shift-repost text) email addresses, phone-number-like sequences, UK postcodes and dates of birth are replaced with `[email redacted]`, `[phone redacted]`, `[postcode redacted]` and `[date of birth redacted]` by default, and returned as stored with `include_contact_details=true`. Venue, group and absence type titles, the absence type's `type`, and venue event titles, `uuid` and cost codes are always redacted this way (those tools have no switch). Payment card numbers (13 to 19 digits that pass the Luhn check) are replaced with `[card number redacted]` whether or not contact details were requested. These are heuristics: the phone match covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), `44…` without a prefix (like the spec's own `447815000000` example), UK numbers with a bracketed area code such as `(020) 7946 0958`, UK-style `0…` numbers of 9 to 11 digits and 10-digit mobiles written without the `0` (`7700 900123`), with spaces, dots or hyphens between groups; other digit strings of those shapes are redacted too, while numeric IDs, dates and hyphenated references are left alone. Postcodes are matched in capitals only (`BH9 2SQ`). A date is treated as a date of birth only after "DOB", "date of birth" or "born"; other dates are left alone. Street addresses without a postcode are not detected. The same redaction is applied to StaffSavvy's error messages before they are passed on.
- Shift records: the spec's `Shift` schema documents only `arrival-info`. The server reads `id`, `start`, `end`, `venue`, `group`, `account`, `task` and `event` (names inferred from the documented `/shifts` filters and parameters; see Status). Any other key a shift carries is listed by name in `other_fields`, never by value.
- Input is checked before any call: IDs must be positive whole numbers (every path ID in the spec is an integer); dates must be real `YYYY-MM-DD` calendar dates (2026-02-30 is refused) with `from` not after `to`; first and last names may not contain the filter operator characters `[ ] : ~ ,`.
- StaffSavvy documents no rate limit. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice, waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). If StaffSavvy asks for a wait longer than 10 seconds, that request gives up at once and the message says how long to wait, so one request waits at most about 20 seconds. One tool call can make many requests (a token request, up to 20 list pages, the staff-name lookups), so the cap alone does not keep a call under the MCP client's default 60-second request timeout. Each tool call therefore also has a 45-second budget shared by all its requests (`STAFFSAVVY_TOOL_BUDGET_S`): a retry whose wait would end after it is not attempted; a list that runs out of budget after its first page returns the pages it has with `complete: false` and the `next_page` to continue from; a staff-name lookup that runs out returns the records by staff ID with a note; otherwise the call fails saying so. 45 seconds leaves room for the last request under the 60-second default, but a single request that is slow to answer is not cut off, so a very slow StaffSavvy can still make a call time out. The tests check the mechanism with a 3-second budget, not the 60-second outcome.
- Paging always advances from the page that was asked for. If a response's `current` is not that page (an API that ignores `page` would answer page 1 every time), the listing stops with `complete: false` and a note, and that response's records are dropped, so the same records are never returned twice.
- 502, 503 and 504 are retried the same way for `GET` only (the only method this server sends); when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML.
- A 200 whose body is not a JSON object (a proxy, a login page, a wrong base URL) and a 200 with `success: false` are reported as errors, never as empty lists. A get-by-id answered with an empty `data` array is reported as not found, like a 404.
- Rejected credentials, a wrong base URL (404 on `/auth`), a 403 and a 400 each produce a message that says what to check.

## Tests

```bash
npm test
```

The test suite runs in about 50 seconds:

1. Validates every fixture record against the schemas in StaffSavvy's published OpenAPI document (`Venue`, `AccountItem` and the `GET /accounts/{accountid}` item, `Shift`, `AbsenceItem`, `TimeEntry`, `VenueEventItem`, `Paging`, and the inline items of `GET /groups`, `/absence-types` and `/info`) with Ajv and `ajv-formats`. The document is downloaded from `api.swaggerhub.com/apis/SmartBlue/StaffSavvy/1.1.0` to `spec.json` on the first run. Because the schemas set no `additionalProperties: false`, every fixture is also walked key by key against its schema, and a key the schema does not declare fails the check, except for a listed set of inferred keys: the shift fields (the `Shift` schema declares only `arrival-info`), `id` on groups and venue events, and `approved` on the deleted absence (from the `inc-deleted` filter note). Shifts are additionally validated against a schema written for this suite from the documented `/shifts` filter and parameter names, which is an assumption, not StaffSavvy's. Negative controls check that the schemas and the key walk still reject what they should.
2. Starts a local mock of the API under `/api/v1` that serves those fixtures with the documented `page` pagination (25 per page, the spec's `per-page` example), the documented filter operators (equals, `gte:`, `lte:`, `[a:b]` and `[a~b]` between, `[a,b,c]` one of, and `inc-deleted=1`) compared strictly (a date-only bound does not reach into that day's date-times, which the suite checks, so the server's filters cannot pass on a lenient reading of the docs), `GET /auth` with `x-user`/`x-auth` headers issuing bearer tokens, 401 on bad credentials or an unknown token, 404 for unknown IDs, 400 for an unexpected query parameter, and 429, 502, 503, HTML, `success: false`, delayed and other substitute answers when armed (per path, optionally per page). The mock's `/auth`, list, get-by-id and error responses are validated against the documented response schemas. Error bodies are `{success: false, message}`: the spec documents no error body, so this shape is an assumption.
3. Starts the built server and drives it over stdio with the official MCP client: 28 checks covering tools/list and annotations (10 read-only tools, `STAFFSAVVY_ALLOW_WRITES=true` adding nothing); the token fetched once from `GET /auth` with header credentials and reused; every tool; paging to `paging.last` across pages 1, 2 and 3 with no fourth request, requests spaced at least about 250 ms apart, and `max_pages`/`page` continuation; the paging fallbacks (no paging object, `total-data-count` alone, `page-count` alone, an empty last page) and an API that ignores `page`; each filter passed through exactly (shift and time-entry `start` as `[from 00:00:00~to 23:59:59]`, `gte:from` and `lte:to 23:59:59`, absence `start` as `[from minus lookback:to]`, `venue`, `group`, `event`, `account`, `inc-deleted=1`, `date` on venue events, `firstname`, `lastname`, `id=[…]`, `_last_history_record=gte:…`); absences overlapping the range found (leave that started before `from`), ended ones dropped, and none found with `lookback_days: 0`; a deleted absence marked by its negative `approved`; staff names for 60 staff looked up in two `id=[…]` queries of 50 and 10 IDs, the first spanning two pages, and skipped when switched off; the "no account record" note for an unknown staff ID and the "cut short" note when the lookup cannot finish; contact details, legal names and absence reasons withheld by default and returned on request; redaction of emails and phone numbers in arrival information, notes, names and venue, group, absence type and venue event titles, and names returned as stored on request; one text with a postcode, a date of birth, `44…`, `7…` and `+44` phone numbers, a card number and an email injected into the free-text fields of `get_shift`, `list_venue_events` (title, `uuid`, cost codes), `list_time_entries` (notes, status, role), `list_absence_types` (title, type), `list_groups`, `list_venues`, `list_accounts` and `list_absences`, and into an error message, with none of them coming back by default, and the arrival information returned as stored on request except for the card number; pay elements and values on time entries and a pay rate on a group never returned; unread shift keys named without their values; ID, date and name validation before any call; the 404 and empty-`data` not-found messages; an expired token fetched again once and a persistently refused token reported; the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms and 2 s then 4 s without it, giving up after three attempts and at once above the 10 s cap; with a 3-second tool budget, retry waits on `/auth` and `/shifts` adding up past the budget (each well under the cap) ending the call, a rate-limited second page, or a slow first page that uses up the budget, returning the first page with `complete: false` and `next_page`, and a rate-limited name lookup returning the shifts by staff ID with a note, the rate-limited cases answering in under 3.5 s; a 502 retried and three 503s reported without HTML; non-JSON and `success: false` 200s reported as errors; an error message with an email, a phone number, the API key and the token passed on redacted and scrubbed; a 403 or a 400 on the name lookup degrading to IDs with a note; wrong credentials and a wrong base URL; start-up refused without the three variables, or with a base URL that is not `http(s)`, carries a username and password (not repeated in the message) or has a query string; and, last, that every request of the whole run (including the wrong-credential and wrong-base-URL ones) was a `GET` to a documented path, with credentials only as `/auth` headers, an issued bearer token and no `x-user` or `x-auth` header everywhere else, and no salary, wage-sheet or report endpoint called.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a StaffSavvy account (no self-service trial was found; the pricing page offers a demo). Everything below comes from the published spec and support article and should be confirmed on a real instance:

- Authentication: that `GET /auth` accepts `x-user` and `x-auth` as request headers (the article says headers, GET or POST variables work; the spec lists query parameters only), that it answers `{success, token}`, that the token is sent as `Authorization: Bearer <token>` (the spec's `bearerAuth` scheme), how long a token lives, and what an expired token returns (the article says tokens expire after inactivity; the server assumes a 401).
- Error bodies and status codes. The spec documents 401 "Unauthorised" and 400 "bad input parameter" without a body, and no 403, 404 or 429. The server reads a `message` field when there is one. How an unknown ID is reported (404, 400, or 200 with an empty `data` array) is not documented; all three are handled.
- Pagination: that `page` is 1-based, that `current` echoes the page asked for (the server stops if it does not), what `last` and `page-count` mean (the server treats `last` as the last page number, falling back to `page-count`; the spec's own example gives `total-data-count` 100, `per-page` 25, `page-count` 1 and `last` 10, which do not agree with each other), what the page size is (no page-size parameter is documented), and what a page past the end returns.
- Shift fields. The `Shift` schema documents only `arrival-info`. The fields `id`, `start`, `end`, `venue`, `group`, `account`, `task` and `event` are inferred from the `/shifts` filter examples (`group`, `start`, `venue`), the parameters of `PUT /shifts/new` and `PUT /shifts/{shiftid}` (`start`, `end`, `account`, `group`, `venue`, `task`) and the `event` query parameter; whether they come back as numbers or as objects is unknown (both are handled). A live run shows any other keys in `other_fields`.
- `GET /venues`: the spec's 200 schema has no `data` array (only `allowed-groups`, `allowed-shift-actions` and `_available_actions` at the top level); the server reads `data` like every other list. `id` is not in the `GET /groups` item schema or in `VenueEventItem`; the server reads it when present.
- Filters. The spec's `filters` parameter says to "use variable name as the parameter", so the server sends `start=[2026-10-01:2026-10-07]` rather than `filters=…`. To confirm: that bracketed and colon values are accepted URL-encoded; whether "between" includes both ends; that the date-time forms the server sends for shift and time-entry starts (`[… 00:00:00~… 23:59:59]`, `lte:… 23:59:59`) are accepted (the `~` form is documented for `/shifts`, `/absences` and `/venue-events`; the `/time-entries` docs show only the generic `[valueStart:valueEnd]`); whether an absence can be filtered on its end (none is documented, hence the `lookback_days` approach); that absences filter on `start` (the documented examples use `start` although the record field is `period_start`); that venue events filter on `date` (their filter examples are copied from absences and use `start`); that time entries filter on `start`; how `inc-deleted=1` behaves; that `_last_history_record=gte:…` works on `/accounts`; and whether `firstname`/`lastname` matching is exact and case-sensitive.
- The sort order of every list. None is documented; the server returns what the API returns.
- `approved` on absences: the `AbsenceItem` schema does not declare it; the `inc-deleted` filter note says deleted or rejected absences are "Denoted by a negative approved integer", so it is read when present. What an active absence carries there is not documented.
- The shape of `account` on absences and time entries (`Account` is `{id, access}` in the spec), and what `period_end_least` means on an absence (it is passed through as `period_end_least`).
- Date-times are documented as local time (`YYYY-MM-DD HH:MM:SS`); the server passes them through unchanged.
- What a level without a given API permission returns (403, 401 or `success: false`), and what an IP-restricted key returns from a non-allowed address.
- How many requests per second the API tolerates; nothing is documented, so the 250 ms spacing is a guess on the polite side.

## Going to production

This version runs locally over stdio, with an API User and Key that each customer creates in their own instance. For managers to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by StaffSavvy, where each instance's own login decides what a user can see, and then a listing in the Claude and ChatGPT connector directories. Write tools (booking absences, accepting or rejecting shifts, creating shifts) can follow once their parameters are confirmed on a test instance.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
