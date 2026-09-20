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
import { runWithSignal, withAmbient } from "./context.js";
import { redactSecrets } from "./secrets.js";

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
/**
 * One shared read in progress.
 *
 * `waiters` is how many callers are still waiting on it. The producer is
 * abandoned only when that reaches zero: a fetch nobody will read is spent
 * budget, but a fetch one caller left and another still needs is not the
 * leaver's to cancel.
 */
interface Inflight {
  /** When the producer's answer was observed, set once at commit time. */
  observedAt?: number;
  promise: Promise<unknown>;
  producer: AbortController;
  waiters: number;
}
// Identical keys requested while a fetch is in flight share that one fetch,
// so ten parallel calls for the same wallet cost the upstream one request.
const inflight = new Map<string, Inflight>();
/** How many distinct keys are in flight per origin, so one busy source cannot spend another's headroom. */
const inflightPerOrigin = new Map<string, number>();
/**
 * Ceiling on DISTINCT in-flight keys, PER ORIGIN.
 *
 * Coalescing only bounds work when callers ask for the same thing. A caller
 * looping over made-up slugs produces a new key every time, and every one of
 * them parks a promise here plus a waiter on the origin's rate gate - unbounded
 * memory and a queue whose tail waits minutes before its own timeout even
 * starts. Past this ceiling new distinct work is shed immediately, in the
 * upstream's own voice, rather than being queued into a backlog.
 *
 * The ceiling is per origin because the budget it protects is per origin: a
 * global one let slow work against one source refuse a healthy source that had
 * nothing queued at all. It matches MAX_GATE_QUEUE, which is the real limit -
 * a 65th distinct key for one origin would be refused by that gate anyway.
 */
const MAX_INFLIGHT_PER_ORIGIN = 64;
/** Emergency ceiling across every origin, so an unbounded set of sources cannot grow the map without limit. */
const MAX_INFLIGHT_TOTAL = 512;

/** Which budget a cache key spends. Keys are `source:what:params`, so the first segment IS the source. */
const originOf = (key: string, given?: string): string => given ?? key.split(":")[0] ?? key;

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
function commit(key: string, data: unknown, at = Date.now()) {
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
  store.set(key, { data, cachedAt: at, bytes });
  approxBytes += bytes;
  if (approxBytes < 0) approxBytes = 0;
}

