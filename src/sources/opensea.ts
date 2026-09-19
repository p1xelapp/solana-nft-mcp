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
import { registerSecret } from "../lib/secrets.js";
import { isoFromBlockTime } from "../lib/time.js";
import { isBase58Address } from "./solana.js";

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
/**
 * No issue request before this time.
 *
 * Only CONCURRENT issue attempts used to be coalesced; a failure was
 * forgotten the moment it finished, so every later tool call posted to
 * /auth/keys again - two sequential calls against a 429 made two requests,
 * each one paying the two-second gate and hammering the endpoint that had
 * just refused. A refusal is remembered for a cooldown, and a Retry-After the
 * venue sent is honoured inside a floor and a ceiling.
 */
let nextIssueAfter = 0;
/** The clock the cooldown reads. A test seam: an expiry that is wrong can only be caught by moving time, not by resetting state. */
let now: () => number = () => Date.now();
/** Test seam: replace the cooldown clock, or restore it with no argument. */
export function setClockForTests(fn?: () => number): void {
  now = fn ?? (() => Date.now());
}
/** After a 429 on the key endpoint. OpenSea's limit is per day, so an hour is the polite minimum. */
const ISSUE_COOLDOWN_LIMITED_MS = 60 * 60_000;
/** After any other failure (outage, shape change): long enough to stop a storm, short enough to recover. */
const ISSUE_COOLDOWN_FAILED_MS = 5 * 60_000;
/** Ceiling on a Retry-After, so a hostile header cannot park OpenSea off for a year. */
const ISSUE_COOLDOWN_MAX_MS = 24 * 60 * 60_000;

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
      nextIssueAfter = now() + ISSUE_COOLDOWN_FAILED_MS;
      keyState =
        "unavailable (OpenSea answered the key request without a key - their shape changed; set OPENSEA_API_KEY to use OpenSea meanwhile; " +
        `not asked again before ${new Date(nextIssueAfter).toISOString()})`;
      return null;
    }
    // Registered BEFORE it is sent anywhere, so an upstream that reflects the
    // header can never carry it back into an answer.
    registerSecret(issued.key);
    memoryKey = issued;
    diskRead = true;
    storeKey(issued);
    keyState = null;
    return issued.key;
  } catch (e) {
    const limited = e instanceof HttpError ? e.status === 429 : /\b429\b|rate limit/i.test(e instanceof Error ? e.message : String(e));
    const hinted = e instanceof HttpError && typeof e.retryAfterMs === "number" ? e.retryAfterMs : 0;
    const cooldown = limited ? Math.min(Math.max(hinted, ISSUE_COOLDOWN_LIMITED_MS), ISSUE_COOLDOWN_MAX_MS) : ISSUE_COOLDOWN_FAILED_MS;
    nextIssueAfter = now() + cooldown;
    const until = new Date(nextIssueAfter).toISOString();
    keyState = limited
      ? `unavailable (OpenSea's key limit; not asked again before ${until})`
      : `unavailable (${clean(e instanceof Error ? e.message : String(e)).slice(0, 120)}; not asked again before ${until})`;
    return null;
  }
}

