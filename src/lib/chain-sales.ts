/**
 * Sales proven from the chain itself.
 *
 * Two kinds of sale never reach the marketplace feeds this server reads.
 * Tensor's API needs a key issued on request, so Tensor is not read at all,
 * and Magic Eden's feed does not carry OpenSea's own Solana fills (on
 * 2026-11-14 its feed for Batman: The Long Halloween ended on October 8 while
 * OpenSea sold an item from it for 0.3 SOL on November 12). Both leave the
 * same evidence on chain: a Metaplex Core transfer of the item, made inside a
 * marketplace program's instruction, with the payment beside it. This module
 * reads one transaction and says whether it is a sale of one item, on which
 * venue, for how much, in which currency, between whom, or that it cannot
 * tell and why.
 *
 * What each venue's transaction looks like, read on 2026-11-14 from real
 * transactions (signatures in test/fixtures/chain-sales/) and, where the
 * program is open source, from its published code:
 *
 *  - Magic Eden order book (M2mx93...). A buy is three instructions: deposit
 *    (the buyer funds an escrow), buy_v2 (the bid), core_execute_sale_v2 (the
 *    escrow pays royalties, the seller and the fee, and the item moves from
 *    Magic Eden's escrow to the buyer). An accepted offer is core_sell then
 *    core_execute_sale_v2 in one transaction. Accounts: 1 buyer, 2 seller.
 *    M2 publishes no Core layout; the slots are read from five transactions.
 *    On a buy the seller receives the list price and the buyer pays royalties
 *    and a 2% fee on top (2 SOL listed, 2.24 SOL paid); on an accepted offer
 *    the seller pays the fee.
 *  - Magic Eden pools (mmm3XB...). sol_mpl_core_fulfill_buy sells an item into
 *    a pool: 0 the seller, 1 the pool owner, who receives the item. The pool's
 *    escrow pays, so the buyer's own balance does not move. fulfill_sell is
 *    the reverse (0 buyer, 1 owner). Both from MMM's published source.
 *  - Tensor (TCMPhJ...). buy_core: 4 buyer, 6 seller; buy_core_spl: 2 buyer,
 *    7 seller; take_bid_core: 1 seller, 3 bid owner. From Tensor's published
 *    IDL 0.7.1 and four real sales. A take_bid pays by moving lamports
 *    directly, with no transfer instruction to read, so its amounts come from
 *    balance changes. Tensor's pool program (TSWAPa...) appears only as the
 *    bid's shared escrow; no Core pool fill through it was found.
 *  - OpenSea (7Aru29...). The program answers Tensor's instruction names and
 *    logs TcompNoop; its accounts are Tensor's with one extra account first
 *    (buy_core: 5 buyer, 7 seller; buy_core_spl: 3 buyer, 8 seller). Read from
 *    real transactions; the take_bid slots are Tensor's shifted by one and no
 *    real one has been seen. BuyCoreSpl is a payment in an SPL token: the
 *    handoff's example paid 3,115.14 of a memecoin, not SOL.
 *
 * The price is taken from the money that reached the seller first: the
 * transfers inside the venue's own instruction, which name each recipient and
 * amount exactly. A seller's balance change is the second choice, because it
 * also counts rent the venue returns when it closes the listing (0.0039 SOL
 * received showed as 0.0071). The buyer's outgoing amount is used last, and
 * only when one item moved. A transaction that moves several items gives no
 * per-item price at all.
 */

import { createHash } from "node:crypto";
import * as sol from "../sources/solana.js";
import { isoFromBlockTime, usableBlockTime } from "./time.js";
import { BoundedMap } from "./bounded.js";
import { NATIVE_SOL, WRAPPED_SOL, classifyPaymentToken, currencyByMint, type KnownCurrency } from "./reconcile.js";
import { isSelfFill } from "../market.js";

const CORE = sol.CORE_PROGRAM;
const SYSTEM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const IX_TRANSFER_V1 = 14;
const IX_CREATE_V1 = 0;
const IX_CREATE_V2 = 20;
const IX_BURN_V1 = 12;
/** The highest Core instruction the decoder in solana.ts knows; anything above it is unknown. */
const IX_KNOWN_MAX = 41;

// ------------------------------------------------------------- currencies

export type CurrencyCode = KnownCurrency;

export interface SaleCurrency {
  /** SOL, USDC, USDT or PYUSD; null for any other token, which is never counted as SOL. */
  code: CurrencyCode | null;
  /** The token's mint address; null for native SOL. */
  mint: string | null;
  /** True when SOL was paid as the wrapped SOL token. */
  wrapped?: true;
  paidInOtherToken: boolean;
  decimals: number;
  /** How to name it to a person. */
  label: string;
  /** The feed rows' wording for a payment in another token, when there is one. */
  note?: string;
}

/**
 * The currency a mint stands for. Null means native SOL (lamports, no mint).
 *
 * Decided by the same rule and the same table as the marketplace sale rows
 * (classifyPaymentToken in reconcile.ts): by mint ADDRESS, never by symbol,
 * because anyone can mint a token named SOL or USDC. Wrapped SOL is SOL.
 * Everything else is another token.
 */
export function currencyOfMint(mint: string | null, decimals: number): SaleCurrency {
  const c = classifyPaymentToken(mint ?? NATIVE_SOL, undefined, "The chain");
  const code = c.kind === "sol" || c.kind === "stablecoin" ? currencyByMint(c.paymentToken ?? "") : null;
  if (code === "SOL") {
    return mint === null || mint === NATIVE_SOL
      ? { code, mint: null, paidInOtherToken: false, decimals: 9, label: "SOL" }
      : { code, mint, wrapped: true, paidInOtherToken: false, decimals: 9, label: "SOL (wrapped)" };
  }
  if (code) return { code, mint, paidInOtherToken: false, decimals, label: code };
  return { code: null, mint, paidInOtherToken: true, decimals, label: `another token (mint ${mint})`, ...(c.note ? { note: c.note } : {}) };
}

// ------------------------------------------------------------- venues

type IxKind = "sale" | "listing" | "delisting" | "escrow-move" | "bid" | "pool-admin" | "log";
interface IxDef {
  kind: IxKind;
  /** Account slots in the venue instruction, for a sale. */
  buyer?: number;
  seller?: number;
  /** Other slots whose receipts are the seller's own (a pool's escrow when it keeps its proceeds). */
  sellerAlso?: number[];
  /** Slots, besides the buyer, that may receive the item (a pool that keeps what it buys). */
  itemToAlso?: number[];
  /** The slot the venue returns closed accounts' rent to, where its layout names one. */
  rentTo?: number;
  /** Where the slots come from: the venue's published code, real transactions, or neither yet. */
  layout?: "published" | "observed" | "inferred";
}
interface Venue {
  name: "Magic Eden" | "Magic Eden pools" | "Tensor" | "Tensor pools" | "OpenSea";
  ix: Record<string, IxDef>;
}

