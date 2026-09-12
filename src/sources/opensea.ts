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
import { clean } from "../lib/untrusted.js";
import { appendAll, assertPageSize, objectRows } from "../lib/shapes.js";
import { NotFoundError } from "../lib/errors.js";

const BASE = "https://api.opensea.io/api/v2";

export const openSeaEnabled = (): boolean => Boolean(process.env.OPENSEA_API_KEY);

// Free tier is ~hundreds of reads/hour: pace conservatively at 1 req/2s.
const gate = rateLimiter(2000, "OpenSea");

async function os<T>(path: string, signal?: AbortSignal): Promise<T> {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new Error("OpenSea source is not enabled (set OPENSEA_API_KEY to add cross-marketplace data)");
  return fetchJson<T>(
    "OpenSea",
    `${BASE}${path}`,
    {
      headers: {
        "x-api-key": key,
        Accept: "application/json",
        "User-Agent": "collector-mcp/1.1 (+https://github.com/p1xelapp/collector-mcp)",
      },
    },
    { gate, signal },
  );
}

interface OsStats {
  total?: { floor_price?: number; floor_price_symbol?: string; volume?: number; sales?: number; num_owners?: number };
}

/** Collection stats by OpenSea slug. Floor is in the listing currency (SOL for Solana collections). */
export async function collectionStats(slug: string, opts: { fresh?: boolean; signal?: AbortSignal } = {}) {
  // `fresh` = contact OpenSea now. A health check served from cache reports a
  // venue answering while it is down, which is the one thing it must not do.
  const { data, stale, cachedAt } = await cached(
    `os:stats:${slug}`,
    60_000,
    // The shared fetch runs on the producer's signal; the caller's signal ends
    // this caller's wait only, so one probe's deadline cannot cancel another
    // caller's read of the same slug.
    (producer) => os<OsStats>(`/collections/${encodeURIComponent(slug)}/stats`, producer),
    { fresh: opts.fresh, signal: opts.signal },
  );
  const t = data?.total;
  // An empty `total` object is a shape change, not a collection with no stats:
  // every real answer carries at least one finite number.
  if (!t || typeof t !== "object") throw new Error(`OpenSea has no stats for slug "${slug}"`);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const fields = [t.floor_price, t.volume, t.sales, t.num_owners];
  if (!fields.some((v) => num(v) !== null)) {
    throw new Error(`OpenSea answered for slug "${slug}" with a stats block carrying no usable numbers (outage or API change)`);
  }
  return {
    slug,
    floor: num(t.floor_price),
    // The currency symbol is venue-supplied text that is printed next to a
    // number; it is neutralised and kept short rather than relayed.
    floorCurrency: typeof t.floor_price_symbol === "string" ? clean(t.floor_price_symbol).slice(0, 16) || null : null,
    totalVolume: num(t.volume),
    totalSales: num(t.sales),
    owners: num(t.num_owners),
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
  const { data, stale, cachedAt } = await cached(`os:sales:${slug}:${Math.min(limit, 50)}`, 30_000, () =>
    os<{ asset_events?: OsEvent[] }>(`/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${Math.min(limit, 50)}`),
  );
  const events = objectRows<OsEvent>("OpenSea", "collection sale events", data?.asset_events);
  assertPageSize("OpenSea", "collection sale events", events, Math.min(limit, 50));
  return {
    slug,
    sales: events.slice(0, limit).map((e) => ({
      time: e.event_timestamp ? new Date(e.event_timestamp * 1000).toISOString() : null,
      price:
        e.payment?.quantity && e.payment.decimals !== undefined
          ? Number(e.payment.quantity) / 10 ** e.payment.decimals
          : null,
      currency: e.payment?.symbol ?? null,
      item: e.nft?.name || e.nft?.identifier ? clean(e.nft?.name ?? e.nft?.identifier) : null,
      buyer: e.buyer ?? null,
      seller: e.seller ?? null,
      transaction: e.transaction ?? null,
    })),
    stale,
    cachedAt,
    source: "opensea",
  };
}

// ------------------------------------------------------- Solana on OpenSea
// OpenSea opened Solana trading on 2026-08-31. Its collection index is the
// only keyed source that maps a slug to the on-chain collection address,
// total supply, and the royalty the project asks for - so with a key set,
// name search and supply questions get a second, independent answer.

export interface OsSolanaCollection {
  collection: string; // slug
  name?: string;
  total_supply?: number;
  created_date?: string;
  contracts?: { address?: string; chain?: string }[];
  fees?: { fee?: number; recipient?: string; required?: boolean }[];
  opensea_url?: string;
  twitter_username?: string;
  project_url?: string;
}

/** Solana collections OpenSea indexes, ordered by 7-day volume. Cached for an hour; a few hundred entries. */
export async function solanaCollections() {
  const { data, stale, cachedAt } = await cached("os:solana-index", 3_600_000, async () => {
    const out: OsSolanaCollection[] = [];
    let next: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = `/collections?chain=solana&limit=100&order_by=seven_day_volume${next ? `&next=${encodeURIComponent(next)}` : ""}`;
      const res = await os<{ collections?: OsSolanaCollection[]; next?: string }>(q);
      const rows = objectRows<OsSolanaCollection>("OpenSea", "Solana collection index", res.collections);
      assertPageSize("OpenSea", "Solana collection index", rows, 100);
      appendAll(out, rows);
      if (!res.next || rows.length < 100) break;
      next = res.next;
    }
    return out;
  });
  return { collections: data, stale, cachedAt };
}

