/**
 * Collection market intelligence - the questions a collector asks about a
 * whole collection rather than one wallet or one asset.
 *
 * "What actually sold this week, and for how much? Who is buying it? Is one
 * buyer the entire market? Which listing is cheap for the trait it carries?
 * What is this collection even called on this venue?"
 *
 * Everything here is pure: it takes the raw feeds the sources return and
 * derives answers, so the logic is testable offline against captured fixtures.
 * The rule throughout is to label what a number is - a trait floor is the
 * cheapest ASK carrying that trait on one venue right now, not what the trait
 * is worth; a feed that stopped at a page limit is a window, not a history -
 * because the wrong label is the expensive bug.
 */

import type { MeCollectionActivity, MeListing, TraitFloor, MeCollectionIndexEntry } from "./sources/magiceden.js";
import { clean } from "./lib/untrusted.js";

/**
 * Rounding at lamport resolution (1e-9 SOL), not the 3 decimals a wallet
 * summary can afford. Card collections trade well under 0.01 SOL - the
 * fixture for this module has sales at 0.009644132 - and 3 decimals would
 * report those as 0.01, turning a third of the price into rounding. Nothing
 * finer than a lamport exists on Solana, so this is lossless for real amounts
 * while still absorbing the float noise a long sum accumulates.
 */
const round = (n: number, dp = 9) => Math.round(n * 10 ** dp) / 10 ** dp;
/**
 * A block time we are willing to turn into a date.
 *
 * Finite is not enough. `blockTime: 1e20` is a finite number and JavaScript's
 * Date cannot represent it, so `new Date(t * 1000).toISOString()` throws
 * RangeError. Reproduced 2026-09-15: three good sales plus ONE unrelated
 * listing row carrying 1e20 threw out of summarizeSales and destroyed the
 * whole report. One malformed upstream record must never remove an answer
 * that is otherwise correct.
 *
 * The lower bound is Solana's genesis, because a Solana block cannot predate
 * the chain, and the upper bound is a day into the future to allow for clock
 * skew at the venue. Anything outside that is not a time, whatever its type.
 */
/**
 * JavaScript Date spans +/-8.64e15 MILLISECONDS from the epoch, and
 * `toISOString` throws outside that. In seconds, that is the bound below.
 */
const MAX_DATE_SECONDS = 8_640_000_000_000;

export function usableBlockTime(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Only representability. An early attempt at this also rejected anything
  // before Solana's genesis as implausible, which threw away real data to
  // solve a problem it did not have: 150 is a daft block time but it renders
  // as 1970 without complaint, and deleting rows we CAN read is a worse bug
  // than printing an odd date. Plausibility is a labelling question; this
  // function exists only to stop a RangeError destroying a whole report.
  if (Math.abs(v) > MAX_DATE_SECONDS) return null;
  return v;
}

const iso = (t: number | null | undefined) => {
  const at = usableBlockTime(t);
  if (at === null) return null;
  try {
    return new Date(at * 1000).toISOString();
  } catch {
    // Belt and braces: the range check above should make this unreachable, and
    // an unreachable throw here would still cost a whole report.
    return null;
  }
};
/** The UTC calendar day a block time falls in, for bucketing a series. */
const utcDay = (t: number): string | null => iso(t)?.slice(0, 10) ?? null;

/**
 * A price we will do arithmetic on. Magic Eden has been observed returning
 * `price` as a string and, on withdrawn rows, as null; a string that coerces
 * would quietly concatenate into a volume total, so only real finite numbers
 * above zero count and everything else is named as unpriced rather than
 * silently dropped.
 */
const usablePrice = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** Activity types that mean money changed hands for an item. */
const SALE_TYPES = new Set(["buyNow", "buy"]);

/** The fields any marketplace activity row carries that identify the EVENT. */
export interface IdentifiableEvent {
  signature?: string;
  type?: string;
  tokenMint?: string;
  buyer?: string;
  seller?: string;
  price?: number;
}

/**
 * The identity of one marketplace event, or null when it cannot be established.
 *
 * A signature is a TRANSACTION, not a sale: one transaction routinely buys two
 * NFTs, and deduplicating on the signature alone throws the second item away
 * and calls it a duplicate - sales and volume both come out low. The identity
 * is therefore the signature plus what distinguishes one fill inside it: the
 * mint and the type.
 *
 * Price and the two sides are deliberately NOT part of it. The venue serves
 * the same fill twice while it hydrates - once sparse, once with a corrected
 * price or a filled-in buyer - and putting those fields in the identity made
 * the two copies two events, which doubled the sale, the volume and the P&L.
 * They are compared instead: a repeat that disagrees is reported, not counted.
 * A row with no signature cannot be identified at all and is kept, because
 * dropping a real sale to protect a counter is the worse error.
 */
export function eventIdentity(e: IdentifiableEvent | null | undefined): string | null {
  const sig = typeof e?.signature === "string" && e.signature ? e.signature : null;
  if (!sig) return null;
  const part = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  return [sig, part(e?.tokenMint), part(e?.type)].join("\u0000");
}