/** Anchor's instruction discriminator: the first 8 bytes of sha256("global:<name>"). */
const anchor = (name: string): string => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const byDisc = (defs: Record<string, IxDef>): Record<string, IxDef & { name: string }> =>
  Object.fromEntries(Object.entries(defs).map(([name, d]) => [anchor(name), { ...d, name }]));

// Tensor's marketplace and OpenSea's program share instruction names; OpenSea
// passes one extra account first, so its slots are Tensor's plus one.
const TENSOR_NON_SALE: Record<string, IxDef> = {
  list_core: { kind: "listing" },
  delist_core: { kind: "delisting" },
  close_expired_listing_core: { kind: "delisting" },
  edit: { kind: "listing" },
  bid: { kind: "bid" },
  cancel_bid: { kind: "bid" },
  close_expired_bid: { kind: "bid" },
  tcomp_noop: { kind: "log" },
};

const VENUES: Record<string, { venue: Venue; table: Record<string, IxDef & { name: string }> }> = {};
function venue(program: string, v: Venue): void {
  VENUES[program] = { venue: v, table: byDisc(v.ix) };
}
venue("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", {
  name: "Magic Eden",
  ix: {
    core_execute_sale_v2: { kind: "sale", buyer: 1, seller: 2, layout: "observed" },
    core_sell: { kind: "listing" },
    core_cancel_sell: { kind: "delisting" },
    deposit: { kind: "bid" },
    withdraw: { kind: "bid" },
    buy_v2: { kind: "bid" },
    cancel_buy: { kind: "bid" },
    withdraw_by_mmm: { kind: "bid" },
  },
});
venue("mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc", {
  name: "Magic Eden pools",
  ix: {
    sol_mpl_core_fulfill_buy: { kind: "sale", seller: 0, buyer: 1, itemToAlso: [4], layout: "published" },
    sol_mpl_core_fulfill_sell: { kind: "sale", buyer: 0, seller: 1, sellerAlso: [5], layout: "published" },
    mpl_core_deposit_sell: { kind: "escrow-move" },
    mpl_core_withdraw_sell: { kind: "escrow-move" },
    mpl_core_wrap: { kind: "escrow-move" },
    sol_deposit_buy: { kind: "bid" },
    sol_withdraw_buy: { kind: "bid" },
    create_pool: { kind: "pool-admin" },
    update_pool: { kind: "pool-admin" },
    update_allowlists: { kind: "pool-admin" },
    sol_close_pool: { kind: "pool-admin" },
  },
});
venue("TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp", {
  name: "Tensor",
  ix: {
    buy_core: { kind: "sale", buyer: 4, seller: 6, layout: "published" },
    buy_core_spl: { kind: "sale", buyer: 2, seller: 7, layout: "published" },
    take_bid_core: { kind: "sale", seller: 1, buyer: 3, rentTo: 16, layout: "published" },
    ...TENSOR_NON_SALE,
  },
});
venue("TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN", { name: "Tensor pools", ix: {} });
venue(sol.OPENSEA_SOLANA_PROGRAM, {
  name: "OpenSea",
  ix: {
    buy_core: { kind: "sale", buyer: 5, seller: 7, layout: "observed" },
    buy_core_spl: { kind: "sale", buyer: 3, seller: 8, layout: "observed" },
    take_bid_core: { kind: "sale", seller: 2, buyer: 4, rentTo: 17, layout: "inferred" },
    ...TENSOR_NON_SALE,
  },
});

// ------------------------------------------------------------- results

export type NotSaleKind =
  | "failed"
  | "item-absent"
  | "item-not-moved"
  | "direct-transfer"
  | "listing"
  | "delisting"
  | "escrow-move"
  | "bid"
  | "pool-admin"
  | "other-core";

export interface ChainSale {
  status: "sale" | "not-a-sale" | "cannot-tell";
  /** For a non-sale, what the transaction did to the item instead. */
  kind?: NotSaleKind;
  /** One plain sentence, always present. */
  reason: string;
  item: string;
  signature: string | null;
  time: string | null;
  slot: number | null;
  venue?: string;
  program?: string;
  instruction?: string;
  /** Where the buyer and seller slots come from. */
  layout?: "published" | "observed" | "inferred";
  collection?: string | null;
  seller?: string;
  buyer?: string;
  /** Who the item went to, from the Core transfer itself. */
  newOwner?: string;
  /** Distinct Core items this transaction moved. */
  itemsMoved?: number;
  currency?: SaleCurrency;
  /** Everything paid for this item: the seller's share plus royalty and fee legs. */
  price?: number | null;
  priceRaw?: string | null;
  priceBasis?: "venue-transfers" | "balance-changes" | "buyer-balance";
  /** False when the figure comes from balance changes, which can include returned rent. */
  priceExact?: boolean;
  /** How far, in the currency, an inexact figure can be off (the rent that moved in this transaction). */
  priceSlack?: number;
  sellerReceived?: number | null;
  /** The buyer's own outgoing amount, network fee excluded, when one item moved and the buyer paid it. */
  buyerPaid?: number | null;
  /** Royalty, fee and broker legs: everyone except the seller who was paid for this item. */
  otherRecipients?: { address: string; amount: number }[];
  /** Why there is no price, when there is none. */
  noPriceReason?: string;
  /** One wallet as buyer and seller, by the marketplace rows' rule (isSelfFill): a sale, but its amount is nobody's payment. */
  selfFill?: true;
  notes: string[];
}

