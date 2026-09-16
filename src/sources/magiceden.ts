/**
 * Magic Eden public v2 API - keyless, read-only marketplace data.
 *
 * TOS note: ME's public Solana API is free at ~2 req/sec and their API terms
 * license read access for building apps. We pace every call through one gate,
 * cache aggressively, and identify ourselves with a real User-Agent. Being a
 * polite client is a feature: it is what keeps a zero-key server viable.
 */

import { cached, fetchJson, HttpError, rateLimiter } from "../lib/http.js";
import { clean } from "../lib/untrusted.js";
import { appendAll, assertPageSize, isCollectionSymbol, objectRows } from "../lib/shapes.js";
import { NotFoundError, EscrowError } from "../lib/errors.js";
import { isoFromBlockTime } from "../lib/time.js";
import { isBase58Address } from "./solana.js";

const BASE = "https://api-mainnet.magiceden.dev/v2";
const HEADERS = {
  "User-Agent": "collector-mcp/1.0 (+https://github.com/p1xelapp/collector-mcp)",
  Accept: "application/json",
};

// 600ms between calls ≈ 1.6 req/s, under ME's ~2/s public allowance.
const gate = rateLimiter(600, "Magic Eden");

async function me<T>(path: string, signal?: AbortSignal, opts: { background?: boolean } = {}): Promise<T> {
  return fetchJson<T>("Magic Eden", `${BASE}${path}`, { headers: HEADERS }, { gate, signal, background: opts.background });
}

/**
 * A page must be an array OF OBJECTS; anything else is an outage or a shape
 * change, never "no more results". A single `null` row used to reach the
 * mappers and crash them mid-answer.
 */
function page<T>(what: string, batch: unknown): T[] {
  return objectRows<T>("Magic Eden", what, batch);
}

const LAMPORTS = 1_000_000_000;
const sol = (lamports: unknown): number | null =>
  typeof lamports === "number" ? lamports / LAMPORTS : null;

export interface MeStats {
  symbol: string;
  floorPrice?: number;
  listedCount?: number;
  volumeAll?: number;
  avgPrice24hr?: number;
}

/**
 * What a caller is told when Magic Eden does not list the symbol at all.
 *
 * One constant because five tools say it and a reader must be able to match
 * the sentence across them.
 */
export const SYMBOL_UNKNOWN_MESSAGE =
  "Magic Eden has no collection with this symbol; search_collections resolves a name to a symbol";

export interface SymbolKnowledge {
  known: boolean;
  /** Exactly which reads this verdict rests on, in the venue's own terms. */
  checked: string;
}

/**
 * Does Magic Eden list this symbol at all?
 *
 * HTTP 200 is not existence: the venue echoes an unknown symbol back as
 * `{symbol, listedCount: 0}`, so a made-up collection came back through four
 * market tools as real and quiet - zero sales, zero listings, no traders, with
 * a note calling it "a quiet or listing-heavy market, not an error". The
 * project's own integration recipe warns about this trap; the guard was
 * missing.
 *
 * Three reads can establish PRESENCE - the stats echo carrying a floor or a
 * lifetime volume, the collection metadata carrying a name, or one page of the
 * unfiltered activity feed carrying any event at all (a collection that
 * launched an hour ago trades before it has stats). An ABSENCE needs the two
 * reads that are actually dependable to both come back readable and empty: the
 * stats echo and the activity feed. Either of those failing for any reason
 * other than a 404 propagates, because an outage must never become "no such
 * collection".
 *
 * The metadata endpoint is deliberately NOT allowed to veto: Magic Eden
 * rate-limits `/collections/{symbol}` far harder than the rest of v2 and
 * answers 429 for perfectly real collections for minutes at a time. Letting
 * that read fail the whole check would mean every market tool erroring during
 * a rate limit; letting it grant absence would mean trusting a read that did
 * not happen. So it can only ever say yes, and `checked` says whether it
 * answered.
 *
 * Cached for ten minutes: a symbol that exists does not stop existing, and the
 * stats read is the same one the caller is about to make anyway.
 */
export async function symbolKnowledge(symbol: string, opts: { signal?: AbortSignal } = {}): Promise<SymbolKnowledge> {
  const { data } = await cached<SymbolKnowledge>(
    `me:symbol-known:${symbol}`,
    10 * 60_000,
    async (producer) => {
      const enc = encodeURIComponent(symbol);
      let stats: MeStats | null = null;
      try {
        stats = await me<MeStats>(`/collections/${enc}/stats`, producer);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      if (stats && (stats.floorPrice !== undefined || stats.volumeAll !== undefined)) {
        return { known: true, checked: "Magic Eden's collection stats carry a floor or a lifetime volume for this symbol" };
      }
      let metaRead = "its collection metadata returned no name";
      try {
        const meta = await collectionMeta(symbol);
        if (meta?.name) return { known: true, checked: "Magic Eden's collection metadata carries a name for this symbol" };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) metaRead = "its collection metadata answered 404";
        else metaRead = `its collection metadata could not be read (${e instanceof Error ? e.message.slice(0, 120) : String(e)}), so that layer proves nothing either way`;
      }
      const acts = page<MeActivity>(
        "collection activities",
        await me<unknown>(`/collections/${enc}/activities?offset=0&limit=1`, producer),
      );
      if (acts.length > 0) return { known: true, checked: "Magic Eden's activity feed carries at least one event for this symbol" };
      return {
        known: false,
        checked: `Magic Eden's collection stats returned an empty echo, its activity feed returned no events at all, and ${metaRead}`,
      };
    },
    { signal: opts.signal },
  );
  return data;
}