/**
 * Get-or-fetch with TTL. On fetcher failure returns the stale entry (flagged)
 * instead of throwing, unless nothing was ever cached for this key.
 *
 * Two separate lifetimes, and conflating them was a real bug. The PRODUCER -
 * the one fetch every waiter shares - runs on a controller of its own and is
 * never cancelled by any individual caller: a status probe with a 12 s deadline
 * used to abort the shared stats fetch that an ordinary floor request had
 * joined, so an unrelated caller lost an answer it was still waiting for. Each
 * WAITER instead races the shared promise against its own signal, so a caller's
 * deadline ends that caller's wait and nobody else's.
 *
 * The producer is not immortal either. Measured over real stdio: a
 * client cancelled a sales read after the first page, and the producer went on
 * to fetch offsets 500 and 1000 with nobody waiting. So the producer runs
 * under its own signal as the AMBIENT deadline for everything it awaits (see
 * lib/context.ts), and that signal fires when the last waiter leaves - never
 * while somebody still needs the answer.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: { fresh?: boolean; signal?: AbortSignal; origin?: string } = {},
): Promise<CacheHit<T>> {
  const hit = store.get(key);
  // `fresh` skips the TTL hit and the stale fallback, but still coalesces
  // with any in-flight fetch and still commits the answer for later callers,
  // so a verification cannot be followed by an older cached value.
  if (!opts.fresh && hit && Date.now() - hit.cachedAt < ttlMs) {
    return { data: hit.data as T, stale: false, cachedAt: new Date(hit.cachedAt).toISOString() };
  }
  // This caller's deadline: whatever was passed explicitly, plus the request
  // it is running inside. A tool handler's cancellation has to end the wait
  // here even when the source never threaded a signal through.
  const waiterSignal = withAmbient(opts.signal);
  let entry: Inflight | undefined;
  let left = false;
  /** This waiter is gone. If it was the last, nobody will read the producer's answer. */
  const leave = () => {
    if (left || !entry) return;
    left = true;
    entry.waiters--;
    if (entry.waiters <= 0 && inflight.get(key) === entry) entry.producer.abort();
  };
  try {
    // One shared promise does the fetch AND the single cache commit, so N
    // concurrent waiters cause one upstream call and one eviction pass.
    const origin = originOf(key, opts.origin);
    entry = inflight.get(key);
    // A producer whose last waiter has already left is on its way out, not
    // work to join: a fresh caller that joined one inherited its AbortedError
    // and never got a fetch of its own. It is replaced;
    // its own cleanup below only deletes the entry it created, so the
    // replacement survives the old one finally settling.
    if (entry && entry.producer.signal.aborted) entry = undefined;
    if (!entry) {
      // A new distinct key is new work. Past the ceiling it is shed, not
      // queued: a stale answer for this key is better than an unbounded
      // backlog, so an existing cached value is still served below.
      const forOrigin = inflightPerOrigin.get(origin) ?? 0;
      if (forOrigin >= MAX_INFLIGHT_PER_ORIGIN || inflight.size >= MAX_INFLIGHT_TOTAL) {
        if (hit && !opts.fresh) return { data: hit.data as T, stale: true, cachedAt: new Date(hit.cachedAt).toISOString() };
        throw new BusyError(forOrigin >= MAX_INFLIGHT_PER_ORIGIN ? `this server's queue for ${origin}` : "this server's upstream queue");
      }
      // The producer's own controller. Nothing in it is tied to whoever asked
      // first, so one caller giving up cannot cancel a fetch others joined.
      // It is also the ambient deadline inside the fetcher, so the caller's
      // own signal - which may fire long before the other waiters' - is not
      // what the fetcher's pages and gate waits see.
      const producer = new AbortController();
      // The commit belongs to the producer that still OWNS the key. One whose
      // last waiter left was replaced (below); if it goes on to settle after
      // its replacement, its older answer must not overwrite the newer one.
  // Reproduced: an abandoned owner read at slot 100 replaced
      // slot 200 in the cache. The identity check on cleanup was never enough.
      // `entry` is assigned just below and read here only after the fetch
      // settles, so the closure sees this call's own entry.
      const promise = runWithSignal(producer.signal, () => fetcher(producer.signal)).then((data) => {
        // One observation, one timestamp. The first waiter used to stamp its
        // own return time, so the same data carried two cachedAt values ten
  // milliseconds apart.
        const at = Date.now();
        if (entry) entry.observedAt = at;
        if (!producer.signal.aborted && inflight.get(key) === entry) commit(key, data, at);
        return data;
      });
      entry = { promise, producer, waiters: 0 };
      inflight.set(key, entry);
      inflightPerOrigin.set(origin, forOrigin + 1);
      const mine = entry;
      promise.finally(() => {
        if (inflight.get(key) === mine) inflight.delete(key);
        const remaining = (inflightPerOrigin.get(origin) ?? 1) - 1;
        if (remaining > 0) inflightPerOrigin.set(origin, remaining);
        else inflightPerOrigin.delete(origin);
      }).catch(() => undefined);
    }
    entry.waiters++;
    const data = await raceSignal(entry.promise as Promise<T>, waiterSignal, "the caller's deadline passed while waiting for a shared read of this data");
    return { data, stale: false, cachedAt: new Date(entry.observedAt ?? Date.now()).toISOString() };
  } catch (err) {
    // An abort is the caller leaving, not the upstream failing: it must not be
    // dressed up as a stale answer from a source that is perfectly healthy.
    if (err instanceof AbortedError) {
      leave();
      throw err;
    }
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
/**
 * Wait for a promise, but only for as long as this caller is still waiting.
 *
 * The underlying work is NOT cancelled - it may be shared with other callers,
 * or be a turn in a queue that still has to advance. What ends is this
 * caller's wait, which is the whole meaning of a deadline.
 */
export function raceSignal<T>(p: Promise<T>, signal: AbortSignal | undefined, why: string): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    // Nobody is left to read the outcome; swallow it so it cannot surface as
    // an unhandled rejection.
    p.catch(() => undefined);
    return Promise.reject(new AbortedError(why));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError(why));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface GateOptions {
  /**
   * Work nobody is waiting on, which yields its turn to work somebody is.
   *
   * The only user of this is the background directory refresh. Everything else
   * is a question a person asked, and defaults to the front.
   */
  background?: boolean;
}

export interface Gate {
  /** Wait for a turn. A caller's signal ends ITS wait; the queue itself still advances. */
  (signal?: AbortSignal, opts?: GateOptions): Promise<void>;
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
  let interval = minIntervalMs;

  /**
   * One waiter for a turn.
   *
   * The queue used to be a promise chain, which made it strictly FIFO. That
   * was fine until the background directory refresh started putting 61 pages
   * into it at once: a question a person had just asked then queued behind all
  * of them. Measured at a 200 ms interval, a foreground call
   * waited 4.1 s behind twenty background turns; at the real 600 ms pace and
   * 61 pages that is about 36 seconds of somebody staring at a spinner.
   *
   * So the order changed and the PACE did not. At most one turn is still
   * released per `interval`, which is the part that keeps a keyless server
   * welcome; what changed is only who gets the next one.
   */
  interface Waiter {
    release: () => void;
    background: boolean;
    queuedAt: number;
    /** A caller who gave up must not spend a turn the others are waiting for. */
    gone: () => boolean;
  }

