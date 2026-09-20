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

const storage = new AsyncLocalStorage<{ signal: AbortSignal | undefined }>();

/** Run `fn` with `signal` as the ambient deadline for everything it awaits. `undefined` detaches from any outer one. */
export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return storage.run({ signal }, fn);
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