// ------------------------------------------------------------- plumbing

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 to bytes, or null. Bounded, because instruction data is upstream text. */
function base58Bytes(s: string, maxLength = 2_000): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > maxLength) return null;
  let n = 0n;
  for (const ch of s) {
    const d = B58.indexOf(ch);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + hex.length / 2);
  for (let i = 0; i < hex.length / 2; i++) out[zeros + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A transaction signature: base58 that decodes to exactly 64 bytes. */
export function isSignature(s: unknown): s is string {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s) && base58Bytes(s, 88)?.length === 64;
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const addr = (v: unknown): string | null => (typeof v === "string" && sol.isBase58Address(v) ? v : null);
const lamports = (v: unknown): bigint | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
const rawAmount = (v: unknown): bigint | null => {
  if (typeof v === "number") return lamports(v);
  return typeof v === "string" && /^\d{1,40}$/.test(v) ? BigInt(v) : null;
};

/** A raw amount in whole units, through a decimal string so 2240000000 lamports reads 2.24 and not 2.2399999. */
function units(raw: bigint, decimals: number): number {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return Number(`${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`);
}

interface Node {
  programId: string;
  accounts: string[];
  data: string | null;
  parsedType: string | null;
  info: Record<string, unknown> | null;
  depth: number;
  parent: number | null;
}

interface Parsed {
  keys: string[];
  pre: bigint[];
  post: bigint[];
  fee: bigint;
  nodes: Node[];
  tokenAccounts: Map<string, { mint: string; owner: string | null; decimals: number }>;
  tokenPre: Map<string, bigint>;
  tokenPost: Map<string, bigint>;
  blockTime: number | null;
  slot: number | null;
  signature: string | null;
  failed: boolean;
}

/** The transaction's shape, checked field by field. A string is a reason it could not be read. */
function parse(raw: unknown): Parsed | string {
  const tx = rec(raw);
  if (!tx) return "the endpoint returned no transaction for this signature (it may not exist, may not be final yet, or the endpoint keeps no history for it)";
  const meta = rec(tx.meta);
  const message = rec(rec(tx.transaction)?.message);
  if (!meta || !message) return "the transaction came back without its status or its message";
  const sigs = rec(tx.transaction)?.signatures;
  const signature = Array.isArray(sigs) && typeof sigs[0] === "string" ? sigs[0] : null;
  const failed = meta.err !== null && meta.err !== undefined;
  const keyList = Array.isArray(message.accountKeys) ? message.accountKeys : null;
  if (!keyList) return "the transaction's account list is missing";
  const keys: string[] = [];
  for (const k of keyList) {
    const a = addr(typeof k === "string" ? k : rec(k)?.pubkey);
    if (!a) return "the transaction's account list holds an entry that is not an address";
    keys.push(a);
  }
  const preRaw = Array.isArray(meta.preBalances) ? meta.preBalances : null;
  const postRaw = Array.isArray(meta.postBalances) ? meta.postBalances : null;
  if (!preRaw || !postRaw || preRaw.length !== postRaw.length) return "the transaction's balance lists are missing or uneven";
  // jsonParsed lists table-loaded accounts in accountKeys already; an answer
  // that lists them only under loadedAddresses is joined the same way the
  // balances are ordered (writable, then read-only).
  if (keys.length !== preRaw.length) {
    const loaded = rec(meta.loadedAddresses);
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
    const extra = [...list(loaded?.writable), ...list(loaded?.readonly)].map(addr);
    if (extra.some((a) => a === null) || keys.length + extra.length !== preRaw.length) return "the transaction's account list and balance list do not line up";
    keys.push(...(extra as string[]));
  }
  const pre: bigint[] = [];
  const post: bigint[] = [];
  for (let i = 0; i < preRaw.length; i++) {
    const a = lamports(preRaw[i]);
    const b = lamports(postRaw[i]);
    if (a === null || b === null) return "a balance in the transaction is not a whole number of lamports";
    pre.push(a);
    post.push(b);
  }
  const fee = lamports(meta.fee) ?? 0n;

  const tokenAccounts = new Map<string, { mint: string; owner: string | null; decimals: number }>();
  const tokenPre = new Map<string, bigint>();
  const tokenPost = new Map<string, bigint>();
  for (const [list, into] of [[meta.preTokenBalances, tokenPre], [meta.postTokenBalances, tokenPost]] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return "the transaction's token balances are not a list";
    for (const b of list) {
      const r = rec(b);
      const idx = r?.accountIndex;
      const amount = rawAmount(rec(r?.uiTokenAmount)?.amount);
      const decimals = rec(r?.uiTokenAmount)?.decimals;
      const mint = addr(r?.mint);
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= keys.length || amount === null || !mint || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        return "a token balance in the transaction could not be read";
      }
      const account = keys[idx]!;
      tokenAccounts.set(account, { mint, owner: addr(r?.owner), decimals });
      into.set(account, amount);
    }
  }

  // Execution order with parents. A stack per inner group gives each inner
  // instruction its caller, which is how a transfer is tied to the venue
  // instruction that made it.
  const nodes: Node[] = [];
  const toNode = (v: unknown, depth: number, parent: number | null): Node | null => {
    const r = rec(v);
    const programId = addr(r?.programId);
    if (!r || !programId) return null;
    const parsed = rec(r.parsed);
    const accounts = Array.isArray(r.accounts) ? r.accounts.filter((a): a is string => typeof a === "string") : [];
    return { programId, accounts, data: typeof r.data === "string" ? r.data : null, parsedType: typeof parsed?.type === "string" ? parsed.type : null, info: rec(parsed?.info), depth, parent };
  };
  const outer = Array.isArray(message.instructions) ? message.instructions : null;
  if (!outer) return "the transaction's instruction list is missing";
  const groups = new Map<number, unknown[]>();
  const innerRaw = meta.innerInstructions;
  if (innerRaw !== undefined && innerRaw !== null) {
    if (!Array.isArray(innerRaw)) return "the transaction's inner instructions are not a list";
    for (const g of innerRaw) {
      const r = rec(g);
      if (!r || typeof r.index !== "number" || !Array.isArray(r.instructions)) return "an inner instruction group could not be read";
      if (r.index < 0 || r.index >= outer.length || groups.has(r.index)) return "an inner instruction group names no instruction of this transaction, so the order of events is unknown";
      groups.set(r.index, r.instructions);
    }
  }
  for (let i = 0; i < outer.length; i++) {
    const top = toNode(outer[i], 1, null);
    if (!top) return "an instruction in the transaction has no program";
    nodes.push(top);
    const stack = [nodes.length - 1];
    for (const child of groups.get(i) ?? []) {
      const h = rec(child)?.stackHeight;
      const depth = typeof h === "number" && Number.isInteger(h) && h >= 2 ? h : 2;
      if (depth > stack.length + 1) return "an inner instruction skips a level of the call stack, so its caller is unknown";
      stack.length = depth - 1;
      const node = toNode(child, depth, stack[depth - 2]!);
      if (!node) return "an inner instruction in the transaction has no program";
      nodes.push(node);
      stack.push(nodes.length - 1);
    }
  }
  const slot = typeof tx.slot === "number" && Number.isSafeInteger(tx.slot) ? tx.slot : null;
  return { keys, pre, post, fee, nodes, tokenAccounts, tokenPre, tokenPost, blockTime: usableBlockTime(tx.blockTime), slot, signature, failed };
}

const coreDisc = (n: Node): number | null => {
  if (n.programId !== CORE || n.data === null) return null;
  const b = base58Bytes(n.data);
  return b && b.length > 0 ? b[0]! : null;
};
const anchorHex = (n: Node): string | null => {
  const b = n.data === null ? null : base58Bytes(n.data);
  return b && b.length >= 8 ? Buffer.from(b.subarray(0, 8)).toString("hex") : null;
};
const isTransfer = (n: Node) => coreDisc(n) === IX_TRANSFER_V1 && n.accounts.length >= 5;
const present = (a: string | undefined): string | null => (a && a !== CORE && a !== SYSTEM && sol.isBase58Address(a) ? a : null);

