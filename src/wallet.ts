/**
 * Wallet intelligence - the questions collectors actually ask about an address.
 *
 * "What do they hold most of? How much of the supply is that? Do they flip or
 * hold? Which venue do they use? How old is the wallet? What is it worth?"
 *
 * Everything in this file is pure: it takes the raw feeds the sources return
 * and derives answers, so the logic is testable offline against captured
 * fixtures. The rule throughout is to label what a number is - a floor times
 * a count is a CEILING, not a value; a Magic Eden feed is Magic Eden's view,
 * not the wallet's whole life - because the wrong label is the expensive bug.
 */

import type { MeWalletActivity, MeWalletToken } from "./sources/magiceden.js";
import type { OsAccountEvent } from "./sources/opensea.js";
import { clean } from "./lib/untrusted.js";

/**
 * Lamport resolution (1e-9 SOL) by default, not the 3 decimals a summary can
 * afford to show. Card collections trade well under 0.01 SOL: at 3 decimals a
 * buy at 0.009644132 and a sell at 0.0098 both became 0.01 and the flip
 * reported a P&L of exactly zero - neither a win nor a loss. Nothing finer
 * than a lamport exists on Solana, so 9 places are lossless for real amounts
 * while still absorbing the float noise a long sum accumulates. Percentages
 * and day counts pass their own smaller `dp`.
 */
const round = (n: number, dp = 9) => Math.round(n * 10 ** dp) / 10 ** dp;
const iso = (t?: number) => (t ? new Date(t * 1000).toISOString() : null);

// ----------------------------------------------------------- holdings

export interface CollectionHolding {
  collection: string;
  name: string | null;
  count: number;
  shareOfWalletPct: number;
  listed: number;
  compressed: number;
  /** Creator royalty the metadata asks for, when every item agrees. */
  royaltyBps: number | null;
  sampleMints: string[];
}

export interface HoldingsSummary {
  totalItems: number;
  collections: number;
  listed: number;
  compressed: number;
  byCollection: CollectionHolding[];
  concentration: {
    topCollection: string | null;
    topCollectionPct: number;
    /** True when one collection is more than half the wallet. */
    concentrated: boolean;
  };
  unnamed: number;
}

