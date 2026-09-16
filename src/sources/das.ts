/**
 * Digital Asset Standard (DAS) reads over the public Solana RPC.
 *
 * The Solana Foundation's mainnet endpoint answers the DAS methods
 * (getAsset, getAssetsByOwner, searchAssets) without a key. That is not
 * documented anywhere and the endpoint is described as "not for production",
 * so this module treats it as a second, independent read - never the only
 * path to a fact. Every caller first asks `capability()`; when the methods
 * disappear the answer is "unavailable" with the reason, and the tools fall
 * back to the raw account decode and the marketplace index they already use.
 *
 * Why it is worth having: DAS indexes every standard (Core, Token Metadata,
 * compressed), so it can list what a wallet holds beyond what a marketplace
 * indexes, and it gives a second opinion on an owner that our own byte-level
 * Core decode can be checked against. Two readers that agree is the strongest
 * signal a keyless tool can offer.
 */

import { createHash } from "node:crypto";

import { AbortedError, assertOnline, cached, originGate, readBoundedJson, OversizedBodyError } from "../lib/http.js";
import { withAmbient } from "../lib/context.js";
import { clean } from "../lib/untrusted.js";
import { objectRows } from "../lib/shapes.js";
import { isBase58Address } from "./solana.js";
import { DasUnsupported } from "../lib/errors.js";

const PUBLIC_DAS = "https://api.mainnet-beta.solana.com";
const SOURCE = "the public Solana RPC asset index (DAS)";

// The Foundation endpoint documents 100 requests per 10 seconds per IP and
// shares that budget with the plain RPC reads in solana.ts. The gate is keyed
// by origin and shared with that file, so the two readers cannot release
// requests at the same instant against one per-IP budget; 450ms is the
// stricter pace, and sharing the gate applies it to both.
const DAS_MIN_INTERVAL_MS = 450;
const gateFor = (url: string) => originGate(url, DAS_MIN_INTERVAL_MS);

// A Metaplex Core collection that has existed since 2026-08 and is read by
// the offline fixtures too; if getAsset stops answering for it, DAS is gone.
const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";

function endpoints(): { id: string; url: string }[] {
  const custom = process.env.DAS_RPC_URL?.trim();
  const list = [{ id: "rpc-mainnet-beta", url: PUBLIC_DAS }];
  return custom ? [{ id: "your DAS_RPC_URL", url: custom }, ...list] : list;
}

interface RpcError {
  code?: number;
  message?: string;
}

/**
 * One signal firing on either the request timeout or the caller's own
 * deadline. `AbortSignal.any` landed in Node 20.3 and the engine floor is
 * 20.0, so the two are combined by hand.
 */
function combineSignals(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (caller.aborted || timeout.aborted) stop();
  else {
    caller.addEventListener("abort", stop, { once: true });
    timeout.addEventListener("abort", stop, { once: true });
  }
  return controller.signal;
}

