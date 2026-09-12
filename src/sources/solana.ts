/**
 * Direct Solana RPC source - zero keys, zero SDKs.
 *
 * Why this exists: Candy Digital (and a growing share of Solana collectibles)
 * mint Metaplex Core assets, not SPL tokens. Enhanced-transaction APIs parse
 * Core transfers as `type: "UNKNOWN"` with empty `tokenTransfers`, so most
 * tooling reports ZERO ownership history for these assets. Ownership actually
 * lives in the Core account's raw bytes and in TransferV1 instruction
 * accounts - both readable from any plain RPC endpoint for free.
 *
 * This module decodes both by hand:
 *  - AssetV1 / CollectionV1 account layouts (owner, name, mint counts)
 *  - TransferV1 instruction accounts -> the new owner of each transfer
 *
 * The transfer heuristic (last account that is not the asset, the collection,
 * the Core program, or the System program) survives the optional-account
 * variants that make fixed indexes unreliable. Verified against a live Candy
 * Digital auction: 36/36 packs traced to their winners, 0 untraced.
 */

import { cached, originGate, readBoundedJson, OversizedBodyError } from "../lib/http.js";
import { clean } from "../lib/untrusted.js";
import { PUBLIC_RPC_ENDPOINTS } from "./catalog.js";
import { NotFoundError, WrongKindError } from "../lib/errors.js";

export const CORE_PROGRAM = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// SPL Noop, passed as Core's optional log wrapper. It trails the new owner in
// TransferV1's account list and must never be mistaken for one.
const LOG_WRAPPER = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

/** Marketplace program ids -> label, used to annotate provenance events. */
const MARKETPLACE_PROGRAMS: Record<string, string> = {
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: "Magic Eden",
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: "Tensor",
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: "Tensor cNFT",
};

// Be polite to the free endpoints: one request per 350ms per HOST, and retry
// 429/5xx with a real backoff - the public RPC rate-limits bursts hard. The
// gate is keyed by origin and shared with the DAS reads in das.ts, because a
// per-IP budget belongs to the host, not to whichever module is calling it.
const RPC_MIN_INTERVAL_MS = 350;
const gateFor = (url: string) => originGate(url, RPC_MIN_INTERVAL_MS);

interface RpcEndpoint {
  id: string;
  url: string;
}

/**
 * The endpoints tried for one call, in order. A user's own endpoint goes
 * first; the verified public list is the safety net behind it, so setting
 * SOLANA_RPC_URL adds a preference rather than removing the fallbacks.
 */
function endpoints(): RpcEndpoint[] {
  const custom = process.env.SOLANA_RPC_URL?.trim();
  return custom ? [{ id: "your SOLANA_RPC_URL", url: custom }, ...PUBLIC_RPC_ENDPOINTS] : [...PUBLIC_RPC_ENDPOINTS];
}

/**
 * Host only, never the URL. A private endpoint carries its key in the query
 * string, and this label ends up in tool output, logs and model context.
 */
function label(ep: RpcEndpoint): string {
  try {
    return `${ep.id} (${new URL(ep.url).host})`;
  } catch {
    return ep.id;
  }
}

/** Filled in by `rpc()` so a caller can report which endpoint actually answered. */
export interface RpcTrace {
  /** Human-safe label of the endpoint that answered LAST. Kept for callers that report a single name. */
  endpoint?: string;
  /**
   * Every endpoint that served part of this answer, in first-use order.
   *
   * One provenance read is an account read, a signature walk and N
   * transaction fetches, and the loop rotates freely between them. Reporting
   * only the last one attributes the whole history to an endpoint that may
   * have served one transaction of it.
   */
  endpoints?: string[];
  /** Endpoints that failed before one answered, with the reason each gave. */
  rotations?: string[];
}

// JSON-RPC error codes that describe the PROVIDER (busy, plan, key), not the
// chain. Every endpoint would answer a chain error identically, so only these
// are worth moving on for.
const PROVIDER_ERROR_CODES = new Set([-32429, -32029, -32052, -32005, 401, 402, 403, 429]);

const ATTEMPTS_PER_ENDPOINT = 2;

// An endpoint that just exhausted its attempts is skipped for a minute.
// Without this, a misconfigured SOLANA_RPC_URL costs every single call two
// attempts and a backoff - measured at 18s for one provenance read against a
// dead host, versus 4s once the memo is in place. Short and self-healing: a
// briefly flaky endpoint is back in rotation a minute later, and the memo is
// ignored entirely when it would leave nothing to try.
const COOLDOWN_MS = 60_000;
const cooldown = new Map<string, number>();

let rpcId = 0;

/**
 * One endpoint, held for the length of a verification walk.
 *
 * The trap this closes: endpoint A serves the post-transfer account state and
 * then fails, endpoint B is a slot behind and serves a signature list without
 * that transfer. Every individual read succeeds, the walk looks complete, and
 * "never changed hands" is confirmed from a snapshot that never existed on any
 * node. A pinned walk reads everything from ONE node, so the answer describes
 * a state that node actually held.
 */
