/**
 * HTTP plumbing shared by every data source: retrying fetch, a serialized
 * rate limiter, and an in-memory stale-on-error cache.
 *
 * Design rule ("never blank"): every upstream here is assumed flaky. When a
 * refresh fails and we hold a previous good value, we serve it labeled stale
 * instead of erroring. An AI agent mid-conversation is better served by
 * 90-second-old floor prices marked `stale: true` than by an exception.
 */

import { inspectUntrusted } from "./untrusted.js";

export interface CacheHit<T> {
  data: T;
  /** True when the value came from cache because a live refresh failed. */
  stale: boolean;
  cachedAt: string;
}

interface CacheEntry {
  data: unknown;
  cachedAt: number;
  bytes: number;
}

const store = new Map<string, CacheEntry>();
// Identical keys requested while a fetch is in flight share that one fetch,
// so ten parallel calls for the same wallet cost the upstream one request.
const inflight = new Map<string, Promise<unknown>>();
/**
 * Ceiling on DISTINCT in-flight keys.
 *
 * Coalescing only bounds work when callers ask for the same thing. A caller
 * looping over made-up slugs produces a new key every time, and every one of
 * them parks a promise here plus a waiter on the origin's rate gate - unbounded
 * memory and a queue whose tail waits minutes before its own timeout even
 * starts. Past this ceiling new distinct work is shed immediately, in the
 * upstream's own voice, rather than being queued into a backlog.
 */
const MAX_INFLIGHT_KEYS = 256;

/** Shed load rather than queue it. Worded as the upstream being busy, because that is what the caller should do about it. */
export class BusyError extends Error {
  constructor(what: string) {
    super(
      `${what} has more requests queued here than it can be asked politely to serve, so this one was refused rather than queued behind a backlog. ` +
        `Wait a few seconds and ask again, or ask for fewer things at once.`,
    );
    this.name = "BusyError";
  }
}
// Approximate byte budget. Wallet pages can be hundreds of KB each; the entry
// count alone does not bound memory.
let approxBytes = 0;
const MAX_BYTES = 24 * 1024 * 1024;
// UTF-8 bytes of the serialised value; unmeasurable values are treated as
// oversized so they are never cached.
const sizeOf = (v: unknown): number => { try { return Buffer.byteLength(JSON.stringify(v), "utf8"); } catch { return Number.POSITIVE_INFINITY; } };
// Hard ceiling so a long-lived server session can't grow unbounded. At ~2KB
// per entry this is <2MB; oldest entries evicted first (Map preserves order).
const MAX_ENTRIES = 500;

/** Store one value: remove the old entry first, refuse oversized values before evicting anything, then evict oldest until within budget. */
function commit(key: string, data: unknown) {
  const bytes = sizeOf(data);
  const prev = store.get(key);
  if (prev) {
    approxBytes -= prev.bytes;
    store.delete(key);
  }
  if (bytes > MAX_BYTES / 4) return; // uncacheable; leave the rest of the cache alone
  while (store.size > 0 && (store.size >= MAX_ENTRIES || approxBytes + bytes > MAX_BYTES)) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    approxBytes -= store.get(oldest)?.bytes ?? 0;
    store.delete(oldest);
  }
  store.set(key, { data, cachedAt: Date.now(), bytes });
  approxBytes += bytes;
  if (approxBytes < 0) approxBytes = 0;
}

