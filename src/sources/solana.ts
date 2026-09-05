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

import { cached, rateLimiter } from "../lib/http.js";
import { clean } from "../lib/untrusted.js";

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

// Public mainnet endpoint works from residential IPs (where stdio MCP servers
// run). Overridable for users with their own endpoint - still optional.
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Be polite to the free endpoint: one request per 350ms, serialized, and
// retry 429/5xx with a real backoff - the public RPC rate-limits bursts hard.
const gate = rateLimiter(350);

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    await gate();
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`Solana RPC HTTP ${res.status}`);
      if (!res.ok) throw new NoRetryError(`Solana RPC HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (j.error) {
        // -32429 = provider rate limit; retryable. Other JSON-RPC errors are not.
        if (j.error.code === -32429) throw new Error(`Solana RPC ${j.error.code}: ${j.error.message}`);
        throw new NoRetryError(`Solana RPC ${j.error.code}: ${j.error.message}`);
      }
      // A malformed envelope with neither result nor error must not read as
      // "no account" or "no history" downstream.
      if (!("result" in j)) throw new NoRetryError("Solana RPC returned an envelope with no result field");
      return j.result as T;
    } catch (e) {
      if (e instanceof NoRetryError) throw new Error(e.message);
      lastErr = e;
    }
  }
  throw new Error(
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)} (after 4 attempts - the free public RPC is ` +
      `rate-limited; set SOLANA_RPC_URL to any endpoint you prefer, still no key required by this server)`,
  );
}

class NoRetryError extends Error {}

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

export async function getCoreAccount(
  address: string,
  opts: { fresh?: boolean } = {},
): Promise<CoreAsset | CoreCollection | null> {
  const read = async () => {
    const info = await rpc<{ value: { data: [string, string]; owner: string } | null }>(
      "getAccountInfo",
      [address, { encoding: "base64" }],
    );
    if (!info?.value) return { missing: true as const };
    if (info.value.owner !== CORE_PROGRAM) return { notCore: true as const, owner: info.value.owner };
    return { decoded: decodeCoreAccount(info.value.data[0]) };
  };
  // `fresh` bypasses the stale-on-error cache: a verification must never
  // confirm ownership or supply from a value kept alive by a failed refresh.
  const { data } = opts.fresh ? { data: await read() } : await cached(`core:${address}`, 60_000, read);
  if ("missing" in data) throw new Error(`account ${address} does not exist on mainnet`);
  if ("notCore" in data)
    throw new Error(
      `account ${address} is owned by ${data.owner}, not Metaplex Core. ` +
        `v1 decodes Metaplex Core assets only (SPL/compressed NFTs: use get_asset, which reads Magic Eden instead).`,
    );
  return data.decoded;
}

// ---------------------------------------------------------- provenance

export interface ProvenanceEvent {
  signature: string;
  time: string | null;
  event: "minted" | "transferred" | "burned" | "marketplace_activity" | "other";
  newOwner?: string;
  marketplace?: string;
}

interface ParsedInstruction {
  programId: string;
  accounts?: string[];
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
export async function getProvenance(mint: string, depth = 15) {
  const account = await getCoreAccount(mint);
  if (!account || account.kind !== "asset") {
    throw new Error(
      account?.kind === "collection"
        ? `${mint} is a Core COLLECTION (${account.name}). Pass an asset mint, or use get_collection_stats for collections.`
        : `${mint} exists but does not decode as a Core asset (possibly burned).`,
    );
  }

  // Walk the signature list to the end (paged, newest first) so the oldest
  // event is the real mint and totals are real totals. Capped at 5 pages of
  // 1,000; beyond that the result says the history is incomplete.
  const { data: walk } = await cached(`sigs:${mint}`, 120_000, async () => {
    const all: { signature: string; blockTime: number | null; err: unknown }[] = [];
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < 5; page++) {
      const batch = await rpc<{ signature: string; blockTime: number | null; err: unknown }[]>("getSignaturesForAddress", [
        mint,
        before ? { limit: 1000, before } : { limit: 1000 },
      ]);
      if (!Array.isArray(batch)) throw new Error("Solana RPC returned an unexpected signature list");
      all.push(...batch);
      if (batch.length < 1000) { complete = true; break; }
      before = batch[batch.length - 1]!.signature;
    }
    return { sigs: all, complete };
  });
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
  for (const sig of selected) {
    const { data: tx } = await cached(`tx:${sig.signature}`, 3_600_000, () =>
      rpc<ParsedTx | null>("getTransaction", [
        sig.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]),
    );
    if (!tx?.meta || tx.meta.err) continue;

    const logs = tx.meta.logMessages ?? [];
    const isTransfer = logs.some((l) => l.includes("Instruction: Transfer"));
    const isCreate = logs.some((l) => l.includes("Instruction: Create"));
    const isBurn = logs.some((l) => l.includes("Instruction: Burn"));

    const all: ParsedInstruction[] = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];
    const marketplace = all
      .map((i) => MARKETPLACE_PROGRAMS[i.programId])
      .find((m): m is string => Boolean(m));

