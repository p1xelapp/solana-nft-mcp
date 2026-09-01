/**
 * Magic Eden public v2 API - keyless, read-only marketplace data.
 *
 * TOS note: ME's public Solana API is free at ~2 req/sec and their API terms
 * license read access for building apps. We pace every call through one gate,
 * cache aggressively, and identify ourselves with a real User-Agent. Being a
 * polite client is a feature: it is what keeps a zero-key server viable.
 */

import { cached, fetchJson, HttpError, rateLimiter } from "../lib/http.js";

const BASE = "https://api-mainnet.magiceden.dev/v2";
const HEADERS = {
  "User-Agent": "collector-mcp/1.0 (+https://github.com/p1xelapp/collector-mcp)",
  Accept: "application/json",
};

// 600ms between calls ≈ 1.6 req/s, under ME's ~2/s public allowance.
const gate = rateLimiter(600);

async function me<T>(path: string): Promise<T> {
  await gate();
  return fetchJson<T>("Magic Eden", `${BASE}${path}`, { headers: HEADERS });
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

export async function collectionStats(symbol: string) {
  const { data, stale, cachedAt } = await cached(`me:stats:${symbol}`, 60_000, () =>
    me<MeStats>(`/collections/${encodeURIComponent(symbol)}/stats`),
  );
  if (!data || data.symbol === undefined) {
    throw new Error(`Magic Eden has no collection with symbol "${symbol}"`);
  }
  // HTTP 200 != exists: ME echoes unknown symbols back as {symbol, listedCount: 0}.
  // A real-but-quiet collection still carries volumeAll; a phantom carries nothing.
  if (data.floorPrice === undefined && data.volumeAll === undefined) {
    const meta = await collectionMeta(symbol).catch(() => null);
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
    for (let page = 0; page < 5 && collected.length < limit; page++) {
      const batch = await me<MeActivity[]>(
        `/collections/${encodeURIComponent(symbol)}/activities?offset=${page * 100}&limit=100`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
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

/** Token metadata + marketplace view of one asset. Null when ME doesn't know it. */
export async function token(mint: string): Promise<MeToken | null> {
  const { data } = await cached(`me:token:${mint}`, 300_000, async () => {
    try {
      return await me<MeToken>(`/tokens/${mint}`);
    } catch {
      return null; // ME 404s tokens it has never indexed - not an error for us
    }
  });
  return data && data.mintAddress ? data : null;
}

/** Wallet holdings as Magic Eden sees them (indexed collections only). */
export async function walletTokens(wallet: string, limit: number) {
  let hit;
  try {
    hit = await cached(`me:wallet:${wallet}`, 120_000, () =>
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
      name: t.name ?? null,
      collection: t.collection ?? null,
      collectionName: t.collectionName ?? null,
      image: t.image ?? null,
      listed: t.listStatus === "listed",
    })),
    stale,
    cachedAt,
    source: "magiceden",
  };
}