/**
 * Get-or-fetch with TTL. On fetcher failure returns the stale entry (flagged)
 * instead of throwing, unless nothing was ever cached for this key.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts: { fresh?: boolean } = {},
): Promise<CacheHit<T>> {
  const hit = store.get(key);
  // `fresh` skips the TTL hit and the stale fallback, but still coalesces
  // with any in-flight fetch and still commits the answer for later callers,
  // so a verification cannot be followed by an older cached value.
  if (!opts.fresh && hit && Date.now() - hit.cachedAt < ttlMs) {
    return { data: hit.data as T, stale: false, cachedAt: new Date(hit.cachedAt).toISOString() };
  }
  try {
    // One shared promise does the fetch AND the single cache commit, so N
    // concurrent waiters cause one upstream call and one eviction pass.
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      // A new distinct key is new work. Past the ceiling it is shed, not
      // queued: a stale answer for this key is better than an unbounded
      // backlog, so an existing cached value is still served below.
      if (inflight.size >= MAX_INFLIGHT_KEYS) {
        if (hit && !opts.fresh) return { data: hit.data as T, stale: true, cachedAt: new Date(hit.cachedAt).toISOString() };
        throw new BusyError("this server's upstream queue");
      }
      p = fetcher().then((data) => {
        commit(key, data);
        return data;
      });
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    const data = await p;
    return { data, stale: false, cachedAt: new Date().toISOString() };
  } catch (err) {
    if (hit && !opts.fresh) {
      return { data: hit.data as T, stale: true, cachedAt: new Date(hit.cachedAt).toISOString() };
    }
    throw err;
  }
}

/**
 * A rate gate. Callable like a plain function; `raiseTo` lets a second module
 * sharing the same gate tighten the pace without replacing the queue.
 */
export interface Gate {
  (): Promise<void>;
  /** Slow the gate down to at least this interval. Never speeds it up. */
  raiseTo(minIntervalMs: number): void;
  /** How many callers are currently waiting their turn. */
  readonly waiting: number;
}

/**
 * Longest queue one origin's gate will hold.
 *
 * At 600ms per turn, 64 waiting callers is already a 38-second tail. Anything
 * past that would wait longer than its own timeout allows and would be
 * abandoned after the request was already spent, so it is refused up front
 * instead - the caller learns immediately rather than at the end of a queue.
 */
const MAX_GATE_QUEUE = 64;

/**
 * Serialized rate limiter: at most one caller passes per `minIntervalMs`,
 * callers queue FIFO. Protects the free public endpoints we depend on -
 * being a polite client is what keeps a keyless server viable.
 */
export function rateLimiter(minIntervalMs: number, label = "this source"): Gate {
  let chain: Promise<void> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;
  let interval = minIntervalMs;
  let waiting = 0;
  // Monotonic, never wall-clock. A clock that jumps - an NTP correction, a
  // suspended laptop, a test stubbing Date.now - would otherwise park every
  // caller behind a deadline in the moved clock's future.
  const gate = function gate() {
    // Refuse BEFORE joining the chain. Joining and then throwing would still
    // have spent a turn, and the queue would keep growing.
    if (waiting >= MAX_GATE_QUEUE) return Promise.reject(new BusyError(label));
    waiting++;
    chain = chain.then(async () => {
      const wait = last + interval - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = performance.now();
    });
    return chain.finally(() => {
      waiting--;
    });
  } as Gate;
  gate.raiseTo = (ms: number) => {
    if (Number.isFinite(ms) && ms > interval) interval = ms;
  };
  Object.defineProperty(gate, "waiting", { get: () => waiting });
  return gate;
}

const originGates = new Map<string, Gate>();

/**
 * One gate per upstream ORIGIN, shared by every module that reads it.
 *
 * A per-IP budget belongs to a host, not to a module. The plain RPC reads and
 * the DAS reads both hit api.mainnet-beta.solana.com; with a limiter each they
 * could release two requests at the same instant and spend a budget neither
 * one could see. Sharing one gate per origin makes the pace real, and the
 * strictest interval any caller asks for wins.
 */
export function originGate(url: string, minIntervalMs: number): Gate {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  const existing = originGates.get(origin);
  if (existing) {
    existing.raiseTo(minIntervalMs);
    return existing;
  }
  const gate = rateLimiter(minIntervalMs, origin);
  originGates.set(origin, gate);
  return gate;
}

/**
 * Offline mode is a hard stop, not a hint.
 *
 * The offline test suite used to rely on "nothing here should call out";
 * whether it really stayed offline depended on which environment variables
 * happened to be set. A call attempted with COLLECTOR_MCP_OFFLINE=1 now fails
 * loudly and names the host, so an accidental live read fails the run instead
 * of quietly passing against real data.
 */
