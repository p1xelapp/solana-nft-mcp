/**
 * Runtime shape guards for third-party JSON.
 *
 * A TypeScript cast on an external payload is a comment, not a check. The
 * failures this closes were all the same shape: the container was validated
 * ("is it an array?") and the elements were not, so a single `null` row from a
 * venue crashed a mapper mid-response and the tool returned nothing at all -
 * an upstream shape change presented as a bug in this server.
 *
 * The rule here is that a malformed page is an UPSTREAM FAILURE, never "no
 * results". Callers get a named error they can report; they never get a
 * silently shortened list.
 */

/** A page must be an array of objects. Anything else is an outage or an API change. */
export function objectRows<T>(source: string, what: string, batch: unknown): T[] {
  if (!Array.isArray(batch)) {
    throw new Error(`${source} returned an unexpected shape for ${what} (outage or API change)`);
  }
  const rows: unknown[] = batch;
  for (let i = 0; i < rows.length; i++) {
    const row: unknown = rows[i];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        `${source} returned a malformed row in ${what} (row ${i} is ${row === null ? "null" : Array.isArray(row) ? "an array" : typeof row}, not an object) - an outage or an API change, not an empty result`,
      );
    }
  }
  return batch as T[];
}

/**
 * A page may never be larger than what was asked for.
 *
 * Page-count budgets bound requests, not rows: a venue answering a request for
 * 100 rows with 100,000 tiny ones costs the same number of round trips and
 * unbounded CPU, memory and output. A page over its own limit is refused
 * before anything maps over it.
 */
export function assertPageSize(source: string, what: string, rows: unknown[], requested: number): void {
  if (rows.length > requested) {
    throw new Error(
      `${source} returned ${rows.length} rows for ${what} when ${requested} were requested - the marketplace is not honouring its own page size, so the page was refused rather than processed`,
    );
  }
}

/**
 * Append without variadic spread.
 *
 * `target.push(...batch)` passes every row as an argument and throws
 * RangeError once a batch is large enough, which turns an oversized upstream
 * page into a crash instead of a refusal.
 */
export function appendAll<T>(target: T[], batch: readonly T[]): void {
  for (const row of batch) target.push(row);
}

/**
 * The grammar a Magic Eden collection symbol obeys.
 *
 * Symbols travel into tool output, into follow-up URLs and into model context.
 * Validating them against the grammar - rather than cleaning them and hoping -
 * means a directory row whose "symbol" is a fake message delimiter is dropped
 * at the boundary instead of being carried as an identifier.
 */
const SYMBOL_RE = /^[a-z0-9_\-.]{1,80}$/i;
export const isCollectionSymbol = (v: unknown): v is string => typeof v === "string" && SYMBOL_RE.test(v);

/** A finite number above zero, or null. The only prices and floors this server does arithmetic on. */
export const finitePositive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** A finite number, or null. For counts and ranks, where zero is meaningful. */
export const finiteNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