/**
 * An identity for a row the venue served without a signature.
 *
 * Keeping every unsigned row was the safe choice against dropping a real sale,
 * and it is the wrong choice against a feed that repeats identical unsigned
 * rows across pages: the same fill then counts twice, doubling collection
 * sales, FIFO flips and realised P&L. An unsigned row is instead identified by
 * everything that would have to coincide for two rows to be the same fill -
 * item, type, both sides, price and block time - and the count of rows that
 * needed this weaker identity is reported, because it IS weaker: two genuinely
 * identical fills in the same block for the same price would collapse into one.
 */
export function fallbackIdentity(e: IdentifiableEvent | null | undefined): string | null {
  if (!e || typeof e !== "object") return null;
  const part = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  // Completeness is the whole point. One populated field is not an identity:
  // two distinct unsigned sales carrying only a type, a price and a block time
  // collapsed into one, and a real fill disappeared to protect a counter. The
  // identifying core - WHICH item, WHAT happened, FOR how much, WHEN - has to
  // be present and valid in full, or this row has no identity at all and is
  // kept as its own event.
  const mint = typeof e.tokenMint === "string" ? e.tokenMint.trim() : "";
  const type = typeof e.type === "string" ? e.type.trim() : "";
  const price = usablePrice(e.price);
  const blockTime = (e as { blockTime?: unknown }).blockTime;
  const at = usableBlockTime(blockTime);
  if (!mint || !type || price === null || at === null) return null;
  const fields = [mint, type, part(e.buyer), part(e.seller), String(price), String(at), part((e as { source?: unknown }).source)];
  return `~ ${fields.join(" ")}`;
}

/**
 * Fields a second copy of one event may fill in while the venue hydrates it.
 *
 * Merging is strictly additive: a null or absent field takes the populated
 * value, so the sparse copy that arrived first no longer wins and erases a
 * price the venue supplied a page later. Two POPULATED values that disagree
 * are not merged - the event is excluded from the money figures and counted as
 * unsettled, because guessing which copy is right is how a wrong number gets
 * presented as a fact.
 */
const HYDRATED_FIELDS = ["buyer", "seller", "price", "blockTime", "source", "name"] as const;

/**
 * The fields a money figure is actually built from.
 *
 * A disagreement here means no copy can be shown to carry the right amount or
 * the right side, so the event is kept as a sale and excluded from volume and
 * per-wallet totals. Everything else - a corrected item name, a venue label,
 * a block time that moved by a second - is METADATA: it changes how the row
 * reads, not what was paid, and suppressing an agreed 2 SOL price because the
 * name was tidied up is the bug this split exists to prevent.
 */
const MONEY_FIELDS: readonly string[] = ["price", "buyer", "seller"];

const populated = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

export interface MergeOutcome<T> {
  merged: T;
  /** Exactly which populated fields disagreed between the two copies. */
  conflicts: string[];
  /** True when one of those fields is a field a money figure is built from. */
  moneyConflict: boolean;
}

/** Merge a later copy of one event into the first, additively. */
export function mergeEventCopies<T extends IdentifiableEvent>(first: T, later: T): MergeOutcome<T> {
  const merged = { ...first } as Record<string, unknown>;
  const conflicts: string[] = [];
  for (const f of HYDRATED_FIELDS) {
    const a = (first as Record<string, unknown>)[f];
    const b = (later as Record<string, unknown>)[f];
    if (!populated(b)) continue;
    if (!populated(a)) {
      merged[f] = b;
      continue;
    }
    if (String(a) !== String(b)) conflicts.push(f);
  }
  return { merged: merged as T, conflicts, moneyConflict: conflicts.some((f) => MONEY_FIELDS.includes(f)) };
}

/**
 * Drop repeated events from a feed, keeping the first occurrence.
 *
 * Offset pagination overlaps whenever new activity arrives mid-walk, and the
 * venue has been seen repeating rows across pages. Two copies of one fill
 * become two FIFO matches downstream, which doubles realised P&L and flip
 * counts - so the feed is deduplicated before anything counts it.
 */
export function dedupeEvents<T extends IdentifiableEvent>(
  events: T[],
): {
  events: T[];
  duplicates: number;
  conflictingDuplicates: number;
  /** Repeats that disagreed only about metadata (name, venue label, block time). Their price is kept. */
  metadataConflicts: number;
  identityFallbacks: number;
  /** Rows with neither a signature nor a complete fallback identity: kept as separate events, never merged. */
  identityUnavailable: number;
  unsettled: number;
} {
  /** id -> where the surviving copy sits in `out`, so a later copy can hydrate it. */
  const at = new Map<string, number>();
  const out: T[] = [];
  /** Index in `out` -> the populated fields its copies disagreed about. */
  const conflictFieldsAt = new Map<number, Set<string>>();
  let duplicates = 0;
  let identityFallbacks = 0;
  let identityUnavailable = 0;
  for (const e of Array.isArray(events) ? events : []) {
    let id = eventIdentity(e);
    if (id === null) {
      id = fallbackIdentity(e);
      if (id === null) {
        // No signature and not enough of its own fields to identify it. Kept
        // whole and counted: a row we cannot match is not a row we may drop,
        // and the count says how much of the feed could not be deduplicated.
        identityUnavailable++;
        out.push(e);
        continue;
      }
      identityFallbacks++;
    }
    const idx = at.get(id);
    if (idx === undefined) {
      at.set(id, out.length);
      out.push(e);
      continue;
    }
    duplicates++;
    // One fill answered twice as the venue fills the row in. The copies are
    // MERGED additively, so a price that arrived on the second copy is not
    // thrown away by keeping the sparse first one.
    const { merged, conflicts } = mergeEventCopies(out[idx]!, e);
    out[idx] = merged;
    if (conflicts.length) {
      const set = conflictFieldsAt.get(idx) ?? new Set<string>();
      for (const f of conflicts) set.add(f);
      conflictFieldsAt.set(idx, set);
    }
  }
  // Only a disagreement about the MONEY - the amount or the sides - takes an
  // event out of the money figures. A metadata disagreement is recorded on the
  // row and counted, and the price survives it.
  let moneyConflicts = 0;
  let metadataConflicts = 0;
  for (const [idx, fields] of conflictFieldsAt) {
    const row = out[idx] as Record<string, unknown>;
    row.conflictFields = [...fields];
    if ([...fields].some((f) => MONEY_FIELDS.includes(f))) {
      row.unsettled = true;
      moneyConflicts++;
    } else {
      row.metadataConflict = true;
      metadataConflicts++;
    }
  }
  return {
    events: out,
    duplicates,
    conflictingDuplicates: moneyConflicts,
    metadataConflicts,
    identityFallbacks,
    identityUnavailable,
    unsettled: moneyConflicts,
  };
}

