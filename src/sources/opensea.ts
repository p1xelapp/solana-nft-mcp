/**
 * OpenSea v2 - OPTIONAL cross-marketplace source.
 *
 * Why it exists: Solana collections (Candy Digital, Mad Lads, Claynosaurz,
 * Collector Crypt) now also trade on OpenSea, so a Solana-only market view
 * undercounts liquidity. Why it is optional: OpenSea requires an API key.
 * This server's promise is zero-config, so OpenSea activates ONLY when the
 * user sets OPENSEA_API_KEY - and every tool degrades gracefully without it.
 * (OpenSea issues instant free keys via POST /api/v2/auth/keys - no signup -
 * but free keys expire within days; use a developer-portal key for real use.)
 */

import { cached, fetchJson, rateLimiter } from "../lib/http.js";

const BASE = "https://api.opensea.io/api/v2";

export const openSeaEnabled = (): boolean => Boolean(process.env.OPENSEA_API_KEY);

// Free tier is ~hundreds of reads/hour: pace conservatively at 1 req/2s.
const gate = rateLimiter(2000);

async function os<T>(path: string): Promise<T> {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new Error("OpenSea source is not enabled (set OPENSEA_API_KEY to add cross-marketplace data)");
  await gate();
  return fetchJson<T>("OpenSea", `${BASE}${path}`, {
    headers: {
      "x-api-key": key,
      Accept: "application/json",
      "User-Agent": "collector-mcp/1.1 (+https://github.com/p1xelapp/collector-mcp)",
    },
  });
}

interface OsStats {
  total?: { floor_price?: number; floor_price_symbol?: string; volume?: number; sales?: number; num_owners?: number };
}

/** Collection stats by OpenSea slug. Floor is in the listing currency (SOL for Solana collections). */
export async function collectionStats(slug: string) {
  const { data, stale, cachedAt } = await cached(`os:stats:${slug}`, 60_000, () =>
    os<OsStats>(`/collections/${encodeURIComponent(slug)}/stats`),
  );
  const t = data?.total;
  if (!t) throw new Error(`OpenSea has no stats for slug "${slug}"`);
  return {
    slug,
    floor: t.floor_price ?? null,
    floorCurrency: t.floor_price_symbol ?? null,
    totalVolume: t.volume ?? null,
    totalSales: t.sales ?? null,
    owners: t.num_owners ?? null,
    stale,
    cachedAt,
    source: "opensea",
  };
}

interface OsEvent {
  event_type?: string;
  payment?: { quantity?: string; decimals?: number; symbol?: string };
  nft?: { identifier?: string; name?: string };
  buyer?: string;
  seller?: string;
  event_timestamp?: number;
  transaction?: string;
}

/** Recent sales by slug (event_type=sale is server-side filtered - unlike Magic Eden). */
export async function recentSales(slug: string, limit: number) {
  const { data, stale, cachedAt } = await cached(`os:sales:${slug}`, 30_000, () =>
    os<{ asset_events?: OsEvent[] }>(`/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${Math.min(limit, 50)}`),
  );
  const events = data?.asset_events ?? [];
  return {
    slug,
    sales: events.slice(0, limit).map((e) => ({
      time: e.event_timestamp ? new Date(e.event_timestamp * 1000).toISOString() : null,
      price:
        e.payment?.quantity && e.payment.decimals !== undefined
          ? Number(e.payment.quantity) / 10 ** e.payment.decimals
          : null,
      currency: e.payment?.symbol ?? null,
      item: e.nft?.name ?? e.nft?.identifier ?? null,
      buyer: e.buyer ?? null,
      seller: e.seller ?? null,
      transaction: e.transaction ?? null,
    })),
    stale,
    cachedAt,
    source: "opensea",
  };
}