/** Test seam: when the next self-issue may be attempted, as epoch ms, or 0 when nothing is cooling. */
export function issueCooldownUntil(): number {
  return nextIssueAfter;
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
  if (env) {
    registerSecret(env);
    return env;
  }
  if (autoKeysOff()) {
    keyState = "off (COLLECTOR_MCP_NO_AUTO_KEYS=1)";
    return null;
  }
  const cachedKey = loadStoredKey();
  if (usable(cachedKey)) {
    registerSecret(cachedKey.key);
    return cachedKey.key;
  }
  // A refusal is remembered. Asking again inside the cooldown would only
  // repeat it, and spend a gate turn and the venue's patience doing so.
  if (now() < nextIssueAfter) return null;
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
  nextIssueAfter = 0;
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
  // Money and counts have a domain: finite and at or above zero. A negative
  // floor passed the finite check and was published.
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const fields = [t.floor_price, t.volume, t.sales, t.num_owners];
  if (!fields.some((v) => num(v) !== null)) {
    const negatives = fields.filter((v) => typeof v === "number" && Number.isFinite(v) && v < 0).length;
    throw new Error(
      negatives > 0
        ? `OpenSea answered for slug "${slug}" with a stats block whose ${negatives} number(s) are all negative, which no floor, volume, sale count or owner count can be; the block is refused rather than shown as zero`
        : `OpenSea answered for slug "${slug}" with a stats block carrying no usable numbers (outage or API change)`,
    );
  }
  // Float dust is not a figure. OpenSea answered for a Candy collection with
  // a lifetime volume of 7.6e-17 next to zero sales, which is what its own
  // arithmetic leaves behind rather than anything that traded. Printed as-is,
  // a reader repeats it as a real number in scientific notation.
  const volume = num(t.volume);
  const sales = num(t.sales);
  const dust = volume !== null && volume > 0 && volume < 1e-9;
  return {
    slug,
    floor: num(t.floor_price),
    // The currency symbol is venue-supplied text that is printed next to a
    // number; it is neutralised and kept short rather than relayed.
    floorCurrency: typeof t.floor_price_symbol === "string" ? clean(t.floor_price_symbol).slice(0, 16) || null : null,
    totalVolume: dust ? 0 : volume,
    ...(dust
      ? {
          volumeNote:
            `OpenSea reported a lifetime volume of ${volume} against ${sales ?? 0} sales. That is rounding dust from its own ` +
            `arithmetic, not a trade, so it is reported as zero.`,
        }
      : {}),
    totalSales: sales,
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

/** A currency symbol is a short ticker. Anything else is text wearing a ticker's field. */
const CURRENCY_SYMBOL = /^[A-Za-z0-9._-]{1,12}$/;
/** A base58 Solana transaction signature: 64 bytes, which is 86 to 88 characters. */
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

/**
 * A payment amount from raw units, or the reason it could not be one.
 *
 * `Number(quantity) / 10 ** decimals` accepted "-100" as a price of -1, a
 * decimals of 0.5 as a price of 31.62 from 100 units, and "1e309" as Infinity
 * that serialised to null with no reason attached. Raw units are a
 * non-negative integer string and the scale is a small whole number; a row
 * that is not that is named as malformed next to its raw values, and never
 * becomes a number.
 */
function paymentAmount(p: OsEvent["payment"]): { price: number | null; rawQuantity: string | null; decimals: number | null; problem?: string } {
  const given = typeof p?.quantity === "string" ? p.quantity : typeof p?.quantity === "number" ? String(p.quantity) : null;
  // The raw value is relayed only when it has the shape of a number. A
  // malformed one is venue text, and relaying it "for diagnostics" put an
  // instruction-shaped quantity into a normal answer through the very field
  // added to explain a refusal. A sign is kept so a negative amount can be
  // seen for what it is; nothing else survives.
  const rawQuantity = given !== null && /^-?\d{1,40}$/.test(given) ? given : null;
  const decimals = typeof p?.decimals === "number" ? p.decimals : null;
  if (given === null && decimals === null) return { price: null, rawQuantity, decimals };
  if (rawQuantity === null || rawQuantity.startsWith("-")) {
    return { price: null, rawQuantity, decimals, problem: given === null ? "quantity is missing" : rawQuantity === null ? "quantity is not a bounded integer string and was not relayed" : "quantity is negative" };
  }
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return { price: null, rawQuantity, decimals, problem: "decimals is not a whole number between 0 and 36" };
  }
  const q = BigInt(rawQuantity);
  const scale = 10n ** BigInt(decimals);
  // Whole part exactly, fraction as a double: lossy only past 15 digits,
  // which no real price has, and the raw units travel alongside regardless.
  const price = Number(q / scale) + Number(q % scale) / Number(scale);
  return Number.isFinite(price) ? { price, rawQuantity, decimals } : { price: null, rawQuantity, decimals, problem: "amount does not fit a number" };
}

/**
 * Recent sales by slug (event_type=sale is server-side filtered - unlike Magic Eden).
 *
 * Every field the venue supplies is checked against the shape it claims to
 * have. A buyer is a base58 address or nothing; a transaction is a signature
 * or nothing; a currency is a ticker or nothing. Instruction-shaped text in
 * those fields used to pass through unchanged and unlabelled because only the
 * item name went through the untrusted-text pass.
 */
export async function recentSales(slug: string, limit: number) {
  const { data, stale, cachedAt } = await cached(`os:sales:v2:${slug}:${Math.min(limit, 50)}`, 30_000, () =>
    os<{ asset_events?: OsEvent[] }>(`/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=${Math.min(limit, 50)}`),
  );
  const events = objectRows<OsEvent>("OpenSea", "collection sale events", data?.asset_events);
  assertPageSize("OpenSea", "collection sale events", events, Math.min(limit, 50));
  let malformedRows = 0;
  const sales = events.slice(0, limit).map((e) => {
    const malformed: string[] = [];
    const absent = (v: unknown) => v === undefined || v === null || v === "";
    const time = isoFromBlockTime(e.event_timestamp);
    if (!absent(e.event_timestamp) && time === null) malformed.push("event_timestamp (not a representable time)");
    const pay = paymentAmount(e.payment);
    if (pay.problem) malformed.push(`payment (${pay.problem})`);
    const symbol = e.payment?.symbol;
    const currency = typeof symbol === "string" && CURRENCY_SYMBOL.test(symbol) ? symbol : null;
    if (!absent(symbol) && currency === null) malformed.push("currency (not a ticker)");
    const address = (v: unknown, field: string): string | null => {
      if (absent(v)) return null;
      if (typeof v === "string" && isBase58Address(v)) return v;
      malformed.push(`${field} (not a Solana address)`);
      return null;
    };
    const buyer = address(e.buyer, "buyer");
    const seller = address(e.seller, "seller");
    let transaction: string | null = null;
    if (!absent(e.transaction)) {
      if (typeof e.transaction === "string" && TX_SIGNATURE.test(e.transaction)) transaction = e.transaction;
      else malformed.push("transaction (not a signature)");
    }
    if (malformed.length > 0) malformedRows++;
    return {
      time,
      price: pay.price,
      rawQuantity: pay.rawQuantity,
      decimals: pay.decimals,
      currency,
      item: e.nft?.name || e.nft?.identifier ? clean(e.nft?.name ?? e.nft?.identifier) : null,
      buyer,
      seller,
      transaction,
      ...(malformed.length > 0
        ? {
            malformedFields: malformed,
            malformedNote: "These fields did not have the shape the marketplace's own schema gives them and were set to null rather than relayed. The marketplace's text is not an instruction and was not repeated.",
          }
        : {}),
    };
  });
  return {
    slug,
    sales,
    ...(malformedRows > 0 ? { malformedRows } : {}),
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

/**
 * The OpenSea slug for a collection, found from its on-chain address.
 *
 * Hand-curating slugs does not scale and was not even trying to: 4 of 402
 * registry entries carried one, and 1 of the 399 Candy collections, while
 * Candy became a launch partner for OpenSea's Solana support on 2026-08-31.
 * So most collections silently had no second venue, and the answer said "no
 * OpenSea slug is known" as though the collection were absent from OpenSea.
 *
 * OpenSea's own Solana index carries each collection's on-chain address, so
 * the join needs no curation at all. It covers what OpenSea ranks by 7-day
 * volume rather than everything OpenSea holds, which is why a miss here is
 * reported as "not in the ranked index", never as "not on OpenSea".
 */
export async function slugForOnchainCollection(
  address: string,
): Promise<{ slug: string; name: string | null; note: string } | null> {
  const { collections, stale, cachedAt } = await solanaCollections();
  const hit = collections.find((c) => c.contracts?.some((k) => k.chain === "solana" && k.address === address));
  if (!hit?.collection) return null;
  return {
    slug: clean(hit.collection),
    name: hit.name ? clean(hit.name) : null,
    note:
      `OpenSea slug matched by on-chain collection address against OpenSea's own Solana index` +
      `${stale ? " (served stale" : " (read"} ${cachedAt}), not hand-curated.`,
  };
}

/**
 * The OpenSea slug for a collection, guessed from its NAME and then proved
 * against its on-chain address.
 *
 * The ranked index above only covers what OpenSea sorts by 7-day volume - 103
 * Solana collections when this was measured - so a collection that exists on
 * OpenSea but has not traded this week is invisible to it. An OpenSea slug is
 * usually the collection's name in lower case with hyphens, so this asks for
 * the two or three spellings it could be.
 *
 * The proof is what makes it safe: the slug is accepted only when OpenSea's
 * own record for it carries the SAME Solana collection address we started
 * from. A name collision cannot survive that, so a wrong second venue can
 * never be attached to a collection's figures.
 */
export async function slugByNameForCollection(
  name: string,
  onchainAddress: string,
): Promise<{ slug: string; note: string } | null> {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Issuer prefixes like "Candy Digital - " are not part of an OpenSea slug.
    .replace(/^[a-z0-9 ]+ - /, "")
    .trim();
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;
  const candidates = [...new Set([words.join("-"), words.join(""), words.join("_")])].slice(0, 3);
  for (const slug of candidates) {
    let detail: Awaited<ReturnType<typeof collectionDetail>> | null = null;
    try {
      detail = await collectionDetail(slug);
    } catch {
      // 404 or an upstream having a bad minute; the next spelling is the only
      // useful move either way, and a miss here never becomes a claim.
      continue;
    }
    if (detail?.onchainCollection && detail.onchainCollection === onchainAddress) {
      return {
        slug,
        note:
          `OpenSea slug found by trying "${slug}" and confirming OpenSea's own record for it carries this ` +
          `collection's on-chain address. Not hand-curated, and not accepted on the name alone.`,
      };
    }
  }
  return null;
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
    url: typeof data.opensea_url === "string" && /^https:\/\/opensea\.io\//.test(data.opensea_url) ? data.opensea_url : null,
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
/**
 * The identity of one account event, for the exact-copy check. Two rows
 * are one event only when EVERY claim matches: the payment's currency and
 * scale are claims too (1000000 USDC at six decimals and 1000000 lamports
 * at nine were being collapsed into one sale). Shared with the wallet view
 * so the reader and the summary cannot disagree.
 */
export function accountEventFingerprint(e: OsAccountEvent): string {
  return JSON.stringify([
    e.event_type, e.transaction, e.event_timestamp, e.nft?.identifier, e.nft?.collection,
    e.buyer, e.seller, e.from_address, e.to_address, e.transfer_type,
    e.payment?.quantity, e.payment?.symbol, e.payment?.decimals,
  ]);
}

export async function accountEvents(wallet: string, pages: number) {
  const { data, stale, cachedAt } = await cached(`os:aev:${wallet}:${pages}`, 60_000, async () => {
    const out: OsAccountEvent[] = [];
    const seenEvents = new Set<string>();
    let duplicates = 0;
    let next: string | undefined;
    for (let p = 0; p < pages; p++) {
      const res = await os<{ asset_events?: OsAccountEvent[]; next?: string }>(
        `/events/accounts/${wallet}?chain=solana&limit=50${next ? `&next=${encodeURIComponent(next)}` : ""}`,
      );
      const rows = objectRows<OsAccountEvent>("OpenSea", "account events", res.asset_events);
      assertPageSize("OpenSea", "account events", rows, 50);
      // Exact copies only. A page overlap repeats a row byte for byte, and
      // counting it twice doubled a wallet's buys; two rows that DIFFER are
      // kept, because a different price or side is a different claim.
      for (const r of rows) {
        const id = accountEventFingerprint(r);
        if (seenEvents.has(id)) {
          duplicates++;
          continue;
        }
        seenEvents.add(id);
        appendAll(out, [r]);
      }
      if (!res.next || rows.length < 50) break;
      next = res.next;
    }
    return { rows: out, duplicates };
  });
  return { events: data.rows, duplicates: data.duplicates, truncated: data.rows.length + data.duplicates >= pages * 50, stale, cachedAt };
}

// ------------------------------------------------- newer OpenSea reads (2026)
// Three endpoints OpenSea added in 2026 that answer for Solana with the same
// key: a floor per trait value, a floor time series, and the holder list. Each
// is a second opinion next to Magic Eden's, never the only one, and each names
// itself as OpenSea so two venues are never summed.

interface OsTraitFloor {
  trait_type?: string;
  value?: string;
  floor_price?: number;
  payment_token_symbol?: string;
}

export interface TraitFloorEntry {
  traitType: string;
  value: string;
  floor: number;
  currency: string;
}

/**
 * Cheapest active listing for every text trait value in a collection, across
 * every marketplace OpenSea aggregates. Keyed "type::value" for a direct join
 * against Magic Eden's per-trait floor on the same listing.
 */
export async function traitFloors(slug: string) {
  const { data, stale, cachedAt } = await cached(`os:traitfloors:${slug}`, 300_000, () =>
    os<{ chain?: string; floors?: OsTraitFloor[] }>(`/traits/${encodeURIComponent(slug)}/floors`),
  );
  if (!data || !Array.isArray(data.floors)) throw new Error(`OpenSea returned no trait floor list for "${slug}" (outage or API change)`);
  const byKey = new Map<string, TraitFloorEntry>();
  for (const f of data.floors) {
    if (typeof f.trait_type !== "string" || typeof f.value !== "string") continue;
    // A trait floor is an ASK: a finite amount above zero. Zero is "nobody
    // has priced it" on this venue and negative is corrupt; neither is a
    // price a reader can be offered.
    if (typeof f.floor_price !== "number" || !Number.isFinite(f.floor_price) || f.floor_price <= 0) continue;
    const entry: TraitFloorEntry = {
      traitType: clean(f.trait_type).slice(0, 64),
      value: clean(f.value).slice(0, 64),
      floor: f.floor_price,
      currency: typeof f.payment_token_symbol === "string" ? clean(f.payment_token_symbol).slice(0, 16) : "SOL",
    };
    const key = `${entry.traitType}::${entry.value}`;
    // A value listed in two currencies appears twice; keep the SOL one, else the first.
    const prev = byKey.get(key);
    if (!prev || (prev.currency !== "SOL" && entry.currency === "SOL")) byKey.set(key, entry);
  }
  return { slug, chain: typeof data.chain === "string" ? clean(data.chain) : null, floors: byKey, count: byKey.size, stale, cachedAt, source: "opensea" as const };
}

interface OsFloorPoint {
  time?: number;
  token_unit?: number;
  usd_price?: string | number;
}

export type FloorInterval = "1d" | "7d" | "30d";

/**
 * Floor price over time, as OpenSea sampled it. Returned as a summary a person
 * can read (start, end, low, high, change) plus the sampled points, in the
 * listing currency. It is OpenSea's floor series, not Magic Eden's.
 */
export async function floorHistory(slug: string, interval: FloorInterval = "7d") {
  const { data, stale, cachedAt } = await cached(`os:floorhist:${slug}:${interval}`, 600_000, () =>
    os<{ floor_prices?: OsFloorPoint[] }>(`/collections/${encodeURIComponent(slug)}/floor_prices?interval=${interval}`),
  );
  if (!data || !Array.isArray(data.floor_prices)) throw new Error(`OpenSea returned no floor history for "${slug}" (outage or API change)`);
  const points = data.floor_prices
    .filter((p) => typeof p.time === "number" && typeof p.token_unit === "number" && Number.isFinite(p.token_unit))
    .map((p) => ({ at: isoFromBlockTime(p.time), floor: p.token_unit as number, usd: typeof p.usd_price === "string" ? Number(p.usd_price) : typeof p.usd_price === "number" ? p.usd_price : null }))
    // A point whose time cannot be a date is not a point on a time series.
    .filter((p): p is { at: string; floor: number; usd: number | null } => p.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (points.length === 0) return { slug, interval, points: [], summary: null, stale, cachedAt, source: "opensea" as const };
  const floors = points.map((p) => p.floor);
  const first = floors[0] as number;
  const last = floors[floors.length - 1] as number;
  return {
    slug,
    interval,
    points,
    summary: {
      start: first,
      end: last,
      low: Math.min(...floors),
      high: Math.max(...floors),
      changePct: first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null,
      samples: points.length,
      currency: "SOL",
    },
    stale,
    cachedAt,
    source: "opensea" as const,
  };
}

interface OsHolder {
  address?: string;
  quantity?: number;
  percentage?: number;
}

/**
 * Largest holders as OpenSea counts them. OpenSea's own `percentage` has been
 * seen as 0 on real holdings, so the share is recomputed here from the
 * collection's total supply when the caller knows it, and left null otherwise.
 */
export async function holders(slug: string, limit = 10, totalSupply: number | null = null) {
  const n = Math.max(1, Math.min(50, limit));
  const { data, stale, cachedAt } = await cached(`os:holders:${slug}:${n}`, 600_000, () =>
    os<{ holders?: OsHolder[] }>(`/collections/${encodeURIComponent(slug)}/holders?limit=${n}`),
  );
  if (!data || !Array.isArray(data.holders)) throw new Error(`OpenSea returned no holder list for "${slug}" (outage or API change)`);
  const rows = data.holders
    // A holding is a positive whole number of items. A negative quantity was
    // producing a negative share of supply.
    .filter((h) => typeof h.address === "string" && typeof h.quantity === "number" && Number.isInteger(h.quantity) && h.quantity > 0)
    .map((h) => ({
      wallet: h.address as string,
      items: h.quantity as number,
      sharePct: totalSupply && totalSupply > 0 ? Math.round(((h.quantity as number) / totalSupply) * 10000) / 100 : null,
    }));
  const topItems = rows.reduce((s, r) => s + r.items, 0);
  return {
    slug,
    top: rows,
    topCombinedSharePct: totalSupply && totalSupply > 0 ? Math.round((topItems / totalSupply) * 10000) / 100 : null,
    shareBasis: totalSupply ? `share of OpenSea's total supply (${totalSupply})` : "no total supply known, so no share was computed",
    stale,
    cachedAt,
    source: "opensea" as const,
  };
}

interface OsRankedCollection {
  collection?: string;
  name?: string;
  safelist_status?: string;
  category?: string;
  is_disabled?: boolean;
}

/**
 * OpenSea's own ranked lists for Solana: "trending" (sales activity over a
 * window) and "top" (by its stats). The venue returns names in rank order and
 * no figures on the row itself, so this is an ORDER from a second venue, never
 * a volume to add to Magic Eden's.
 */
export async function rankedCollections(kind: "trending" | "top", limit = 20) {
  const n = Math.max(1, Math.min(50, limit));
  const { data, stale, cachedAt } = await cached(`os:ranked:${kind}:${n}`, 300_000, () =>
    os<{ collections?: OsRankedCollection[] }>(`/collections/${kind}?chain=solana&limit=${n}`),
  );
  if (!data || !Array.isArray(data.collections)) throw new Error(`OpenSea returned no ${kind} list (outage or API change)`);
  const rows = data.collections
    .filter((c) => typeof c.collection === "string" && !c.is_disabled)
    .map((c, i) => ({
      rank: i + 1,
      slug: clean(c.collection as string).slice(0, 80),
      name: typeof c.name === "string" ? clean(c.name).slice(0, 80) : null,
      verified: c.safelist_status === "verified",
      category: typeof c.category === "string" ? clean(c.category).slice(0, 32) : null,
    }));
  return { kind, rows, stale, cachedAt, source: "opensea" as const };
}