// ----------------------------------------------------------- sales

export interface SaleRef {
  priceSol: number;
  tokenMint: string | null;
  name: string | null;
  signature: string | null;
  time: string | null;
  buyer: string | null;
  seller: string | null;
  venue: string;
}

export interface DailyPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Every sale that day, priced or not. */
  sales: number;
  /** Volume of the priced ones only; `pricedSales` says how many that was. */
  volumeSol: number;
  pricedSales: number;
}

export interface SalesSummary {
  window: { from: string | null; to: string | null };
  /** Freshness of the feed these figures were derived from. */
  freshness: {
    stale: boolean;
    cachedAt: string | null;
    /** The moment the coverage claim is actually about. */
    coversUpTo: string | null;
  };
  /** Every completed sale in the window, priced or not. This is the answer to "how many sold". */
  sales: number;
  /** The subset carrying a usable price - the only rows any money figure here is built from. */
  pricedSales: number;
  volumeSol: number;
  highest: SaleRef | null;
  lowest: SaleRef | null;
  medianSol: number | null;
  averageSol: number | null;
  uniqueBuyers: number;
  uniqueSellers: number;
  topBuyers: { wallet: string; sales: number; spentSol: number }[];
  topSellers: { wallet: string; sales: number; receivedSol: number }[];
  daily: DailyPoint[];
  /** Fills grouped by the program that executed them, not by the site a person was looking at. */
  venues: { venue: string; sales: number; volumeSol: number }[];
  coverage: {
    oldestSeen: string | null;
    newestSeen: string | null;
    truncated: boolean;
    eventsRead: number;
    /** Sale-shaped rows carrying no usable price. Counted as sales, never folded into volume. */
    unusableTimestamps: number;
    unpricedSales: number;
    /** Repeated EVENTS (same signature, mint and type) counted once. */
    duplicateEvents: number;
    /** Of those repeats, how many disagreed about a populated price or side. Those events are excluded from every money figure. */
    conflictingDuplicates: number;
    /** Repeats that disagreed only about metadata (item name, venue label, block time). Their agreed price is still counted. */
    metadataConflicts: number;
    /** Rows with no signature and no complete fallback identity: kept as separate events rather than merged into anything. */
    identityUnavailable: number;
    /** Sale-shaped rows excluded from money figures because two copies disagreed, or the price was not a finite number above zero. */
    unsettled: number;
    /** Rows that carried no signature and had to be identified by their own fields instead. */
    identityFallbacks: number;
    /** Rows whose price field was present but not a finite number above zero. */
    malformedPrices: number;
    note: string;
  };
}

/**
 * Read a collection activity feed as a sales report for one window.
 *
 * Three traps this closes. Duplicate events: the same fill appears twice when
 * pages overlap or a caller stitches two reads, and counting it twice inflates
 * volume - so rows are matched on the whole event, not on the signature, which
 * a single transaction can share between two different items. Non-numeric
 * prices: a row with a missing or string price is still a completed sale, so
 * it counts in `sales` and is excluded only from the money figures, never
 * treated as zero. A truncated feed: the window we could see is not the window
 * that was asked for, and coverage says which.
 */