export interface EndpointPin {
  /** Chosen on the first read; every later read in the walk reuses it. */
  ep: RpcEndpoint | null;
  /** Endpoints a previous attempt already burned through. */
  exclude: Set<string>;
  /** Human-safe label of the pinned endpoint, once one has answered. */
  label: string | null;
}

/** The pinned endpoint stopped answering mid-walk. The walk is restarted, never stitched. */
class PinnedEndpointError extends Error {}

const newPin = (exclude: Iterable<string> = []): EndpointPin => ({ ep: null, exclude: new Set(exclude), label: null });

/**
 * Run a read that must see ONE consistent node.
 *
 * If the pinned endpoint fails part-way the whole walk restarts from scratch
 * against the next endpoint - never resumed, because a resumed walk is exactly
 * the mixed-slot snapshot this exists to prevent. A second failure is an
 * unverifiable read and is thrown to the caller to report as such.
 */
export async function pinnedWalk<T>(run: (pin: EndpointPin) => Promise<T>): Promise<{ value: T; endpointPinned: string }> {
  const first = newPin();
  try {
    const value = await run(first);
    return { value, endpointPinned: first.label ?? "no endpoint was contacted for this read" };
  } catch (e) {
    if (!(e instanceof PinnedEndpointError)) throw e;
    const second = newPin(first.ep ? [first.ep.id] : []);
    const value = await run(second);
    return { value, endpointPinned: second.label ?? "no endpoint was contacted for this read" };
  }
}

/**
 * One JSON-RPC call, with endpoint fallback.
 *
 * Anything that says "this endpoint is not answering" - transport failure,
 * 429, 5xx, any other non-200, a non-JSON body, a provider error code, or an
 * envelope carrying neither `result` nor `error` - retries here and then moves
 * to the next endpoint. A real chain error (bad parameter, unsupported method)
 * is thrown straight out: rotating would only collect the same answer three
 * more times and cost the user ten seconds.
 */