export function assertOnline(url: string): void {
  if (process.env.COLLECTOR_MCP_OFFLINE !== "1") return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* not a parseable URL - report it as given */
  }
  throw new Error(`offline mode (COLLECTOR_MCP_OFFLINE=1): refused to contact ${host}`);
}

/**
 * Ceiling on any single response body.
 *
 * A hostile or broken endpoint can answer a one-line request with gigabytes.
 * `res.text()` and `res.json()` buffer the whole thing before any size check
 * downstream can run, so the process dies before it can report anything. Four
 * megabytes is an order of magnitude above the largest real page these sources
 * serve (a 500-row wallet page measures ~400 KB).
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Read a response body as text, refusing anything over the ceiling.
 *
 * Two gates, because either alone is bypassable: a declared Content-Length
 * above the ceiling is refused without reading a byte, and the stream itself
 * is counted as it arrives so a chunked response with no length, or a lying
 * one, is aborted the moment it crosses the line.
 */
export async function readBoundedText(res: Response, source = "the upstream"): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new OversizedBodyError(
      `${source} declared a ${Math.round(declared / 1_048_576)} MB response; this server refuses bodies over 4 MB and did not read it.`,
    );
  }
  const body = res.body;
  // A Response-like object with no readable stream (a stub, a polyfill, an
  // empty body) still has to be read, and the declared-length gate above has
  // already run. `.text()` is bounded afterwards so a lying length cannot slip
  // an oversized body through this path either.
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      throw new OversizedBodyError(`${source} sent more than 4 MB of body; it was discarded at the limit.`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OversizedBodyError(`${source} sent more than 4 MB of body; the read was aborted at the limit.`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body was too big to read. Distinct so a caller can name the upstream rather than blame a parse. */
export class OversizedBodyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OversizedBodyError";
  }
}

/** Parse JSON from a bounded read; the buffer is already capped by readBoundedText. */
export async function readBoundedJson<T>(res: Response, source: string): Promise<T> {
  const text = await readBoundedText(res, source);
  return JSON.parse(text) as T;
}

/**
 * fetch with timeout + retries + backoff. Retries network errors, 5xx, and
 * 429 (with a longer pause). Returns the first usable Response.
 *
 * The gate wait counts against the deadline. Waiting a minute for a turn and
 * only THEN starting a 15-second timeout is how one busy origin turned a
 * 15-second promise into a multi-minute one; the whole attempt shares one
 * budget, and a turn that arrives too late to be useful is abandoned.
 */