export function summarizeSales(
  events: MeCollectionActivity[],
  opts: { windowStartUnix: number; windowEndUnix: number; truncated?: boolean; stale?: boolean; cachedAt?: string | null },
): SalesSummary {
  const { windowStartUnix, windowEndUnix } = opts;
  const truncated = Boolean(opts.truncated);
  const stale = Boolean(opts.stale);
  const cachedAt = opts.cachedAt ?? null;

  let oldestSeen: number | null = null;
  let newestSeen: number | null = null;
  let malformedPrices = 0;

  // The feed is deduplicated with the same additive merge the wallet feed
  // uses, so a price that arrived on the second copy of a fill is not thrown
  // away, and a fill whose copies disagree is marked unsettled rather than
  // silently counted from whichever copy came first.
  const inWindow: MeCollectionActivity[] = [];
  // Rows whose block time is not a time. Counted rather than dropped in
  // silence, because a feed that starts serving nonsense is worth knowing about.
  let unusableTimestamps = 0;
  for (const e of Array.isArray(events) ? events : []) {
    const bt = usableBlockTime(e?.blockTime);
    if (bt === null && e?.blockTime !== undefined && e?.blockTime !== null) unusableTimestamps++;
    if (bt !== null) {
      if (oldestSeen === null || bt < oldestSeen) oldestSeen = bt;
      if (newestSeen === null || bt > newestSeen) newestSeen = bt;
    }
    if (!e || !SALE_TYPES.has(String(e.type))) continue;
    // Outside the window is not a data problem, so it is skipped before the
    // dedupe counter - it must not read as a duplicate.
    if (bt === null || bt < windowStartUnix || bt > windowEndUnix) continue;
    inWindow.push(e);
  }
  const deduped = dedupeEvents(inWindow);
  const duplicateEvents = deduped.duplicates;
  const conflictingDuplicates = deduped.conflictingDuplicates;
  const identityFallbacks = deduped.identityFallbacks;

  let unpricedSales = 0;
  /** Every completed sale in the window. `price` is null when we could not price it. */
  const sales: { price: number | null; e: MeCollectionActivity; at: number | null }[] = [];
  for (const e of deduped.events) {
    const bt = usableBlockTime(e.blockTime);
    // A price is only money when it is a finite number above zero. A negative
    // or non-finite one is a malformed row, counted and named, never folded
    // into a total where it would subtract from volume or poison it with NaN.
    const priceGiven = (e as { price?: unknown }).price;
    const price = usablePrice(priceGiven);
    if (price === null && priceGiven !== null && priceGiven !== undefined) malformedPrices++;
    // An event whose copies disagreed cannot support a money figure.
    const settled = (e as { unsettled?: boolean }).unsettled !== true;
    const usable = settled ? price : null;
    if (usable === null) unpricedSales++;
    sales.push({ price: usable, e, at: bt });
  }

  const priced = sales.filter((s): s is { price: number; e: MeCollectionActivity; at: number | null } => s.price !== null);

  const ref = (s: { price: number; e: MeCollectionActivity; at: number | null }): SaleRef => ({
    priceSol: round(s.price),
    tokenMint: typeof s.e.tokenMint === "string" ? s.e.tokenMint : null,
    // The only attacker-authored string on this row: anyone can mint an item
    // with any name and get it in front of whoever asks about the collection.
    name: s.e.name ? clean(s.e.name) : null,
    signature: typeof s.e.signature === "string" ? s.e.signature : null,
    time: iso(s.at),
    buyer: typeof s.e.buyer === "string" ? s.e.buyer : null,
    seller: typeof s.e.seller === "string" ? s.e.seller : null,
    venue: clean(s.e.source ?? "") || "unknown",
  });

  const byPrice = [...priced].sort((a, b) => a.price - b.price);
  const volume = priced.reduce((s, x) => s + x.price, 0);
  const median = byPrice.length
    ? byPrice.length % 2
      ? byPrice[(byPrice.length - 1) / 2]!.price
      : (byPrice[byPrice.length / 2 - 1]!.price + byPrice[byPrice.length / 2]!.price) / 2
    : null;

  // Counters carry both numbers: how many sales, and how much of that could be
  // priced. A wallet that bought three items of which one had no price is
  // three sales and one price, never two sales.
  interface Tally {
    sales: number;
    priced: number;
    sol: number;
  }
  const buyers = new Map<string, Tally>();
  const sellers = new Map<string, Tally>();
  const days = new Map<string, Tally>();
  const venues = new Map<string, Tally>();
  const bump = (m: Map<string, Tally>, k: string, sol: number | null) => {
    const cur = m.get(k) ?? { sales: 0, priced: 0, sol: 0 };
    cur.sales++;
    if (sol !== null) {
      cur.priced++;
      cur.sol += sol;
    }
    m.set(k, cur);
  };
  for (const s of sales) {
    if (typeof s.e.buyer === "string" && s.e.buyer) bump(buyers, s.e.buyer, s.price);
    if (typeof s.e.seller === "string" && s.e.seller) bump(sellers, s.e.seller, s.price);
    const day = s.at !== null ? utcDay(s.at) : null;
    if (day !== null) bump(days, day, s.price);
    bump(venues, clean(s.e.source ?? "") || "unknown", s.price);
  }

  const rank = (m: Map<string, Tally>) =>
    [...m.entries()].sort((a, b) => b[1].sales - a[1].sales || b[1].sol - a[1].sol).slice(0, 10);

  const notes: string[] = [];
  notes.push(
    truncated
      ? "The activity feed was still returning full pages when the page budget ran out, so this covers only the most recent part of the window - older sales exist. Raise the page budget for the full window."
      : stale
        ? `Magic Eden did not answer for this read, so these figures come from the feed as it stood at ${cachedAt ?? "an unrecorded earlier time"}. They are LAST-KNOWN, not current: anything that sold since is missing, and the window's closing hours are not covered. Ask again in a minute for a live read.`
        : "The activity feed ran out before the page budget did, so this is everything Magic Eden held for the window at the moment of this read.",
  );
  if (deduped.identityFallbacks) {
    notes.push(
      `${deduped.identityFallbacks} row(s) carried no transaction signature and were identified by item, type, both sides, price and block time instead. That identity is weaker than a signature: two genuinely separate fills of the same item at the same price in the same block would be counted once.`,
    );
  }
  if (deduped.identityUnavailable) {
    notes.push(
      `${deduped.identityUnavailable} row(s) carried neither a transaction signature nor a complete item/type/price/time set, so they could not be matched against anything. They are kept as separate events rather than merged, which means a repeat of one of them would be counted twice.`,
    );
  }
  if (deduped.metadataConflicts) {
    notes.push(
      `${deduped.metadataConflicts} repeated event(s) disagreed only about metadata (item name, venue label or block time). The price both copies agreed on is still counted; only the changed field is in doubt.`,
    );
  }
  if (malformedPrices) {
    notes.push(
      `${malformedPrices} sale-shaped row(s) carried a price that was not a finite number above zero (negative, zero, a string, or infinite). They are counted as sales and excluded from every money figure rather than being summed.`,
    );
  }
  if (unpricedSales) {
    notes.push(
      `${unpricedSales} completed sale${unpricedSales === 1 ? "" : "s"} carried no usable price: counted in sales, buyers, sellers and the daily series, and excluded from volume, median and average rather than counted as zero. Money figures here cover ${sales.length - unpricedSales} of ${sales.length} sales.`,
    );
  }
  if (duplicateEvents) {
    notes.push(
      `${duplicateEvents} repeated event${duplicateEvents === 1 ? "" : "s"} (same signature, item and type) counted once. Two different items bought in one transaction are two sales and both are kept.` +
        (conflictingDuplicates
          ? ` ${conflictingDuplicates} of those repeats disagreed with the first copy about a populated price or side. Those ${conflictingDuplicates === 1 ? "event is" : "events are"} counted as ${conflictingDuplicates === 1 ? "a sale" : "sales"} and excluded from volume, median, average and every per-wallet total, because no copy can be shown to be the right one.`
          : ""),
    );
  }
  notes.push(
    "Magic Eden's feed, so this is what settled through Magic Eden and its AMM pools. Tensor, OpenSea and peer-to-peer trades are not in it.",
  );

  return {
    window: { from: iso(windowStartUnix), to: iso(windowEndUnix) },
    freshness: {
      stale,
      cachedAt,
      // A stale read cannot describe the window up to now. What it can
      // describe is the moment it was actually taken.
      coversUpTo: stale ? cachedAt : iso(windowEndUnix),
    },
    sales: sales.length,
    pricedSales: priced.length,
    volumeSol: round(volume),
    highest: byPrice.length ? ref(byPrice[byPrice.length - 1]!) : null,
    lowest: byPrice.length ? ref(byPrice[0]!) : null,
    medianSol: median === null ? null : round(median),
    // Over the priced sales only: dividing by every sale would quietly treat
    // the ones we could not price as free.
    averageSol: priced.length ? round(volume / priced.length) : null,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    topBuyers: rank(buyers).map(([wallet, v]) => ({ wallet, sales: v.sales, spentSol: round(v.sol) })),
    topSellers: rank(sellers).map(([wallet, v]) => ({ wallet, sales: v.sales, receivedSol: round(v.sol) })),
    daily: [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, sales: v.sales, volumeSol: round(v.sol), pricedSales: v.priced })),
    venues: [...venues.entries()]
      .sort((a, b) => b[1].sales - a[1].sales)
      .map(([venue, v]) => ({ venue, sales: v.sales, volumeSol: round(v.sol) })),
    coverage: {
      oldestSeen: iso(oldestSeen),
      newestSeen: iso(newestSeen),
      truncated,
      eventsRead: Array.isArray(events) ? events.length : 0,
      // Rows the feed served with something in the blockTime field that is not
      // a time. Reported rather than dropped in silence: a feed that starts
      // serving nonsense is worth knowing about, and this used to throw the
      // whole report away instead of counting.
      unusableTimestamps,
      unpricedSales,
      duplicateEvents,
      conflictingDuplicates,
      metadataConflicts: deduped.metadataConflicts,
      identityUnavailable: deduped.identityUnavailable,
      unsettled: deduped.unsettled,
      identityFallbacks,
      malformedPrices,
      note: notes.join(" "),
    },
  };
}

