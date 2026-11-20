/**
 * The caller's deadline, carried without being passed.
 *
 * A client that cancels a request (a person hit stop, a host timed out) tells
 * this server through the SDK's per-request `AbortSignal`. Measured on
 * in testing: after the client aborted a collection sales
 * read, the server still fetched offsets 500 and 1000 from Magic Eden with
 * nobody waiting, because the signal reached the handler and stopped there.
 * Threading it by hand through every source, every page loop and every gate
 * wait is fifty edits and one missed call site is the same bug again.
 *
 * So the signal travels as ambient context. A tool handler runs inside
 * `runWithSignal`, and everything it awaits - the rate gates, the retry
 * sleeps, the fetches, the next page - reads `ambientSignal()` and stops when
 * it fires. A shared cache producer runs under its OWN signal (see `cached`),
 * so one caller leaving cannot kill a read another caller joined.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What one tool call asked of one source, so a slow answer can say where its
 * time went. A person who waits 30 s for an answer and is told nothing reads
 * the wait as this server being slow or broken; most of it is the public
 * sources' own pacing, and the answer can say so with numbers.
 */
export interface SourceUse {
  /** Requests that got a turn against the source's rate limit. */
  requests: number;
  /**
   * Wall-clock time during which at least one of this call's requests was
   * queued for a turn. Waits that overlap are counted once: a sum of fourteen
   * parallel waits read as more time than the call took.
   */
  turnWaitMs: number;
  /** Requests of this call queued right now, and since when one has been. */
  queuedNow: number;
  queuedSince: number;
  /** The spacing this server keeps between requests to the source. */
  spacingMs: number;
  /** Answers that said "slow down" (HTTP 429). */
  rateLimited: number;
  /** Requests not sent because the source had asked for a pause. */
  skippedForPause: number;
  /** Requests that got no usable answer: no reply in time, a dropped connection or a server error. */
  failed: number;
}

const storage = new AsyncLocalStorage<{ signal: AbortSignal | undefined; uses?: Map<string, SourceUse> }>();

/**
 * Run `fn` with `signal` as the ambient deadline for everything it awaits. `undefined` detaches from any outer one.
 * The call's source log, when there is one, carries on: a read started on a call's behalf is part of its wait.
 */
export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return storage.run({ signal, uses: storage.getStore()?.uses }, fn);
}

/** Run one tool call with its own source log. */
export function runMeasured<T>(signal: AbortSignal | undefined, uses: Map<string, SourceUse>, fn: () => T): T {
  return storage.run({ signal, uses }, fn);
}

function useOf(source: string): SourceUse | undefined {
  const uses = storage.getStore()?.uses;
  if (!uses) return undefined;
  let u = uses.get(source);
  if (!u) {
    u = { requests: 0, turnWaitMs: 0, queuedNow: 0, queuedSince: 0, spacingMs: 0, rateLimited: 0, skippedForPause: 0, failed: 0 };
    uses.set(source, u);
  }
  return u;
}

/** Add to the current call's record for one source; a no-op outside a call. */
export function noteSourceUse(source: string, add: Partial<Pick<SourceUse, "requests" | "spacingMs" | "rateLimited" | "skippedForPause" | "failed">>): void {
  const u = useOf(source);
  if (!u) return;
  u.requests += add.requests ?? 0;
  u.rateLimited += add.rateLimited ?? 0;
  u.skippedForPause += add.skippedForPause ?? 0;
  u.failed += add.failed ?? 0;
  u.spacingMs = Math.max(u.spacingMs, add.spacingMs ?? 0);
}

/**
 * Marks one request of the current call as queued for a turn against a
 * source's rate limit. The returned function ends that wait, once.
 */
export function noteQueued(source: string): () => void {
  const u = useOf(source);
  if (!u) return () => undefined;
  if (u.queuedNow++ === 0) u.queuedSince = performance.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (--u.queuedNow === 0) u.turnWaitMs += performance.now() - u.queuedSince;
  };
}

/** Time this call has spent waiting on a source so far, including a wait still open. */
export function queuedMs(u: SourceUse): number {
  return u.turnWaitMs + (u.queuedNow > 0 ? performance.now() - u.queuedSince : 0);
}

/** The deadline of whoever is waiting on the current work, or undefined when nobody is. */
export function ambientSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/**
 * One signal that fires when either the explicit one or the ambient one does.
 *
 * Returns the single signal when only one exists, so the common paths pay
 * for no listeners at all.
 */
export function withAmbient(explicit?: AbortSignal): AbortSignal | undefined {
  const ambient = ambientSignal();
  if (!ambient) return explicit;
  if (!explicit || explicit === ambient) return ambient;
  // AbortSignal.any holds its parents weakly, so a combination that finishes
  // leaves nothing behind on the parent that outlived it. The handwritten
  // combiner it replaced added a listener to each parent and removed neither:
  // measured: twenty combinations against one long-lived request
  // signal left twenty listeners on it for as long as the request ran.
  return AbortSignal.any([explicit, ambient]);
}