/** True when `child` runs inside `ancestor`'s call. */
function within(nodes: Node[], child: number, ancestor: number): boolean {
  let p: number | null = child;
  while (p !== null) {
    if (p === ancestor) return true;
    p = nodes[p]!.parent;
  }
  return false;
}

interface Leg { currency: string; decimals: number; from: string; to: string; raw: bigint; wrapped?: true }

/** Value moved by transfer instructions: SOL by the System Program, tokens by either token program. */
function legsOf(p: Parsed, idx: number[]): Leg[] {
  const out: Leg[] = [];
  for (const i of idx) {
    const n = p.nodes[i]!;
    if (n.programId === SYSTEM && (n.parsedType === "transfer" || n.parsedType === "transferWithSeed")) {
      const from = addr(n.info?.source);
      const to = addr(n.info?.destination);
      const raw = lamports(n.info?.lamports);
      if (from && to && raw !== null && raw > 0n) out.push({ currency: "SOL", decimals: 9, from, to, raw });
    } else if (TOKEN_PROGRAMS.has(n.programId) && (n.parsedType === "transfer" || n.parsedType === "transferChecked")) {
      const src = addr(n.info?.source);
      const dst = addr(n.info?.destination);
      const raw = rawAmount(n.info?.amount ?? rec(n.info?.tokenAmount)?.amount);
      if (!src || !dst || raw === null || raw === 0n) continue;
      const known = p.tokenAccounts.get(dst) ?? p.tokenAccounts.get(src);
      const mint = addr(n.info?.mint) ?? known?.mint ?? null;
      if (!mint) continue;
      const wrapped = mint === WRAPPED_SOL;
      out.push({
        currency: wrapped ? "SOL" : mint,
        decimals: wrapped ? 9 : known?.decimals ?? 0,
        from: p.tokenAccounts.get(src)?.owner ?? addr(n.info?.authority) ?? src,
        to: p.tokenAccounts.get(dst)?.owner ?? dst,
        raw,
        ...(wrapped ? { wrapped: true as const } : {}),
      });
    }
  }
  return out;
}

/** Balance change per owner and currency over the whole transaction; the network fee is added back for whoever paid it. */
function balanceChanges(p: Parsed): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  const add = (cur: string, who: string, v: bigint) => {
    const m = out.get(cur) ?? new Map<string, bigint>();
    m.set(who, (m.get(who) ?? 0n) + v);
    out.set(cur, m);
  };
  p.keys.forEach((k, i) => {
    const d = p.post[i]! - p.pre[i]! + (i === 0 ? p.fee : 0n);
    if (d !== 0n) add("SOL", k, d);
  });
  for (const [account, t] of p.tokenAccounts) {
    if (!t.owner) continue;
    const d = (p.tokenPost.get(account) ?? 0n) - (p.tokenPre.get(account) ?? 0n);
    if (d !== 0n) add(t.mint === WRAPPED_SOL ? "SOL" : t.mint, t.owner, d);
  }
  return out;
}

const decimalsOf = (p: Parsed, currency: string): number => {
  if (currency === "SOL") return 9;
  for (const t of p.tokenAccounts.values()) if (t.mint === currency) return t.decimals;
  return 0;
};
const currencyOf = (p: Parsed, currency: string, wrappedSeen: boolean): SaleCurrency =>
  currency === "SOL" ? currencyOfMint(wrappedSeen ? WRAPPED_SOL : null, 9) : currencyOfMint(currency, decimalsOf(p, currency));

// ------------------------------------------------------------- the decoder

/**
 * Whether one parsed transaction (getTransaction, encoding jsonParsed) is a
 * sale of `item`. Pure and total: every input, however malformed, gets an
 * answer, and every answer that is not a sale says why.
 */
