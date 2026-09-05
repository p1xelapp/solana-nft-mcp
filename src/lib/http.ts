/**
 * HTTP plumbing shared by every data source: retrying fetch, a serialized
 * rate limiter, and an in-memory stale-on-error cache.
 *
 * Design rule ("never blank"): every upstream here is assumed flaky. When a
 * refresh fails and we hold a previous good value, we serve it labeled stale
 * instead of erroring. An AI agent mid-conversation is better served by
 * 90-second-old floor prices marked `stale: true` than by an exception.
 */

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
 * Serialized rate limiter: at most one caller passes per `minIntervalMs`,
 * callers queue FIFO. Protects the free public endpoints we depend on -
 * being a polite client is what keeps a keyless server viable.
 */
export function rateLimiter(minIntervalMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let last = 0;
  return function gate() {
    chain = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    });
    return chain;
  };
}

/**
 * fetch with timeout + retries + backoff. Retries network errors, 5xx, and
 * 429 (with a longer pause). Returns the first usable Response.
 */
export async function fetchRetry(
  url: string,
  opts: RequestInit = {},
  { retries = 2, timeoutMs = 15_000, backoffMs = 800, gate }: { retries?: number; timeoutMs?: number; backoffMs?: number; gate?: () => Promise<void> } = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      // The source's rate gate runs before EVERY attempt, so a retry can never
      // land closer to the previous request than the advertised pace.
      if (gate) await gate();
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
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
async function upstreamReason(res: Response): Promise<string> {
  let body: string;
  try {
    body = (await res.text()).slice(0, 2000);
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
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 200);
  return msg;
}

/** Fetch JSON with a clean error naming the upstream when the shape is wrong. */
export async function fetchJson<T>(
  source: string,
  url: string,
  opts: RequestInit = {},
  retryOpts?: { retries?: number; timeoutMs?: number; gate?: () => Promise<void> },
): Promise<T> {
  const res = await fetchRetry(url, opts, retryOpts);
  if (!res.ok) {
    const reason = await upstreamReason(res);
    throw new HttpError(
      `${source} responded HTTP ${res.status}${reason ? ` - ${reason}` : ""}`,
      res.status,
      reason,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
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