export async function fetchRetry(
  url: string,
  opts: RequestInit = {},
  { retries = 2, timeoutMs = 15_000, backoffMs = 800, gate, signal }: { retries?: number; timeoutMs?: number; backoffMs?: number; gate?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<Response> {
  assertOnline(url);
  if (signal?.aborted) throw new AbortedError("the caller's deadline had already passed before this request was sent");
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const attemptStarted = Date.now();
    try {
      // The source's rate gate runs before EVERY attempt, so a retry can never
      // land closer to the previous request than the advertised pace.
      if (gate) await gate();
      // A caller that gave up while we were queued must not have its request
      // sent anyway: the point of an abort is that the work stops.
      if (signal?.aborted) throw new AbortedError("the caller's deadline passed while this request waited for a turn against the source's rate limit");
      const remaining = timeoutMs - (Date.now() - attemptStarted);
      if (remaining <= 0) throw new Error(`waited longer than ${Math.round(timeoutMs / 1000)}s for a turn against this source's rate limit; the request was abandoned rather than sent late`);
      const res = await fetch(url, { ...opts, signal: combineSignals(remaining, signal) });
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const wait = retryAfterMs(res.headers.get("retry-after"));
        // A server asking for more than 30s is telling us to go away, not to
        // retry: stop rather than hammer it early.
        if (wait > 30_000) throw new StopError(`HTTP 429 (rate limited; server asked for a ${Math.round(wait / 1000)}s pause)`);
        throw new RetryableError(`HTTP 429 (rate limited)`, true, wait);
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new RetryableError(`HTTP ${res.status}`, false, 0);
      }
      return res;
    } catch (e) {
      if (e instanceof StopError) throw new Error(e.message);
      // Shed load and oversized bodies are both final answers: retrying adds
      // another queued caller, or downloads the same gigabyte again.
      if (e instanceof BusyError || e instanceof OversizedBodyError || e instanceof AbortedError) throw e;
      // An abort is the caller's decision, not a flaky source: retrying it
      // spends the source's budget on work nobody is waiting for.
      if (signal?.aborted) throw new AbortedError("the caller's deadline passed while this request was in flight");
      lastErr = e;
      if (i < retries) {
        const slow = e instanceof RetryableError && e.slow;
        const hinted = e instanceof RetryableError ? e.retryAfterMs : 0;
        await new Promise((r) => setTimeout(r, Math.max(hinted, backoffMs * (i + 1) * (slow ? 3 : 1))));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Retry-After is either delta-seconds or an HTTP-date; both are honoured. */
function retryAfterMs(h: string | null): number {
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/** Thrown to leave the retry loop immediately. */
class StopError extends Error {}

/** The caller's own deadline passed. Not an upstream failure and never retried. */
export class AbortedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AbortedError";
  }
}

/**
 * One signal that fires on either the per-attempt timeout or the caller's own
 * deadline.
 *
 * `AbortSignal.any` would do this in one line but landed in Node 20.3, and
 * this package supports 18.17 - so the two are combined by hand.
 */
function combineSignals(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (caller.aborted || timeout.aborted) stop();
  else {
    caller.addEventListener("abort", stop, { once: true });
    timeout.addEventListener("abort", stop, { once: true });
  }
  return controller.signal;
}

class RetryableError extends Error {
  constructor(msg: string, public slow: boolean, public retryAfterMs: number) {
    super(msg);
  }
}

/**
 * Pull the human-readable reason out of an upstream error body.
 *
 * A bare "HTTP 400" tells an AI agent nothing it can act on, and the agent
 * relays that dead end to the user. Upstreams almost always explain
 * themselves in the body ("Blocked NFT owner: ...", "collection not found"),
 * so we surface that instead. Redacted and truncated: an error body is
 * attacker-influenced text that ends up in logs and model context.
 */
async function upstreamReason(res: Response, source: string): Promise<string> {
  let body: string;
  try {
    body = (await readBoundedText(res, source)).slice(0, 2000);
  } catch {
    return "";
  }
  let msg = body;
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const field = j.message ?? j.error ?? j.detail ?? j.errors;
    if (field) msg = typeof field === "string" ? field : JSON.stringify(field);
  } catch {
    /* not JSON - fall through to the raw snippet */
  }
  // Never let a key we sent bounce back into an error string.
  const key = process.env.OPENSEA_API_KEY;
  if (key && key.length > 6) msg = msg.split(key).join("[REDACTED]");
  // An error body is attacker-authored text that ends up in model context and
  // in logs: it goes through the same neutralising pass as any minted name,
  // and is capped short enough that it cannot crowd out the real answer.
  return inspectUntrusted(msg.replace(/\s+/g, " ").trim().slice(0, 300)).value;
}

/** Fetch JSON with a clean error naming the upstream when the shape is wrong. */
export async function fetchJson<T>(
  source: string,
  url: string,
  opts: RequestInit = {},
  retryOpts?: { retries?: number; timeoutMs?: number; gate?: () => Promise<void>; signal?: AbortSignal },
): Promise<T> {
  const res = await fetchRetry(url, opts, retryOpts);
  if (!res.ok) {
    const reason = await upstreamReason(res, source);
    throw new HttpError(
      `${source} responded HTTP ${res.status}${reason ? ` - ${reason}` : ""}`,
      res.status,
      reason,
    );
  }
  try {
    return await readBoundedJson<T>(res, source);
  } catch (e) {
    if (e instanceof OversizedBodyError) throw e;
    throw new Error(`${source} returned non-JSON (upstream outage or shape change)`);
  }
}

/** Carries the upstream status + reason so callers can special-case them. */
export class HttpError extends Error {
  constructor(msg: string, public status: number, public reason: string) {
    super(msg);
    this.name = "HttpError";
  }
}