    const time = sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null;

    if (isTransfer) {
      // The Core instruction that includes this asset carries the new owner.
      const coreIx = all.find(
        (i) => i.programId === CORE_PROGRAM && (i.accounts ?? []).includes(mint),
      );
      const exclude = new Set([mint, account.collection ?? "", CORE_PROGRAM, SYSTEM_PROGRAM, LOG_WRAPPER]);
      const candidates = (coreIx?.accounts ?? []).filter((a) => !exclude.has(a));
      const newOwner = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
      events.push({ signature: sig.signature, time, event: "transferred", newOwner, marketplace });
    } else if (isBurn) {
      events.push({ signature: sig.signature, time, event: "burned", marketplace });
    } else if (isCreate) {
      events.push({ signature: sig.signature, time, event: "minted", marketplace });
    } else if (marketplace) {
      // Listing/delisting/escrow motion on a marketplace - no ownership change.
      events.push({ signature: sig.signature, time, event: "marketplace_activity", marketplace });
    } else {
      events.push({ signature: sig.signature, time, event: "other", marketplace });
    }
  }

  events.reverse(); // oldest first - reads as a story
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
    totalSignatures: ok.length,
    /** False when the asset has more than 5,000 signatures and the oldest were not read. */
    historyComplete: walk.complete,
    ...(walk.complete ? {} : { historyNote: "This asset has more signatures than were walked; the earliest events, including the mint, are not in this list." }),
  };
}

/**
 * Find recent asset mints touched by transactions on a Core COLLECTION
 * address. Used to discover concrete asset addresses from a collection
 * keylessly (no DAS API needed) - handy for demos and spot checks.
 */
export async function findRecentCollectionAssets(collection: string, max = 3): Promise<string[]> {
  // 25 sigs: listings (e.g. Magic Eden CoreSell) carry no Core instruction,
  // so a listing-heavy stretch needs headroom before we hit a real transfer.
  const sigs = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [
    collection,
    { limit: 25 },
  ]);
  const found = new Set<string>();
  for (const s of sigs.filter((x) => !x.err)) {
    if (found.size >= max) break;
    const tx = await rpc<ParsedTx | null>("getTransaction", [
      s.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
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
  return [...found].slice(0, max);
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
  let before: string | undefined;
  let count = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await rpc<{ signature: string; blockTime: number | null }[]>("getSignaturesForAddress", [
      wallet,
      before ? { limit: 1000, before } : { limit: 1000 },
    ]);
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
  const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);
  const days = oldest ? Math.floor((Date.now() / 1000 - oldest) / 86_400) : null;
  return {
    transactions: count,
    transactionsExact: complete,
    firstSeen: iso(oldest),
    firstSeenIsBound: !complete,
    lastSeen: iso(newest),
    ageDays: days,
    note: complete
      ? "Every signature was counted."
      : `Stopped after ${count} signatures (${maxPages} pages). The wallet is AT LEAST this old and this busy; the true first transaction is earlier.`,
  };
}