export function decodeSale(raw: unknown, item: string, expectSignature?: string): ChainSale {
  const p = parse(raw);
  const base = { item, signature: expectSignature ?? null, time: null as string | null, slot: null as number | null, notes: [] as string[] };
  if (typeof p === "string") return { ...base, status: "cannot-tell", reason: `This transaction could not be read: ${p}.` };
  if (expectSignature && p.signature && p.signature !== expectSignature) {
    return { ...base, status: "cannot-tell", reason: "The endpoint answered with a different transaction from the one asked for, so nothing in it is evidence about this signature." };
  }
  const out = { ...base, signature: p.signature ?? expectSignature ?? null, time: isoFromBlockTime(p.blockTime), slot: p.slot };
  if (p.failed) return { ...out, status: "not-a-sale", kind: "failed", reason: "The transaction failed on chain, so nothing in it happened: no item moved and no payment was made." };

  const nodes = p.nodes;
  const transfers = nodes.map((n, i) => ({ n, i })).filter(({ n }) => isTransfer(n));
  const itemsMoved = new Set(transfers.map(({ n }) => n.accounts[0])).size;
  const coreOnItem = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.programId === CORE && n.accounts[0] === item);
  const unreadableCore = coreOnItem.filter(({ n }) => {
    const d = coreDisc(n);
    return d === null || d > IX_KNOWN_MAX;
  });
  if (unreadableCore.length > 0) {
    return { ...out, status: "cannot-tell", itemsMoved, reason: "A Metaplex Core instruction on this item could not be decoded, so what it did to the item is unknown." };
  }
  const mine = transfers.filter(({ n }) => n.accounts[0] === item);

  if (mine.length === 0) {
    if ([...p.tokenAccounts.values()].some((t) => t.mint === item)) {
      return { ...out, status: "cannot-tell", itemsMoved, reason: "This item moves as a token here, not as a Metaplex Core asset; sales are decoded for Core items only." };
    }
    if (!p.keys.includes(item)) {
      // A bid names its target in instruction data, not as an account, so a
      // bid on this very item lands here too. The venue's instruction is
      // named when it is one this decoder knows.
      const other = nodes.map((n) => ({ n, d: VENUES[n.programId]?.table[anchorHex(n) ?? ""] })).find(({ d }) => d && d.kind !== "log");
      const otherKind = other?.d?.kind;
      return {
        ...out,
        status: "not-a-sale",
        kind: otherKind && otherKind !== "sale" && otherKind !== "log" ? otherKind : "item-absent",
        itemsMoved,
        ...(other?.d ? { venue: VENUES[other.n.programId]!.venue.name, program: other.n.programId, instruction: other.d.name } : {}),
        reason: `The item does not appear in this transaction at all${other?.d ? ` (it is ${VENUES[other.n.programId]!.venue.name} ${other.d.name}, a ${other.d.kind === "sale" ? "fill of another item" : other.d.kind.replace("-", " ")})` : ""}, so this transaction cannot be a sale of it.`,
      };
    }
    if (coreOnItem.some(({ n }) => [IX_BURN_V1, IX_CREATE_V1, IX_CREATE_V2].includes(coreDisc(n) ?? -1))) {
      return { ...out, status: "not-a-sale", kind: "other-core", itemsMoved, reason: "This transaction created or burned the item; it did not sell it." };
    }
    const named = nodes.find((n) => VENUES[n.programId] && n.accounts.includes(item));
    const def = named ? VENUES[named.programId]!.table[anchorHex(named) ?? ""] : undefined;
    const kind: NotSaleKind = def && def.kind !== "sale" && def.kind !== "log" ? def.kind : "item-not-moved";
    return {
      ...out,
      status: "not-a-sale",
      kind,
      itemsMoved,
      ...(named ? { venue: VENUES[named.programId]!.venue.name, program: named.programId, ...(def ? { instruction: def.name } : {}) } : {}),
      reason: `The item is named in this transaction but did not change owner in it${named ? ` (${VENUES[named.programId]!.venue.name}${def ? ` ${def.name}` : ""})` : ""}. Every sale of a Core item moves it, so this is not a sale.`,
    };
  }

  // The transfer that decides it. Two moves of one item are a listing and its
  // fill only when the earlier one is a listing on the venue that sells it.
  const venueOf = (i: number): number | null => {
    let q = nodes[i]!.parent;
    while (q !== null) {
      if (VENUES[nodes[q]!.programId]) return q;
      q = nodes[q]!.parent;
    }
    return null;
  };
  const defOf = (v: number | null) => (v === null ? undefined : VENUES[nodes[v]!.programId]!.table[anchorHex(nodes[v]!) ?? ""]);
  const pick = mine[mine.length - 1]!;
  const notes: string[] = [];
  if (mine.length > 1) {
    const last = venueOf(pick.i);
    const earlierAreListings = mine.slice(0, -1).every(({ i }) => {
      const v = venueOf(i);
      return v !== null && last !== null && nodes[v]!.programId === nodes[last]!.programId && defOf(v)?.kind === "listing";
    });
    if (!(defOf(last)?.kind === "sale" && earlierAreListings)) {
      return { ...out, status: "cannot-tell", itemsMoved, reason: `The item moved ${mine.length} times in this one transaction, and the moves are not a listing followed by its fill, so which move was a sale cannot be told.` };
    }
    notes.push("The item was listed and sold in this same transaction, which is how an accepted offer is filled.");
  }
  const t = pick.n;
  const collection = present(t.accounts[1]);
  const newOwner = present(t.accounts[4]);
  const payer = present(t.accounts[2]);
  const authority = present(t.accounts[3]) ?? payer;
  if (!newOwner) return { ...out, status: "cannot-tell", itemsMoved, collection, reason: "The Core transfer of this item does not name a usable new owner." };
  const shared = { ...out, itemsMoved, collection, newOwner };

  const v = venueOf(pick.i);
  if (v === null) {
    if (t.parent !== null) {
      const top = (() => {
        let q: number = pick.i;
        while (nodes[q]!.parent !== null) q = nodes[q]!.parent!;
        return nodes[q]!.programId;
      })();
      return { ...shared, status: "cannot-tell", program: top, reason: `The item was moved by program ${top}, which is not a marketplace this decoder knows, so whether it was sold cannot be told.` };
    }
    // A direct transfer: the owner, or a delegate, moved it with no marketplace
    // program involved. A payment from the new owner beside it is how a private
    // sale looks, and is not called either way.
    const senders = new Set([payer, authority].filter((a): a is string => a !== null));
    const paid = legsOf(p, nodes.map((_, i) => i)).some((l) => l.from === newOwner && senders.has(l.to));
    if (paid) {
      return { ...shared, status: "cannot-tell", reason: "The item was transferred directly, with no marketplace program, and the receiver paid the sender in the same transaction. That is how a private sale looks, but no venue recorded it, so it is neither confirmed nor ruled out as a sale here." };
    }
    const who = present(t.accounts[3]) ? `authority ${authority}` : `its owner ${payer}`;
    return {
      ...shared,
      status: "not-a-sale",
      kind: "direct-transfer",
      reason:
        itemsMoved > 1
          ? `The item was moved directly by ${who}, together with ${itemsMoved - 1} other item(s) in one transaction, with no marketplace program and no payment: a batch move such as a wallet migration or a delegate's transfer, not a sale.`
          : `The item was moved directly by ${who}, with no marketplace program and no payment: a transfer, not a sale.`,
    };
  }

  const vn = nodes[v]!;
  const venueInfo = VENUES[vn.programId]!;
  const def = defOf(v);
  const named = { ...shared, venue: venueInfo.venue.name, program: vn.programId, ...(def ? { instruction: def.name } : {}) };
  if (!def) {
    return { ...named, status: "cannot-tell", reason: `The item moved inside a ${venueInfo.venue.name} instruction this decoder does not know (discriminator ${anchorHex(vn) ?? "unreadable"}), so whether it was a sale cannot be told.` };
  }
  if (def.kind !== "sale") {
    const what = def.kind === "listing" ? "a listing: the item moved into the venue's listing account" : def.kind === "delisting" ? "a delisting: the item came back out of the venue's listing account" : def.kind === "escrow-move" ? "an escrow move: the item went into or out of a pool" : `a ${def.kind} instruction`;
    return { ...named, status: "not-a-sale", kind: def.kind === "log" ? "item-not-moved" : def.kind, reason: `This is ${venueInfo.venue.name} ${def.name}, ${what}. No sale happened in it.` };
  }

  const seller = present(vn.accounts[def.seller!]);
  const buyer = present(vn.accounts[def.buyer!]);
  if (!seller || !buyer) return { ...named, status: "cannot-tell", reason: `The ${venueInfo.venue.name} ${def.name} instruction does not carry usable buyer and seller accounts where its layout puts them.` };
  if (!vn.accounts.includes(item)) return { ...named, status: "cannot-tell", reason: `The ${venueInfo.venue.name} ${def.name} instruction that moved the item does not name it, so the fill and the item cannot be tied together.` };
  const itemTo = new Set([buyer, ...(def.itemToAlso ?? []).map((s) => present(vn.accounts[s])).filter((a): a is string => a !== null)]);
  if (!itemTo.has(newOwner)) {
    return { ...named, seller, buyer, status: "cannot-tell", reason: `The item went to ${newOwner}, which is not the buyer ${buyer} that the ${venueInfo.venue.name} ${def.name} layout names, so the layout does not describe this transaction.` };
  }
  if (def.layout === "inferred") notes.push(`The buyer and seller slots for ${venueInfo.venue.name} ${def.name} are inferred from a sibling program and no real transaction of this kind has been checked; the payment must agree with them or the sale is not called.`);
  const self = isSelfFill(buyer, seller);
  if (self) notes.push("The buyer and the seller are the same wallet: a self-fill, which moves no ownership and proves no market price.");
  const sale = { ...named, seller, buyer, layout: def.layout, ...(self ? { selfFill: true as const } : {}) };

  // ------------------------------------------------------------ the money
  const sellerSide = new Set([seller, ...(def.sellerAlso ?? []).map((s) => present(vn.accounts[s])).filter((a): a is string => a !== null)]);
  const notPaidTo = new Set([buyer, newOwner]);
  const subtree = nodes.map((_, i) => i).filter((i) => within(nodes, i, v));
  const legs = legsOf(p, subtree);
  const wrappedSeen = legs.some((l) => l.wrapped && sellerSide.has(l.to));
  const net = new Map<string, Map<string, bigint>>();
  for (const l of legs) {
    const m = net.get(l.currency) ?? new Map<string, bigint>();
    m.set(l.from, (m.get(l.from) ?? 0n) - l.raw);
    m.set(l.to, (m.get(l.to) ?? 0n) + l.raw);
    net.set(l.currency, m);
  }
  const single = itemsMoved === 1;
  const changes = balanceChanges(p);
  // Lamports left in accounts this transaction closed went to someone. When
  // the layout names who (the rent slot) and it is not the seller, the
  // seller's balance change is exact; otherwise that amount is the most an
  // inexact figure can be off by.
  const closedRent = p.keys.reduce((s, _, i) => (p.pre[i]! > 0n && p.post[i]! === 0n ? s + p.pre[i]! : s), 0n);
  const openedRent = p.keys.reduce((s, _, i) => (p.pre[i]! === 0n && p.post[i]! > 0n ? s + p.post[i]! : s), 0n);
  const rentTo = def.rentTo === undefined ? null : present(vn.accounts[def.rentTo]);
  const buyerOut = (cur: string): bigint => {
    const d = changes.get(cur)?.get(buyer) ?? 0n;
    return d < 0n ? -d : 0n;
  };

  const legCurrencies = [...net.entries()].filter(([, m]) => [...sellerSide].some((s) => (m.get(s) ?? 0n) > 0n)).map(([c]) => c);
  let result: Partial<ChainSale> & { currencyKey?: string } = {};
  if (legCurrencies.length > 1) {
    return { ...sale, status: "cannot-tell", notes, reason: `The seller was paid in ${legCurrencies.length} currencies in this fill, so its price cannot be stated in one.` };
  }
  if (legCurrencies.length === 1) {
    const cur = legCurrencies[0]!;
    const m = net.get(cur)!;
    const dec = legs.find((l) => l.currency === cur)!.decimals;
    let sellerRaw = 0n;
    for (const s of sellerSide) sellerRaw += (m.get(s) ?? 0n) > 0n ? m.get(s)! : 0n;
    const others = [...m.entries()].filter(([who, val]) => val > 0n && !sellerSide.has(who) && !notPaidTo.has(who));
    const top = others.reduce((a, [, val]) => (val > a ? val : a), 0n);
    if (top > sellerRaw) {
      return { ...sale, status: "cannot-tell", notes, reason: `The account the ${venueInfo.venue.name} layout names as seller (${seller}) received less than another account paid in this fill, so the layout and the payment disagree about who sold.` };
    }
    const grossRaw = sellerRaw + others.reduce((a, [, val]) => a + val, 0n);
    result = {
      currencyKey: cur,
      currency: currencyOf(p, cur, wrappedSeen),
      sellerReceived: units(sellerRaw, dec),
      otherRecipients: others.slice(0, 12).map(([address, val]) => ({ address, amount: units(val, dec) })),
      price: units(grossRaw, dec),
      priceRaw: grossRaw.toString(),
      priceBasis: "venue-transfers",
      priceExact: true,
    };
  } else {
    // No transfer instruction reached the seller: the venue moved lamports
    // directly (Tensor's take_bid does). The seller's balance change is the
    // evidence, and it can include rent returned in the same transaction.
    const sellerCurrencies = [...changes.entries()].filter(([, m]) => [...sellerSide].some((s) => (m.get(s) ?? 0n) > 0n)).map(([c]) => c);
    if (sellerCurrencies.length === 1) {
      const cur = sellerCurrencies[0]!;
      const m = changes.get(cur)!;
      const dec = decimalsOf(p, cur);
      let sellerRaw = 0n;
      for (const s of sellerSide) sellerRaw += (m.get(s) ?? 0n) > 0n ? m.get(s)! : 0n;
      const created = new Set(p.keys.filter((_, i) => p.pre[i] === 0n));
      const others = [...m.entries()].filter(([who, val]) => val > 0n && !sellerSide.has(who) && !notPaidTo.has(who) && who !== rentTo && !(cur === "SOL" && created.has(who)));
      const rentKnownElsewhere = rentTo !== null && !sellerSide.has(rentTo);
      const slack = cur === "SOL" && !rentKnownElsewhere ? closedRent : 0n;
      result = {
        currencyKey: cur,
        currency: currencyOf(p, cur, false),
        sellerReceived: units(sellerRaw, dec),
        priceBasis: "balance-changes",
        priceExact: slack === 0n,
        ...(slack > 0n ? { priceSlack: units(slack, dec) } : {}),
      };
      if (single) {
        const grossRaw = sellerRaw + others.reduce((a, [, val]) => a + val, 0n);
        result.price = units(grossRaw, dec);
        result.priceRaw = grossRaw.toString();
        result.otherRecipients = others.slice(0, 12).map(([address, val]) => ({ address, amount: units(val, dec) }));
      }
      notes.push(
        "No transfer instruction carried the payment (the venue moved the money directly), so the figures come from balance changes" +
          (slack > 0n
            ? `; up to ${units(slack, dec)} ${cur === "SOL" ? "SOL" : "units"} that accounts closed in this transaction returned may be counted in them.`
            : rentKnownElsewhere
              ? `; the rent this transaction returned went to ${rentTo}, which the layout names for it, so it is not in the seller's figure.`
              : "."),
      );
    } else if (sellerCurrencies.length > 1) {
      return { ...sale, status: "cannot-tell", notes, reason: "The seller's balance rose in more than one currency, so the price cannot be stated in one." };
    } else if (single) {
      const outs = [...changes.keys()].filter((c) => buyerOut(c) > 0n);
      if (outs.length === 1) {
        const cur = outs[0]!;
        const dec = decimalsOf(p, cur);
        result = {
          currencyKey: cur,
          currency: currencyOf(p, cur, false),
          sellerReceived: null,
          price: units(buyerOut(cur), dec),
          priceRaw: buyerOut(cur).toString(),
          priceBasis: "buyer-balance",
          priceExact: false,
          ...(cur === "SOL" && openedRent > 0n ? { priceSlack: units(openedRent, dec) } : {}),
        };
        notes.push("The seller's proceeds are not visible in this transaction, so the price is the buyer's outgoing amount, which can include rent for accounts the buyer opened.");
      }
    }
  }
  if (!result.currency) {
    return { ...sale, status: "cannot-tell", notes, reason: "No payment to the seller, and no single payment from the buyer, could be found in this transaction, so the amount cannot be told." };
  }
  // One wallet on both sides. By the marketplace rows' rule its amount is
  // nobody's payment, and here it is not even readable: what the wallet pays
  // itself cancels out of the transfers, so the figures above can be a sliver
  // of the order (a real 0.3 SOL OpenSea sale, rewritten so its buyer is its
  // seller, leaves 0.0307 SOL in the legs). No price is given at all.
  if (self) {
    const noPrice = "The buyer and the seller are the same wallet, so no money changed hands between two parties and no price can be stated: what the wallet paid itself cancels out of this transaction's transfers.";
    return { ...sale, currency: result.currency, price: null, priceRaw: null, sellerReceived: null, noPriceReason: noPrice, status: "sale", notes, reason: `${/^[AEIOU]/.test(venueInfo.venue.name) ? "An" : "A"} ${venueInfo.venue.name} fill of this item (${def.name}) with one wallet as buyer and seller. ${noPrice}` };
  }
  const cur = result.currencyKey!;
  delete result.currencyKey;
  if (single && cur && buyerOut(cur) > 0n) result.buyerPaid = units(buyerOut(cur), decimalsOf(p, cur));
  else if (single) notes.push("The buyer's own balance did not pay for this item in this transaction: an escrow, a bid account or a pool paid on the buyer's behalf.");
  if (!single) {
    const noPrice = `This transaction moved ${itemsMoved} items, so no per-item price can be proven from it.`;
    return { ...sale, currency: result.currency, price: null, priceRaw: null, sellerReceived: null, noPriceReason: noPrice, status: "sale", notes, reason: `${/^[AEIOU]/.test(venueInfo.venue.name) ? "An" : "A"} ${venueInfo.venue.name} sale of this item (${def.name}). ${noPrice}` };
  }
  if (result.currency.paidInOtherToken) notes.push("Paid in another token: this amount is in that token's own units and is never a SOL figure.");
  const priceText = result.price !== undefined && result.price !== null ? `${result.price} ${result.currency.code ?? "units of another token"}` : "an amount that could not be stated";
  return {
    ...sale,
    ...result,
    status: "sale",
    notes,
    reason: `${/^[AEIOU]/.test(venueInfo.venue.name) ? "An" : "A"} ${venueInfo.venue.name} sale of this item (${def.name}) for ${priceText}${result.sellerReceived !== null && result.sellerReceived !== undefined ? `, of which the seller received ${result.sellerReceived}` : ""}.`,
  };
}

