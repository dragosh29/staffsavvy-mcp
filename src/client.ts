// Minimal StaffSavvy REST API client used by the MCP tools.
// Docs: https://support.staffsavvy.com/hc/en-gb/articles/7903636975389-StaffSavvy-Open-API
// Spec: https://api.swaggerhub.com/apis/SmartBlue/StaffSavvy/1.1.0 (OpenAPI 3.0.0, "StaffSavvy REST API" 1.1.0)
import { AsyncLocalStorage } from "node:async_hooks";
import { redactContacts } from "./format.js";

export class StaffSavvyError extends Error {
  /** outOfTime: the request gave up because a retry wait would have passed the tool call's time budget. */
  constructor(message: string, public readonly status?: number, public readonly outOfTime = false) {
    super(message);
    this.name = "StaffSavvyError";
  }
}

// Spec Paging: "Provides current pagination information. To set the desired page to view, use the
// page paramater in the request. E.g. page=2".
export interface Paging {
  "total-data-count"?: number;
  "page-count"?: number;
  "per-page"?: number;
  current?: number;
  last?: number;
}

// Every documented 200 body is {success, message, data[], paging}.
export interface Envelope<T> {
  success?: boolean;
  message?: string;
  data?: T[];
  paging?: Paging;
  token?: string;
}

// A 429 means the request was not processed, so it is safe to repeat. A 502/503/504 from a gateway does
// not prove the upstream did not process the request, so those are only retried for GET. This server
// only ever sends GET requests (GET /auth included), so in practice every request is retryable; the
// rule is kept so that a future write could not be repeated after a gateway error.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After, per request: a longer Retry-After makes the request
// give up at once with the wait time in the message. With at most two waits, one request spends at most
// about 20 s waiting. A tool call makes several requests (a token request, up to 20 list pages, the
// staff-name lookups), so this cap alone does not keep a call under the MCP SDK's default 60 s request
// timeout (DEFAULT_REQUEST_TIMEOUT_MSEC); the per-call budget below is what does that.
export const MAX_RETRY_AFTER_S = 10;
// Every tool call runs with a time budget shared by all its requests (index.ts, withBudget). A retry
// whose wait would end after the budget is not attempted, and list() fetches no further page once the
// budget is spent, returning what it has with complete: false. 45 s leaves room for the last request
// under the 60 s default. A single request that is slow to answer is not cut off.
export const DEFAULT_CALL_BUDGET_S = 45;
const callDeadline = new AsyncLocalStorage<number>();
/** Run fn with a deadline of budgetMs from now; retry waits and paging in any request it makes respect it. */
export function withBudget<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  return callDeadline.run(Date.now() + budgetMs, fn);
}
/** Milliseconds left in the current tool call's budget (negative once spent), or undefined outside one. */
export function budgetLeftMs(): number | undefined {
  const d = callDeadline.getStore();
  return d === undefined ? undefined : d - Date.now();
}
// Values shorter than this are not scrubbed from passed-on text: they would hit ordinary words.
const MIN_SCRUB_LENGTH = 6;

export type QueryValue = string | number | undefined;

export interface ListResult<T = any> {
  items: T[];
  complete: boolean;
  /** The page to continue from; absent when the listing cannot be continued (see note). */
  next_page?: number;
  total?: number;
  pages_fetched: number;
  /** Why the listing stopped before the end: the time budget ran out, or the API's paging could not be followed. */
  stopped?: "time" | "paging";
  note?: string;
}