/**
 * Apply a name filter to a window of sales, or refuse to.
 *
 * The trap this closes: the name index fails, every event fails the "does its
 * name contain X" test because no event HAS a name, and the tool reports zero
 * matching sales. Zero is an answer about the collection; "we could not look"
 * is an answer about the index, and only one of them is true. When names are
 * unavailable the filter reports `unavailable` and returns no filtered set at
 * all, so nothing downstream can present zeros as the filtered figure.
 */
export function applyNameFilter(
  windowEvents: MeCollectionActivity[],
  names: Map<string, { name: string | null }> | null,
  needle: string | null,
): { status: "not-requested" | "applied" | "unavailable"; events: MeCollectionActivity[] | null } {
  if (!needle) return { status: "not-requested", events: null };
  if (names === null) return { status: "unavailable", events: null };
  const lower = needle.toLowerCase();
  const rows = (Array.isArray(windowEvents) ? windowEvents : []).filter(
    (e) => (e?.tokenMint && names.get(e.tokenMint)?.name?.toLowerCase().includes(lower)) === true,
  );
  return { status: "applied", events: rows };
}

// ----------------------------------------------------------- listings

export interface DealTrait {
  traitType: string;
  value: string;
  /** Cheapest ask carrying this trait anywhere in the collection, now. */
  traitFloorSol: number | null;
  listedWithTrait: number;
}