/** Every Core item of `collection` this transaction moved, for a scan that does not know the item in advance. */
export function itemsOfCollection(raw: unknown, collection: string): string[] {
  const p = parse(raw);
  if (typeof p === "string") return [];
  return [...new Set(p.nodes.filter((n) => isTransfer(n) && n.accounts[1] === collection).map((n) => n.accounts[0]!).filter((a) => sol.isBase58Address(a)))];
}

// ------------------------------------------------------------- reads

/**
 * Confirmed transactions never change, so a read is kept for an hour. A miss
 * (null) is never kept: a transaction that is not final yet will be soon.
 */
const txCache = new BoundedMap<unknown>(100, 60 * 60_000);

/**
 * The one place this module asks for a transaction, through the server's
 * shared helper (sol.getParsedTransaction), so the format version is decided
 * where every other transaction read decides it: version 1 and up, asked
 * again once when a node names a newer one, and a format this server cannot
 * read is a typed failure, which the callers below report as unread.
 */
export async function readTransaction(signature: string, opts: { signal?: AbortSignal; trace?: sol.RpcTrace } = {}): Promise<unknown> {
  const hit = txCache.get(signature);
  if (hit !== undefined) return hit;
  const tx = await sol.getParsedTransaction<unknown>(signature, { trace: opts.trace, signal: opts.signal });
  if (tx !== null && tx !== undefined) txCache.set(signature, tx);
  return tx;
}