export function summarizeHoldings(tokens: MeWalletToken[]): HoldingsSummary {
  const groups = new Map<string, MeWalletToken[]>();
  let unnamed = 0;
  for (const t of tokens) {
    // Marketplace-assigned, but still marketplace-controlled text: clean it.
    const key = t.collection ? clean(t.collection) : "(no collection)";
    if (!t.collection) unnamed++;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  const total = tokens.length;
  const byCollection: CollectionHolding[] = [...groups.entries()]
    .map(([collection, items]) => {
      const bps = new Set(items.map((i) => i.sellerFeeBasisPoints).filter((b): b is number => typeof b === "number"));
      return {
        collection,
        name: (() => {
          const n = items.find((i) => i.collectionName)?.collectionName;
          return n ? clean(n) : null;
        })(),
        count: items.length,
        shareOfWalletPct: total ? round((items.length / total) * 100, 1) : 0,
        listed: items.filter((i) => i.listStatus === "listed").length,
        compressed: items.filter((i) => i.isCompressed).length,
        royaltyBps: bps.size === 1 ? [...bps][0]! : null,
        sampleMints: items
          .slice(0, 3)
          .map((i) => i.mintAddress)
          .filter((m): m is string => Boolean(m)),
      };
    })
    .sort((a, b) => b.count - a.count);
  const top = byCollection[0];
  return {
    totalItems: total,
    collections: groups.size,
    listed: tokens.filter((t) => t.listStatus === "listed").length,
    compressed: tokens.filter((t) => t.isCompressed).length,
    byCollection,
    concentration: {
      topCollection: top?.collection ?? null,
      topCollectionPct: top?.shareOfWalletPct ?? 0,
      concentrated: Boolean(top && top.shareOfWalletPct > 50),
    },
    unnamed,
  };
}

// ----------------------------------------------------------- activity

export interface Flip {
  mint: string;
  collection: string | null;
  boughtAt: string | null;
  soldAt: string | null;
  buySol: number;
  sellSol: number;
  pnlSol: number;
  heldDays: number | null;
}

export interface ActivitySummary {
  window: { from: string | null; to: string | null; events: number; truncated: boolean };
  byType: Record<string, number>;
  venues: Record<string, number>;
  buys: { count: number; totalSol: number; collections: Record<string, number> };
  sells: { count: number; totalSol: number; collections: Record<string, number> };
  netFlowSol: number;
  topCollections: { collection: string; events: number }[];
  flips: Flip[];
  realized: {
    flips: number;
    pnlSol: number;
    wins: number;
    losses: number;
    best: Flip | null;
    worst: Flip | null;
    note: string;
  };
  behaviour: {
    /** Of the items bought in the window, how many were sold again inside it. */
    boughtThenSoldPct: number | null;
    medianHoldDays: number | null;
    label: "flipper" | "mixed" | "holder" | "seller" | "lister" | "quiet" | "unknown";
    why: string;
  };
  firstBuyInWindow: { mint: string; collection: string | null; time: string | null; priceSol: number } | null;
  caveats: string[];
}

/**
 * Magic Eden's wallet feed, read as a story about the wallet's behaviour.
 *
 * Buyer/seller fields tell us which side the wallet was on for a buyNow. An
 * event with neither matching is a pool (AMM) fill or a data gap; it is
 * counted in byType but not attributed as a buy or sell.
 */
export function summarizeActivity(
  wallet: string,
  events: MeWalletActivity[],
  truncated: boolean,
): ActivitySummary {
  const byType: Record<string, number> = {};
  const venues: Record<string, number> = {};
  const buys = { count: 0, totalSol: 0, collections: {} as Record<string, number> };
  const sells = { count: 0, totalSol: 0, collections: {} as Record<string, number> };
  const perCollection: Record<string, number> = {};
  // Per mint, a FIFO of buys not yet matched to a later sell, so a wallet that
  // buys, sells and re-buys the same item gets one flip per cycle.
  const openBuys = new Map<string, MeWalletActivity[]>();
  // Each flip is carried with its UNROUNDED delta: a win or a loss is decided
  // on the real difference, never on a displayed number that rounding can pull
  // to zero.
  const rows: { flip: Flip; delta: number }[] = [];
  let purchases = 0;
  let lists = 0;

  const bump = (r: Record<string, number>, k: string) => (r[k] = (r[k] ?? 0) + 1);

  // Feed is newest-first; walk oldest-first so "bought then sold" reads in time order.
  const chrono = [...events].reverse();
  for (const e of chrono) {
    const type = e.type ? clean(e.type) : "unknown";
    bump(byType, type);
    bump(venues, e.source ? clean(e.source) : "unknown");
    const rawCol = e.collectionSymbol ?? e.collection ?? null;
    const col = rawCol ? clean(rawCol) : null;
    if (col) bump(perCollection, col);
    if (type === "list") lists++;
    if (type === "buyNow" && typeof e.price === "number") {
      if (e.buyer === wallet) {
        buys.count++;
        buys.totalSol += e.price;
        if (col) bump(buys.collections, col);
        if (e.tokenMint) {
          purchases++;
          const q = openBuys.get(e.tokenMint);
          if (q) q.push(e);
          else openBuys.set(e.tokenMint, [e]);
        }
      } else if (e.seller === wallet) {
        sells.count++;
        sells.totalSol += e.price;
        if (col) bump(sells.collections, col);
        const q = e.tokenMint ? openBuys.get(e.tokenMint) : undefined;
        const buy = q?.shift();
        if (buy && buy.blockTime && e.blockTime && e.blockTime > buy.blockTime && e.tokenMint) {
          const delta = e.price - (buy.price ?? 0);
          rows.push({
            delta,
            flip: {
              mint: e.tokenMint,
              collection: col,
              boughtAt: iso(buy.blockTime),
              soldAt: iso(e.blockTime),
              buySol: round(buy.price ?? 0),
              sellSol: round(e.price),
              pnlSol: round(delta),
              heldDays: round((e.blockTime - buy.blockTime) / 86_400, 1),
            },
          });
        }
      }
    }
  }

  rows.sort((a, b) => (b.flip.soldAt ?? "").localeCompare(a.flip.soldAt ?? ""));
  const flips: Flip[] = rows.map((r) => r.flip);

  const holds = flips.map((f) => f.heldDays).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)]! : null;
  const boughtThenSoldPct = purchases ? round((flips.length / purchases) * 100, 1) : null;

  let label: ActivitySummary["behaviour"]["label"] = "unknown";
  let why = "";
  if (events.length === 0) {
    label = "quiet";
    why = "No Magic Eden activity on record for this wallet.";
  } else if (lists >= 5 && buys.count + sells.count <= Math.max(2, Math.floor(lists / 10))) {
    label = "lister";
    why = `${lists} listings against ${buys.count + sells.count} completed trades in the window - inventory being offered, not traded.`;
  } else if (sells.count >= 5 && sells.count >= buys.count * 3) {
    label = "seller";
    why = `${sells.count} sells against ${buys.count} buys in the window - distributing inventory that was minted, transferred in, or bought earlier.`;
  } else if (boughtThenSoldPct !== null && purchases >= 3) {
    if (boughtThenSoldPct >= 50 && (medianHold ?? 0) < 14) {
      label = "flipper";
      why = `${flips.length} of ${purchases} purchases were resold inside the window, median hold ${medianHold} days.`;
    } else if (boughtThenSoldPct <= 15) {
      label = "holder";
      why = `Only ${flips.length} of ${purchases} purchases were resold inside the window.`;
    } else {
      label = "mixed";
      why = `${flips.length} of ${purchases} purchases resold, median hold ${medianHold ?? "n/a"} days.`;
    }
  } else if (buys.count + sells.count > 0) {
    label = "mixed";
    why = `${buys.count} buys and ${sells.count} sells in the window - too few purchases to call a pattern.`;
  }

  const firstBuy = chrono.find((e) => e.type === "buyNow" && e.buyer === wallet && typeof e.price === "number");
  const firstBuyCol = firstBuy?.collectionSymbol ?? firstBuy?.collection ?? null;

  const caveats = [
    "This is Magic Eden's view of the wallet: listings, bids, buys and sells that touched Magic Eden or its AMM pools. Trades on Tensor or OpenSea, plain transfers, mints and airdrops are not in this feed.",
    "Realised P&L here is sale price minus purchase price for items both bought and sold in the window, before marketplace fees and royalties. It is a lower bound on cost, not an accounting.",
  ];
  if (truncated) caveats.push("The feed was cut at the page limit; older activity exists. Raise `pages` to see more.");
  if (sells.count > 0 && purchases === 0) caveats.push("Sells without matching buys usually means the items were minted, transferred in, or bought before the window started.");

  return {
    window: { from: iso(chrono[0]?.blockTime), to: iso(events[0]?.blockTime), events: events.length, truncated },
    byType,
    venues,
    buys: { ...buys, totalSol: round(buys.totalSol) },
    sells: { ...sells, totalSol: round(sells.totalSol) },
    netFlowSol: round(sells.totalSol - buys.totalSol),
    topCollections: Object.entries(perCollection)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([collection, n]) => ({ collection, events: n })),
    flips: flips.slice(0, 25),
    // Totals run over every flip, not the 25 shown, so "how much has this
    // wallet made" does not silently shrink with the display cap.
    realized: {
      flips: rows.length,
      pnlSol: round(rows.reduce((s, r) => s + r.delta, 0)),
      // Classified on the real difference. A 0.00016 SOL gain is a win on a
      // card that cost 0.0096; rounding it away invents a break-even.
      wins: rows.filter((r) => r.delta > 0).length,
      losses: rows.filter((r) => r.delta < 0).length,
      best: rows.length ? rows.reduce((a, b) => (b.delta > a.delta ? b : a)).flip : null,
      worst: rows.length ? rows.reduce((a, b) => (b.delta < a.delta ? b : a)).flip : null,
      note: "Sale minus purchase for items both bought and sold inside the window, before fees and royalties, Magic Eden feed only. Amounts are shown to lamport resolution (9 decimals); wins and losses are decided on the unrounded difference.",
    },
    behaviour: { boughtThenSoldPct, medianHoldDays: medianHold, label, why },
    firstBuyInWindow: firstBuy
      ? {
          mint: firstBuy.tokenMint ?? "",
          collection: firstBuyCol ? clean(firstBuyCol) : null,
          time: iso(firstBuy.blockTime),
          priceSol: round(firstBuy.price ?? 0),
        }
      : null,
    caveats,
  };
}

