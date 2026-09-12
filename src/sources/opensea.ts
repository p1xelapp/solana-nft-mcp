/**
 * OpenSea v2 - OPTIONAL cross-marketplace source.
 *
 * Why it exists: Solana collections (Candy Digital, Mad Lads, Claynosaurz,
 * Collector Crypt) now also trade on OpenSea, so a Solana-only market view
 * undercounts liquidity.
 *
 * Why it still answers with no configuration: OpenSea hands out free "agent"
 * keys from POST /api/v2/auth/keys with no signup, so the first tool call that
 * actually needs OpenSea asks for one, keeps it in the user's own home folder,
 * and reuses it until it is close to expiring. The key is the user's; it never
 * leaves their machine and is never printed. OPENSEA_API_KEY, when set, wins
 * over all of it, and COLLECTOR_MCP_NO_AUTO_KEYS=1 turns the self-issue off.
 *
 * Every failure here is a shrug, not an error: no key means the OpenSea half
 * of an answer is named as missing, exactly as it was before any of this.
 */

import { homedir } from "node:os";
import fs from "node:fs";
import path from "node:path";

import { cached, fetchJson, rateLimiter, HttpError } from "../lib/http.js";
import { clean } from "../lib/untrusted.js";
import { appendAll, assertPageSize, objectRows } from "../lib/shapes.js";
import { NotFoundError } from "../lib/errors.js";

const BASE = "https://api.opensea.io/api/v2";

// Free tier is ~hundreds of reads/hour: pace conservatively at 1 req/2s.
const gate = rateLimiter(2000, "OpenSea");

// ------------------------------------------------------- self-issued key

interface StoredKey {
  key: string;
  issuedAt: string;
  expiresAt: string;
  source: "opensea-agent-key";
}

export interface OpenSeaState {
  enabled: boolean;
  source: "env" | "auto" | "none";
  /** ISO expiry of a self-issued key; null for an env key (OpenSea does not tell us) and when off. */
  expiresAt: string | null;
  /** One sentence for a person: which key is in use, or why none is. */
  note: string;
  /**
   * Why the last self-issue attempt produced nothing, or null when none was
   * made yet. "Not tried" and "refused" are different sentences, and a banner
   * that reports the first as the second invents a failure.
   */
  unavailableReason?: string | null;
}

// Paths are resolved per call, never captured at import time: the home folder
// is environment, and a module-level constant cannot be driven through the
// states this has to survive (unwritable home, a different user).
const keyDir = (): string => path.join(homedir(), ".collector-mcp");
const keyFile = (): string => path.join(keyDir(), "opensea-key.json");
/** What the user is told the file is called. The real path carries their username; the shape is the useful part. */
const KEY_FILE_LABEL = "~/.collector-mcp/opensea-key.json";

/**
 * Refresh this long before expiry.
 *
 * A key that dies mid-conversation is worse than one refreshed a day early,
 * and OpenSea rate-limits key CREATION at about two per day per IP - so the
 * refresh window has to be wide enough that a normal day needs at most one.
 */
const REFRESH_WINDOW_MS = 24 * 60 * 60_000;
/** Assumed life when OpenSea's response does not say. Observed: 7 days. */
const ASSUMED_LIFE_MS = 7 * 24 * 60 * 60_000;

const autoKeysOff = (): boolean => process.env.COLLECTOR_MCP_NO_AUTO_KEYS === "1";

let memoryKey: StoredKey | null = null;
let diskRead = false;
/** Why the last self-issue attempt produced nothing. Shown instead of silence. */
let keyState: string | null = null;
let issuing: Promise<string | null> | null = null;

const usable = (k: StoredKey | null): k is StoredKey =>
  Boolean(k?.key) && Date.parse(k?.expiresAt ?? "") - Date.now() > REFRESH_WINDOW_MS;

function loadStoredKey(): StoredKey | null {
  if (diskRead) return memoryKey;
  diskRead = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(keyFile(), "utf8")) as Partial<StoredKey>;
    if (typeof parsed.key === "string" && parsed.key && typeof parsed.expiresAt === "string" && Number.isFinite(Date.parse(parsed.expiresAt))) {
      memoryKey = {
        key: parsed.key,
        issuedAt: typeof parsed.issuedAt === "string" ? parsed.issuedAt : new Date(0).toISOString(),
        expiresAt: parsed.expiresAt,
        source: "opensea-agent-key",
      };
    }
  } catch {
    // No file, unreadable file, or garbage in it: all mean "no cached key".
  }
  return memoryKey;
}

/**
 * Best-effort persistence. A read-only home folder must cost the user nothing
 * but a fresh key next restart, so every failure here is swallowed.
 */
function storeKey(k: StoredKey): void {
  try {
    fs.mkdirSync(keyDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile(), `${JSON.stringify(k, null, 2)}\n`, { mode: 0o600 });
    // mkdir/writeFile only apply the mode when they CREATE; an existing file
    // from a looser umask would keep its old permissions.
    fs.chmodSync(keyFile(), 0o600);
  } catch {
    /* the key still works for this process; it is simply not remembered */
  }
}

