/**
 * Keep an answer inside the ceiling the CLIENT imposes.
 *
 * Every client truncates a tool result, and none of them say so to the model:
 * Claude Code cuts at 25,000 tokens, Claude.ai at roughly 150,000 characters.
 * A truncated JSON body is not a smaller answer, it is a WRONG one, because
 * the model reads the surviving prefix as the whole thing and then reports
 * "the 23 listings" when there were 100.
 *
 * Measured on 2026-09-15: `find_listings` with limit 100 on Mad Lads returned
 * 247,385 characters, of which 140 KB was a full trait array repeated on every
 * row, with the same trait floors already aggregated once at the top of the
 * same answer. It was four times past what the client would keep.
 *
 * So the size is decided here rather than left to the transport, and every
 * reduction is named in the answer. The order is deliberate: drop detail from
 * whole rows before dropping rows, because a reader can ask for the detail of
 * one item but cannot ask for an item they were never told exists.
 */

/** Roughly four characters to the token, which is the usual working figure. */
export const CLIENT_TOKEN_CEILING = 25_000;

/**
 * The budget one answer may spend.
 *
 * Deliberately well under the ceiling: the model still has to hold the
 * question, the other tool definitions and its own reasoning alongside this.
 */
export const ANSWER_BUDGET_BYTES = 45_000;

export interface Fitted<T> {
  rows: T[];
  /** Rows left out entirely. */
  omitted: number;
  /** True when rows were slimmed rather than removed. */
  slimmed: boolean;
  /** Plain words for the answer, or undefined when nothing was reduced. */
  note?: string;
}

/**
 * UTF-8 bytes, not string length.
 *
 * `JSON.stringify(v).length` counts UTF-16 code units, and the budget is named
 * in bytes. Measured 2026-09-15: thirty CJK characters are 43 code units and
 * 103 UTF-8 bytes, so a 60-byte budget accepted a 103-byte payload. Any
 * collection with a non-Latin name defeated the guarantee this helper exists
 * to provide, and the venues carry plenty of them.
 */
const size = (v: unknown): number => {
  const json = JSON.stringify(v);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
};

/**
 * Fit rows into a byte budget without ever returning half a row.
 *
 * `slim` is the smaller shape of one row, used before any row is dropped.
 * `detailHint` says how a reader gets back what slimming removed; it is put
 * into the note, because a reduction nobody can undo is just a loss.
 */
export function fitRows<T>(
  rows: T[],
  opts: {
    budget?: number;
    slim?: (row: T) => T;
    /** What slimming takes off a row, for the note. e.g. "the full trait list". */
    slimmedAway?: string;
    /** How to get the detail back. e.g. "call get_asset on a mint". */
    detailHint?: string;
    /** How to reach the rows that were dropped. e.g. "raise startAt". */
    moreHint?: string;
  } = {},
): Fitted<T> {
  const budget = opts.budget ?? ANSWER_BUDGET_BYTES;
  if (rows.length === 0 || size(rows) <= budget) return { rows, omitted: 0, slimmed: false };

  let working = rows;
  let slimmed = false;
  if (opts.slim) {
    working = rows.map(opts.slim);
    slimmed = true;
    if (size(working) <= budget) {
      return {
        rows: working,
        omitted: 0,
        slimmed: true,
        note:
          `All ${rows.length} rows are here, but ${opts.slimmedAway ?? "the per-row detail"} was left off each one to keep this answer ` +
          `inside the size a client will carry; a bigger answer is silently cut off, which reads as a shorter list rather than a truncated one.` +
          (opts.detailHint ? ` ${opts.detailHint}` : ""),
      };
    }
  }

  // Still too big with every row slimmed, so rows have to go. Binary search
  // the count rather than measuring the whole array on every step.
  let lo = 0;
  let hi = working.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(working.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  // `Math.max(lo, 1)` used to keep one row even when that row alone was over
  // the budget: a 1,000-character name against a 100-byte budget returned 1,013
  // bytes and reported nothing omitted. Preserving one row by breaking the
  // guarantee is the one thing this helper must not do, because the caller has
  // been told the answer fits and a client will cut it without saying so.
  const kept = working.slice(0, lo);
  if (kept.length === 0) {
    const firstBytes = size(working[0]);
    return {
      rows: [],
      omitted: rows.length,
      slimmed,
      note:
        `No rows are here. The smallest row on its own is ${firstBytes} bytes against a ${budget}-byte budget, so returning ` +
        `even one would produce an answer a client silently cuts off - which reads as a complete list rather than a truncated one. ` +
        `This is a size limit, not an empty result.` +
        (opts.moreHint ? ` ${opts.moreHint}` : "") +
        (opts.detailHint ? ` ${opts.detailHint}` : ""),
    };
  }
  const omitted = rows.length - kept.length;
  return {
    rows: kept,
    omitted,
    slimmed,
    note:
      `${kept.length} of ${rows.length} rows are here. ${omitted} were left out, and ` +
      (slimmed ? `${opts.slimmedAway ?? "the per-row detail"} was left off the ones that remain, ` : "") +
      `because a client silently cuts off an answer past about ${Math.round(CLIENT_TOKEN_CEILING / 1000)}k tokens and the cut looks like a shorter list. ` +
      `This is a size limit, not the end of the data.` +
      (opts.moreHint ? ` ${opts.moreHint}` : "") +
      (opts.detailHint ? ` ${opts.detailHint}` : ""),
  };
}

/**
 * A copy of an object without the named keys.
 *
 * Written out rather than destructured-and-discarded because the discard form
 * leaves bindings nothing reads, which the linter is right to object to.
 */
export function omit<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Omit<T, K> {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}