// ------------------------------------------------------ OpenSea events

export interface OpenSeaWalletView {
  events: number;
  truncated: boolean;
  bought: number;
  sold: number;
  transfersIn: number;
  transfersOut: number;
  /** Items that arrived by plain transfer with no sale recorded for them: gift, airdrop, self-transfer, or a trade elsewhere. */
  receivedWithoutSale: { mint: string; collection: string | null; from: string; time: string | null }[];
  collections: Record<string, number>;
  caveat: string;
}

export function summarizeOpenSeaEvents(wallet: string, events: OsAccountEvent[], truncated: boolean): OpenSeaWalletView {
  let bought = 0;
  let sold = 0;
  let tin = 0;
  let tout = 0;
  const collections: Record<string, number> = {};
  // A sale's own settlement shows up as a transfer in the same transaction.
  // Match on the transaction, not the mint: an item bought in March and
  // handed over by plain transfer in August is a real transfer-in.
  const saleTxs = new Set<string>();
  for (const e of events) {
    if (e.event_type === "sale") {
      if (e.buyer === wallet) bought++;
      if (e.seller === wallet) sold++;
      if (e.transaction) saleTxs.add(e.transaction);
    }
    if (e.nft?.collection) collections[e.nft.collection] = (collections[e.nft.collection] ?? 0) + 1;
  }
  const received: OpenSeaWalletView["receivedWithoutSale"] = [];
  for (const e of events) {
    if (e.event_type !== "transfer") continue;
    if (e.to_address === wallet) {
      tin++;
      const id = e.nft?.identifier ?? "";
      const settlesASale = Boolean(e.transaction && saleTxs.has(e.transaction));
      if (id && !settlesASale && e.from_address && e.from_address !== wallet) {
        received.push({ mint: id, collection: e.nft?.collection ?? null, from: e.from_address, time: iso(e.event_timestamp) });
      }
    } else if (e.from_address === wallet) tout++;
  }
  return {
    events: events.length,
    truncated,
    bought,
    sold,
    transfersIn: tin,
    transfersOut: tout,
    receivedWithoutSale: received.slice(0, 25),
    collections,
    caveat:
      "OpenSea's account feed on Solana includes plain transfers, which Magic Eden's does not. A transfer-in with no sale can be a gift, an airdrop, a move between the owner's own wallets, or a purchase OpenSea did not see (e.g. a Magic Eden fill) - the chain records the movement, not the reason. OpenSea has also been observed labelling Magic Eden fills as its own sales.",
  };
}