/** Read one transaction and decode it for one item. A failed read is a reason, never an answer. */
export async function readSale(signature: string, item: string, opts: { signal?: AbortSignal } = {}): Promise<ChainSale & { readAt: string; endpoint: string | null }> {
  const trace: sol.RpcTrace = {};
  const tx = await readTransaction(signature, { ...opts, trace });
  return { ...decodeSale(tx, item, signature), readAt: new Date().toISOString(), endpoint: trace.endpoint ?? (trace.endpoints?.[0] ?? null) };
}

// ------------------------------------------------------------- the scan

/**
 * A bounded walk over one collection's own signature list. Every sale of a
 * Core item touches its collection account, so the list holds every sale; the
 * cap and the clock decide how much of it is read.
 *
 * Measured on the public endpoint on 2026-11-14: one signature list of 50 to
 * 100 took 1.6 to 7 s, and one transaction 0.6 s at best, 1.6 to 2.5 s at
 * 22:37 UTC and 5 s typically at 21:50 UTC (median of 40 reads 5.0 s, slowest
 * 7.4 s). A whole get_recent_sales call with an 18 s scan took 19.9 and
 * 21.4 s and read 9 transactions each time. So the clock is the real bound,
 * set at 15 s so the call stays near 20 s, the cap of 10 reads applies only
 * on a fast minute, and the answer says where the scan stopped.
 */
export const SCAN_SIGNATURES = 50;
export const SCAN_MAX_READS = 10;
export const SCAN_DEADLINE_MS = 15_000;

export interface ChainScan {
  collection: string;
  readFrom: "the Solana chain";
  sales: ChainSale[];
  coverage: {
    signaturesListed: number;
    newestListed: string | null;
    oldestListed: string | null;
    transactionsRead: number;
    /** The block time of the oldest transaction read: the scan saw everything newer than this, within what it read. */
    readBackTo: string | null;
    alreadyInFeeds: number;
    failedOnChain: number;
    notRead: number;
    unreadable: number;
    notSales: number;
    cannotTell: { signature: string; reason: string }[];
    stoppedBecause: "end-of-list" | "read-cap" | "deadline" | "cancelled";
    cap: { signatures: number; reads: number; deadlineMs: number };
    endpoint: string | null;
  };
  note: string;
}

