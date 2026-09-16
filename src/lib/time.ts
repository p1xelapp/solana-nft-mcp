/**
 * One timestamp guard for every source, so the sales tools cannot disagree
 * about what a bad block time does to a report.
 *
 * `get_collection_sales` had a bounded conversion and `get_recent_sales` did
 * not: one venue row with `blockTime: 1e20` threw a RangeError out of
 * `toISOString` and took the other nine sales with it. OpenSea's event
 * timestamp went through the same unguarded call. Every conversion now goes
 * through here and answers null for a time it cannot represent, and callers
 * count those nulls rather than losing the row.
 */

/**
 * JavaScript Date spans +/-8.64e15 MILLISECONDS from the epoch, and
 * `toISOString` throws outside that. In seconds, that is the bound below.
 */
const MAX_DATE_SECONDS = 8_640_000_000_000;

/**
 * A block time (seconds since the epoch) that can be turned into a date, or null.
 *
 * Only representability is checked. An early attempt also rejected anything
 * before Solana's genesis as implausible, which threw away real data to solve
 * a problem it did not have: 150 is a daft block time but it renders as 1970
 * without complaint, and deleting rows we CAN read is a worse bug than
 * printing an odd date. Plausibility is a labelling question.
 */
export function usableBlockTime(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (Math.abs(v) > MAX_DATE_SECONDS) return null;
  return v;
}

/** ISO-8601 for a block time, or null when it cannot be represented. Never throws. */
export function isoFromBlockTime(t: unknown): string | null {
  const at = usableBlockTime(t);
  if (at === null) return null;
  try {
    return new Date(at * 1000).toISOString();
  } catch {
    // The range check above should make this unreachable, and an unreachable
    // throw here would still cost a whole report.
    return null;
  }
}