async function call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: T; endpoint: string }> {
  // The request this read serves may be cancelled without anyone passing the
  // signal down; the ambient one is joined so the gate wait below ends too.
  signal = withAmbient(signal);
  let last = "";
  // A -32601 from one endpoint is that endpoint's answer, not the method's
  // fate: a plain RPC set as DAS_RPC_URL would otherwise take the built-in
  // endpoint that does serve DAS down with it.
  const withoutTheMethod: string[] = [];
  const all = endpoints();
  for (const ep of all) {
    assertOnline(ep.url);
    // A caller whose deadline has passed gets no further requests spent on it.
    if (signal?.aborted) throw new Error(`${SOURCE} was not reached before the caller's deadline passed`);
    // The signal goes INTO the gate. Checking it only after the turn arrived
    // meant a caller who had already left still waited out the whole queue.
    await gateFor(ep.url)(signal);
    if (signal?.aborted) throw new Error(`${SOURCE} was not reached before the caller's deadline passed`);
    let j: { result?: T; error?: RpcError } | null = null;
    try {
      const r = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "collector-mcp/1.0 (+https://github.com/p1xelapp/collector-mcp)" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: combineSignals(20_000, signal),
      });
      if (r.status === 429 || r.status >= 500) {
        last = `${ep.id} answered HTTP ${r.status}`;
        continue;
      }
      // Bounded read: a hostile or broken endpoint answering a one-line
      // JSON-RPC request with gigabytes must not be buffered in full.
      j = await readBoundedJson<{ result?: T; error?: RpcError }>(r, ep.id);
    } catch (e) {
      if (e instanceof OversizedBodyError) throw e;
      last = `${ep.id} ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    // A JSON-RPC response is an object. An endpoint answering the literal
    // `null`, or a bare string or number, is not a response at all - and
    // reading `.error` off it threw a TypeError from inside this reader, which
    // reached the caller as a generic failure with our own stack in it.
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      last = `${ep.id} answered with something that is not a JSON-RPC response`;
      continue;
    }
    if (j.error?.code === -32601) {
      withoutTheMethod.push(ep.id);
      last = `${ep.id} does not serve ${method}`;
      continue;
    }
    if (j.error) {
      last = `${ep.id}: ${j.error.message ?? "error " + String(j.error.code)}`;
      continue;
    }
    if (!("result" in j)) {
      last = `${ep.id} returned no result field`;
      continue;
    }
    return { result: j.result as T, endpoint: ep.id };
  }
  if (withoutTheMethod.length === all.length) {
    throw new DasUnsupported(`no configured endpoint serves ${method} (${withoutTheMethod.join(", ")})`);
  }
  throw new Error(`${SOURCE} did not answer (${last}). That is the free public endpoint being busy, not a problem with what you asked; the other sources still work.`);
}

export interface DasCapability {
  available: boolean;
  /**
   * Which kind of "no" this is.
   * - `available`: getAsset answered for the canary.
   * - `withdrawn`: every endpoint answered -32601. Definitive, and the only
   *   state that should make a caller stop asking.
   * - `temporarily-unreachable`: a 429, a timeout, a 5xx, a shape we did not
   *   recognise. That is the endpoint being busy, not the method being gone.
   */
  state: "available" | "withdrawn" | "temporarily-unreachable";
  endpoint: string | null;
  note: string;
  checkedAt: string;
}

/**
 * Definitive answers are worth remembering; a bad minute is not.
 *
 * The trap this closes: one 429 during a status probe used to be committed to
 * the same ten-minute memo as a real withdrawal, so every DAS-backed tool
 * stayed dark for ten minutes after the endpoint had already recovered - and
 * told the user the capability had been withdrawn, which was false. A
 * definitive -32601 from every endpoint still holds for ten minutes; a
 * transient failure holds for thirty seconds, only to stop a burst of retries,
 * and callers are told they may try the read anyway.
 */
const CAP_TTL_DEFINITIVE_MS = 10 * 60_000;
const CAP_TTL_TRANSIENT_MS = 30_000;
let capMemo: { value: DasCapability; expiresAt: number } | null = null;

/**
 * Cached probe; a -32601 from every endpoint means the methods were withdrawn.
 *
 * `fresh` contacts the endpoint instead of trusting the memo. The status tool
 * requires it: a cached `available: true` for a capability that was withdrawn
 * two minutes ago is exactly the lie a health check exists to prevent.
 */
export async function capability(opts: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<DasCapability> {
  if (!opts.fresh && capMemo && Date.now() < capMemo.expiresAt) return capMemo.value;
  const checkedAt = new Date().toISOString();
  let value: DasCapability;
  try {
    const { result, endpoint } = await call<{ id?: string }>("getAsset", { id: CANARY }, opts.signal);
    value =
      result?.id === CANARY
        ? { available: true, state: "available", endpoint, note: "Undocumented public capability; used as a second read, never the only one.", checkedAt }
        : {
            available: false,
            state: "temporarily-unreachable",
            endpoint,
            // An unexpected shape is one bad answer, not a withdrawal: the
            // methods are still being served.
            note: "The asset index answered with an unexpected shape just now; treated as temporarily unreachable, not withdrawn.",
            checkedAt,
          };
  } catch (e) {
    value =
      e instanceof DasUnsupported
        ? { available: false, state: "withdrawn", endpoint: null, note: "the public RPC no longer serves DAS methods", checkedAt }
        : {
            available: false,
            state: "temporarily-unreachable",
            endpoint: null,
            note: `the asset index did not answer just now (${e instanceof Error ? e.message : String(e)}); that is the free endpoint being busy, not the methods being withdrawn`,
            checkedAt,
          };
  }
  capMemo = { value, expiresAt: Date.now() + (value.state === "temporarily-unreachable" ? CAP_TTL_TRANSIENT_MS : CAP_TTL_DEFINITIVE_MS) };
  return value;
}

/**
 * A read may proceed unless the methods are definitively gone.
 *
 * A transient probe failure must not block the very call that would prove the
 * endpoint is back: the read is attempted and speaks for itself.
 */
function refuseIfWithdrawn(cap: DasCapability): void {
  if (cap.state === "withdrawn") throw new DasUnsupported(`${SOURCE} is unavailable right now (${cap.note}).`);
}

// --------------------------------------------------------------- shapes

interface RawAsset {
  id?: string;
  interface?: string;
  burnt?: boolean;
  content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string }; json_uri?: string };
  grouping?: { group_key?: string; group_value?: string; verified?: boolean }[];
  ownership?: { owner?: string; frozen?: boolean; delegated?: boolean; delegate?: string | null; ownership_model?: string };
  royalty?: { percent?: number; basis_points?: number; primary_sale_happened?: boolean; locked?: boolean };
  compression?: { compressed?: boolean; tree?: string; leaf_id?: number };
  plugins?: Record<string, unknown>;
  external_plugins?: unknown[];
  creators?: { address?: string; share?: number; verified?: boolean }[];
  supply?: { print_max_supply?: number | null; print_current_supply?: number | null; edition_nonce?: number | null } | null;
  token_info?: { supply?: number; decimals?: number };
}

export interface DasAsset {
  /**
   * DAS interface name, but only from the known set below. The index is a
   * third party: an unrecognised value is reported as "unknown" rather than
   * passed through, because this string reaches a model as a fact about the
   * standard.
   */
  id: string;
  interface: string;
  /** Plain-words standard, derived from the interface. */
  standard: "metaplex-core" | "metaplex-core-collection" | "token-metadata" | "programmable-nft" | "compressed" | "fungible" | "other";
  name: string | null;
  symbol: string | null;
  image: string | null;
  collection: string | null;
  collectionVerified: boolean | null;
  owner: string | null;
  frozen: boolean | null;
  delegated: boolean | null;
  delegate: string | null;
  royaltyPct: number | null;
  burnt: boolean;
  compressed: boolean;
  /** Plugin names the index reports for Core assets; the byte-level decode in coreplugins.ts remains authoritative. */
  pluginNames: string[];
  creators: { address: string; share: number | null; verified: boolean | null }[];
  readFrom: string;
  /** When the index actually answered. On a cached read this is the cache entry's own timestamp, never "now". */
  readAt: string;
}

/**
 * Interface values this server recognises. Anything else becomes "unknown":
 * the field is index-supplied text and has been seen to carry newline-bearing
 * and instruction-shaped values, so it is matched against a list rather than
 * relayed.
 */
const KNOWN_INTERFACES = new Set([
  "MplCoreAsset",
  "MplCoreCollection",
  "ProgrammableNFT",
  "V1_NFT",
  "V2_NFT",
  "LEGACY_NFT",
  "V1_PRINT",
  "FungibleToken",
  "FungibleAsset",
  "Custom",
  "Identity",
  "Executable",
]);

/** Longest a plugin key may be before it is cut; a real plugin name is one word. */
const MAX_PLUGIN_KEY = 48;

/**
 * Most ids one getAssetNames call will request.
 *
 * Ids beyond this are not quietly dropped: the count comes back as `omitted`
 * and is folded into `unresolved`, so a caller can never read "0 unresolved"
 * about a window whose tail was never asked about.
 */
const MAX_BATCH_IDS = 5000;

/**
 * Longest a whole multi-page read may take before the endpoint is abandoned.
 *
 * The trap this closes: a `DAS_RPC_URL` that accepts the connection and never
 * answers. Each request had its own 20 s timeout, so a page walk against a
 * black hole ran 41 s - past the bar a client waits - and, because the walk
 * simply ended, `sourceErrors` came back empty and the caller could not tell
 * that the endpoint they configured never said a word. One deadline covers the
 * whole read now, and running out of it is an error that NAMES the endpoint.
 */
const READ_DEADLINE_MS = 25_000;

/** The endpoints this read would have used, for an error that has to name them. */
const endpointNames = (): string => endpoints().map((e) => e.id).join(", ");

const deadlinePassed = (what: string): Error =>
  new Error(
    `${SOURCE} did not finish ${what} within ${READ_DEADLINE_MS / 1000} s (${endpointNames()}), so the read was abandoned. That is the endpoint not answering, not a problem with what you asked; the other sources still work.`,
  );

function standardOf(iface: string, compressed: boolean): DasAsset["standard"] {
  if (compressed) return "compressed";
  if (iface === "MplCoreAsset") return "metaplex-core";
  if (iface === "MplCoreCollection") return "metaplex-core-collection";
  if (iface === "ProgrammableNFT") return "programmable-nft";
  if (iface === "V1_NFT" || iface === "LEGACY_NFT" || iface === "V2_NFT") return "token-metadata";
  if (iface === "FungibleToken" || iface === "FungibleAsset") return "fungible";
  return "other";
}

const addr = (v: unknown): string | null => (typeof v === "string" && isBase58Address(v) ? v : null);
const https = (v: unknown): string | null => (typeof v === "string" && /^https:\/\//.test(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? clean(v) : null);

function normalise(a: RawAsset, endpoint: string, readAt: string): DasAsset {
  const iface = typeof a.interface === "string" && KNOWN_INTERFACES.has(a.interface) ? a.interface : "unknown";
  const compressed = a.compression?.compressed === true;
  // `grouping` has been observed as an object rather than an array; .find on
  // it throws and takes the whole read down.
  const grouping = Array.isArray(a.grouping) ? a.grouping : [];
  const collection = grouping.find((g) => g && typeof g === "object" && g.group_key === "collection");
  const pct =
    typeof a.royalty?.basis_points === "number"
      ? a.royalty.basis_points / 100
      : typeof a.royalty?.percent === "number"
        ? a.royalty.percent * 100
        : null;
  return {
    id: typeof a.id === "string" ? a.id : "",
    interface: iface,
    standard: standardOf(iface, compressed),
    name: str(a.content?.metadata?.name),
    symbol: str(a.content?.metadata?.symbol),
    image: https(a.content?.links?.image),
    collection: addr(collection?.group_value),
    // An absent `verified` is "the index did not say", not "verified". Reading
    // a missing field as true is how an unverified grouping gets presented as
    // a confirmed collection membership.
    collectionVerified: typeof collection?.verified === "boolean" ? collection.verified : null,
    owner: addr(a.ownership?.owner),
    frozen: typeof a.ownership?.frozen === "boolean" ? a.ownership.frozen : null,
    delegated: typeof a.ownership?.delegated === "boolean" ? a.ownership.delegated : null,
    delegate: addr(a.ownership?.delegate),
    royaltyPct: pct !== null && Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null,
    burnt: a.burnt === true,
    compressed,
    // Plugin KEYS are index-supplied strings too: a key carrying line breaks
    // or a fake delimiter would otherwise reach the model verbatim.
    pluginNames:
      a.plugins && typeof a.plugins === "object"
        ? Object.keys(a.plugins)
            .slice(0, 32)
            .map((k) => clean(k).slice(0, MAX_PLUGIN_KEY))
            .filter((k) => k.length > 0)
        : [],
    creators: (Array.isArray(a.creators) ? a.creators : []).slice(0, 16).flatMap((c) => {
      if (!c || typeof c !== "object") return [];
      const address = addr(c.address);
      return address ? [{ address, share: typeof c.share === "number" ? c.share : null, verified: typeof c.verified === "boolean" ? c.verified : null }] : [];
    }),
    readFrom: `${SOURCE} via ${endpoint}`,
    readAt,
  };
}

export interface DasAssetRead {
  /** The asset, or null when the index has no record of the id. */
  asset: DasAsset | null;
  /** True when the index refused and this is a cached copy: not current state. */
  stale: boolean;
  /** When the index actually answered. */
  cachedAt: string;
}

/**
 * One asset of any standard, with the freshness of the read.
 *
 * Ownership from a stale index entry is the previous owner, so `stale` travels
 * with the data rather than being dropped at this boundary.
 */
export async function getAsset(id: string, opts: { signal?: AbortSignal } = {}): Promise<DasAssetRead> {
  refuseIfWithdrawn(await capability({ signal: opts.signal }));
  const { data, stale, cachedAt } = await cached<{ raw: RawAsset; endpoint: string } | null>(`das:asset:${id}`, 60_000, async (producer) => {
    try {
      // Producer signal: this read is shared, so it outlives any one caller's
      // deadline. The caller's own signal is passed to cached() below and ends
      // only its wait.
      const { result, endpoint } = await call<RawAsset | null>("getAsset", { id }, producer);
      if (!result || typeof result !== "object") return null;
      // An answer carrying a different id is not this asset. Caching it under
      // the requested id would show one asset's owner beneath another's mint.
      if (result.id !== id) {
        throw new Error(
          `${SOURCE} answered a getAsset for ${id} with a record for ${typeof result.id === "string" ? clean(result.id).slice(0, 64) : "no id at all"} (outage or API change)`,
        );
      }
      return { raw: result, endpoint };
    } catch (e) {
      // DAS reports an unknown id as an error rather than an empty result.
      if (e instanceof Error && /not found|does not exist|Asset Not Found/i.test(e.message)) return null;
      throw e;
    }
  }, { signal: opts.signal });
  return { asset: data ? normalise(data.raw, data.endpoint, cachedAt) : null, stale, cachedAt };
}

export interface DasOwnerPage {
  items: DasAsset[];
  /** DAS "total" is the number of items on the page, not the wallet's count. */
  pagesRead: number;
  truncated: boolean;
  /**
   * Rows the index served that carried no usable id, dropped rather than
   * counted. Any value above zero means the returned count is a floor over
   * what could be identified, never the wallet's total.
   */
  rowsRejected: number;
  readFrom: string;
  /** True when any page came from cache after a failed refresh: the holdings may have moved since. */
  stale: boolean;
  /** The OLDEST page timestamp in the walk - a list is only as current as its stalest page. */
  cachedAt: string;
}

/**
 * Everything the index knows the wallet holds, across standards. Pages are
 * 1000 wide; the walk stops at `max` items or the first short page.
 */
export async function getAssetsByOwner(owner: string, max = 2000, opts: { signal?: AbortSignal } = {}): Promise<DasOwnerPage> {
  // One deadline for the WHOLE walk, not per request: see READ_DEADLINE_MS.
  const deadline = combineSignals(READ_DEADLINE_MS, opts.signal);
  const cap = await capability({ signal: deadline });
  refuseIfWithdrawn(cap);
  const limit = 1000;
  const items: DasAsset[] = [];
  let page = 1;
  let truncated = false;
  let rowsRejected = 0;
  let readFrom = cap.endpoint ?? PUBLIC_DAS;
  let stale = false;
  let cachedAt = new Date().toISOString();
  for (;;) {
    if (deadline.aborted) throw deadlinePassed(`listing what ${owner} holds`);
    let hit;
    try {
      hit = await cached<{ items: RawAsset[]; rejected: number; endpoint: string }>(`das:owner:${owner}:${page}:${limit}`, 60_000, async (producer) => {
        const { result, endpoint } = await call<{ items?: unknown }>(
          "getAssetsByOwner",
          {
            ownerAddress: owner,
            page,
            limit,
            displayOptions: { showFungible: false },
          },
          combineSignals(READ_DEADLINE_MS, producer),
        );
        // Every ROW is validated, not just the container: one `null` item, or a
        // row whose `grouping` is an object instead of an array, used to crash
        // normalise() mid-answer and return nothing at all.
        const rows = objectRows<RawAsset>(SOURCE, "getAssetsByOwner items", result.items);
        if (rows.length > limit) {
          throw new Error(`${SOURCE} returned ${rows.length} items for a page of ${limit} - the endpoint is not honouring its own page size, so the page was refused rather than processed`);
        }
        // An id is what makes a row an ASSET. A row without one used to become
        // a holding with `mint: ""`, counted in a total the caller was told was
        // authoritative - a wrong holdings count carried with full confidence,
        // which is the exact class of silent-wrong-answer this server exists to
        // avoid. The single-asset path has always refused the same shape.
        const usable = rows.filter((r) => typeof r.id === "string" && isBase58Address(r.id));
        if (rows.length > 0 && usable.length === 0) {
          throw new Error(`${SOURCE} returned ${rows.length} row(s) for getAssetsByOwner and not one carried a usable id (outage or API change) - the page was refused rather than counted`);
        }
        return { items: usable, rejected: rows.length - usable.length, endpoint };
      }, { signal: deadline });
    } catch (e) {
      if (e instanceof AbortedError || deadline.aborted) throw deadlinePassed(`listing what ${owner} holds`);
      throw e;
    }
    const data = hit.data;
    readFrom = data.endpoint;
    stale = stale || hit.stale;
    rowsRejected += data.rejected;
    // Pages are cached separately, so a walk can mix a page read now with one
    // read a minute ago. Stamping every row with "now" is what turned a stale
    // owner list into a current-looking one; the oldest page sets the age.
    if (hit.cachedAt < cachedAt) cachedAt = hit.cachedAt;
    for (const raw of data.items) items.push(normalise(raw, data.endpoint, hit.cachedAt));
    // A short page is short of the PAGE SIZE the endpoint was asked for, so
    // dropped rows are added back before deciding whether the walk is over -
    // otherwise a page of 1,000 rows with one bad row reads as the last page.
    if (data.items.length + data.rejected < limit) break;
    if (items.length >= max) {
      truncated = true;
      break;
    }
    page++;
  }
  return { items: items.slice(0, max), pagesRead: page, truncated, rowsRejected, readFrom: `${SOURCE} via ${readFrom}`, stale, cachedAt };
}

/**
 * Names and standards for many mints in one call.
 *
 * A sales feed carries mints, not names, so "how many Ohtani cards sold" and
 * "which player sold the most" were unanswerable without one venue call per
 * sale. getAssetBatch answers a thousand ids at once, so the breakdown costs
 * one or two requests instead of hundreds. Missing ids come back as null in
 * the batch and are simply absent from the map; the caller reports the count.
 */
export async function getAssetNames(
  ids: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ names: Map<string, { name: string | null; standard: DasAsset["standard"] }>; stale: boolean; unresolved: number; omitted: number }> {
  // One deadline for every chunk together: see READ_DEADLINE_MS.
  const deadline = combineSignals(READ_DEADLINE_MS, opts.signal);
  const names = new Map<string, { name: string | null; standard: DasAsset["standard"] }>();
  const all = [...new Set(ids.filter(isBase58Address))];
  const unique = all.slice(0, MAX_BATCH_IDS);
  // Ids past the cap were never REQUESTED. Reporting them as resolved-and-fine
  // is how a name filter silently stopped covering part of its own window, so
  // they are named separately and counted as unresolved too.
  const omitted = all.length - unique.length;
  if (unique.length === 0) return { names, stale: false, unresolved: omitted, omitted };
  const cap = await capability({ signal: deadline });
  if (cap.state === "withdrawn") throw new DasUnsupported(`${SOURCE} is unavailable right now (${cap.note}).`);
  let stale = false;
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    // Keyed by a hash of the WHOLE ordered chunk. Length plus first and last id
    // collided for [A,B,C] and [A,X,C]: the second caller was served B's row in
    // X's position, the identity check dropped it, and X was reported
    // unresolved for ten minutes although the index knows it perfectly well.
    const key = `das:batch:${createHash("sha256").update(chunk.join(",")).digest("hex")}`;
    if (deadline.aborted) throw deadlinePassed("naming these mints");
    let read;
    try {
      read = await cached<{ rows: (RawAsset | null)[]; endpoint: string }>(key, 10 * 60_000, async (producer) => {
        const { result, endpoint } = await call<(RawAsset | null)[]>("getAssetBatch", { ids: chunk }, combineSignals(READ_DEADLINE_MS, producer));
        if (!Array.isArray(result)) throw new Error(`${SOURCE} returned an unexpected shape for getAssetBatch (outage or API change)`);
        if (result.length > chunk.length) {
          throw new Error(`${SOURCE} returned ${result.length} rows for a batch of ${chunk.length} ids - the endpoint is not honouring the request, so the page was refused rather than processed`);
        }
        // A missing id is a legitimate null here, so rows are checked one by one
        // rather than with the all-objects guard.
        for (const row of result) {
          if (row !== null && (typeof row !== "object" || Array.isArray(row))) {
            throw new Error(`${SOURCE} returned a malformed row in getAssetBatch (a row is ${Array.isArray(row) ? "an array" : typeof row}, not an object or null) - an outage or an API change`);
          }
        }
        return { rows: result, endpoint };
      }, { signal: deadline });
    } catch (e) {
      if (e instanceof AbortedError || deadline.aborted) throw deadlinePassed("naming these mints");
      throw e;
    }
    stale = stale || read.stale;
    read.data.rows.forEach((raw, idx) => {
      const id = chunk[idx];
      if (!id || !raw || typeof raw !== "object" || raw.id !== id) return;
      const iface = typeof raw.interface === "string" ? raw.interface : "unknown";
      names.set(id, { name: str(raw.content?.metadata?.name), standard: standardOf(iface, raw.compression?.compressed === true) });
    });
  }
  return { names, stale, unresolved: unique.length - names.size + omitted, omitted };
}