  const queue: Waiter[] = [];
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * How long background work will yield before it insists.
   *
   * Without this, a session asking questions without pause could hold the
   * refresh off forever, and the directory it maintains is exactly what stops
   * us answering from a stale snapshot. Yielding is politeness, not surrender.
   */
  const BACKGROUND_PATIENCE_MS = 20_000;

  /** Which waiter gets the next turn. */
  function pick(): Waiter | undefined {
    // Anyone who gave up leaves first, wherever they are in the queue: a dead
    // waiter at the head used to make everybody behind it wait for a request
    // that was never going to be sent.
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.gone()) queue.splice(i, 1);
    if (queue.length === 0) return undefined;
    const now = performance.now();
    const bg = queue.findIndex((w) => w.background);
    // Background that has waited too long stops yielding.
    if (bg >= 0 && now - queue[bg]!.queuedAt >= BACKGROUND_PATIENCE_MS) return queue.splice(bg, 1)[0];
    const fg = queue.findIndex((w) => !w.background);
    if (fg >= 0) return queue.splice(fg, 1)[0];
    return bg >= 0 ? queue.splice(bg, 1)[0] : undefined;
  }

  function pump(): void {
    if (timer !== null || queue.length === 0) return;
    // Monotonic, never wall-clock. A clock that jumps - an NTP correction, a
    // suspended laptop, a test stubbing Date.now - would otherwise park every
    // caller behind a deadline in the moved clock's future.
    const wait = last + interval - performance.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      // Deliberately NOT unref'd. Somebody is awaiting this turn, so it is
      // work: unref'ing let Node exit before granting it, and the caller's
      // promise simply never settled. A timer is only ever scheduled while the
      // queue has someone in it, so this cannot hold the process open idle.
      return;
    }
    const next = pick();
    if (!next) return;
    last = performance.now();
    next.release();
    // Schedule whoever is behind them, one interval from now.
    pump();
  }

  const gate = function gate(signal?: AbortSignal, opts?: GateOptions) {
    // Refuse BEFORE joining the queue. Joining and then throwing would still
    // have spent a turn, and the queue would keep growing.
    if (signal?.aborted) return Promise.reject(new AbortedError(`the caller's deadline had already passed before it queued for a turn against ${label}'s rate limit`));
    if (queue.length >= MAX_GATE_QUEUE) return Promise.reject(new BusyError(label));
    const turn = new Promise<void>((resolve) => {
      queue.push({
        release: resolve,
        background: opts?.background === true,
        queuedAt: performance.now(),
        gone: () => signal?.aborted === true,
      });
    });
    pump();
    // The queue still advances at its own pace - the turn is what keeps this
    // source's budget honest. What the signal ends is THIS caller's wait, so a
    // 25 s deadline is not silently extended by a 38 s queue tail.
    // Deliberately does not say WHOSE deadline. The signal handed in here can
    // be the caller's, or this attempt's own timeout, and naming the wrong one
    // sends a reader looking in the wrong place.
    return raceSignal(turn, signal, `a deadline passed while waiting for a turn against ${label}'s rate limit`);
  } as Gate;
  gate.raiseTo = (ms: number) => {
    if (Number.isFinite(ms) && ms > interval) interval = ms;
  };
  Object.defineProperty(gate, "waiting", { get: () => queue.length });
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
  { retries = 2, timeoutMs = 15_000, backoffMs = 800, gate, signal, background = false }: { retries?: number; timeoutMs?: number; backoffMs?: number; gate?: (signal?: AbortSignal, opts?: GateOptions) => Promise<void>; signal?: AbortSignal; background?: boolean } = {},
): Promise<Response> {
  assertOnline(url);
  // The request this fetch is serving may have been cancelled by the client
  // without any source threading that signal here. The ambient one is joined
  // to whatever was passed, so a cancelled question stops at the next gate
  // wait, retry sleep or fetch whichever module is doing the asking.
  signal = withAmbient(signal);
  if (signal?.aborted) throw new AbortedError("the caller's deadline had already passed before this request was sent");
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    const attemptStarted = Date.now();
    try {
      // The source's rate gate runs before EVERY attempt, so a retry can never
      // land closer to the previous request than the advertised pace.
      //
      // The ATTEMPT's own deadline goes into the gate, not just the caller's.
      // Passing only the caller's signal meant timeoutMs never bounded the
      // queue wait: a 10 ms timeout against a 100 ms gate
      // took ~103 ms to reject, because the clock was only consulted after the
      // queue tail had already been waited out. A deadline checked after the
      // waiting is not a deadline.
      const attemptDeadline = combineSignals(timeoutMs, signal);
      if (gate) await gate(attemptDeadline, { background });
      // Which deadline passed changes what the caller should do, so the two
      // are reported differently: the caller giving up is not the same event as
      // this attempt running out of its own budget.
      if (signal?.aborted) throw new AbortedError("the caller's deadline passed while this request waited for a turn against the source's rate limit");
      const remaining = timeoutMs - (Date.now() - attemptStarted);
      if (attemptDeadline.aborted || remaining <= 0) {
        throw new Error(
          `waited longer than ${Math.round(timeoutMs / 1000)}s for a turn against this source's rate limit; ` +
            `the request was abandoned rather than sent late`,
        );
      }
      // Never follow a redirect. Every request this server makes goes to one
      // fixed API host, and fetch's default would carry the request headers,
      // including an OpenSea key, to whatever host a 302 named. A redirect
      // from an API host is a change at the venue or something in between,
      // and either way it is an upstream failure with a name, not a hop.
      const res = await fetch(url, { ...opts, redirect: "manual", signal: combineSignals(remaining, signal) });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        let target = "an unnamed location";
        try {
          if (location) target = new URL(location, url).origin;
        } catch {
          /* an unparsable Location is still a redirect; the label stands */
        }
        throw new RedirectRefused(
          `HTTP ${res.status} redirect to ${target} refused: this server sends each request to one fixed host and follows no redirect, so a credential is never carried to a host it was not meant for`,
          res.status,
        );
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const wait = retryAfterMs(res.headers.get("retry-after"));
        // A server asking for more than 30s is telling us to go away, not to
        // retry: stop rather than hammer it early. The pause it asked for
        // travels with the error, so a caller with its own cooldown (the key
        // issuer) can honour it instead of guessing.
        if (wait > 30_000) throw new StopError(`HTTP 429 (rate limited; server asked for a ${Math.round(wait / 1000)}s pause)`, wait);
        throw new RetryableError(`HTTP 429 (rate limited)`, true, wait);
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new RetryableError(`HTTP ${res.status}`, false, 0);
      }
      return res;
    } catch (e) {
      if (e instanceof StopError) throw new HttpError(e.message, 429, "rate limited", e.retryAfterMs);
      // A redirect is final: retrying asks the same host for the same hop.
      if (e instanceof RedirectRefused) throw new HttpError(e.message, e.status, "redirect refused");
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
        // The backoff is part of the caller's budget too: sleeping four
        // seconds after the deadline has passed spends time nobody is waiting
        // for, and then sends the retry anyway.
        await sleep(Math.max(hinted, backoffMs * (i + 1) * (slow ? 3 : 1)), signal);
      }
    }
  }
  // A 429 or 5xx that outlived every retry is an HTTP answer, and is thrown
  // as one: a caller checking `status === 429` used to get a private error
  // class instead and had to grep the message for the number.
  if (lastErr instanceof RetryableError) {
    const status = lastErr.slow ? 429 : Number(/HTTP (\d{3})/.exec(lastErr.message)?.[1] ?? 502);
    throw new HttpError(lastErr.message, status, lastErr.slow ? "rate limited" : "upstream error", lastErr.retryAfterMs || undefined);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Sleep that ends early when the caller gives up, and throws so the retry loop stops rather than continuing. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError("the caller's deadline passed before this retry's backoff finished"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new AbortedError("the caller's deadline passed while this retry was backing off"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After is either delta-seconds or an HTTP-date; both are honoured. */
function retryAfterMs(h: string | null): number {
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/** Thrown when an upstream answered with a redirect, which this server never follows. */
class RedirectRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thrown to leave the retry loop immediately. */
class StopError extends Error {
  constructor(msg: string, public retryAfterMs = 0) {
    super(msg);
  }
}

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
 * `AbortSignal.any` holds its parents weakly, so a timeout that fires or an
 * attempt that finishes leaves no listener on the caller's signal. The
 * handwritten combiner it replaced (written for a Node 20.0 floor that is now
 * 22) never removed the listener it added to the caller, so every retry and
 * every page of a long read left one more behind for the life of the request.
 */
export function combineSignals(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
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
  // Never let a key we sent bounce back into an error string. EVERY key this
  // process has sent, not the one in the environment: the self-issued key
  // lives in memory and on disk, and reading only the environment let a mocked
  // OpenSea 400 carry it into a normal status answer.
  msg = redactSecrets(msg);
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
  retryOpts?: { retries?: number; timeoutMs?: number; gate?: (signal?: AbortSignal, opts?: GateOptions) => Promise<void>; signal?: AbortSignal; background?: boolean },
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
  constructor(
    msg: string,
    public status: number,
    public reason: string,
    /** How long the upstream asked us to stay away, when it said. */
    public retryAfterMs?: number,
  ) {
    super(msg);
    this.name = "HttpError";
  }
}