/** The boolean, for callers that only branch on it. */
export async function symbolIsKnown(symbol: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  return (await symbolKnowledge(symbol, opts)).known;
}

/** The same check, as a refusal. Throws the typed not-found the wording layer reads. */
export async function assertSymbolKnown(symbol: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
  if (!(await symbolIsKnown(symbol, opts))) throw new NotFoundError(SYMBOL_UNKNOWN_MESSAGE);
}

export async function collectionStats(symbol: string, opts: { fresh?: boolean; signal?: AbortSignal } = {}) {
  // The FETCH runs on the cache's producer signal, not the caller's: this one
  // read is shared by every caller asking for the same symbol, and a status
  // probe's 12 s deadline must not cancel a floor request that joined it. The
  // caller's own signal ends only the caller's WAIT.
  const read = (producer: AbortSignal) => me<MeStats>(`/collections/${encodeURIComponent(symbol)}/stats`, producer);
  // `fresh` = the venue's answer now (coalesced and committed, never a stale
  // fallback), for verifications.
  const { data, stale, cachedAt } = await cached(`me:stats:${symbol}`, 60_000, read, { fresh: opts.fresh, signal: opts.signal });
  if (!data || data.symbol === undefined) {
    throw new NotFoundError(`Magic Eden has no collection with symbol "${symbol}"`);
  }
  // HTTP 200 != exists: ME echoes unknown symbols back as {symbol, listedCount: 0}.
  // A real-but-quiet collection still carries volumeAll; a phantom carries nothing.
  // One helper owns the phantom check, so the five market tools that now run it
  // before reading a feed cannot drift from what this function decides.
  if (data.floorPrice === undefined && data.volumeAll === undefined) {
    await assertSymbolKnown(symbol, { signal: opts.signal });
  }
  return {
    symbol: data.symbol,
    floorPriceSol: sol(data.floorPrice),
    listedCount: data.listedCount ?? null,
    // ME reports volumeAll in SOL for some collections and lamports for
    // others historically; current v2 returns SOL. Label the unit explicitly.
    volumeAllSol: typeof data.volumeAll === "number" ? data.volumeAll : null,
    avgPrice24hSol: sol(data.avgPrice24hr),
    stale,
    cachedAt,
    source: "magiceden",
  };
}

interface MeCollectionMeta {
  symbol: string;
  name?: string;
  description?: string;
  image?: string;
  twitter?: string;
  website?: string;
}

export async function collectionMeta(symbol: string) {
  const { data } = await cached(`me:meta:${symbol}`, 3_600_000, () =>
    me<MeCollectionMeta>(`/collections/${encodeURIComponent(symbol)}`),
  );
  return data;
}

interface MeActivity {
  signature?: string;
  type?: string;
  source?: string;
  tokenMint?: string;
  collection?: string;
  buyer?: string;
  seller?: string;
  price?: number; // SOL
  blockTime?: number;
}

/**
 * Recent completed sales (buyNow) for a collection, newest first.
 *
 * The activity feed has no server-side type filter and busy collections can
 * show pages of listings/bids between sales, so we walk up to 5 pages (paced
 * by the shared gate) until we have `limit` sales - and report how much
 * activity we scanned so thin results are explainable, never mysterious.
 */