async function rpc<T>(method: string, params: unknown[], trace?: RpcTrace, pin?: EndpointPin, signal?: AbortSignal): Promise<T> {
  const all = endpoints();
  const now = Date.now();
  const isCooling = (ep: RpcEndpoint) => (cooldown.get(ep.id) ?? 0) >= now;
  // Cooling endpoints are demoted, never removed. Skipping them entirely lets
  // one fresh endpoint fail and produce "every endpoint was tried" while two
  // recovered ones were never asked - a self-inflicted outage.
  let list = [...all.filter((ep) => !isCooling(ep)), ...all.filter(isCooling)];
  if (pin) {
    // Pinned: one endpoint for the whole walk. Rotating mid-walk is what
    // produces a snapshot stitched from two different slots.
    list = pin.ep ? [pin.ep] : list.filter((ep) => !pin.exclude.has(ep.id));
    if (list.length === 0) {
      throw new Error(
        `no Solana endpoint is left to pin this read to (every one was already tried). That is the free public RPC being busy, not a problem with what you asked.`,
      );
    }
  }
  const problems: string[] = [];
  for (const ep of list) {
    const wasCooling = isCooling(ep);
    let lastErr: unknown;
    for (let attempt = 0; attempt < ATTEMPTS_PER_ENDPOINT; attempt++) {
      // A caller that has already given up gets no further requests spent on
      // its behalf, and none of the source's rate budget either.
      if (signal?.aborted) throw new Error("the Solana read was abandoned: the caller's deadline passed");
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      await gateFor(ep.url)();
      if (signal?.aborted) throw new Error("the Solana read was abandoned: the caller's deadline passed");
      try {
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
          signal: combineSignals(12_000, signal),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new EndpointError(`HTTP ${res.status}`);
        }
        let j: { result?: T; error?: { code: number; message: string } };
        try {
          // Bounded read: an endpoint answering a one-line request with
          // gigabytes must not be buffered in full before anything checks it.
          j = await readBoundedJson<{ result?: T; error?: { code: number; message: string } }>(res, ep.id);
        } catch (e) {
          if (e instanceof OversizedBodyError) throw e;
          throw new EndpointError("returned a non-JSON body");
        }
        if (j.error) {
          if (PROVIDER_ERROR_CODES.has(j.error.code)) throw new EndpointError(`${j.error.code}: ${j.error.message}`);
          throw new ChainError(`Solana RPC ${j.error.code}: ${j.error.message}`);
        }
        // A malformed envelope with neither result nor error must not read as
        // "no account" or "no history" downstream.
        if (!("result" in j)) throw new EndpointError("returned an envelope with no result field");
        cooldown.delete(ep.id);
        if (pin && !pin.ep) {
          pin.ep = ep;
          pin.label = label(ep);
        }
        if (trace) {
          const name = label(ep);
          trace.endpoint = name;
          trace.endpoints ??= [];
          if (!trace.endpoints.includes(name)) trace.endpoints.push(name);
          if (problems.length > 0) trace.rotations = [...problems];
        }
        return j.result as T;
      } catch (e) {
        if (e instanceof ChainError) throw new Error(e.message);
        if (e instanceof OversizedBodyError) throw e;
        lastErr = e;
      }
    }
    cooldown.set(ep.id, Date.now() + COOLDOWN_MS);
    problems.push(
      `${label(ep)}${wasCooling ? " (tried as a last resort after a recent failure)" : ""} ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
  if (pin) {
    // The pinned endpoint is gone. The caller restarts the whole walk against
    // the next one rather than continuing against a second node.
    throw new PinnedEndpointError(
      `the Solana endpoint this read was pinned to stopped answering part-way (${problems.join("; ")})`,
    );
  }
  throw new Error(
    `public Solana RPC is not answering right now. Every endpoint was tried and none returned a result ` +
      `(${problems.join("; ")}). That is the free public RPC being busy, not a problem with what you asked. ` +
      `Set SOLANA_RPC_URL to any endpoint you prefer - this server still needs no key of its own.`,
  );
}

/** This endpoint is not answering: retry it, then move to the next one. */
class EndpointError extends Error {}

/**
 * One signal firing on either the request timeout or the caller's own
 * deadline. `AbortSignal.any` landed in Node 20.3 and this package supports
 * 18.17, so the two are combined by hand.
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

/** The chain answered, and the answer was an error. Every endpoint would say the same. */
class ChainError extends Error {}

export interface RpcEndpointHealth {
  /** Human-safe label: id plus host, never a URL that could carry a key. */
  endpoint: string;
  ok: boolean;
  latencyMs: number | null;
  slot: number | null;
  note: string;
}

/**
 * Per-endpoint health for the status tool: getHealth and getSlot in one
 * batched request each, so the whole check is one round trip per endpoint.
 *
 * Deliberately does NOT use the fallback loop above - the point is to report
 * on each endpoint individually, and a loop that rotates away from a sick one
 * would hide exactly what is being asked about. Never throws.
 */
export async function rpcHealth(timeoutMs = 6_000, signal?: AbortSignal): Promise<RpcEndpointHealth[]> {
  const out: RpcEndpointHealth[] = [];
  for (const ep of endpoints()) {
    const started = Date.now();
    // The caller's deadline governs this check too. Without it the status
    // tool's shared budget could be spent entirely here, and every marketplace
    // would then be reported as timed out without having been contacted once.
    if (signal?.aborted) {
      out.push({ endpoint: label(ep), ok: false, latencyMs: null, slot: null, note: "not checked: the status check's budget ran out before this endpoint was reached" });
      continue;
    }
    try {
      await gateFor(ep.url)(signal);
      const res = await fetch(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "getHealth" },
          { jsonrpc: "2.0", id: 2, method: "getSlot" },
        ]),
        signal: combineSignals(timeoutMs, signal),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        out.push({ endpoint: label(ep), ok: false, latencyMs, slot: null, note: `refused with HTTP ${res.status}` });
        continue;
      }
      const body = (await res.json()) as unknown;
      // A batch answer is an array. Anything else is a shape change or a proxy
      // page, not "unhealthy" - say which, rather than guessing.
      if (!Array.isArray(body)) {
        out.push({ endpoint: label(ep), ok: false, latencyMs, slot: null, note: "answered, but not with a JSON-RPC batch (shape change or proxy page)" });
        continue;
      }
      const rows = body as { id?: number; result?: unknown; error?: { message?: string } }[];
      const health = rows.find((r) => r.id === 1);
      const slotRow = rows.find((r) => r.id === 2);
      const slot = typeof slotRow?.result === "number" ? slotRow.result : null;
      const healthy = health?.result === "ok";
      out.push({
        endpoint: label(ep),
        ok: healthy && slot !== null,
        latencyMs,
        slot,
        note: healthy && slot !== null
          ? `healthy at slot ${slot}`
          : (health?.error?.message ?? "answered but did not report itself healthy"),
      });
    } catch (e) {
      out.push({
        endpoint: label(ep),
        ok: false,
        latencyMs: Date.now() - started,
        slot: null,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- base58

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 encode (32-byte pubkeys), avoids pulling in bs58/web3.js. */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const d = digits[i]! * 256 + carry;
      digits[i] = d % 58;
      carry = Math.floor(d / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = 0;
  for (const byte of bytes) {
    if (byte === 0) zeros++;
    else break;
  }
  // Drop the residual zero digit so an all-zero key encodes as exactly 32 ones.
  let top = digits.length - 1;
  while (top > 0 && digits[top] === 0) top--;
  let out = "1".repeat(zeros);
  if (!(top === 0 && digits[0] === 0)) for (let i = top; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

/** Cheap shape check for tool inputs - full validity is proven by the RPC call. */
export function isBase58Address(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// ------------------------------------------------- Core account decoding

export interface CoreAsset {
  kind: "asset";
  owner: string;
  collection: string | null;
  name: string;
}

export interface CoreCollection {
  kind: "collection";
  updateAuthority: string;
  name: string;
  uri: string;
  numMinted: number;
  currentSize: number;
}

function readString(buf: Buffer, off: number): { value: string; next: number } {
  const len = buf.readUInt32LE(off);
  if (len > 1000) throw new Error("implausible string length (wrong layout)");
  return { value: buf.toString("utf8", off + 4, off + 4 + len), next: off + 4 + len };
}

/**
 * Decode a Metaplex Core account from base64 data. Discriminator byte:
 * 1 = AssetV1, 5 = CollectionV1 (Key enum). Returns null when the account
 * is neither (e.g. a 1-byte burnt stub).
 *
 * AssetV1:      key(1) + owner(32) + updateAuthority(enum: tag(1) [+32]) + name + uri [+ seq]
 * CollectionV1: key(1) + updateAuthority(32) + name + uri + numMinted(u32) + currentSize(u32)
 */
export function decodeCoreAccount(b64: string): CoreAsset | CoreCollection | null {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 34) return null;
    const key = buf[0];
    if (key === 1) {
      const owner = base58Encode(buf.subarray(1, 33));
      let off = 33;
      const tag = buf[off]!;
      off += 1;
      let collection: string | null = null;
      if (tag === 1 || tag === 2) {
        const addr = base58Encode(buf.subarray(off, off + 32));
        if (tag === 2) collection = addr; // UpdateAuthority::Collection
        off += 32;
      }
      const { value: name } = readString(buf, off);
      // The name is whatever the minter typed. Neutralise it here, at the point
      // it stops being bytes and becomes text a model will read.
      return { kind: "asset", owner, collection, name: clean(name) };
    }
    if (key === 5) {
      const updateAuthority = base58Encode(buf.subarray(1, 33));
      const off = 33;
      const n = readString(buf, off);
      const u = readString(buf, n.next);
      const numMinted = buf.readUInt32LE(u.next);
      const currentSize = buf.readUInt32LE(u.next + 4);
      return { kind: "collection", updateAuthority, name: clean(n.value), uri: u.value, numMinted, currentSize };
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch + decode one Core account. Distinguishes "missing" from "not Core". */
/** Raw base64 account data for a Core-owned account, or null when it does not exist. */
export async function getCoreAccountRaw(address: string): Promise<string | null> {
  const info = await rpc<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [
    address,
    { encoding: "base64" },
  ]);
  if (!info?.value) return null;
  if (info.value.owner !== CORE_PROGRAM) throw new Error(`account ${address} is owned by ${info.value.owner}, not Metaplex Core`);
  return info.value.data[0];
}

export interface CoreAccountRead {
  account: CoreAsset | CoreCollection | null;
  /**
   * The slot the endpoint says this account read describes, when it reported
   * one. It is the anchor for the rest of a walk: every later read in the same
   * walk asks for a state at least this recent, so a node cannot serve the
   * account from one slot and the history from an older one.
   */
  contextSlot: number | null;
  /**
   * True when the RPC refused and this is a previously cached account kept
   * alive by the stale-on-error rule. A stale owner is not current ownership
   * and must never be presented as settled.
   */
  stale: boolean;
  /** When the account was actually read from an endpoint, not when it was served. */
  cachedAt: string;
}

/**
 * One Core account plus the freshness of the read that produced it.
 *
 * Ownership is the claim this server is most often asked to settle, so the
 * caller has to be able to tell "read from the chain just now" from "the RPC
 * failed and this is a minute-old copy". `getCoreAccount` keeps the simple
 * shape for callers that only need the decoded account.
 */
export async function getCoreAccountWithMeta(
  address: string,
  opts: { fresh?: boolean; trace?: RpcTrace; pin?: EndpointPin; signal?: AbortSignal } = {},
): Promise<CoreAccountRead> {
  const read = async (producer?: AbortSignal) => {
    const info = await rpc<{ context?: { slot?: number }; value: { data: [string, string]; owner: string } | null }>(
      "getAccountInfo",
      [address, { encoding: "base64" }],
      opts.trace,
      opts.pin,
      // A `fresh` read is this caller's alone and carries the caller's signal.
      // A cached read is SHARED, so the fetch runs on the cache's producer
      // signal and only this caller's wait ends with its own deadline.
      producer ?? opts.signal,
    );
    // The slot travels WITH the decoded account, through the cache, because it
    // describes that value and nothing else.
    const slot = typeof info?.context?.slot === "number" && Number.isFinite(info.context.slot) ? info.context.slot : null;
    if (!info?.value) return { missing: true as const, slot };
    if (info.value.owner !== CORE_PROGRAM) return { notCore: true as const, owner: info.value.owner, slot };
    return { decoded: decodeCoreAccount(info.value.data[0]), slot };
  };
  // `fresh` bypasses the stale-on-error cache: a verification must never
  // confirm ownership or supply from a value kept alive by a failed refresh.
  const hit = opts.fresh
    ? { data: await read(opts.signal), stale: false, cachedAt: new Date().toISOString() }
    : await cached(`core:${address}`, 60_000, (producer) => read(producer), { signal: opts.signal });
  const { data } = hit;
  if ("missing" in data) throw new NotFoundError(`account ${address} does not exist on mainnet`);
  if ("notCore" in data)
    throw new WrongKindError(
      `account ${address} is owned by ${data.owner}, not Metaplex Core. ` +
        `v1 decodes Metaplex Core assets only (SPL/compressed NFTs: use get_asset, which reads Magic Eden instead).`,
    );
  return { account: data.decoded, contextSlot: data.slot, stale: hit.stale, cachedAt: hit.cachedAt };
}

export async function getCoreAccount(
  address: string,
  opts: { fresh?: boolean; trace?: RpcTrace; pin?: EndpointPin; signal?: AbortSignal } = {},
): Promise<CoreAsset | CoreCollection | null> {
  return (await getCoreAccountWithMeta(address, opts)).account;
}

// ---------------------------------------------------------- provenance

export interface ProvenanceEvent {
  signature: string;
  time: string | null;
  event: "minted" | "transferred" | "burned" | "marketplace_activity" | "other";
  newOwner?: string;
  marketplace?: string;
  /** Present when a field had to be inferred rather than decoded. */
  note?: string;
}

interface ParsedInstruction {
  programId: string;
  accounts?: string[];
  /** base58 instruction data for programs the RPC cannot parse (Core is one). */
  data?: string;
}

// mpl-core instruction discriminators (first data byte), from the generated
// client: CreateV1 0, TransferV1 14, BurnV1 12. TransferV1's account list is
// fixed: asset, collection, payer, authority, new_owner, system_program,
// log_wrapper - omitted optionals are filled with the program id, so
// new_owner is always index 4.
const IX_TRANSFER_V1 = 14;
const IX_CREATE_V1 = 0;
const IX_BURN_V1 = 12;
const TRANSFER_NEW_OWNER_INDEX = 4;

/** First byte of a base58 instruction payload, or null when it is not decodable. */
function discriminator(data: string | undefined): number | null {
  if (!data) return null;
  let n = 0n;
  for (const ch of data) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  // Leading '1's are leading zero bytes; the first byte is then zero.
  if (data.startsWith("1")) return 0;
  const hex = n.toString(16);
  const bytes = hex.length % 2 ? "0" + hex : hex;
  return parseInt(bytes.slice(0, 2), 16);
}

interface ParsedTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    logMessages?: string[];
    innerInstructions?: { instructions: ParsedInstruction[] }[];
  } | null;
  transaction: { message: { instructions: ParsedInstruction[]; accountKeys: { pubkey: string }[] } };
}

/**
 * Full ownership history of a Metaplex Core asset, straight from the chain.
 *
 * Reads the signature list for the asset, then walks each transaction's Core
 * instructions and extracts the new owner from the TransferV1 account list.
 * `depth` caps how many transactions we decode (each is one RPC call, paced);
 * Core assets are cheap here - even a heavily traded card is ~5-15 signatures.
 */
export async function getProvenance(mint: string, depth = 15, opts: { fresh?: boolean } = {}) {
  // Which endpoint actually served this history is part of the evidence: a
  // reader checking the result by hand needs to know whose node they are
  // disagreeing with. A `fresh` read is a verification walk and is pinned to
  // ONE endpoint for the account, the signature pages and the transactions.
  const trace: RpcTrace = {};
  const run = async (pin?: EndpointPin) => {
    const accountRead = await getCoreAccountWithMeta(mint, { fresh: opts.fresh, trace, pin });
    const account = accountRead.account;
    // Pinning one endpoint stops the walk being stitched from two NODES. It
    // does not stop one node serving the account from a recent slot and the
    // signature list from an older one behind a load balancer, which reads as
    // "this asset has no history" for an asset that was transferred a second
    // ago. Every later read in this walk asks for a state at least as recent
    // as the account read's own slot.
    const anchorSlot = accountRead.contextSlot;
    /** Set when an endpoint refused the parameter: the pin is still the guarantee, and the result says which held. */
    let slotFloorHonoured = anchorSlot !== null;
    let slotNote: string | undefined;
    const withAnchor = (config: Record<string, unknown>): Record<string, unknown> =>
      anchorSlot !== null && slotFloorHonoured ? { ...config, minContextSlot: anchorSlot } : config;
    /**
     * Run a read with the slot floor, and fall back without it when the
     * endpoint rejects the parameter rather than failing the whole walk. A
     * rejected parameter is a weaker guarantee, not a broken read - the pinned
     * endpoint still holds - so it is recorded and the walk continues.
     */
    const anchored = async <T>(attempt: (config: Record<string, unknown>) => Promise<T>, config: Record<string, unknown>): Promise<T> => {
      try {
        return await attempt(withAnchor(config));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // -32602 is "invalid params" and is what a node that does not take
        // minContextSlot answers; the named parameter appears in the message
        // of nodes that do take it but could not reach the slot.
        if (anchorSlot === null || !slotFloorHonoured || !/-32602|invalid param|minContextSlot|Minimum context slot/i.test(msg)) throw e;
        slotFloorHonoured = false;
        slotNote = `This endpoint refused minContextSlot (${msg.slice(0, 120)}), so the reads after the account were not pinned to slot ${anchorSlot}. They all came from the one pinned endpoint, which is the fallback guarantee.`;
        return attempt(config);
      }
    };
    if (!account || account.kind !== "asset") {
      throw new WrongKindError(
        account?.kind === "collection"
          ? `${mint} is a Core COLLECTION (${account.name}). Pass an asset mint, or use get_collection_stats for collections.`
          : `${mint} exists but does not decode as a Core asset (possibly burned).`,
      );
    }

    // Walk the signature list to the end (paged, newest first) so the oldest
    // event is the real mint and totals are real totals. Capped at 5 pages of
    // 1,000; beyond that the result says the history is incomplete.
    const walkSignatures = async () => {
      const all: { signature: string; blockTime: number | null; err: unknown }[] = [];
      let before: string | undefined;
      let complete = false;
      for (let page = 0; page < 5; page++) {
        const batch = await anchored(
          (config) =>
            rpc<{ signature: string; blockTime: number | null; err: unknown }[]>(
              "getSignaturesForAddress",
              [mint, config],
              trace,
              pin,
            ),
          before ? { limit: 1000, before } : { limit: 1000 },
        );
        if (!Array.isArray(batch)) throw new Error("Solana RPC returned an unexpected signature list");
        all.push(...batch);
        if (batch.length < 1000) { complete = true; break; }
        before = batch[batch.length - 1]!.signature;
      }
      return { sigs: all, complete };
    };
    // A verification must walk the chain now; a cached walk from two minutes
    // ago can miss the transfer that just happened.
    const walk = opts.fresh ? await walkSignatures() : (await cached(`sigs:${mint}`, 120_000, walkSignatures)).data;
    const sigs = walk.sigs;

    const ok = sigs.filter((s) => !s.err);
    // Newest-first from RPC. Always include the oldest (the mint) plus the most
    // recent `depth - 1`; announce anything we skipped rather than hiding it.
    let selected = ok;
    let skipped = 0;
    if (ok.length > depth) {
      selected = [...ok.slice(0, depth - 1), ok[ok.length - 1]!];
      skipped = ok.length - selected.length;
    }

    const events: ProvenanceEvent[] = [];
    // A signature the RPC could not return, or one carrying neither logs nor a
    // readable instruction list, is a hole in the evidence and is counted as
    // such - never silently skipped.
    let unreadable = 0;
    // Transactions whose logs and whose decoded instructions disagreed about
    // whether a transfer happened. The INSTRUCTIONS win; the count is reported
    // so a reader knows the log text could not corroborate them.
    let logsDisagreed = 0;
    for (const sig of selected) {
      // Confirmed transactions are immutable, so a cached one is the same bytes
      // whichever node served it; only the reads that actually go out are
      // pinned.
      const { data: tx } = await cached(`tx:${sig.signature}`, 3_600_000, () =>
        anchored(
          (config) => rpc<ParsedTx | null>("getTransaction", [sig.signature, config], trace, pin),
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ),
      );
      if (!tx?.meta) { unreadable++; continue; }
      if (tx.meta.err) continue; // failed transaction: nothing happened on chain

      const all: ParsedInstruction[] = [
        ...(Array.isArray(tx.transaction?.message?.instructions) ? tx.transaction.message.instructions : []),
        ...(Array.isArray(tx.meta.innerInstructions) ? tx.meta.innerInstructions : []).flatMap((i) =>
          Array.isArray(i?.instructions) ? i.instructions : [],
        ),
      ].filter((i): i is ParsedInstruction => Boolean(i) && typeof i.programId === "string");

      // Log text is a CROSS-CHECK, never the detector.
      //
      // The trap this closes: a transaction carrying a Core TransferV1 whose
      // logMessages happen to lack "Instruction: Transfer" - truncated logs, a
      // CPI whose wrapper swallowed them, a node that returned none - used to
      // be read as "no transfer", and with an otherwise complete history that
      // became a confirmed "never changed hands". Transfers are now identified
      // from the program id, the instruction discriminator and the account
      // slot on EVERY instruction of every readable transaction; the logs only
      // get to agree or disagree afterwards.
      const logs = Array.isArray(tx.meta.logMessages) ? tx.meta.logMessages : [];
      const logsMissing = !Array.isArray(tx.meta.logMessages);
      const coreIxs = all.filter((i) => i.programId === CORE_PROGRAM && (i.accounts ?? []).includes(mint));
      const decodable = coreIxs.filter((i) => discriminator(i.data) !== null);
      const transferIx = coreIxs.find((i) => discriminator(i.data) === IX_TRANSFER_V1);
      const createIx = coreIxs.find((i) => discriminator(i.data) === IX_CREATE_V1);
      const burnIx = coreIxs.find((i) => discriminator(i.data) === IX_BURN_V1);

      // A transaction we can read neither way is a hole, not an absence of
      // events: no logs AND no decodable Core instruction means we cannot say
      // what it did.
      if (logsMissing && decodable.length === 0) { unreadable++; continue; }

      const logSaysTransfer = logs.some((l) => typeof l === "string" && l.includes("Instruction: Transfer"));
      const logSaysCreate = logs.some((l) => typeof l === "string" && l.includes("Instruction: Create"));
      const logSaysBurn = logs.some((l) => typeof l === "string" && l.includes("Instruction: Burn"));

      const marketplace = all
        .map((i) => MARKETPLACE_PROGRAMS[i.programId])
        .find((m): m is string => Boolean(m));

      const time = sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null;

      // A Core instruction on this asset that we could not decode at all, with
      // logs claiming a transfer, is still a transfer - just one whose new
      // owner has to be inferred.
      const undecodableTransfer = !transferIx && logSaysTransfer && coreIxs.length > 0;

      if (transferIx || undecodableTransfer) {
        let newOwner: string | undefined;
        const notes: string[] = [];
        if (transferIx) {
          const candidate = transferIx.accounts?.[TRANSFER_NEW_OWNER_INDEX];
          // The slot is fixed, but the value still has to look like a pubkey
          // and must not be one of the structural accounts.
          const structural = new Set([mint, account.collection ?? "", CORE_PROGRAM, SYSTEM_PROGRAM, LOG_WRAPPER]);
          newOwner = candidate && isBase58Address(candidate) && !structural.has(candidate) ? candidate : undefined;
          if (!newOwner) notes.push("the TransferV1 new_owner slot did not hold a usable address; the transfer is recorded, the recipient is not");
          if (!logSaysTransfer) {
            logsDisagreed++;
            notes.push(
              logsMissing
                ? "this transaction carried no logs; the transfer was identified from the Core program id, the TransferV1 discriminator and the account list"
                : "the transaction logs do not mention a Transfer instruction, but a TransferV1 for this asset is present in the instruction list - the instructions are the record, the logs could not corroborate them",
            );
          }
        } else {
          const coreIx = coreIxs[0];
          const exclude = new Set([mint, account.collection ?? "", CORE_PROGRAM, SYSTEM_PROGRAM, LOG_WRAPPER]);
          const candidates = (coreIx?.accounts ?? []).filter((a) => !exclude.has(a) && isBase58Address(a));
          newOwner = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
          notes.push("new owner inferred from the account list (no instruction data available); treat as probable");
        }
        events.push({ signature: sig.signature, time, event: "transferred", newOwner, marketplace, ...(notes.length ? { note: notes.join("; ") } : {}) });
      } else if (burnIx || (logSaysBurn && coreIxs.length > 0)) {
        events.push({ signature: sig.signature, time, event: "burned", marketplace });
      } else if (createIx || (logSaysCreate && coreIxs.length > 0)) {
        events.push({ signature: sig.signature, time, event: "minted", marketplace });
      } else if (marketplace) {
        // Listing/delisting/escrow motion on a marketplace - no ownership change.
        events.push({ signature: sig.signature, time, event: "marketplace_activity", marketplace });
      } else {
        events.push({ signature: sig.signature, time, event: "other", marketplace });
      }
    }

    events.reverse(); // oldest first - reads as a story
    return { account, events, skipped, unreadable, logsDisagreed, walk, okCount: ok.length, anchorSlot, slotFloorHonoured, slotNote };
  };

  // A fresh read is a verification walk: one endpoint for the whole thing, or
  // one clean restart, or unverifiable. An ordinary read keeps the old
  // behaviour, where rotating between endpoints costs nothing but a label.
  const { value, endpointPinned } = opts.fresh
    ? await pinnedWalk(run)
    : { value: await run(), endpointPinned: "not pinned (this was not a verification read)" };
  const { account, events, skipped, unreadable, logsDisagreed, walk, okCount, anchorSlot, slotFloorHonoured, slotNote } = value;

  return {
    mint,
    explorer: `https://solscan.io/token/${mint}`,
    name: account.name,
    collection: account.collection,
    currentOwner: account.owner,
    currentOwnerNote:
      "If the asset is listed on a marketplace, currentOwner may be an escrow account, not the seller's wallet.",
    events,
    skippedTransactions: skipped,
    /** Signatures whose transaction could not be fetched, or which carried neither logs nor a decodable Core instruction. */
    unreadableTransactions: unreadable,
    /** Transactions where the logs did not corroborate a TransferV1 that the instruction list clearly carries. */
    transfersWithoutLogEvidence: logsDisagreed,
    totalSignatures: okCount,
    /** The last Solana endpoint to serve part of this read (host only - a private URL's key is never echoed). */
    rpcEndpointUsed: trace.endpoint ?? "cache (no endpoint was contacted for this read)",
    /** Every endpoint that served part of it: the account, the signature pages and the transactions can come from different ones. */
    rpcEndpointsUsed: trace.endpoints ?? [],
    /** For a verification walk, the ONE endpoint every read in it was pinned to. */
    endpointPinned,
    /** The slot the account read described; every later read in this walk asked for a state at least this recent. */
    contextSlot: anchorSlot,
    /** True when the endpoint accepted that floor. False means the pin alone carried the consistency guarantee. */
    slotFloorHonoured,
    ...(slotNote ? { slotNote } : {}),
    ...(trace.rotations ? { rpcEndpointNote: `Moved on after: ${trace.rotations.join("; ")}.` } : {}),
    /** True only when every signature was listed, every transaction was decoded (none skipped for depth), and every one was readable. */
    historyComplete: walk.complete && unreadable === 0 && skipped === 0,
    ...(walk.complete ? {} : { historyNote: "This asset has more signatures than were walked; the earliest events, including the mint, are not in this list." }),
  };
}