export class StaffSavvyClient {
  private readonly baseUrl: string;
  private token?: string;
  // One token request shared by every caller that needs a token before it settles.
  private tokenInFlight?: Promise<string>;
  private readonly secrets = new Set<string>();
  // StaffSavvy documents no rate limit. Space requests at about four per second so a tool call that
  // pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(private readonly apiUser: string, private readonly apiKey: string, baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.secrets.add(apiKey);
  }

  get base(): string {
    return this.baseUrl;
  }

  /** Replace the API key and every token issued so far with "[redacted]" in text that is passed on. */
  private scrub(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    let out = text;
    for (const s of this.secrets) if (s.length >= MIN_SCRUB_LENGTH) out = out.split(s).join("[redacted]");
    return out;
  }

  /** Text from an error body, safe to show: contact details redacted, secrets scrubbed. */
  private safeDetail(json: any): string | undefined {
    return redactContacts(this.scrub(describeError(json)), false)?.slice(0, 300);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** One HTTP exchange with the throttle and the 429 / gateway retry policy; no auth handling. */
  private async send(method: string, path: string, headers: Record<string, string>, query: Record<string, QueryValue> = {}): Promise<{ status: number; text: string; json: any; contentType: string }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers });
      } catch (err) {
        throw new StaffSavvyError(`Could not reach StaffSavvy at ${this.baseUrl}: ${(err as Error).message}. Check STAFFSAVVY_BASE_URL and the network.`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new StaffSavvyError(`StaffSavvy asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        const left = budgetLeftMs();
        if (left !== undefined && delay > left) {
          throw new StaffSavvyError(
            `StaffSavvy answered ${method} ${path} with HTTP ${res.status}, and waiting ${Math.ceil(delay / 1000)} more seconds to retry would take this tool call past its time budget (an MCP client gives up after 60 seconds by default). Try again in a minute.`,
            res.status,
            true,
          );
        }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      return { status: res.status, text, json: text ? safeJson(text) : undefined, contentType: res.headers.get("content-type") ?? "unknown" };
    }
  }

  /**
   * Support article, "Using the API": "To generate a token, you need to request it via the /auth
   * endpoint passing in the following variables. They can be passed in the GET, POST or REQUEST
   * HEADER. x-user: your API User ID, x-auth: your API Key". The spec documents GET /auth with x-user
   * and x-auth as query parameters; this server sends them as request headers so the key never ends up
   * in a URL (and so in proxy or server logs). The answer is {success, token}. "The tokens will expire
   * after a period of inactivity": no lifetime is documented, so the token is kept until an API call
   * answers 401 and then fetched afresh once.
   */
  private getToken(force = false): Promise<string> {
    if (!force && this.token) return Promise.resolve(this.token);
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.fetchToken().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    this.token = undefined;
    const { status, json, text, contentType } = await this.send("GET", "/auth", { "x-user": this.apiUser, "x-auth": this.apiKey, Accept: "application/json" });
    const detail = this.safeDetail(json);
    const suffix = detail ? " " + detail : "";
    if (status === 401 || status === 403) {
      throw new StaffSavvyError(
        `StaffSavvy rejected the API User and API Key at ${this.baseUrl}/auth (${status}). Check STAFFSAVVY_API_USER and STAFFSAVVY_API_KEY: they are the API User ID and API Key shown under My Account > API Access in StaffSavvy (not your login). A replaced key stops working 14 days after replacement or when cancelled, and the key may be restricted to certain IP addresses on the same page.${suffix}`,
        status,
      );
    }
    if (status === 404) {
      throw new StaffSavvyError(`No StaffSavvy API was found at ${this.baseUrl}/auth (404). Check STAFFSAVVY_BASE_URL: it must be your StaffSavvy instance URL followed by /api/v1.${suffix}`, status);
    }
    if (status === 429) throw new StaffSavvyError(`StaffSavvy rate-limited the token request (429; no limit is documented). Wait a minute and try again.${suffix}`, status);
    if (status < 200 || status >= 300) {
      const how = RETRY_GET_ONLY.has(status) ? ` ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.` : ". Check STAFFSAVVY_BASE_URL and try again.";
      throw new StaffSavvyError(`StaffSavvy returned ${status} for GET /auth${how}${suffix}`, status);
    }
    const token = json && typeof json === "object" && typeof json.token === "string" && json.token ? (json.token as string) : undefined;
    if (!token || json.success === false) {
      // Described, never quoted: the body might hold a token under a key this client does not read.
      const shape = json && typeof json === "object" ? `JSON with keys ${Object.keys(json).join(", ") || "(none)"}` : `a ${contentType} body of ${text.length} bytes`;
      throw new StaffSavvyError(`StaffSavvy answered GET /auth with ${status} but no token (${shape}). Check STAFFSAVVY_BASE_URL (it must end in /api/v1), STAFFSAVVY_API_USER and STAFFSAVVY_API_KEY.${suffix}`, status);
    }
    this.secrets.add(token);
    this.token = token;
    return token;
  }

  /** GET an API path with the bearer token; on a 401 the token is fetched afresh and the call repeated once. */
  async get<T = any>(path: string, query: Record<string, QueryValue> = {}): Promise<Envelope<T>> {
    for (let auth = 0; ; auth++) {
      const token = await this.getToken(auth > 0);
      const { status, json, text } = await this.send("GET", path, { Authorization: `Bearer ${token}`, Accept: "application/json" }, query);
      if (status === 401 && auth === 0) continue;

      if (status >= 200 && status < 300) {
        // "All responses will be in a JSON format". A 200 with HTML (a proxy, a login page, a wrong
        // base URL) must not be mistaken for an empty list.
        if (!json || typeof json !== "object" || Array.isArray(json)) {
          throw new StaffSavvyError(
            `StaffSavvy returned ${status} for GET ${path} but the body was not a JSON object (starts with: ${JSON.stringify((redactContacts(this.scrub(text), false) ?? "").slice(0, 60))}). Check STAFFSAVVY_BASE_URL (your instance URL followed by /api/v1) and whether a proxy or login page is in the way.`,
            status,
          );
        }
        if (json.success === false) {
          const detail = this.safeDetail(json);
          throw new StaffSavvyError(`StaffSavvy reported a failure for GET ${path} (success: false).${detail ? " " + detail : ""}`, status);
        }
        return json as Envelope<T>;
      }

      const detail = this.safeDetail(json);
      const suffix = detail ? " " + detail : "";
      if (status === 401) {
        throw new StaffSavvyError(
          `StaffSavvy rejected the bearer token (401) for GET ${path}, even after fetching a fresh one. Check that the API user still has API permission (System > Levels & Permissions > Manage Permissions) and that STAFFSAVVY_API_USER / STAFFSAVVY_API_KEY belong to this instance.${suffix}`,
          401,
        );
      }
      if (status === 403) throw new StaffSavvyError(`StaffSavvy refused GET ${path} (403). The API user's level may not include this API permission (System > Levels & Permissions > Manage Permissions).${suffix}`, 403);
      if (status === 404) throw new StaffSavvyError(`Not found: ${path}. Check the ID; the record does not exist or is not visible to this API user.${suffix}`, 404);
      if (status === 400) throw new StaffSavvyError(`StaffSavvy rejected GET ${path} (400 bad input parameter).${suffix}`, 400);
      if (status === 429) throw new StaffSavvyError(`StaffSavvy rate limit reached (429; no limit is documented). Wait a minute and try again.${suffix}`, 429);
      if (RETRY_GET_ONLY.has(status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. Gateway bodies are usually HTML, so only a JSON
        // message is passed on (safeDetail reads JSON only).
        throw new StaffSavvyError(`StaffSavvy returned ${status} for GET ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${suffix}`, status);
      }
      throw new StaffSavvyError(`StaffSavvy returned ${status} for GET ${path}.${suffix}`, status);
    }
  }

  /** GET one record by ID. Every documented get-by-id answers {data: [record]}; an empty data array is reported as not found. */
  async getOne<T = any>(path: string): Promise<T> {
    const res = await this.get<T>(path);
    const item = Array.isArray(res.data) ? res.data[0] : undefined;
    if (item === undefined || item === null) throw new StaffSavvyError(`Not found: ${path}. StaffSavvy answered with no record; check the ID.`, 404);
    return item;
  }

  /**
   * Fetch a paged collection (spec Paging: request `page=N`; the response carries total-data-count,
   * page-count, per-page, current and last). Starts at `page` and fetches up to `maxPages` pages,
   * always advancing from the page it asked for. The end is reached when the page asked for is at least
   * `last` (falling back to page-count when `last` is absent), when total-data-count items have been
   * collected from page 1, or on an empty page. A response without any paging information is treated as
   * a single, complete page. A response whose `current` is not the page asked for (an API that ignores
   * `page`) stops the listing with complete: false and a note, and that page's records are dropped, so
   * the same records are never returned twice. Once the tool call's time budget is spent, no further page
   * is fetched and the result says which page to continue from.
   */
  async list<T = any>(path: string, { query = {} as Record<string, QueryValue>, page = 1, maxPages = 4 } = {}): Promise<ListResult<T>> {
    const items: T[] = [];
    let total: number | undefined;
    let current = page;
    const outOfTime = (n: number): ListResult<T> => ({
      items,
      complete: false,
      next_page: current,
      total,
      pages_fetched: n,
      stopped: "time",
      note: `Stopped after ${n} page${n === 1 ? "" : "s"} to keep this tool call within its time budget (StaffSavvy was slow or rate-limiting). Call again with page ${current} to continue.`,
    });
    for (let n = 0; n < maxPages; n++) {
      if (n > 0 && (budgetLeftMs() ?? 1) <= 0) return outOfTime(n);
      let res: Envelope<T>;
      try {
        res = await this.get<T>(path, { ...query, page: current });
      } catch (err) {
        if (n > 0 && err instanceof StaffSavvyError && err.outOfTime) return outOfTime(n);
        throw err;
      }
      const data = Array.isArray(res.data) ? res.data : [];
      const p = res.paging && typeof res.paging === "object" ? res.paging : undefined;
      const cur = Number(p?.current);
      if (Number.isFinite(cur) && cur > 0 && cur !== current) {
        return {
          items,
          complete: false,
          total,
          pages_fetched: n + 1,
          stopped: "paging",
          note: `StaffSavvy answered a request for page ${current} of ${path} with page ${cur}, so its paging cannot be followed; ${items.length} record${items.length === 1 ? "" : "s"} from earlier pages ${items.length === 1 ? "is" : "are"} returned and that page's records were dropped. Narrow the filters to see the rest.`,
        };
      }
      items.push(...data);
      const t = Number(p?.["total-data-count"]);
      if (Number.isFinite(t) && t >= 0) total = t;
      const lastRaw = Number(p?.last ?? p?.["page-count"]);
      const last = Number.isFinite(lastRaw) && lastRaw > 0 ? lastRaw : undefined;
      const done =
        !p ||
        data.length === 0 ||
        (last !== undefined && current >= last) ||
        (last === undefined && total !== undefined && page === 1 && items.length >= total);
      if (done) return { items, complete: true, total, pages_fetched: n + 1 };
      current += 1;
    }
    return { items, complete: false, next_page: current, total, pages_fetched: maxPages };
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The spec documents no error body (401 "Unauthorised", 400 "bad input parameter", descriptions only).
// The support article says errors are JSON "with standardised formatting" and "further details of the
// error may be included"; every documented body carries `message`, so that is what is read.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const m = typeof json.message === "string" ? json.message.trim() : "";
  return m || undefined;
}