export interface Deal {
  tokenMint: string | null;
  name: string | null;
  priceSol: number | null;
  seller: string | null;
  listingVenue: string;
  /** Rank from the rarity providers ME echoes. Absent for most collections, including every Core one seen. */
  rarity: { howrare: number | null; moonrank: number | null } | null;
  traits: DealTrait[];
  /** The dearest trait floor this item carries: the trait that most argues the ask is low. */
  strongestTraitFloorSol: number | null;
  strongestTrait: string | null;
  /** How far under that trait's own floor this ask sits. Negative means it is above it. */
  underStrongestTraitFloorPct: number | null;
  /** Set when the ask is the trait floor itself, so nothing is being compared to itself and called a discount. */
  isOwnTraitFloor: boolean;
}

export interface BestDeals {
  deals: Deal[];
  unpricedListings: number;
  traitsMatched: number;
  traitsUnmatched: number;
  /** "available" when every trait comparison in `deals` was computed from a live read; otherwise why it was not. */
  comparison: string;
  readThis: string[];
}

/** Both sides of the comparison, and when each was actually read. */
export interface DealFreshness {
  listingsStale: boolean;
  listingsReadAt: string | null;
  traitFloorsStale: boolean;
  traitFloorsReadAt: string | null;
}

/**
 * Listings ordered cheapest first, each read against the floor of the traits
 * it carries.
 *
 * A trait floor is the cheapest ASK carrying that trait on this venue right
 * now. It is not a valuation and not a sale price: one seller can set it, and
 * a trait nobody has listed has no floor at all rather than a floor of zero.
 * The comparison exists to point at listings worth a human look, so when a
 * listing IS the trait floor we say so instead of reporting a 0% discount that
 * reads like a finding.
 */
export function bestDeals(listings: MeListing[], attributes: TraitFloor[], freshness?: DealFreshness): BestDeals {
  // A discount percentage is arithmetic across two reads, and it is only true
  // if both of them are current. A failed trait-floor refresh used to be
  // served from cache and still described as the floor "at query time", which
  // turns a five-minute-old number into a precise claim about now. When either
  // side is stale the asks are returned as they are, and the comparison says
  // what was missing and when each side was actually read.
  const staleSides: string[] = [];
  if (freshness?.listingsStale) staleSides.push(`the listing page last read at ${freshness.listingsReadAt ?? "an unrecorded time"}`);
  if (freshness?.traitFloorsStale) staleSides.push(`trait floors last read at ${freshness.traitFloorsReadAt ?? "an unrecorded time"}`);
  const comparable = staleSides.length === 0;
  const comparison = comparable ? "available" : `unavailable (stale: ${staleSides.join("; ")})`;

  const floors = new Map<string, TraitFloor>();
  for (const a of Array.isArray(attributes) ? attributes : []) {
    if (!a || typeof a.traitType !== "string" || typeof a.value !== "string") continue;
    floors.set(`${a.traitType}\u0000${a.value}`, a);
  }

  let unpricedListings = 0;
  let traitsMatched = 0;
  let traitsUnmatched = 0;

  const deals: Deal[] = (Array.isArray(listings) ? listings : []).map((l) => {
    const priceSol = usablePrice(l?.price);
    if (priceSol === null) unpricedListings++;

    const traits: DealTrait[] = [];
    for (const t of l?.token?.attributes ?? []) {
      if (!t || typeof t.trait_type !== "string") continue;
      // Trait names and values are minter-chosen text on a permissionless
      // chain, so they are cleaned before they are used as a key or shown.
      const traitType = clean(t.trait_type);
      const value = clean(t.value);
      if (!traitType) continue;
      const hit = floors.get(`${traitType}\u0000${value}`);
      if (hit) traitsMatched++;
      else traitsUnmatched++;
      traits.push({
        traitType,
        value,
        traitFloorSol: hit?.floorSol ?? null,
        listedWithTrait: hit?.listedCount ?? 0,
      });
    }

    let strongest: DealTrait | null = null;
    for (const t of traits) {
      if (t.traitFloorSol === null) continue;
      if (strongest === null || t.traitFloorSol > (strongest.traitFloorSol ?? 0)) strongest = t;
    }
    const strongestFloor = strongest?.traitFloorSol ?? null;
    // Floating point makes an item that IS the floor compare as 0.0000001
    // under it; a hair's width is the same listing, not a discount.
    const isOwnTraitFloor =
      priceSol !== null && strongestFloor !== null && Math.abs(priceSol - strongestFloor) < 1e-9;

    const r = l?.rarity;
    const howrare = typeof r?.howrare?.rank === "number" ? r.howrare.rank : null;
    const moonrank = typeof r?.moonrank?.rank === "number" ? r.moonrank.rank : null;

    return {
      tokenMint: typeof l?.tokenMint === "string" ? l.tokenMint : null,
      name: l?.token?.name ? clean(l.token.name) : null,
      priceSol: priceSol === null ? null : round(priceSol),
      seller: typeof l?.seller === "string" ? l.seller : null,
      listingVenue: clean(l?.listingSource ?? "") || "unknown",
      rarity: howrare === null && moonrank === null ? null : { howrare, moonrank },
      traits,
      strongestTraitFloorSol: strongestFloor,
      strongestTrait: strongest ? `${strongest.traitType}: ${strongest.value}` : null,
      underStrongestTraitFloorPct:
        priceSol === null || strongestFloor === null || strongestFloor <= 0 || isOwnTraitFloor
          ? null
          : round(((strongestFloor - priceSol) / strongestFloor) * 100, 1),
      isOwnTraitFloor,
    };
  });

  // Unpriced listings cannot be ranked against priced ones, so they sort last
  // rather than to the front as a zero would.
  deals.sort((a, b) => (a.priceSol ?? Number.POSITIVE_INFINITY) - (b.priceSol ?? Number.POSITIVE_INFINITY));

  const readThis = comparable
    ? [
    "A trait floor is the cheapest ASK carrying that trait on Magic Eden at query time - one seller's number, not a valuation and not a price anybody paid.",
    "\"Under the trait floor\" compares this ask to the dearest trait it carries. It says the listing is worth a look, never that it is underpriced: the trait floor may itself be an outlier, and rarity is not demand.",
      ]
    : [
        `No trait comparison was made: ${staleSides.join(" and ")}. A percentage under a trait floor is only true if both sides were read just now, so the asks are shown as they are. Ask again in a minute for the comparison.`,
      ];
  if (unpricedListings) {
    readThis.push(`${unpricedListings} listing${unpricedListings === 1 ? "" : "s"} carried no usable price and ${unpricedListings === 1 ? "is" : "are"} listed last, unpriced, rather than treated as free.`);
  }
  if (traitsUnmatched) {
    readThis.push(
      `${traitsUnmatched} trait value${traitsUnmatched === 1 ? "" : "s"} on these listings had no entry in the venue's trait index, usually because nothing else carrying ${traitsUnmatched === 1 ? "it is" : "them is"} listed. Those traits have no floor here rather than a floor of zero.`,
    );
  }
  if (!deals.some((d) => d.rarity)) {
    readThis.push("No rarity ranks came back for these listings. Magic Eden echoes third-party ranks only where a provider covers the collection, and Metaplex Core collections are typically uncovered - absent ranks are not a sign of anything.");
  }
  return { deals, unpricedListings, traitsMatched, traitsUnmatched, comparison, readThis };
}

