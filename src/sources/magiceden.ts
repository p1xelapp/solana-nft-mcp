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

const BASE = "https://api-mainnet.magiceden.dev/v2";
const HEADERS = {
  "User-Agent": "collector-mcp/1.0 (+https://github.com/p1xelapp/collector-mcp)",
  Accept: "application/json",
};

// 600ms between calls ≈ 1.6 req/s, under ME's ~2/s public allowance.
const gate = rateLimiter(600);

async function me<T>(path: string): Promise<T> {
  return fetchJson<T>("Magic Eden", `${BASE}${path}`, { headers: HEADERS }, { gate });
}

/** A page must be an array; anything else is an outage or a shape change, never "no more results". */
function page<T>(what: string, batch: unknown): T[] {
  if (!Array.isArray(batch)) throw new Error(`Magic Eden returned an unexpected shape for ${what} (outage or API change)`);
  return batch as T[];
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

export async function collectionStats(symbol: string, opts: { fresh?: boolean } = {}) {
  const read = () => me<MeStats>(`/collections/${encodeURIComponent(symbol)}/stats`);
  // `fresh` = the venue's answer now (coalesced and committed, never a stale
  // fallback), for verifications.
  const { data, stale, cachedAt } = await cached(`me:stats:${symbol}`, 60_000, read, { fresh: opts.fresh });
  if (!data || data.symbol === undefined) {
    throw new Error(`Magic Eden has no collection with symbol "${symbol}"`);
  }
  // HTTP 200 != exists: ME echoes unknown symbols back as {symbol, listedCount: 0}.
  // A real-but-quiet collection still carries volumeAll; a phantom carries nothing.
  if (data.floorPrice === undefined && data.volumeAll === undefined) {
    // Only an explicit 404 on the metadata means "no such collection"; an
    // outage during this second read must not turn a quiet collection into a phantom.
    let meta: MeCollectionMeta | null = null;
    try {
      meta = await collectionMeta(symbol);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
    if (!meta?.name) {
      throw new Error(
        `Magic Eden has no collection with symbol "${symbol}" (try search_collections, or pass a Core collection address)`,
      );
    }
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
  const { data, stale, cachedAt } = await cached(`me:sales:${symbol}:${limit}`, 30_000, async () => {
    const collected: MeActivity[] = [];
    let scanned = 0;
    for (let pageNo = 0; pageNo < 5 && collected.length < limit; pageNo++) {
      const batch = page<MeActivity>(
        "collection activities",
        await me<unknown>(`/collections/${encodeURIComponent(symbol)}/activities?offset=${pageNo * 100}&limit=100`),
      );
      if (batch.length === 0) break;
      scanned += batch.length;
      collected.push(...batch.filter((a) => a.type === "buyNow" && typeof a.price === "number"));
      if (batch.length < 100) break;
    }
    return { collected, scanned };
  });
  if (!Array.isArray(data.collected)) throw new Error(`Magic Eden returned no activity for "${symbol}"`);
  const sales = data.collected
    .slice(0, limit)
    .map((a) => ({
      time: a.blockTime ? new Date(a.blockTime * 1000).toISOString() : null,
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
    note:
      sales.length < limit
        ? `only ${sales.length} sales in the last ${data.scanned} activity events - a quiet or listing-heavy market, not an error`
        : undefined,
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
    if (e instanceof HttpError && /blocked nft owner/i.test(e.reason)) {
      throw new Error(
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
      image: t.image ?? null,
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
      if (batch.length === 0) break;
      all.push(...batch);
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
 */
export async function walletTokensAll(wallet: string, max: number) {
  const { data, stale, cachedAt } = await cached(`me:wall:${wallet}:${max}`, 120_000, async () => {
    const all: MeWalletToken[] = [];
    let offset = 0;
    while (offset < max) {
      let batch: MeWalletToken[];
      try {
        batch = page<MeWalletToken>(
          "wallet tokens",
          await me<unknown>(`/wallets/${wallet}/tokens?offset=${offset}&limit=${Math.min(500, max - offset)}&listedOnly=false`),
        );
      } catch (e) {
        if (e instanceof HttpError && /blocked nft owner/i.test(e.reason)) {
          throw new Error(
            `Magic Eden will not list holdings for ${wallet} - it is a marketplace escrow or program account, not a user wallet.`,
          );
        }
        throw e;
      }
      if (batch.length === 0) break;
      all.push(...batch);
      // A page under 100 is the end whether ME honoured limit=500 or silently
      // capped at 100; anything else means keep walking, so a cap can never
      // truncate a wallet while reporting capped:false.
      if (batch.length < 100) break;
      offset += batch.length;
    }
    return all;
  });
  return { tokens: data, capped: data.length >= max, stale, cachedAt };
}