export async function recentSales(symbol: string, limit: number) {
  const { data, stale, cachedAt } = await cached(`me:sales:v2:${symbol}:${limit}`, 30_000, async () => {
    const collected: MeActivity[] = [];
    let scanned = 0;
    // type=buyNow makes the venue do the filtering: on a busy collection the
    // unfiltered feed is thousands of listings per sale, and five pages of it
    // found one sale for Mad Lads. The filtered feed reaches months back.
    for (let pageNo = 0; pageNo < 5 && collected.length < limit; pageNo++) {
      const batch = page<MeActivity>(
        "collection activities",
        await me<unknown>(`/collections/${encodeURIComponent(symbol)}/activities?offset=${pageNo * 100}&limit=100&type=buyNow`),
      );
      assertPageSize("Magic Eden", "collection activities", batch, 100);
      if (batch.length === 0) break;
      scanned += batch.length;
      appendAll(collected, batch.filter((a) => a.type === "buyNow" && typeof a.price === "number"));
      if (batch.length < 100) break;
    }
    return { collected, scanned };
  });
  if (!Array.isArray(data.collected)) throw new Error(`Magic Eden returned no activity for "${symbol}"`);
  // One row with a block time Date cannot represent (1e20 has been served)
  // used to throw out of `toISOString` and take the other nine sales with it.
  // The guard answers null and the row is counted, not lost.
  let unusableTimestamps = 0;
  const sales = data.collected
    .slice(0, limit)
    .map((a) => {
      const time = isoFromBlockTime(a.blockTime);
      if (time === null && a.blockTime !== undefined && a.blockTime !== null) unusableTimestamps++;
      return { time, a };
    })
    .map(({ time, a }) => ({
      time,
      priceSol: a.price ?? null,
      tokenMint: a.tokenMint ?? null,
      buyer: a.buyer ?? null,
      seller: a.seller ?? null,
      marketplace: a.source ?? "magiceden",
      signature: a.signature ?? null,
    }));
  return {
    symbol,
    sales,
    activitiesScanned: data.scanned,
    // "A quiet or listing-heavy market" is a claim about a real collection, so
    // it may only be made about a feed that actually carried events. A symbol
    // the venue does not list scans nothing, and that sentence made a made-up
    // collection read as a real, quiet one.
    note:
      sales.length < limit
        ? data.scanned > 0
          ? `only ${sales.length} sales in the last ${data.scanned} activity events - a quiet or listing-heavy market, not an error`
          : `Magic Eden's activity feed returned no events at all for "${symbol}" - that is the feed being empty, which is not the same as the market being quiet. Confirm the symbol with search_collections.`
        : undefined,
    ...(unusableTimestamps > 0
      ? {
          unusableTimestamps,
          timestampNote: `${unusableTimestamps} sale(s) carried a block time that cannot be represented as a date; the sale is kept with time: null rather than dropped.`,
        }
      : {}),
    stale,
    cachedAt,
    source: "magiceden",
  };
}

interface MeToken {
  mintAddress?: string;
  owner?: string;
  name?: string;
  collection?: string;
  collectionName?: string;
  image?: string;
  attributes?: { trait_type?: string; value?: unknown }[];
  listStatus?: string;
  supply?: number;
}