export async function scanCollectionSales(
  collection: string,
  opts: { known?: Set<string>; signal?: AbortSignal; maxReads?: number; deadlineMs?: number; signatures?: number } = {},
): Promise<ChainScan> {
  const started = Date.now();
  const maxReads = opts.maxReads ?? SCAN_MAX_READS;
  const deadlineMs = opts.deadlineMs ?? SCAN_DEADLINE_MS;
  const limit = opts.signatures ?? SCAN_SIGNATURES;
  const trace: sol.RpcTrace = {};
  const list = await sol.newestSignatures(collection, limit, { signal: opts.signal, trace });
  if (!Array.isArray(list)) throw new Error("the Solana endpoint answered the signature list with something that is not a list");
  const sigs = list
    .map((s) => rec(s))
    .filter((s): s is Record<string, unknown> => s !== null && isSignature(s.signature))
    .map((s) => ({ signature: s.signature as string, blockTime: usableBlockTime(s.blockTime), failed: s.err !== null && s.err !== undefined }));
  const sales: ChainSale[] = [];
  const cannotTell: { signature: string; reason: string }[] = [];
  let read = 0;
  let already = 0;
  let failed = 0;
  let unreadable = 0;
  let notSales = 0;
  let readBackTo: number | null = null;
  let stopped: ChainScan["coverage"]["stoppedBecause"] = "end-of-list";
  let notRead = 0;
  for (let k = 0; k < sigs.length; k++) {
    const s = sigs[k]!;
    if (s.failed) {
      failed++;
      continue;
    }
    if (opts.known?.has(s.signature)) {
      already++;
      continue;
    }
    if (opts.signal?.aborted) stopped = "cancelled";
    else if (read >= maxReads) stopped = "read-cap";
    else if (Date.now() - started > deadlineMs) stopped = "deadline";
    if (stopped !== "end-of-list") {
      notRead = sigs.slice(k).filter((x) => !x.failed && !opts.known?.has(x.signature)).length;
      break;
    }
    read++;
    let tx: unknown;
    try {
      tx = await readTransaction(s.signature, { signal: opts.signal, trace });
    } catch (e) {
      unreadable++;
      cannotTell.push({ signature: s.signature, reason: `could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` });
      continue;
    }
    if (s.blockTime !== null) readBackTo = readBackTo === null ? s.blockTime : Math.min(readBackTo, s.blockTime);
    if (tx === null || tx === undefined) {
      unreadable++;
      cannotTell.push({ signature: s.signature, reason: "the endpoint returned no transaction for it" });
      continue;
    }
    const items = itemsOfCollection(tx, collection);
    if (items.length === 0) {
      notSales++;
      continue;
    }
    let any = false;
    for (const item of items.slice(0, 20)) {
      const d = decodeSale(tx, item, s.signature);
      if (d.status === "sale") {
        sales.push(d);
        any = true;
      } else if (d.status === "cannot-tell") {
        cannotTell.push({ signature: s.signature, reason: `${item}: ${d.reason}` });
        any = true;
      }
    }
    if (!any) notSales++;
  }
  const iso = (t: number | null) => (t === null ? null : isoFromBlockTime(t));
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => t !== null);
  return {
    collection,
    readFrom: "the Solana chain",
    sales,
    coverage: {
      signaturesListed: sigs.length,
      newestListed: iso(times.length ? Math.max(...times) : null),
      oldestListed: iso(times.length ? Math.min(...times) : null),
      transactionsRead: read,
      readBackTo: iso(readBackTo),
      alreadyInFeeds: already,
      failedOnChain: failed,
      notRead,
      unreadable,
      notSales,
      cannotTell: cannotTell.slice(0, 10),
      stoppedBecause: stopped,
      cap: { signatures: limit, reads: maxReads, deadlineMs },
      endpoint: trace.endpoint ?? null,
    },
    note:
      `The newest ${sigs.length} transaction(s) touching the collection account were listed; ${read} were read and decoded here` +
      (already ? `, ${already} were skipped because a marketplace feed above already carries their signature` : "") +
      (notRead ? `, and ${notRead} were not read (${stopped === "deadline" ? `the ${Math.round(deadlineMs / 1000)} s budget ran out` : stopped === "read-cap" ? `the cap is ${maxReads} reads per call` : "the call was cancelled"})` : "") +
      (cannotTell.length ? `; ${cannotTell.length} read transaction(s) or item(s) could not be read or decided (coverage.cannotTell)` : "") +
      `. A sale among the unread or undecided ones is missing from this list, not absent from the chain.`,
  };
}

/**
 * The signatures a get_recent_sales answer already carries as marketplace
 * rows: Magic Eden's `signature` and OpenSea's `transaction`, the same two
 * fields the two feeds' own fills are matched on. The scan never reads one of
 * these, so a fill the feeds list cannot also appear as a chain row. That is
 * coarser than matching the feeds' fills to each other (signature, item,
 * buyer and seller): a transaction that sold two of the collection's items
 * and is listed for one of them is not read for the other, which leaves that
 * sale out rather than risk counting one twice.
 */
export function feedSignatures(answer: Record<string, unknown>): Set<string> {
  const known = new Set<string>();
  const take = (rows: unknown, field: string) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const v = rec(row)?.[field];
      if (typeof v === "string") known.add(v);
    }
  };
  take(answer.sales, "signature");
  take(rec(answer.opensea)?.sales, "transaction");
  return known;
}

/**
 * One chain sale as a row beside the marketplace rows, under their rules and
 * field names: the currency from the payment token's address (`currency`,
 * `paymentToken`, `paidInOtherToken`, `currencyNote`), `selfFill` when one
 * wallet is on both sides, and `sharedTransaction` when the transaction moved
 * several items, in which case the chain gives no per-item price at all.
 */
export function chainSaleRow(s: ChainSale): Record<string, unknown> {
  const cur = s.currency;
  const items = s.itemsMoved ?? 1;
  return {
    venue: s.venue,
    signature: s.signature,
    time: s.time,
    item: s.item,
    seller: s.seller,
    buyer: s.buyer,
    price: s.price ?? null,
    currency: cur?.code ?? null,
    paymentToken: cur ? (cur.mint ?? NATIVE_SOL) : null,
    ...(cur?.paidInOtherToken ? { paidInOtherToken: true as const } : {}),
    ...(cur?.note ? { currencyNote: cur.note } : {}),
    sellerReceived: s.sellerReceived ?? null,
    ...(s.buyerPaid !== undefined ? { buyerPaid: s.buyerPaid } : {}),
    priceBasis: s.priceBasis ?? null,
    ...(s.noPriceReason ? { noPriceReason: s.noPriceReason } : {}),
    ...(s.selfFill ? { selfFill: true as const } : {}),
    ...(items > 1
      ? {
          sharedTransaction: {
            items,
            note: `This transaction moved ${items} items. The chain gives no per-item price for it, so price is null: a buyer's total for the transaction cannot prove how it splits between the items.`,
          },
        }
      : {}),
  };
}
