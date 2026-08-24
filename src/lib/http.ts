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
}

const store = new Map<string, CacheEntry>();
// Hard ceiling so a long-lived server session can't grow unbounded. At ~2KB
// per entry this is <2MB; oldest entries evicted first (Map preserves order).
const MAX_ENTRIES = 500;

/**
 * Get-or-fetch with TTL. On fetcher failure returns the stale entry (flagged)
 * instead of throwing, unless nothing was ever cached for this key.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<CacheHit<T>> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.cachedAt < ttlMs) {
    return { data: hit.data as T, stale: false, cachedAt: new Date(hit.cachedAt).toISOString() };
  }
  try {
    const data = await fetcher();
    if (store.size >= MAX_ENTRIES && !store.has(key)) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { data, cachedAt: Date.now() });
    return { data, stale: false, cachedAt: new Date().toISOString() };
  } catch (err) {
    if (hit) {
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
  { retries = 2, timeoutMs = 15_000, backoffMs = 800 } = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) throw new RetryableError(`HTTP 429 (rate limited)`, true);
      if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`, false);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const slow = e instanceof RetryableError && e.slow;
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1) * (slow ? 3 : 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

class RetryableError extends Error {
  constructor(msg: string, public slow: boolean) {
    super(msg);
  }
}

/** Fetch JSON with a clean error naming the upstream when the shape is wrong. */
export async function fetchJson<T>(
  source: string,
  url: string,
  opts: RequestInit = {},
  retryOpts?: { retries?: number; timeoutMs?: number },
): Promise<T> {
  const res = await fetchRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`${source} responded HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${source} returned non-JSON (upstream outage or shape change)`);
  }
}