// ------------------------------------------------- two-reader comparison

export interface ReaderCount {
  /** What this reader is called in the answer. */
  reader: string;
  /** Rows actually read, or null when the reader did not answer at all. */
  count: number | null;
  /** True when the reader stopped at a page/walk limit, so the count is a lower bound. */
  bounded: boolean;
  /** What to raise to read further, named for the caller. */
  raise?: string;
  /** True when this count came from cache after a failed refresh: it describes an earlier moment. */
  stale?: boolean;
  /** When this reader actually answered, for the sentence that says so. */
  readAt?: string;
}

export interface ReaderComparison {
  /** True only when both readers answered AND neither stopped at a limit. */
  comparable: boolean;
  /** The sentence to show. Null when neither reader answered. */
  note: string | null;
}

/**
 * Compare what two independent readers listed for one wallet.
 *
 * The trap: a wallet holds 100 items, the caller asks for 50, and both readers
 * return 50. "Both readers count the same number of items" is then a statement
 * about the page size, not about the wallet - and it reads as corroboration of
 * a total neither reader established. Counts are only compared when neither
 * side was cut off; otherwise they are named as items READ, a lower bound.
 *
 * The same applies to freshness: two cached lists can carry the same count
 * because neither reader answered, and that agreement is about the cache.
 */