// OpenSea's own 1% marketplace fee is listed alongside creator fees; it goes
// to a fixed EVM-looking address and is not a creator royalty.
const OPENSEA_FEE_RECIPIENT = /^0x0000a26b/i;

/** One collection's detail by slug: supply, on-chain address, royalty, links. */
export async function collectionDetail(slug: string) {
  const { data, stale, cachedAt } = await cached(`os:detail:${slug}`, 3_600_000, () =>
    os<OsSolanaCollection>(`/collections/${encodeURIComponent(slug)}`),
  );
  if (!data?.collection) throw new NotFoundError(`OpenSea has no collection "${slug}"`);
  // fees absent = OpenSea did not say; only an explicit list with no creator
  // entry means "no creator royalty". Do not turn silence into a zero.
  const royalty = data.fees ? data.fees.filter((f) => f.recipient && !OPENSEA_FEE_RECIPIENT.test(f.recipient)) : null;
  return {
    slug: data.collection,
    name: data.name ? clean(data.name) : null,
    totalSupply: data.total_supply ?? null,
    onchainCollection: data.contracts?.find((c) => c.chain === "solana")?.address ?? null,
    creatorRoyaltyPct: royalty === null ? null : royalty.reduce((s, f) => s + (f.fee ?? 0), 0),
    listedOn: data.created_date ?? null,
    url: data.opensea_url ?? null,
    stale,
    cachedAt,
    source: "opensea",
  };
}

export interface OsAccountEvent {
  event_type?: string; // sale | transfer | order | ...
  event_timestamp?: number;
  transaction?: string;
  transfer_type?: string;
  from_address?: string;
  to_address?: string;
  buyer?: string;
  seller?: string;
  payment?: { quantity?: string; decimals?: number; symbol?: string };
  nft?: { identifier?: string; name?: string; collection?: string };
}

/**
 * Sales AND plain transfers for a wallet on Solana. The transfer events are
 * the piece Magic Eden's wallet feed lacks - they are how "was this
 * airdropped or bought?" gets an evidence-based answer.
 */
export async function accountEvents(wallet: string, pages: number) {
  const { data, stale, cachedAt } = await cached(`os:aev:${wallet}:${pages}`, 60_000, async () => {
    const out: OsAccountEvent[] = [];
    let next: string | undefined;
    for (let p = 0; p < pages; p++) {
      const res = await os<{ asset_events?: OsAccountEvent[]; next?: string }>(
        `/events/accounts/${wallet}?chain=solana&limit=50${next ? `&next=${encodeURIComponent(next)}` : ""}`,
      );
      const rows = objectRows<OsAccountEvent>("OpenSea", "account events", res.asset_events);
      assertPageSize("OpenSea", "account events", rows, 50);
      appendAll(out, rows);
      if (!res.next || rows.length < 50) break;
      next = res.next;
    }
    return out;
  });
  return { events: data, truncated: data.length >= pages * 50, stale, cachedAt };
}