// ----------------------------------------------------------- name search

export interface NameMatch {
  symbol: string;
  name: string;
  score: number;
  why: string;
  categories: string[];
  isBadged: boolean;
  hasCNFTs: boolean;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => normalise(s).split(" ").filter(Boolean);

/**
 * Find the symbol behind a name a person typed.
 *
 * Every venue call needs a symbol, and a collector says "Mad Lads" or "MLB
 * gold series". Scoring is deliberately explainable - each match carries why
 * it matched - because the failure that costs money is confidently returning
 * the wrong collection, and a caller that can see "matched 2 of 4 words" knows
 * to confirm rather than proceed.
 */
export function findByName(index: MeCollectionIndexEntry[], query: string): NameMatch[] {
  const q = normalise(String(query ?? ""));
  if (!q) return [];
  const qWords = words(q);
  const out: NameMatch[] = [];

  for (const c of Array.isArray(index) ? index : []) {
    if (!c || typeof c.symbol !== "string" || !c.symbol) continue;
    // Both fields are venue-supplied text that reaches a model, so both are
    // cleaned before scoring and before being returned.
    const symbol = clean(c.symbol);
    const name = clean(c.name ?? "");
    if (!symbol) continue;
    const nSymbol = normalise(symbol);
    const nName = normalise(name);

    let score = 0;
    let why = "";
    if (nSymbol === q) {
      score = 100;
      why = "exact symbol";
    } else if (nName === q) {
      score = 95;
      why = "exact name";
    } else if (nName.startsWith(q) || nSymbol.startsWith(q)) {
      score = 80;
      why = "name or symbol starts with the query";
    } else {
      const hay = `${nName} ${nSymbol}`;
      const hayWords = new Set(words(hay));
      const hit = qWords.filter((w) => hayWords.has(w)).length;
      if (hit === qWords.length && qWords.length > 0) {
        score = 70;
        why = `every query word appears (${hit} of ${qWords.length})`;
      } else if (hit > 0 && hit * 2 >= qWords.length) {
        // Half the query has to land. One shared word out of four is almost
        // always a generic one ("collection", "series", "2026") and offering
        // those as candidates is how a caller ends up querying the wrong
        // collection with confidence.
        score = Math.round((hit / qWords.length) * 50);
        why = `matched ${hit} of ${qWords.length} query words`;
      } else if (hay.includes(q)) {
        score = 30;
        why = "query appears inside the name";
      }
    }
    if (score <= 0) continue;
    // A shorter name containing the query is more likely the thing meant than
    // a long one that happens to include the words. Exact matches are left
    // alone so the scale tops out at 100 and a reader can trust what 100 means.
    if (score < 90 && nName.length && nName.length < 40) score += 2;
    out.push({
      symbol,
      name,
      score,
      why,
      categories: Array.isArray(c.categories) ? c.categories.map((x) => clean(x)).filter(Boolean) : [],
      isBadged: c.isBadged === true,
      hasCNFTs: c.hasCNFTs === true,
    });
  }

  return out.sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, 25);
}