/** Pull a key and an expiry out of whatever shape OpenSea answers with. */
function readIssuedKey(body: unknown): StoredKey | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const nested = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
  const pick = (...names: string[]): unknown => {
    for (const n of names) {
      if (typeof root[n] === "string" || typeof root[n] === "number") return root[n];
      if (typeof nested[n] === "string" || typeof nested[n] === "number") return nested[n];
    }
    return undefined;
  };
  const key = pick("api_key", "apiKey", "key", "token");
  if (typeof key !== "string" || !key.trim()) return null;
  const rawExpiry = pick("expires_at", "expiresAt", "expiry", "expiration", "valid_until");
  const issuedAt = Date.now();
  let expiresAt = issuedAt + ASSUMED_LIFE_MS;
  if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
    // Seconds or milliseconds; anything before now is meaningless, so the
    // assumed life stands rather than a key that is born expired.
    const ms = rawExpiry > 1e12 ? rawExpiry : rawExpiry * 1000;
    if (ms > issuedAt) expiresAt = ms;
  } else if (typeof rawExpiry === "string") {
    const parsed = Date.parse(rawExpiry);
    if (Number.isFinite(parsed) && parsed > issuedAt) expiresAt = parsed;
  }
  return {
    key: key.trim(),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    source: "opensea-agent-key",
  };
}

async function issueKey(): Promise<string | null> {
  try {
    const body = await fetchJson<unknown>(
      "OpenSea",
      `${BASE}/auth/keys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      },
      // No retries on purpose: the only interesting failure is a daily key
      // ceiling, and retrying a quota spends it faster without ever winning.
      { gate, retries: 0, timeoutMs: 10_000 },
    );
    const issued = readIssuedKey(body);
    if (!issued) {
      keyState = "unavailable (OpenSea answered the key request without a key - their shape changed; set OPENSEA_API_KEY to use OpenSea meanwhile)";
      return null;
    }
    memoryKey = issued;
    diskRead = true;
    storeKey(issued);
    keyState = null;
    return issued.key;
  } catch (e) {
    const limited = e instanceof HttpError ? e.status === 429 : /\b429\b|rate limit/i.test(e instanceof Error ? e.message : String(e));
    keyState = limited
      ? "unavailable (OpenSea's key limit; retry after a day)"
      : `unavailable (${clean(e instanceof Error ? e.message : String(e)).slice(0, 120)})`;
    return null;
  }
}

/**
 * The key to send, or null when OpenSea stays off.
 *
 * Called by the first request that actually needs OpenSea, never at startup:
 * a client that only ever asks chain questions must not spend the user's
 * daily key allowance.
 */
export async function ensureKey(): Promise<string | null> {
  const env = process.env.OPENSEA_API_KEY;
  if (env) return env;
  if (autoKeysOff()) {
    keyState = "off (COLLECTOR_MCP_NO_AUTO_KEYS=1)";
    return null;
  }
  const cachedKey = loadStoredKey();
  if (usable(cachedKey)) return cachedKey.key;
  // One issue at a time: two tools asking at once must not spend two of the
  // day's two allowed keys.
  issuing ??= issueKey().finally(() => {
    issuing = null;
  });
  return issuing;
}

/**
 * What OpenSea is doing right now, without contacting anyone. Safe for the
 * startup banner and the status table; it never issues a key.
 */
export function openSeaState(): OpenSeaState {
  if (process.env.OPENSEA_API_KEY) {
    return { enabled: true, source: "env", expiresAt: null, note: "using the OPENSEA_API_KEY set in this server's environment" };
  }
  if (autoKeysOff()) {
    return {
      enabled: false,
      source: "none",
      expiresAt: null,
      note: "off - automatic key issue is disabled by COLLECTOR_MCP_NO_AUTO_KEYS=1. Set OPENSEA_API_KEY to turn OpenSea back on.",
    };
  }
  const stored = loadStoredKey();
  if (usable(stored)) {
    return {
      enabled: true,
      source: "auto",
      expiresAt: stored.expiresAt,
      note: `using a free key this server requested from OpenSea and stored in ${KEY_FILE_LABEL}; it expires ${stored.expiresAt.slice(0, 10)} and is renewed automatically`,
    };
  }
  return {
    enabled: false,
    source: "none",
    expiresAt: null,
    unavailableReason: keyState,
    note: keyState
      ? `off - a free OpenSea key could not be issued: ${keyState}. Every other source still answers; set OPENSEA_API_KEY to add OpenSea now.`
      : "no key yet - one free key is requested from OpenSea the first time a tool actually needs OpenSea, so nothing is spent on a session that never asks",
  };
}

/** True when an OpenSea request can be made right now WITHOUT issuing anything. */
export const openSeaEnabled = (): boolean => openSeaState().enabled;

/**
 * True when OpenSea can answer, issuing a key if that is what it takes. This
 * is what a tool handler asks; `openSeaEnabled()` is what a report asks.
 */
export async function openSeaAvailable(): Promise<boolean> {
  return Boolean(await ensureKey());
}

/** Drop every cached key and failure note. Exists so the offline suite can drive each state from a clean slate. */
export function resetKeyCache(): void {
  memoryKey = null;
  diskRead = false;
  keyState = null;
  issuing = null;
}

async function os<T>(route: string, signal?: AbortSignal): Promise<T> {
  const key = await ensureKey();
  if (!key) throw new Error(`OpenSea is not answering for this server: ${openSeaState().note}`);
  return fetchJson<T>(
    "OpenSea",
    `${BASE}${route}`,
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