export function compareReaderCounts(a: ReaderCount, b: ReaderCount): ReaderComparison {
  const answered = [a, b].filter((r) => r.count !== null);
  if (answered.length < 2) return { comparable: false, note: null };
  const bounded = [a, b].filter((r) => r.bounded);
  const describe = (r: ReaderCount) =>
    `${r.reader} listed ${r.count} item(s)${r.bounded ? ` and stopped at its limit${r.raise ? ` (raise ${r.raise} to read more)` : ""}` : ""}`;
  if (bounded.length > 0) {
    return {
      comparable: false,
      note:
        `${describe(a)}; ${describe(b)}. These are items READ, not totals: at least one reader stopped at a limit, ` +
        `so each number is a lower bound and the two cannot be compared to each other.`,
    };
  }
  if (a.count === b.count) {
    return {
      comparable: true,
      note: `Both readers listed ${a.count} item(s) and neither stopped at a limit, so they agree on what they can see. Coverage still differs: ${a.reader} only carries what it indexes, and ${b.reader} has undocumented coverage of its own.`,
    };
  }
  return {
    comparable: true,
    note:
      `${describe(a)}; ${describe(b)}. Neither index is complete on its own: a marketplace skips what it does not trade, ` +
      `the public asset index has undocumented coverage. Treat the larger count as the floor.`,
  };
}

// ----------------------------------------------------------- valuation

export interface FloorQuoteForValue {
  collection: string;
  count: number;
  floorSol: number | null;
  listedCount: number | null;
  /** True when the floor is a cached value from a failed refresh. */
  stale?: boolean;
  /** Why no floor: the upstream error, when there was one. */
  error?: string;
}

/**
 * Floor x count, presented as what it is. "Portfolio value" is the most
 * misused number in this hobby: the floor is one seller's ask, selling N items
 * into it moves it, and illiquid collections have a floor nobody has paid in
 * months. So this returns a CEILING with the assumptions spelled out, never a
 * "worth".
 */
export function floorCeiling(quotes: FloorQuoteForValue[], totalItems: number) {
  // A stale or failed quote cannot price anything "now": those items count as
  // unpriced and the reason is spelled out below.
  const priced = quotes.filter(
    (q) => !q.stale && !q.error && typeof q.floorSol === "number" && Number.isFinite(q.floorSol) && q.floorSol > 0 && Number.isFinite(q.count) && q.count > 0,
  );
  const failed = quotes.filter((q) => q.stale || q.error);
  const coveredItems = priced.reduce((s, q) => s + q.count, 0);
  const ceilingSol = round(priced.reduce((s, q) => s + (q.floorSol ?? 0) * q.count, 0));
  const thin = priced.filter((q) => (q.listedCount ?? 0) > 0 && q.count > (q.listedCount ?? 0) / 2);
  return {
    ceilingSol,
    itemsPriced: coveredItems,
    itemsUnpriced: Math.max(0, totalItems - coveredItems),
    perCollection: priced.map((q) => ({
      collection: q.collection,
      count: q.count,
      floorSol: q.floorSol,
      floorTimesCountSol: round((q.floorSol ?? 0) * q.count),
      listedOnVenue: q.listedCount,
    })),
    readThis: [
      "This is floor x count on Magic Eden at query time: the most the wallet could list for and still be the cheapest, not what it would realise.",
      `${Math.max(0, totalItems - coveredItems)} items had no Magic Eden floor (unindexed, no listings, or the collection was outside the priced set) and count as zero here.`,
      ...(thin.length
        ? [
            `${thin.map((q) => q.collection).join(", ")}: the wallet holds more than half as many items as are listed on the whole venue - selling would move the floor, so the ceiling is generous.`,
          ]
        : []),
      ...(failed.length
        ? [`${failed.map((q) => `${q.collection} (${q.stale ? "venue did not answer; last value not used" : q.error})`).join("; ")}: not priced.`]
        : []),
      "Recent sales, not floors, say what buyers pay. Use get_recent_sales on the collections that matter.",
    ],
  };
}