// ------------------------------------------------------------ names + serials

/**
 * The serial printed in a name: "Shohei Ohtani (12/250)", "Claynosaurz #9",
 * "12/250". Null when the name carries none. The edition size is kept when
 * present because "#12" of 250 and "#12" of 15 are different rarities.
 */
export function parseSerial(name: string | null | undefined): { serial: number; of: number | null } | null {
  if (typeof name !== "string" || !name) return null;
  const s = name.trim();

  // 1. An explicit terminal "#N" wins outright.
  //
  // "Batman (2011/2016) #10041" is issue 10041 of a run that happens to carry
  // a year range in brackets. Reading the bracket as a fraction returned
  // serial 2011 of 2016 and ranked that listing above the real #1 in
  // lowest-serial mode, which is a wrong answer presented as a find. A hash
  // that ends the name is unambiguous, so it is tried first.
  const trailingHash = s.match(/#\s*(\d{1,7})\s*$/);
  if (trailingHash) {
    // "#12 / 250" at the end still carries its edition size.
    const withSize = s.match(/#\s*(\d{1,6})\s*\/\s*(\d{1,7})\s*$/);
    if (withSize) return { serial: Number(withSize[1]), of: Number(withSize[2]) };
    return { serial: Number(trailingHash[1]), of: null };
  }

  // "#12/250" anywhere: the hash makes the fraction a serial, not a date.
  const hashFrac = s.match(/#\s*(\d{1,6})\s*\/\s*(\d{1,7})/);
  if (hashFrac) return { serial: Number(hashFrac[1]), of: Number(hashFrac[2]) };

  // 2. "N of M" spelled out - unambiguous wherever it appears.
  const ofForm = s.match(/\b(\d{1,6})\s+of\s+(\d{1,7})\b/i);
  if (ofForm) return { serial: Number(ofForm[1]), of: Number(ofForm[2]) };

  // 3. A bare "N/M" only when it is the LAST numeric thing in the name.
  //
  // A slash fraction is the weakest signal: it is also how dates, year ranges
  // and set sizes are written. Accepting it only in the serial position - the
  // tail of the name, optionally inside brackets - keeps "(12/250)" and
  // "12/250" working while refusing "(2011/2016) #10041" and "2011/2016 Prizm
  // Panini #5".
  const bareFrac = s.match(/\(?\s*(\d{1,6})\s*\/\s*(\d{1,7})\s*\)?\s*$/);
  if (bareFrac) return { serial: Number(bareFrac[1]), of: Number(bareFrac[2]) };

  // 4. A non-terminal "#N" last: it is still explicit, just less certain about
  // being the serial than a terminal one.
  const hash = s.match(/#\s*(\d{1,7})\b/);
  if (hash) return { serial: Number(hash[1]), of: null };
  return null;
}

/** "Shohei Ohtani (12/250)" -> "Shohei Ohtani": the name without its serial, for grouping. */
export function baseName(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name
    .replace(/\(\s*#?\d{1,6}\s*\/\s*\d{1,7}\s*\)/g, "")
    .replace(/#\s*\d{1,7}\s*\/\s*\d{1,7}/g, "")
    .replace(/#\s*\d{1,7}\b/g, "")
    .replace(/\b\d{1,6}\s+of\s+\d{1,7}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s.length ? s : null;
}

export interface NameBreakdownRow {
  name: string;
  sales: number;
  volumeSol: number;
  highestSol: number | null;
  lowestSol: number | null;
}

/**
 * Sales grouped by the item's base name (player, character, issue), so
 * "which player sold the most this week" is one read. Events without a
 * resolved name are counted, never dropped.
 */
export function breakdownByName(
  events: MeCollectionActivity[],
  names: Map<string, { name: string | null }>,
  limit = 15,
): { rows: NameBreakdownRow[]; unnamedSales: number; distinctNames: number } {
  const acc = new Map<string, NameBreakdownRow>();
  let unnamed = 0;
  for (const e of events) {
    if (e.type !== "buyNow") continue;
    const nm = e.tokenMint ? baseName(names.get(e.tokenMint)?.name) : null;
    if (!nm) {
      unnamed++;
      continue;
    }
    const price = usablePrice(e.price);
    const row = acc.get(nm) ?? { name: nm, sales: 0, volumeSol: 0, highestSol: null, lowestSol: null };
    row.sales++;
    if (price !== null) {
      row.volumeSol = Math.round((row.volumeSol + price) * 1e9) / 1e9;
      row.highestSol = row.highestSol === null ? price : Math.max(row.highestSol, price);
      row.lowestSol = row.lowestSol === null ? price : Math.min(row.lowestSol, price);
    }
    acc.set(nm, row);
  }
  const rows = [...acc.values()].sort((a, b) => b.sales - a.sales || b.volumeSol - a.volumeSol).slice(0, limit);
  return { rows, unnamedSales: unnamed, distinctNames: acc.size };
}