/**
 * Find recent asset mints touched by transactions on a Core COLLECTION
 * address. Used to discover concrete asset addresses from a collection
 * keylessly (no DAS API needed) - handy for demos and spot checks.
 *
 * Bounded twice, because this runs inside ordinary calls: transactions are
 * fetched one at a time behind the shared RPC gate, so a listing-heavy or slow
 * collection could otherwise keep one identify() running for minutes. Running
 * out of time is reported rather than hidden - "no members found" and "we ran
 * out of time looking" are different answers.
 */
export async function findRecentCollectionAssets(
  collection: string,
  max = 3,
  opts: { maxTransactions?: number; deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<{ assets: string[]; transactionsRead: number; timedOut: boolean }> {
  const maxTransactions = opts.maxTransactions ?? 8;
  const deadline = Date.now() + (opts.deadlineMs ?? 6_000);
  const signal = opts.signal;
  // Listings (e.g. Magic Eden CoreSell) carry no Core instruction, so a
  // listing-heavy stretch needs headroom before we hit a real transfer.
  const sigs = await rpc<{ signature: string; err: unknown }[]>(
    "getSignaturesForAddress",
    [collection, { limit: 25 }],
    undefined,
    undefined,
    signal,
  );
  const found = new Set<string>();
  let transactionsRead = 0;
  let ranOut = false;
  for (const s of sigs.filter((x) => !x.err)) {
    if (found.size >= max) break;
    if (transactionsRead >= maxTransactions || Date.now() > deadline || signal?.aborted) {
      ranOut = true;
      break;
    }
    transactionsRead++;
    const tx = await rpc<ParsedTx | null>(
      "getTransaction",
      [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      undefined,
      undefined,
      signal,
    );
    if (!tx?.meta || tx.meta.err) continue;
    const all = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];
    for (const ix of all) {
      if (ix.programId !== CORE_PROGRAM) continue;
      const accts = ix.accounts ?? [];
      if (!accts.includes(collection)) continue;
      // Core instructions list the asset first.
      const candidate = accts[0];
      if (candidate && candidate !== collection) found.add(candidate);
    }
  }
  return { assets: [...found].slice(0, max), transactionsRead, timedOut: ranOut };
}

// ------------------------------------------------------------ wallet age

/**
 * How old a wallet is and roughly how busy, from its signature list.
 *
 * Signatures come newest-first, 1,000 per call. A bot wallet can produce
 * 1,000 in a day, so we cap the walk at `maxPages` and report a bound
 * ("older than", "at least N transactions") instead of a false precision.
 */
export async function walletAge(wallet: string, maxPages = 3) {
  const trace: RpcTrace = {};
  let before: string | undefined;
  let count = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await rpc<{ signature: string; blockTime: number | null }[]>(
      "getSignaturesForAddress",
      [wallet, before ? { limit: 1000, before } : { limit: 1000 }],
      trace,
    );
    if (!Array.isArray(sigs) || sigs.length === 0) {
      complete = true;
      break;
    }
    count += sigs.length;
    if (newest === null && sigs[0]?.blockTime) newest = sigs[0].blockTime;
    const last = sigs[sigs.length - 1]!;
    if (last.blockTime) oldest = last.blockTime;
    before = last.signature;
    if (sigs.length < 1000) {
      complete = true;
      break;
    }
  }
  // One sentinel read past the page budget.
  //
  // Exactly `maxPages` full pages is ambiguous: the wallet may have exactly
  // that many signatures, or millions more. Asking for ONE more signature
  // settles it for the cost of a single call, so a wallet whose history ends
  // precisely on the budget is reported as exact instead of being told its
  // "true first transaction is earlier" when it is not.
  let sentinelFailed = false;
  if (!complete && before) {
    try {
      const sentinel = await rpc<{ signature: string; blockTime: number | null }[]>(
        "getSignaturesForAddress",
        [wallet, { limit: 1, before }],
        trace,
      );
      if (Array.isArray(sentinel) && sentinel.length === 0) complete = true;
    } catch {
      // The sentinel is an extra confirmation, never a reason to fail the
      // whole read; without it the count stays a lower bound, which is true.
      sentinelFailed = true;
    }
  }
  const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);
  const days = oldest ? Math.floor((Date.now() / 1000 - oldest) / 86_400) : null;
  return {
    transactions: count,
    transactionsExact: complete,
    firstSeen: iso(oldest),
    firstSeenIsBound: !complete,
    lastSeen: iso(newest),
    ageDays: days,
    rpcEndpointUsed: trace.endpoint ?? "no endpoint was contacted for this read",
    rpcEndpointsUsed: trace.endpoints ?? [],
    ...(trace.rotations ? { rpcEndpointNote: `Moved on after: ${trace.rotations.join("; ")}.` } : {}),
    note: complete
      ? "Every signature was counted."
      : `Stopped after ${count} signatures (${maxPages} pages)${sentinelFailed ? ", and the one extra signature that would have settled whether more exist could not be read" : ""}. ` +
        `The wallet is AT LEAST this old and this busy; the true first transaction MAY be earlier.`,
  };
}
