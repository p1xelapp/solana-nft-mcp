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
import { accountEventFingerprint } from "./sources/opensea.js";
import { clean } from "./lib/untrusted.js";
import { knownVenueAccount } from "./sources/solana.js";
import { isoFromBlockTime, usableBlockTime } from "./lib/time.js";

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
// Never throws: a block time the Date type cannot represent (1e20 was served
// once) is null here, and the row it sits on is counted as unusable rather
// than costing the whole report (2026-09-18).
const iso = (t?: unknown) => isoFromBlockTime(t);

/**
 * A price this module will do arithmetic on.
 *
 * `typeof e.price === "number"` was not enough. A newest-first feed carrying a
 * buy at -1 and a sale at 1 reported 2 SOL of profit, and a single Infinity
 * turned every total, every flip and the whole realised P&L into Infinity or
 * NaN - a poisoned number presented with the same confidence as a real one.
 * Only a finite amount above zero is money; everything else is counted as a
 * malformed row and named, never summed.
 */
const usablePrice = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

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
  currency: "SOL";
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
  /** Every SOL figure in this object is denominated in this currency and read from this venue's API. */
  currency: "SOL";
  source: "magiceden";
  window: { from: string | null; to: string | null; events: number; truncated: boolean };
  byType: Record<string, number>;
  venues: Record<string, number>;
  buys: { count: number; totalSol: number; collections: Record<string, number> };
  sells: { count: number; totalSol: number; collections: Record<string, number> };
  netFlowSol: number;
  /** Fills with this wallet on both sides. Outside every total above. */
  selfFills: number;
  /** Money figures cover the trades this many SOL totals could actually be built from. */
  pricing: {
    /** Trade-shaped rows whose price was present but not a finite amount above zero. */
    malformedPrices: number;
    /** Trades whose repeated copies disagreed about the amount or a side. */
    unsettled: number;
    /** Buys and sells counted on their side but left out of every SOL total. */
    unpricedTrades: number;
    /** Rows whose blockTime was present but not a representable time. Their times are null; the rows still count. */
    unusableTimestamps: number;
  };
  topCollections: { collection: string; events: number }[];
  flips: Flip[];
  realized: {
    /** Buy-then-sell cycles where both prices and the order in time were usable: the only ones pnlSol is built from. */
    flips: number;
    /**
     * Buy-then-sell cycles of one item that closed inside the window but could
     * not be measured: a leg with no usable price, or two legs whose times
     * could not be ordered. They moved inventory, so they are matched and
     * counted here rather than left open to pair a later sale with the wrong
     * purchase (2026-09-18).
     */
    unmeasuredCycles: number;
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
    label: "flipper" | "mixed" | "holder" | "seller" | "lister" | "bidder" | "quiet" | "unknown";
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
  // buys, sells and re-buys the same item gets one flip per cycle. Every buy
  // of an item is a lot and every sell of it consumes one, whatever the price:
  // an unpriced sale used to leave its purchase open, so the next cycle's sale
  // was matched against the earlier, cheaper purchase and the profit of one
  // cycle was booked as the profit of two.
  const openBuys = new Map<string, { e: MeWalletActivity; price: number | null }[]>();
  // Each flip is carried with its UNROUNDED delta: a win or a loss is decided
  // on the real difference, never on a displayed number that rounding can pull
  // to zero.
  const rows: { flip: Flip; delta: number }[] = [];
  /** Buys of an identifiable item, priced or not. */
  let purchases = 0;
  /** Buy-then-sell cycles of one item that closed inside the window, measured or not. */
  let cyclesClosed = 0;
  let unmeasuredCycles = 0;
  let unusableTimestamps = 0;
  let lists = 0;
  /** Standing offers placed. A wallet that bids hundreds of times and buys three items is a bidder, not a "holder". */
  let bids = 0;
  /** Trade-shaped rows whose price field was present but not a finite amount above zero. */
  let malformedPrices = 0;
  /** Trades counted on their side but kept out of every SOL total, because no usable price survived. */
  let unpricedTrades = 0;
  /** Trades excluded from money because two copies of the row disagreed about the amount or a side. */
  let unsettledTrades = 0;
  /**
   * Fills where this wallet is BOTH buyer and seller. No money left or
   * entered the wallet, so they sit outside the buy and sell totals and the
   * net flow; buyer precedence used to book a 2 SOL self-fill as 2 SOL spent.
   */
  let selfFills = 0;

  // Own properties only: a venue-authored key such as "constructor" used to
  // read the inherited function and concatenate "1" onto its source text.
  const bump = (r: Record<string, number>, k: string) => (r[k] = (Object.hasOwn(r, k) ? r[k]! : 0) + 1);

  // Feed is newest-first; walk oldest-first so "bought then sold" reads in time order.
  const chrono = [...events].reverse();
  for (const e of chrono) {
    const type = e.type ? clean(e.type) : "unknown";
    if (e.blockTime !== undefined && e.blockTime !== null && usableBlockTime(e.blockTime) === null) unusableTimestamps++;
    bump(byType, type);
    bump(venues, e.source ? clean(e.source) : "unknown");
    const rawCol = e.collectionSymbol ?? e.collection ?? null;
    const col = rawCol ? clean(rawCol) : null;
    if (col) bump(perCollection, col);
    if (type === "list") lists++;
    if (type === "bid") bids++;
    if (type === "buyNow") {
      const rawPrice = (e as { price?: unknown }).price;
      const settled = (e as { unsettled?: boolean }).unsettled !== true;
      const parsed = usablePrice(rawPrice);
      if (parsed === null && rawPrice !== null && rawPrice !== undefined) malformedPrices++;
      // A row whose two copies disagreed about the amount or a side is a trade
      // that happened for an amount we cannot state, exactly like a missing
      // price: the side is counted, the money is not.
      if (!settled && parsed !== null) unsettledTrades++;
      const price = settled ? parsed : null;
      if (e.buyer === wallet && e.seller === wallet) {
        selfFills++;
        continue;
      }
      const side = e.buyer === wallet ? "buy" : e.seller === wallet ? "sell" : null;
      if (side && price === null) unpricedTrades++;
      if (side === "buy") {
        buys.count++;
        if (price !== null) buys.totalSol += price;
        if (col) bump(buys.collections, col);
        if (e.tokenMint) {
          purchases++;
          const lot = { e, price };
          const q = openBuys.get(e.tokenMint);
          if (q) q.push(lot);
          else openBuys.set(e.tokenMint, [lot]);
        }
      } else if (side === "sell") {
        sells.count++;
        if (price !== null) sells.totalSol += price;
        if (col) bump(sells.collections, col);
        // A sale consumes the oldest open lot of that item whatever its price:
        // inventory moved. P&L is arithmetic on two prices and two times, so
        // the cycle is measured only when all four are usable, and counted as
        // unmeasured otherwise rather than matched against a zero.
        const lot = e.tokenMint ? openBuys.get(e.tokenMint)?.shift() : undefined;
        if (lot && e.tokenMint) {
          cyclesClosed++;
          const boughtAt = usableBlockTime(lot.e.blockTime);
          const soldAt = usableBlockTime(e.blockTime);
          if (lot.price !== null && price !== null && boughtAt !== null && soldAt !== null && soldAt > boughtAt) {
            const delta = price - lot.price;
            rows.push({
              delta,
              flip: {
                currency: "SOL",
                mint: e.tokenMint,
                collection: col,
                boughtAt: iso(boughtAt),
                soldAt: iso(soldAt),
                buySol: round(lot.price),
                sellSol: round(price),
                pnlSol: round(delta),
                heldDays: round((soldAt - boughtAt) / 86_400, 1),
              },
            });
          } else unmeasuredCycles++;
        }
      }
    }
  }

  rows.sort((a, b) => (b.flip.soldAt ?? "").localeCompare(a.flip.soldAt ?? ""));
  const flips: Flip[] = rows.map((r) => r.flip);

  const holds = flips.map((f) => f.heldDays).filter((d): d is number => d !== null).sort((a, b) => a - b);
  // The median of an even-length sample is the mean of its two middle
  // values. Taking the upper one turned holds of 1 and 20 days into a median
  // of 20, and a flipper into "mixed".
  const medianHold =
    holds.length === 0
      ? null
      : holds.length % 2 === 1
        ? holds[(holds.length - 1) / 2]!
        : round((holds[holds.length / 2 - 1]! + holds[holds.length / 2]!) / 2, 1);
  // Resold means the cycle closed, measured or not: an unpriced resale is
  // still a resale.
  const boughtThenSoldPct = purchases ? round((cyclesClosed / purchases) * 100, 1) : null;

  let label: ActivitySummary["behaviour"]["label"] = "unknown";
  let why = "";
  if (events.length === 0) {
    label = "quiet";
    why = "No Magic Eden activity on record for this wallet.";
  } else if (bids >= 10 && bids >= 5 * (buys.count + sells.count)) {
    label = "bidder";
    why = `${bids} bids against ${buys.count + sells.count} completed trades in the window - standing offers below the ask, not buying at it. Labelled from what dominates the feed; the few trades it did complete are counted above.`;
  } else if (lists >= 5 && buys.count + sells.count <= Math.max(2, Math.floor(lists / 10))) {
    label = "lister";
    why = `${lists} listings against ${buys.count + sells.count} completed trades in the window - inventory being offered, not traded.`;
  } else if (sells.count >= 5 && sells.count >= buys.count * 3) {
    label = "seller";
    why = `${sells.count} sells against ${buys.count} buys in the window - distributing inventory that was minted, transferred in, or bought earlier.`;
  } else if (boughtThenSoldPct !== null && purchases >= 3) {
    if (boughtThenSoldPct >= 50 && (medianHold ?? 0) < 14) {
      label = "flipper";
      why = `${cyclesClosed} of ${purchases} purchases were resold inside the window, median hold ${medianHold ?? "n/a"} days.`;
    } else if (boughtThenSoldPct <= 15) {
      label = "holder";
      why = `Only ${cyclesClosed} of ${purchases} purchases were resold inside the window.`;
    } else {
      label = "mixed";
      why = `${cyclesClosed} of ${purchases} purchases resold, median hold ${medianHold ?? "n/a"} days.`;
    }
  } else if (buys.count + sells.count > 0) {
    label = "mixed";
    why = `${buys.count} buys and ${sells.count} sells in the window - too few purchases to call a pattern.`;
  } else {
    // Every other branch is a judgement with its reason. This one used to fall
    // through as the label "unknown" with an EMPTY reason, which is the one
    // combination a reader cannot act on: a wallet that listed and delisted
    // and never completed a trade is not mysterious, it just did not trade.
    label = "unknown";
    why =
      `No completed buys or sells in this window, so there is no pattern to label: the feed carried ` +
      `${events.length} event(s), ${lists} of them listings. Widen the window or read get_wallet_holdings for what it actually holds.`;
  }

  // The same predicate the loop uses: a self-fill is not a purchase, and it
  // was being reported as the first one.
  const firstBuy = chrono.find(
    (e) => e.type === "buyNow" && e.buyer === wallet && e.seller !== wallet && usablePrice(e.price) !== null && (e as { unsettled?: boolean }).unsettled !== true,
  );
  const firstBuyCol = firstBuy?.collectionSymbol ?? firstBuy?.collection ?? null;

  const caveats = [
    "This is Magic Eden's API feed for the wallet: listings, bids, buys and sells as Magic Eden indexed them. Each row names the execution venue Magic Eden reported for it (see venues); how completely that feed covers fills on other programs is not established, so a venue absent from it is unobserved here, not absent from the wallet's life. Plain transfers, mints and airdrops are never in it.",
    "Realised P&L here is sale price minus purchase price for items both bought and sold in the window, before marketplace fees and royalties. It is a lower bound on cost, not an accounting.",
  ];
  if (malformedPrices) {
    caveats.push(
      `${malformedPrices} trade-shaped row(s) carried a price that was not a finite amount above zero (negative, zero, or infinite). They are counted as trades on the side the wallet was on and excluded from every SOL total, flip and P&L figure rather than being summed.`,
    );
  }
  if (unsettledTrades) {
    caveats.push(
      `${unsettledTrades} trade(s) came back twice with a different price or a different buyer/seller, so no amount can be shown to be the right one. They are counted as trades and left out of the SOL totals and P&L.`,
    );
  }
  if (selfFills) {
    caveats.push(
      `${selfFills} fill(s) had this wallet as both buyer and seller. No SOL entered or left it on those, so they are outside the buy and sell counts, the totals and the net flow. A wallet filling its own listing is worth a look on its own.`,
    );
  }
  if (unpricedTrades) {
    caveats.push(
      `${unpricedTrades} of the buys and sells here carry no usable price: the counts include them, the SOL totals, net flow and realised P&L do not.`,
    );
  }
  if (unmeasuredCycles) {
    caveats.push(
      `${unmeasuredCycles} buy-then-sell cycle(s) closed in the window but could not be measured (a leg without a usable price, or two legs whose times could not be ordered). They are matched so that a later sale of the same item is paired with its own purchase, and they are outside pnlSol, wins and losses.`,
    );
  }
  if (unusableTimestamps) {
    caveats.push(`${unusableTimestamps} row(s) carried a blockTime that is not a representable time; their times are null and the rows still count.`);
  }
  if (truncated) caveats.push("The feed was cut at the page limit; older activity exists. Raise `pages` to see more.");
  if (sells.count > 0 && purchases === 0) caveats.push("Sells without matching buys usually means the items were minted, transferred in, or bought before the window started.");

  return {
    currency: "SOL",
    source: "magiceden",
    window: { from: iso(chrono[0]?.blockTime), to: iso(events[0]?.blockTime), events: events.length, truncated },
    byType,
    venues,
    buys: { ...buys, totalSol: round(buys.totalSol) },
    sells: { ...sells, totalSol: round(sells.totalSol) },
    netFlowSol: round(sells.totalSol - buys.totalSol),
    selfFills,
    pricing: { malformedPrices, unsettled: unsettledTrades, unpricedTrades, unusableTimestamps },
    topCollections: Object.entries(perCollection)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([collection, n]) => ({ collection, events: n })),
    flips: flips.slice(0, 25),
    // Totals run over every flip, not the 25 shown, so "how much has this
    // wallet made" does not silently shrink with the display cap.
    realized: {
      flips: rows.length,
      unmeasuredCycles,
      pnlSol: round(rows.reduce((s, r) => s + r.delta, 0)),
      // Classified on the real difference. A 0.00016 SOL gain is a win on a
      // card that cost 0.0096; rounding it away invents a break-even.
      wins: rows.filter((r) => r.delta > 0).length,
      losses: rows.filter((r) => r.delta < 0).length,
      best: rows.length ? rows.reduce((a, b) => (b.delta > a.delta ? b : a)).flip : null,
      worst: rows.length ? rows.reduce((a, b) => (b.delta < a.delta ? b : a)).flip : null,
      note: "Sale minus purchase for items both bought and sold inside the window, before fees and royalties, Magic Eden feed only. Amounts are shown to lamport resolution (9 decimals); wins and losses are decided on the unrounded difference. unmeasuredCycles are resales that closed but could not be priced or ordered; they are outside every figure here.",
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
  receivedWithoutSale: { mint: string; collection: string | null; from: string; time: string | null; note?: string }[];
  /** Items that LEFT by plain transfer with no sale recorded: consolidation, gift, or a trade elsewhere. Itemised, because a count alone left a reader unable to follow one. */
  sentWithoutSale: { mint: string; collection: string | null; to: string; time: string | null; note?: string }[];
  collections: Record<string, number>;
  /** Transfers in or out sharing a transaction with a sale that named no item: neither a settlement nor a gift can be proven. */
  settlementUncertain: number;
  /** Exact duplicate rows the feed served and this view dropped before counting. */
  duplicateRowsDropped: number;
  caveat: string;
}

export function summarizeOpenSeaEvents(wallet: string, rawEvents: OsAccountEvent[], truncated: boolean, duplicatesUpstream = 0): OpenSeaWalletView {
  // Exact copies are dropped here as well as in the reader, so a caller that
  // hands this function a feed of its own gets the same arithmetic: two
  // identical rows are one event, two rows that differ are two claims.
  const seen = new Set<string>();
  const events: OsAccountEvent[] = [];
  let duplicateRowsDropped = duplicatesUpstream;
  for (const e of rawEvents) {
    const id = accountEventFingerprint(e);
    if (seen.has(id)) {
      duplicateRowsDropped++;
      continue;
    }
    seen.add(id);
    events.push(e);
  }
  let bought = 0;
  let sold = 0;
  let tin = 0;
  let tout = 0;
  const collections: Record<string, number> = {};
  // A sale's own settlement shows up as a transfer in the same transaction
  // FOR THE SAME ITEM. Matching on the transaction alone hid a gift of item B
  // that shared a transaction with a sale of item A. A sale that names no
  // item cannot be matched to an item, so a transfer in its transaction is
  // uncertain: it is kept out of the list and counted, not silently either way.
  const saleKeys = new Set<string>();
  const itemlessSaleTxs = new Set<string>();
  for (const e of events) {
    if (e.event_type === "sale") {
      if (e.buyer === wallet) bought++;
      if (e.seller === wallet) sold++;
      if (e.transaction && e.nft?.identifier) saleKeys.add(`${e.transaction}\u0000${e.nft.identifier}`);
      else if (e.transaction) itemlessSaleTxs.add(e.transaction);
    }
    if (e.nft?.collection) collections[e.nft.collection] = (Object.hasOwn(collections, e.nft.collection) ? collections[e.nft.collection]! : 0) + 1;
  }
  const received: OpenSeaWalletView["receivedWithoutSale"] = [];
  const sent: OpenSeaWalletView["sentWithoutSale"] = [];
  let settlementUncertain = 0;
  for (const e of events) {
    if (e.event_type !== "transfer") continue;
    if (e.to_address === wallet) {
      tin++;
      const id = e.nft?.identifier ?? "";
      const settlesASale = Boolean(e.transaction && id && saleKeys.has(`${e.transaction}\u0000${id}`));
      if (e.transaction && !settlesASale && itemlessSaleTxs.has(e.transaction)) {
        settlementUncertain++;
        continue;
      }
      if (id && !settlesASale && e.from_address && e.from_address !== wallet) {
        received.push({ mint: id, collection: e.nft?.collection ?? null, from: e.from_address, time: iso(e.event_timestamp), ...(knownVenueAccount(e.from_address) ? { note: "from a Magic Eden escrow account: a fill or a delisting that OpenSea recorded as a plain transfer, not a gift" } : {}) });
      }
    } else if (e.from_address === wallet) {
      tout++;
      const id = e.nft?.identifier ?? "";
      const settlesASale = Boolean(e.transaction && id && saleKeys.has(`${e.transaction}\u0000${id}`));
      // The same uncertainty as the incoming side: a sale that names no item
      // in this transaction may be this transfer's settlement.
      if (e.transaction && !settlesASale && itemlessSaleTxs.has(e.transaction)) {
        settlementUncertain++;
        continue;
      }
      if (id && !settlesASale && e.to_address && e.to_address !== wallet) {
        sent.push({ mint: id, collection: e.nft?.collection ?? null, to: e.to_address, time: iso(e.event_timestamp), ...(knownVenueAccount(e.to_address) ? { note: "to a Magic Eden escrow account: a listing, not a sale or a gift" } : {}) });
      }
    }
  }
  return {
    events: events.length,
    truncated,
    bought,
    sold,
    transfersIn: tin,
    transfersOut: tout,
    receivedWithoutSale: received.slice(0, 25),
    sentWithoutSale: sent.slice(0, 25),
    collections,
    settlementUncertain,
    duplicateRowsDropped,
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
  const staleReaders = [a, b].filter((r) => r.stale === true);
  const describe = (r: ReaderCount) =>
    `${r.reader} listed ${r.count} item(s)${r.stale ? ` from cache after a failed refresh${r.readAt ? `, last answered ${r.readAt}` : ""}` : ""}${r.bounded ? ` and stopped at its limit${r.raise ? ` (raise ${r.raise} to read more)` : ""}` : ""}`;
  // A reader that did not answer is not a second opinion.
  //
  // Two cached lists can carry the same count because NEITHER reader answered,
  // and calling that agreement describes the cache, not the wallet. Freshness
  // is checked before the counts are ever compared.
  if (staleReaders.length > 0) {
    return {
      comparable: false,
      note:
        `${describe(a)}; ${describe(b)}. ` +
        `${staleReaders.length === 2 ? "Neither reader" : `${staleReaders[0]!.reader}`} answered for this read, so ${staleReaders.length === 2 ? "both counts are" : "that count is"} LAST-KNOWN rather than current. ` +
        `Counts that are not both current cannot corroborate each other - two cached lists agreeing is the cache agreeing with itself. Ask again in a minute.`,
    };
  }
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
export interface HoldingsCoverage {
  /** True when the holdings walk stopped at the caller's cap: totals are lower bounds over what was read. */
  capped: boolean;
  /** True when the holdings list came from cache after a failed refresh: it describes an earlier moment. */
  stale: boolean;
  /** When the holdings were actually read. */
  cachedAt?: string | null;
  /** What to raise to read further. */
  raise?: string;
}

/**
 * Is a holdings count from the chain's asset index a TOTAL?
 *
 * Only when the walk finished and every row the index served could be
 * identified. The trap this closes: a row carrying no id became a holding with
 * an empty mint, counted, and published with `countIsATotal: true` - a wrong
 * count carried with full confidence during an index outage. Dropped rows mean
 * the wallet holds things this count cannot name, so the figure is a floor.
 */
export const chainCountIsATotal = (truncated: boolean, rowsRejected: number): boolean => !truncated && rowsRejected === 0;

export function floorCeiling(
  quotes: FloorQuoteForValue[],
  totalItems: number,
  coverage: HoldingsCoverage = { capped: false, stale: false },
  floorsReadAt: string = new Date().toISOString(),
) {
  // A stale or failed quote cannot price anything "now": those items count as
  // unpriced and the reason is spelled out below.
  // Stale holdings cannot be multiplied by a live floor.
  //
  // The trap: the holdings refresh failed and returned a cached list of ten
  // items the wallet no longer owns, the floor requests succeeded live, and
  // the product was published as a present-tense ceiling. A ceiling is
  // arithmetic across two reads and is only about NOW if both of them are.
  // When the holdings are stale the figure is returned as last-known, stamped
  // with when the holdings were actually read.
  const holdingsStale = coverage.stale === true;
  const priced = quotes.filter(
    (q) => !q.stale && !q.error && typeof q.floorSol === "number" && Number.isFinite(q.floorSol) && q.floorSol > 0 && Number.isFinite(q.count) && q.count > 0,
  );
  const failed = quotes.filter((q) => q.stale || q.error);
  const coveredItems = priced.reduce((s, q) => s + q.count, 0);
  const ceilingSol = round(priced.reduce((s, q) => s + (q.floorSol ?? 0) * q.count, 0));
  const thin = priced.filter((q) => (q.listedCount ?? 0) > 0 && q.count > (q.listedCount ?? 0) / 2);
  // A capped walk saw part of the wallet. Everything derived from it is a
  // LOWER BOUND over the items observed, and the count of items we could not
  // price is unknowable rather than "total minus covered" - the total itself
  // was never established.
  const capped = coverage.capped === true;
  // Stale holdings x live floors is a figure about no moment that ever
  // existed: the counts are from one time, the prices from another, and
  // "last-known" was a label on a number nothing was ever worth. There is no
  // honest figure to publish, so none is - both read times and the reason are
  // returned instead, and the caller is told what to do about it.
  const mixedTime = holdingsStale;
  return {
    /** What this figure is. A stale read has no figure at all; a capped one is a lower bound. */
    basis: mixedTime
      ? "unavailable"
      : capped
        ? "lower-bound-over-observed-items"
        : "ceiling-at-query-time",
    /** Present-tense only when the holdings were current and complete; otherwise the lower-bound figure or nothing. */
    ceilingSol: mixedTime || capped ? null : ceilingSol,
    /** The arithmetic itself - withheld entirely when the two sides describe different moments. */
    figureSol: mixedTime ? null : ceilingSol,
    /**
     * The unit, stated rather than implied. Every figure here is SOL and this
     * server has no price feed, so a client that reads a bare number and
     * offers the user a dollar value is promising a conversion nothing here
     * can perform.
     */
    currency: "SOL" as const,
    fiatNote: "No fiat conversion is performed.",
    /** Why no figure is given, when none is. */
    unavailableReason: mixedTime
      ? `Magic Eden did not answer for this wallet's holdings, so the only counts available were read at ${coverage.cachedAt ?? "an unrecorded earlier time"} while the floors were read at ${floorsReadAt}. Multiplying those together would produce a figure that was never true at either moment, so no figure is given. Ask again in a minute.`
      : null,
    /** When the holdings behind this figure were actually read. */
    holdingsReadAt: coverage.cachedAt ?? null,
    /** When the floors this would have been multiplied by were read. */
    floorsReadAt,
    holdingsStale,
    holdingsCapped: capped,
    itemsPriced: coveredItems,
    // With a capped walk, "items we could not price" is unknown: the wallet's
    // real total was never read, so subtracting from the observed count would
    // report a number about a population nobody counted.
    itemsUnpriced: capped || mixedTime ? null : Math.max(0, totalItems - coveredItems),
    perCollection: mixedTime ? [] : priced.map((q) => ({
      collection: q.collection,
      count: q.count,
      floorSol: q.floorSol,
      floorTimesCountSol: round((q.floorSol ?? 0) * q.count),
      listedOnVenue: q.listedCount,
    })),
    readThis: [
      mixedTime
        ? `NO FIGURE: Magic Eden did not answer for the holdings themselves. The counts available were read at ${coverage.cachedAt ?? "an unrecorded earlier time"} and the floors at ${floorsReadAt}, and floor x a cached count is a number no moment ever held - the wallet may hold none of these items now. Ask again in a minute for a figure about the present.`
        : capped
          ? `A LOWER BOUND over the ${totalItems} items actually read: the holdings walk stopped at its cap${coverage.raise ? ` (raise ${coverage.raise} to read further)` : ""}, so items beyond it are absent from every figure here and the wallet's real total was never established.`
          : "This is floor x count on Magic Eden at query time: the most the wallet could list for and still be the cheapest, not what it would realise.",
      capped || mixedTime
        ? "How many items had no Magic Eden floor cannot be stated: that count needs a current holdings total this read did not establish."
        : `${Math.max(0, totalItems - coveredItems)} items had no Magic Eden floor (unindexed, no listings, or the collection was outside the priced set) and count as zero here.`,
      ...(thin.length
        ? [
            `${thin.map((q) => q.collection).join(", ")}: the wallet holds more than half as many items as are listed on the whole venue - selling would move the floor, so the ceiling is generous.`,
          ]
        : []),
      ...(failed.length
        ? [`${failed.map((q) => `${q.collection} (${q.stale ? "venue did not answer; last value not used" : q.error})`).join("; ")}: not priced.`]
        : []),
      "Every figure here is in SOL. No fiat conversion is performed: this server reads no price feed, so there is no dollar figure to give and none can be produced on a following turn.",
      "Recent sales, not floors, say what buyers pay. Use get_recent_sales on the collections that matter.",
    ],
  };
}