/** Token metadata + marketplace view of one asset. Null when ME doesn't know it. Carries cache freshness. */
export async function token(mint: string): Promise<(MeToken & { stale: boolean; cachedAt: string }) | null> {
  const { data, stale, cachedAt } = await cached(`me:token:${mint}`, 300_000, async () => {
    try {
      const t = await me<MeToken>(`/tokens/${mint}`);
      // HTTP 200 with no mint address is a shape change or an outage page,
      // not "ME does not know it".
      if (!t || typeof t !== "object" || typeof t.mintAddress !== "string") {
        throw new Error("Magic Eden returned an unexpected token shape (outage or API change)");
      }
      return t;
    } catch (e) {
      // Only a documented not-found is "ME does not know it". Timeouts, rate
      // limits and outages must surface, or an outage reads as "no such token".
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  });
  return data && data.mintAddress ? { ...data, stale, cachedAt } : null;
}

/** Wallet holdings as Magic Eden sees them (indexed collections only). */
export async function walletTokens(wallet: string, limit: number) {
  let hit;
  try {
    hit = await cached(`me:wallet:${wallet}:${Math.min(limit, 100)}`, 120_000, () =>
      me<MeToken[]>(`/wallets/${wallet}/tokens?offset=0&limit=${Math.min(limit, 100)}&listedOnly=false`),
    );
  } catch (e) {
    // ME refuses this endpoint for its own escrow/program accounts. That is
    // the common case for an address taken from provenance: a listed item's
    // on-chain owner IS the marketplace escrow, not the seller. Say so,
    // because "HTTP 400" sends the agent hunting for a bug that isn't there.
    if (e instanceof HttpError && e.status === 400 && /blocked nft owner/i.test(e.reason)) {
      throw new EscrowError(
        `Magic Eden will not list holdings for ${wallet} - it blocks this address, ` +
          `which usually means it is a marketplace escrow or program account rather than ` +
          `a user wallet. If you got this address from get_asset_provenance, the item is ` +
          `most likely listed for sale and held in escrow; the seller is the wallet that ` +
          `transferred it in.`,
      );
    }
    throw e;
  }
  const { data, stale, cachedAt } = hit;
  if (!Array.isArray(data)) throw new Error("Magic Eden returned an unexpected wallet shape");
  return {
    wallet,
    count: data.length,
    capped: data.length >= Math.min(limit, 100),
    tokens: data.map((t) => ({
      mint: t.mintAddress ?? null,
      name: t.name ? clean(t.name) : null,
      collection: t.collection ?? null,
      collectionName: t.collectionName ? clean(t.collectionName) : null,
      // A link is venue text like any other. Only https survives: a
      // javascript: or private-network URL in a gallery is an injection.
      image: typeof t.image === "string" && /^https:\/\//.test(t.image) ? t.image : null,
      listed: t.listStatus === "listed",
    })),
    stale,
    cachedAt,
    source: "magiceden",
  };
}

// ------------------------------------------------------------ wallet views

export interface MeWalletActivity {
  signature?: string;
  type?: string;
  source?: string;
  tokenMint?: string;
  collection?: string;
  collectionSymbol?: string;
  blockTime?: number;
  buyer?: string;
  seller?: string;
  price?: number; // SOL
}

/**
 * Marketplace activity for a wallet as Magic Eden records it, newest first.
 *
 * Covers what happened on Magic Eden (listings, delists, bids, buys, AMM pool
 * updates). It does NOT see plain wallet-to-wallet transfers, airdrops, or
 * trades on other venues - callers must say so rather than present this as
 * the wallet's whole life. Up to `pages` * 100 events.
 */
export async function walletActivities(wallet: string, pages: number) {
  const { data, stale, cachedAt } = await cached(`me:wact:${wallet}:${pages}`, 60_000, async () => {
    const all: MeWalletActivity[] = [];
    for (let p = 0; p < pages; p++) {
      const batch = page<MeWalletActivity>("wallet activities", await me<unknown>(`/wallets/${wallet}/activities?offset=${p * 100}&limit=100`));
      assertPageSize("Magic Eden", "wallet activities", batch, 100);
      if (batch.length === 0) break;
      appendAll(all, batch);
      if (batch.length < 100) break;
    }
    return all;
  });
  return { events: data, truncated: data.length >= pages * 100, stale, cachedAt };
}

export interface MeWalletToken {
  mintAddress?: string;
  name?: string;
  collection?: string;
  collectionName?: string;
  image?: string;
  listStatus?: string;
  isCompressed?: boolean;
  sellerFeeBasisPoints?: number;
  updateAuthority?: string;
  supply?: number;
}

/**
 * Every collectible Magic Eden indexes for a wallet, paged 500 at a time up
 * to `max`. Escrow/program accounts are refused by ME (see walletTokens).
 *
 * Offset pages OVERLAP when the wallet changes mid-walk: an item that arrives
 * during the read pushes the last row of one page onto the start of the next.
 * Reproduced 2026-09-15 with two shifting pages: 150 rows for 149 distinct
 * mints, reported as a complete count. So rows are deduplicated on a validated
 * mint, the overlap is counted, and the caller is told that a walk which
 * overlapped can have SKIPPED an item by the same shift - deduplication fixes
 * the inflation, it cannot recover the omission.
 */
export async function walletTokensAll(wallet: string, max: number) {
  const { data, stale, cachedAt } = await cached(`me:wall:v2:${wallet}:${max}`, 120_000, async () => {
    const tokens: MeWalletToken[] = [];
    const seen = new Set<string>();
    let rawRows = 0;
    let overlap = 0;
    let offset = 0;
    while (offset < max) {
      let batch: MeWalletToken[];
      try {
        batch = page<MeWalletToken>(
          "wallet tokens",
          await me<unknown>(`/wallets/${wallet}/tokens?offset=${offset}&limit=${Math.min(500, max - offset)}&listedOnly=false`),
        );
      } catch (e) {
        if (e instanceof HttpError && e.status === 400 && /blocked nft owner/i.test(e.reason)) {
          throw new EscrowError(
            `Magic Eden will not list holdings for ${wallet} - it is a marketplace escrow or program account, not a user wallet.`,
          );
        }
        throw e;
      }
      assertPageSize("Magic Eden", "wallet tokens", batch, Math.min(500, max - offset));
      if (batch.length === 0) break;
      rawRows += batch.length;
      for (const t of batch) {
        // Only a mint that IS a mint can identify a row. A row without one is
        // kept as its own item, because dropping it would hide a holding.
        const mint = typeof t.mintAddress === "string" && isBase58Address(t.mintAddress) ? t.mintAddress : null;
        if (mint !== null) {
          if (seen.has(mint)) {
            overlap++;
            continue;
          }
          seen.add(mint);
        }
        tokens.push(t);
      }
      // A page under 100 is the end whether ME honoured limit=500 or silently
      // capped at 100; anything else means keep walking, so a cap can never
      // truncate a wallet while reporting capped:false.
      if (batch.length < 100) break;
      offset += batch.length;
    }
    return { tokens, rawRows, overlap };
  });
  return {
    tokens: data.tokens,
    // The cap is judged on what the venue SENT, not on what survived
    // deduplication, so an overlapping walk that hit the ceiling still says so.
    capped: data.rawRows >= max,
    /** Rows the venue repeated across pages, removed here. Non-zero means the wallet moved during the read. */
    overlap: data.overlap,
    stale,
    cachedAt,
  };
}

// ------------------------------------------- collection market intelligence

/**
 * The activity types Magic Eden accepts on the collection feed.
 *
 * This list is not cosmetic. The `type` filter is NOT validated upstream: a
 * value ME does not recognise is dropped and the UNFILTERED feed comes back
 * with HTTP 200, so asking for "sale" or "sold" would quietly return listings,
 * bids and pool updates, and every sales figure derived from them would be
 * wrong while looking fine. Unknown types are refused here instead.
 * (Verified 2026-09-11: `type=bogusType` answered 200 with list/bid rows.)
 */
export const ACTIVITY_TYPES = [
  "buyNow",
  "buy",
  "list",
  "delist",
  "bid",
  "cancelBid",
  "auctionCreated",
  "auctionUpdated",
  "auctionCanceled",
  "auctionSettled",
  "auctionPlaceBid",
  "poolUpdate",
  "mint",
  "transfer",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * One row of the collection activity feed.
 *
 * `price` is SOL and is the only price field worth reading. `priceInfo
 * .solPrice.rawAmount` is scaled inconsistently between endpoints: on
 * activities it carries 18 decimal places while the sibling `decimals` field
 * says 9 (0.04 SOL arrives as "40000000000000000"), on listings it is genuine
 * lamports. Dividing it by 1e9 as the field advertises overstates an activity
 * price a billionfold, so we never touch it.
 */
export interface MeCollectionActivity {
  signature?: string;
  type?: string;
  source?: string;
  tokenMint?: string;
  collection?: string;
  collectionSymbol?: string;
  slot?: number;
  blockTime?: number;
  buyer?: string;
  seller?: string;
  price?: number;
  /** Not on the activity feed; carried so a caller that joined token metadata can pass a name through. */
  name?: string;
}

/** ME's ceiling on the activity feed; limit=501 is a 400. */
const ACTIVITY_PAGE = 500;

export interface CollectionActivityRead {
  events: MeCollectionActivity[];
  /** True when full pages were still coming and we stopped on budget: older activity exists. */
  truncated: boolean;
  pagesRead: number;
  oldestSeen: number | null;
  newestSeen: number | null;
  stale: boolean;
  cachedAt: string;
}

/**
 * Collection activity, newest first, paged until the caller's window is
 * covered or the page budget runs out.
 *
 * Pages are cached individually: page 0 turns over constantly while page 6 is
 * settled history, and one cache entry for the whole walk would throw the
 * settled pages away every minute.
 */
export async function collectionActivities(
  symbol: string,
  opts: { types?: ActivityType[]; maxPages: number; sinceUnix?: number },
): Promise<CollectionActivityRead> {
  const types = opts.types ?? [];
  for (const t of types) {
    if (!(ACTIVITY_TYPES as readonly string[]).includes(t)) {
      throw new Error(`"${String(t)}" is not a Magic Eden activity type. Use one of: ${ACTIVITY_TYPES.join(", ")}.`);
    }
  }
  const budget = Math.max(1, Math.floor(opts.maxPages));
  // Comma-delimited is the only accepted form; repeating `type=` is a 400.
  const filter = types.length ? `&type=${types.map((t) => encodeURIComponent(t)).join(",")}` : "";
  const events: MeCollectionActivity[] = [];
  let pagesRead = 0;
  let oldestSeen: number | null = null;
  let newestSeen: number | null = null;
  let truncated = false;
  let stale = false;
  let cachedAt = new Date().toISOString();

  for (let p = 0; p < budget; p++) {
    const offset = p * ACTIVITY_PAGE;
    const hit = await cached(
      `me:cact:${symbol}:${types.join(",")}:${offset}:${ACTIVITY_PAGE}`,
      60_000,
      () =>
        me<unknown>(
          `/collections/${encodeURIComponent(symbol)}/activities?offset=${offset}&limit=${ACTIVITY_PAGE}${filter}`,
        ),
    );
    const batch = page<MeCollectionActivity>("collection activities", hit.data);
    assertPageSize("Magic Eden", "collection activities", batch, ACTIVITY_PAGE);
    stale = stale || hit.stale;
    // Pages are cached separately, so a walk mixes a page fetched now with one
    // fetched 55 seconds ago. The answer is only as fresh as its stalest page;
    // reporting the newest would overstate it.
    if (hit.cachedAt < cachedAt) cachedAt = hit.cachedAt;
    pagesRead++;
    appendAll(events, batch);
    for (const a of batch) {
      if (typeof a.blockTime !== "number") continue;
      if (oldestSeen === null || a.blockTime < oldestSeen) oldestSeen = a.blockTime;
      if (newestSeen === null || a.blockTime > newestSeen) newestSeen = a.blockTime;
    }
    // A short page is the end of what ME will serve, not a budget cut.
    if (batch.length < ACTIVITY_PAGE) {
      truncated = false;
      break;
    }
    // Newest-first: once a page reaches past the caller's window there is
    // nothing older left to want.
    if (opts.sinceUnix !== undefined && oldestSeen !== null && oldestSeen <= opts.sinceUnix) {
      truncated = false;
      break;
    }
    // Full page and still inside the window: history continues past our budget.
    truncated = true;
  }

  return { events, truncated, pagesRead, oldestSeen, newestSeen, stale, cachedAt };
}

/**
 * ME caps the listings endpoint at 100 per page even though the activity and
 * collection endpoints take 500. Asking for more is a 400, not a silent cap.
 */
const LISTING_PAGE_MAX = 100;

export type ListingSort = "listPrice" | "updatedAt";
export type SortDirection = "asc" | "desc";

/** One trait constraint. Several are combined with AND (see collectionListings). */
export interface TraitFilter {
  traitType: string;
  value: string;
}

export interface MeListing {
  pdaAddress?: string;
  tokenMint?: string;
  tokenAddress?: string;
  seller?: string;
  price?: number; // SOL
  expiry?: number;
  listingSource?: string;
  rarity?: {
    howrare?: { rank?: number };
    moonrank?: { rank?: number; absolute_rarity?: number };
  };
  token?: {
    name?: string;
    collection?: string;
    collectionName?: string;
    attributes?: { trait_type?: string; value?: unknown }[];
    sellerFeeBasisPoints?: number;
  };
}

export interface CollectionListingsRead {
  listings: MeListing[];
  /** True when the page came back full: there are more listings past what was asked for. */
  more: boolean;
  /**
   * True when the venue answered with a SHORT page.
   *
   * That is the venue saying it has nothing further to serve for this filter -
   * which is not the same as this being every listing that exists. A faulty or
   * hostile venue can return 99 rows for offset zero while holding thousands
   * more, so this flag is reported as what it is (the venue's report) and
   * never as proof of complete coverage.
   */
  venueReportedEnd: boolean;
  requestedLimit: number;
  appliedLimit: number;
  /** Where in the collection's listing order this page started. */
  offset: number;
  stale: boolean;
  cachedAt: string;
}

/**
 * Live listings for a collection, cheapest first by default.
 *
 * Trait filtering: ME reads `attributes` as an array of groups, AND across
 * groups and OR inside one. Verified 2026-09-11 - two groups asking for two
 * values of the same trait returned zero rows (nothing is both), while one
 * group holding a Species and a Class returned items matching either. Each
 * filter gets its own group here, so several filters mean "all of these",
 * which is what a collector asking for a trait combination means.
 */
export async function collectionListings(
  symbol: string,
  opts: { attributes?: TraitFilter[]; limit: number; offset?: number; sort?: ListingSort; direction?: SortDirection },
): Promise<CollectionListingsRead> {
  const requestedLimit = Math.max(1, Math.floor(opts.limit));
  const appliedLimit = Math.min(requestedLimit, LISTING_PAGE_MAX);
  // The endpoint caps a PAGE at 100, so reaching listing 101 means paging, not
  // a bigger limit. `offset` is what lets a name search walk past the first page.
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const sort: ListingSort = opts.sort ?? "listPrice";
  const direction: SortDirection = opts.direction ?? "asc";
  const filters = opts.attributes ?? [];
  for (const f of filters) {
    if (!f || typeof f.traitType !== "string" || typeof f.value !== "string" || !f.traitType || !f.value) {
      throw new Error("Each trait filter needs a non-empty traitType and value.");
    }
  }
  const attrParam = filters.length
    ? `&attributes=${encodeURIComponent(JSON.stringify(filters.map((f) => [{ traitType: f.traitType, value: f.value }])))}`
    : "";
  // Canonical JSON of sorted PAIRS, never a joined string: a trait value
  // containing the separators ("b|c=d") would otherwise build the same key as
  // two separate filters, and the second caller would be served the first
  // caller's listings.
  const canonicalFilters = JSON.stringify(
    filters
      .map((f) => [f.traitType, f.value] as const)
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  );
  const key = `me:clist:${symbol}:${offset}:${appliedLimit}:${sort}:${direction}:${canonicalFilters}`;
  const { data, stale, cachedAt } = await cached(key, 30_000, () =>
    me<unknown>(
      `/collections/${encodeURIComponent(symbol)}/listings?offset=${offset}&limit=${appliedLimit}&sort=${sort}&sort_direction=${direction}${attrParam}`,
    ),
  );
  const listings = page<MeListing>("collection listings", data);
  assertPageSize("Magic Eden", "collection listings", listings, appliedLimit);
  const more = listings.length >= appliedLimit;
  return { listings, more, venueReportedEnd: !more, requestedLimit, appliedLimit, offset, stale, cachedAt };
}

export interface MeAvailableAttribute {
  attribute?: { trait_type?: string; value?: unknown };
  count?: number;
  /** Lamports on this endpoint, unlike the `price` fields elsewhere on the same API. */
  floor?: number;
  countByListingType?: Record<string, number>;
}

export interface TraitFloor {
  traitType: string;
  value: string;
  listedCount: number;
  floorSol: number | null;
}

export interface CollectionAttributesRead {
  symbol: string;
  attributes: TraitFloor[];
  stale: boolean;
  cachedAt: string;
}

/**
 * Every trait value ME currently has a listing for, with the cheapest ask
 * carrying it.
 *
 * `floor` here is lamports while `price` on the sibling endpoints is SOL.
 * Converting once, here, keeps that trap in one place.
 */
export async function collectionAttributes(symbol: string): Promise<CollectionAttributesRead> {
  const { data, stale, cachedAt } = await cached(`me:cattr:${symbol}`, 300_000, () =>
    me<{ results?: { symbol?: string; availableAttributes?: unknown } }>(
      `/collections/${encodeURIComponent(symbol)}/attributes`,
    ),
  );
  // This endpoint wraps its array; a missing wrapper is an outage, not "no traits".
  if (!data || typeof data !== "object" || !data.results) {
    throw new Error(`Magic Eden returned an unexpected shape for ${symbol} attributes (outage or API change)`);
  }
  const rows = page<MeAvailableAttribute>("collection attributes", data.results.availableAttributes ?? []);
  return {
    symbol: clean(data.results.symbol ?? symbol),
    attributes: rows
      .filter((r) => r.attribute && typeof r.attribute.trait_type === "string")
      .map((r) => ({
        traitType: clean(r.attribute?.trait_type),
        value: clean(r.attribute?.value),
        listedCount: typeof r.count === "number" ? r.count : 0,
        floorSol: sol(r.floor),
      })),
    stale,
    cachedAt,
  };
}

export interface MeLeaderboardRow {
  wallet?: string;
  /** Lamports. */
  totalVolume?: number;
  lastTradeAt?: number;
}

export interface LeaderboardRead {
  symbol: string;
  traders: { wallet: string; volumeSol: number | null; lastTradeAt: string | null }[];
  stale: boolean;
  cachedAt: string;
  caveat: string;
}

/** Biggest traders of a collection as Magic Eden counts them: its own fills only. */
export async function collectionLeaderboard(symbol: string, limit: number): Promise<LeaderboardRead> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const { data, stale, cachedAt } = await cached(`me:clead:${symbol}:${n}`, 300_000, () =>
    me<unknown>(`/collections/${encodeURIComponent(symbol)}/leaderboard?limit=${n}`),
  );
  const rows = page<MeLeaderboardRow>("collection leaderboard", data);
  return {
    symbol,
    traders: rows
      .filter((r): r is MeLeaderboardRow & { wallet: string } => typeof r.wallet === "string")
      .map((r) => ({
        wallet: r.wallet,
        volumeSol: sol(r.totalVolume),
        lastTradeAt: typeof r.lastTradeAt === "number" ? new Date(r.lastTradeAt * 1000).toISOString() : null,
      })),
    stale,
    cachedAt,
    caveat:
      "Volume counted by Magic Eden across its own order book and AMM pools. Trades on Tensor, OpenSea or peer-to-peer are not in it, so this ranks Magic Eden activity, not a collection's whole trading.",
  };
}

export const POPULAR_TIME_RANGES = ["1h", "1d", "7d", "30d"] as const;
export type PopularTimeRange = (typeof POPULAR_TIME_RANGES)[number];

export interface PopularCollectionsRead {
  timeRange: PopularTimeRange;
  collections: Record<string, unknown>[];
  /** Set when the endpoint answered but had nothing to say, so a caller never reads empty as "nothing is trading". */
  note?: string;
  stale: boolean;
  cachedAt: string;
}

/**
 * Magic Eden's own trending list.
 *
 * `limit` is not free-form: ME rejects anything but 50 or 100. As of
 * 2026-09-11 every valid timeRange answers HTTP 200 with an empty array, so an
 * empty result means the venue published nothing, not that the market is
 * quiet. The note says so rather than letting a caller invent the second
 * reading.
 */
export async function popularCollections(timeRange: PopularTimeRange): Promise<PopularCollectionsRead> {
  if (!(POPULAR_TIME_RANGES as readonly string[]).includes(timeRange)) {
    throw new Error(`Magic Eden accepts only ${POPULAR_TIME_RANGES.join(", ")} for a popularity window.`);
  }
  const { data, stale, cachedAt } = await cached(`me:pop:${timeRange}`, 300_000, () =>
    me<unknown>(`/marketplace/popular_collections?timeRange=${timeRange}&limit=50`),
  );
  const rows = page<Record<string, unknown>>("popular collections", data);
  return {
    timeRange,
    collections: rows,
    note: rows.length
      ? undefined
      : "Magic Eden's trending endpoint answered but returned no collections. That is the venue publishing nothing for this window, not evidence that trading stopped - read a collection's own stats or activity feed instead.",
    stale,
    cachedAt,
  };
}

export interface MeCollectionIndexEntry {
  symbol?: string;
  name?: string;
  description?: string;
  twitter?: string;
  discord?: string;
  website?: string;
  categories?: string[];
  isBadged?: boolean;
  hasCNFTs?: boolean;
  isOcp?: boolean;
}

/**
 * A directory row as this server is willing to hold it.
 *
 * The venue's raw row carries a description, socials and categories - none of
 * which name resolution needs, all of which are attacker-authored, and 500 of
 * which per page across 80 pages is gigabytes retained for a day outside any
 * bounded cache. Rows are projected to these three fields the moment they
 * arrive; the raw payload is never retained.
 */
export interface DirectoryRow {
  /** Validated against the collection-symbol grammar; rows that fail it are dropped. */
  symbol: string;
  /** Neutralised and capped: a directory name is minter-adjacent text that reaches a model. */
  name: string;
  isBadged: boolean;
}

/** Longest directory name kept. Real collection names are far shorter. */
const MAX_DIRECTORY_NAME = 120;
/** Rows accepted from one directory page. The venue's own page size is 500. */
const MAX_DIRECTORY_ROWS_PER_PAGE = 500;
/** Rows retained across the whole walk. The reachable catalogue is ~30,500. */
const MAX_DIRECTORY_ROWS_TOTAL = 40_000;

export interface CollectionsIndexRead {
  collections: DirectoryRow[];
  /** True when OUR page budget ran out first: this is a prefix, not the catalogue. */
  partial: boolean;
  /** True when Magic Eden refused to page further. Everything past its offset ceiling is unreachable here at any budget. */
  atVenuePagingLimit: boolean;
  pagesRead: number;
  /** Directory rows dropped because their "symbol" did not obey the symbol grammar. */
  rowsRejected: number;
  stale: boolean;
  cachedAt: string;
}

/** ME's ceiling on the collection list; 501 is a 400. */
const INDEX_PAGE = 500;
/**
 * Past offset 30,000 the collection list answers 400 - a hard paging ceiling,
 * not the end of the data. ME blames it on "offset and limit must be a
 * multiple of 20", which is untrue (30,500 is a multiple of 500 and still
 * fails), so the message must not be relayed to a user as a request error on
 * our side. Recognising it here turns an exception into a clean stop.
 */
const isPagingCeiling = (e: unknown): boolean =>
  e instanceof HttpError && e.status === 400 && /multiple of/i.test(e.reason);

/**
 * Magic Eden's collection catalogue, for turning a name a person typed into
 * the symbol the API needs.
 *
 * Sizing this matters more than it looks. The reachable catalogue is 30,500
 * entries over 61 pages, and the big names sit deep in it - mad_lads at offset
 * 17,500, claynosaurz at 20,000 (measured 2026-09-11). A caller that budgets a
 * handful of pages will not find them and, without `partial`, would report
 * "no such collection" about the best-known collection on the venue. Cached
 * for a day because collections get added, not reshuffled, so the full 61-page
 * walk is paid once.
 */
export async function collectionsIndex(maxPages: number): Promise<CollectionsIndexRead> {
  const budget = Math.max(1, Math.floor(maxPages));
  const { data, stale, cachedAt } = await cached(`me:cindex:${budget}`, 86_400_000, async () => {
    const collections: DirectoryRow[] = [];
    let partial = false;
    let atVenuePagingLimit = false;
    let pagesRead = 0;
    let rowsRejected = 0;
    for (let p = 0; p < budget; p++) {
      let batch: MeCollectionIndexEntry[];
      try {
        batch = page<MeCollectionIndexEntry>(
          "collection index",
          // The directory walk is 61 pages nobody is waiting on. It yields its
          // turn to any question a person actually asked, which is what stops a
          // cold start putting 36 seconds of queue in front of the first one.
          await me<unknown>(`/collections?offset=${p * INDEX_PAGE}&limit=${INDEX_PAGE}`, undefined, { background: true }),
        );
      } catch (e) {
        if (isPagingCeiling(e) && collections.length > 0) {
          atVenuePagingLimit = true;
          partial = false;
          break;
        }
        throw e;
      }
      assertPageSize("Magic Eden", "collection index", batch, MAX_DIRECTORY_ROWS_PER_PAGE);
      pagesRead++;
      // Project HERE, before anything is retained. A row that fails the symbol
      // grammar is not an identifier and is counted rather than carried.
      for (const raw of batch) {
        if (collections.length >= MAX_DIRECTORY_ROWS_TOTAL) break;
        if (!isCollectionSymbol(raw.symbol)) {
          rowsRejected++;
          continue;
        }
        collections.push({
          symbol: raw.symbol,
          name: clean(raw.name ?? "").slice(0, MAX_DIRECTORY_NAME),
          isBadged: raw.isBadged === true,
        });
      }
      if (collections.length >= MAX_DIRECTORY_ROWS_TOTAL) {
        partial = true;
        break;
      }
      if (batch.length < INDEX_PAGE) {
        partial = false;
        break;
      }
      partial = true;
    }
    return { collections, partial, atVenuePagingLimit, pagesRead, rowsRejected };
  });
  return { ...data, stale, cachedAt };
}
