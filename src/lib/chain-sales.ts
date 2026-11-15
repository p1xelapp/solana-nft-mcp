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
 *    real one has been seen. BuyCoreSpl is a payment in an SPL token: a real
 *    sale on 2026-11-12 paid 3,115.14 of a memecoin, not SOL.
 *  - Tensor's AMM pools (TAMM6u...). Read on chain on 2026-11-14: a pool fill
 *    of a Token Metadata item runs sell_nft_trade_pool there and the pool
 *    pays from its own account, with no transfer instruction. The Core
 *    instructions and their slots come from the program's published IDL
 *    1.0.0 (taker 1, pool owner 0, pool 4); no real Core fill through it has
 *    been read, so no verdict rests on that layout yet.
 *
 * The price is taken from the money that reached the seller first: the
 * transfers inside the venue's own instruction, which name each recipient and
 * amount exactly. A seller's balance change is the second choice, because it
 * also counts rent the venue returns when it closes the listing (0.0039 SOL
 * received showed as 0.0071). The buyer's outgoing amount is used last, and
 * only when one item moved. A transaction that moves several items gives no
 * per-item price at all.
 *
 * Only money the marketplace moved is the sale. A transfer in another
 * instruction of the same transaction is somebody's side payment: one of
 * 40 SOL from the buyer to a friend made a 0.3 SOL sale read as "the buyer
 * paid 0.8", and 40 SOL sent to a Tensor seller by a stranger made a 0.0294
 * SOL take_bid read as 40.03. So the buyer's own figure counts only its
 * transfers inside the marketplace's instructions, a balance change counts
 * only accounts those instructions name, and value that reached the seller or
 * a payee from outside them makes the amount impossible to tell.
 */

import { createHash } from "node:crypto";
import * as sol from "../sources/solana.js";
import { isoFromBlockTime, usableBlockTime } from "./time.js";
import { AbortedError, cached, plainReason } from "./http.js";
import { NATIVE_SOL, WRAPPED_SOL, classifyPaymentToken, currencyByMint, type KnownCurrency } from "./reconcile.js";
import { farAboveRange, isSelfFill } from "../market.js";

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
  /** Byte offset of the order price (u64, in the payment currency's smallest unit) in the instruction data, where real transactions show one. */
  priceAt?: number;
  /** Where the slots come from: the venue's published code, real transactions, or neither yet. */
  layout?: SaleLayout;
}
/**
 * `published-unchecked` is a layout from the venue's published code that no
 * real transaction of its kind has been checked against. Like `inferred`, it
 * names a sale and its money, and no verdict rests on it.
 */
export type SaleLayout = "published" | "observed" | "inferred" | "published-unchecked";
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
// core_execute_sale_v2 carries the order price as a u64 right after its
// discriminator, in the payment currency's smallest unit: 2 SOL on a 2 SOL
// listing, 0.0039 on two 0.0039 fills, 800 USDC on an 800 USDC listing, and on
// accepted offers 1, 0.001 and 0.0021 SOL where the seller kept 0.98, 0.00098
// and 0.002058 after the fee it paid (seven real transactions, 2026-11-14).
venue("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", {
  name: "Magic Eden",
  ix: {
    core_execute_sale_v2: { kind: "sale", buyer: 1, seller: 2, priceAt: 8, layout: "observed" },
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
// Tensor's AMM. A trade pool selling one of its items is buy_nft_core (the
// taker buys; the pool keeps the proceeds); a pool buying is a sell
// instruction (the taker sells; a trade pool keeps the item, a token pool
// hands it to its owner). The pool pays from its own account, so the amount
// is what the pool paid, read from balance changes.
venue(sol.TENSOR_AMM_PROGRAM, {
  name: "Tensor pools",
  ix: {
    buy_nft_core: { kind: "sale", seller: 0, buyer: 1, sellerAlso: [4], layout: "published-unchecked" },
    sell_nft_trade_pool_core: { kind: "sale", seller: 1, buyer: 0, itemToAlso: [4], layout: "published-unchecked" },
    sell_nft_token_pool_core: { kind: "sale", seller: 1, buyer: 0, itemToAlso: [4], layout: "published-unchecked" },
    deposit_nft_core: { kind: "escrow-move" },
    withdraw_nft_core: { kind: "escrow-move" },
    create_pool: { kind: "pool-admin" },
    edit_pool: { kind: "pool-admin" },
    close_pool: { kind: "pool-admin" },
    deposit_sol: { kind: "bid" },
    withdraw_sol: { kind: "bid" },
    tamm_noop: { kind: "log" },
  },
});
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
  layout?: SaleLayout;
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
  /** What the seller kept after the network fee, when the seller signed and paid it (in SOL only). */
  sellerAfterFee?: number;
  /** The price on the order itself, read from the marketplace instruction's data where real transactions show where it sits. */
  orderPrice?: number;
  /** The buyer's own outgoing transfers inside the marketplace's instructions, when one item moved and the buyer paid it. */
  buyerPaid?: number | null;
  /** Royalty, fee and broker legs: everyone except the seller who was paid for this item. */
  otherRecipients?: { address: string; amount: number }[];
  /** Why there is no price, when there is none. */
  noPriceReason?: string;
  /** One wallet as buyer and seller, by the marketplace rows' rule (isSelfFill): a sale, but its amount is nobody's payment. */
  selfFill?: true;
  /**
   * Set on a non-sale that rests on the item being a Metaplex Core asset: it
   * does not appear in the transaction, or appears without moving. A Core
   * item always moves in its own sale; a compressed item's id is never an
   * account at all, so the verdict needs the item's account read (readSale).
   */
  onlyIfCore?: true;
  /** On those non-sales: the Core items this transaction did move. */
  movedItems?: string[];
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

const KNOWN_VERSIONS = new Set<string | number>(["legacy", 0, 1]);

/** The transaction's shape, checked field by field. A string is a reason it could not be read. */
function parse(raw: unknown): Parsed | string {
  const tx = rec(raw);
  if (!tx) return "the endpoint returned no transaction for this signature (it may not exist, may not be final yet, or the endpoint keeps no history for it)";
  const meta = rec(tx.meta);
  const message = rec(rec(tx.transaction)?.message);
  if (!meta || !message) return "the transaction came back without its status or its message";
  // The formats whose instruction lists were read and understood: legacy,
  // version 0 and version 1 (2026-11-14). Anything else may lay out accounts
  // or payments differently, and decoding it as one of those is a guess.
  if (!KNOWN_VERSIONS.has(tx.version as string | number)) {
    return tx.version === undefined
      ? "the transaction came back without its format version"
      : `the transaction is in format version ${typeof tx.version === "number" && Number.isSafeInteger(tx.version) ? tx.version : "(unreadable)"}, which this decoder does not read (it reads legacy, 0 and 1)`;
  }
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

interface Leg {
  currency: string;
  /** The decimal places a transferChecked states for this token; null when the instruction states none. */
  decimals: number | null;
  from: string;
  to: string;
  raw: bigint;
  wrapped?: true;
  /** Set when the reply disagrees with itself about which token this is. */
  mintProblem?: string;
}

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
      const srcInfo = p.tokenAccounts.get(src);
      const dstInfo = p.tokenAccounts.get(dst);
      const mint = addr(n.info?.mint) ?? (dstInfo ?? srcInfo)?.mint ?? null;
      if (!mint) continue;
      const wrapped = mint === WRAPPED_SOL;
      const stated = rec(n.info?.tokenAmount)?.decimals;
      // A transfer naming one mint between token accounts the same reply says
      // hold another is a reply that disagrees with itself; neither is trusted.
      const otherMint = [srcInfo, dstInfo].find((t) => t && t.mint !== mint)?.mint;
      out.push({
        currency: wrapped ? "SOL" : mint,
        decimals: typeof stated === "number" && Number.isInteger(stated) ? stated : null,
        from: srcInfo?.owner ?? addr(n.info?.authority) ?? src,
        to: dstInfo?.owner ?? dst,
        raw,
        ...(wrapped ? { wrapped: true as const } : {}),
        ...(otherMint ? { mintProblem: `a token transfer in this transaction names the mint ${mint} while its token account holds ${otherMint}, so which token was paid cannot be told` } : {}),
      });
    }
  }
  return out;
}

/** The decimal places each known currency's mint has on chain. */
const KNOWN_DECIMALS: Record<string, number> = { SOL: 9, USDC: 6, USDT: 6, PYUSD: 6 };

/**
 * The decimal places one payment currency is read with, or why it cannot be.
 *
 * A token's decimals are fixed by its mint, so for SOL (wrapped too) and the
 * stablecoins they are known in advance, and a reply stating anything else
 * is a reply that cannot be read: wrapped SOL given 0 decimals read 1.07 SOL
 * as 1,070,000,000, and USDC given 0 read 800 USDC as 800,000,000. For any
 * other token the reply's own figure is used only when it states one, once.
 */
function decimalsFor(p: Parsed, cur: string, legs: Leg[]): { dec: number } | { problem: string } {
  const mine = legs.filter((l) => l.currency === cur);
  const bad = mine.find((l) => l.mintProblem);
  if (bad) return { problem: bad.mintProblem! };
  const tokenMint = cur === "SOL" ? (mine.some((l) => l.wrapped) || [...p.tokenAccounts.values()].some((t) => t.mint === WRAPPED_SOL) ? WRAPPED_SOL : null) : cur;
  if (tokenMint === null) return { dec: 9 };
  const code = tokenMint === WRAPPED_SOL ? "SOL" : currencyByMint(tokenMint);
  const expected = code ? KNOWN_DECIMALS[code] : undefined;
  const seen = new Set<number>();
  for (const t of p.tokenAccounts.values()) if (t.mint === tokenMint) seen.add(t.decimals);
  for (const l of mine) if (l.decimals !== null && (l.wrapped || cur !== "SOL")) seen.add(l.decimals);
  if (expected !== undefined) {
    const wrong = [...seen].find((d) => d !== expected);
    return wrong === undefined
      ? { dec: expected }
      : { problem: `the transaction gives ${code === "SOL" ? "wrapped SOL" : code} ${wrong} decimal places where its mint has ${expected}` };
  }
  if (seen.size === 1) return { dec: [...seen][0]! };
  return { problem: seen.size === 0 ? `the transaction states no decimal places for the token ${tokenMint}` : `the transaction states different decimal places for the token ${tokenMint} in different places` };
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

const currencyOf = (currency: string, wrappedSeen: boolean, decimals: number): SaleCurrency =>
  currency === "SOL" ? currencyOfMint(wrappedSeen ? WRAPPED_SOL : null, 9) : currencyOfMint(currency, decimals);

/** The node indices whose call chain runs through an instruction of `program`, the program's own included. */
function runBy(nodes: Node[], program: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let q: number | null = i; q !== null; q = nodes[q]!.parent) {
      if (nodes[q]!.programId === program) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** A u64, little-endian, at `offset` of base58 instruction data, or null. */
function u64At(data: string | null, offset: number): bigint | null {
  const b = data === null ? null : base58Bytes(data);
  if (!b || b.length < offset + 8) return null;
  return Buffer.from(b.subarray(offset, offset + 8)).readBigUInt64LE(0);
}

// ------------------------------------------------------------- the decoder

/**
 * A reply that does not carry the signature asked for is not that
 * transaction. One with no signatures field at all was decoded as the sale
 * asked about, confirmed, and kept for an hour.
 */
function signatureProblem(p: Parsed, expectSignature: string | undefined): string | null {
  if (!expectSignature || p.signature === expectSignature) return null;
  return p.signature === null
    ? "The endpoint's answer carries no signature, so it cannot be tied to the transaction asked for, and nothing in it is evidence about this signature."
    : "The endpoint answered with a different transaction from the one asked for, so nothing in it is evidence about this signature.";
}

/** Why a reply cannot stand as the transaction `signature`, or null when it can be decoded as that transaction. */
export function replyProblem(raw: unknown, signature: string): string | null {
  const p = parse(raw);
  return typeof p === "string" ? `could not be read: ${p}` : signatureProblem(p, signature);
}

/**
 * Whether one parsed transaction (getTransaction, encoding jsonParsed) is a
 * sale of `item`. Pure and total: every input, however malformed, gets an
 * answer, and every answer that is not a sale says why.
 */
export function decodeSale(raw: unknown, item: string, expectSignature?: string): ChainSale {
  const p = parse(raw);
  const base = { item, signature: expectSignature ?? null, time: null as string | null, slot: null as number | null, notes: [] as string[] };
  if (typeof p === "string") return { ...base, status: "cannot-tell", reason: `This transaction could not be read: ${p}.` };
  const mismatch = signatureProblem(p, expectSignature);
  if (mismatch) return { ...base, status: "cannot-tell", reason: mismatch };
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
    // Both answers below rest on the item being a Core asset, which always
    // moves in its own sale. A compressed item's id is never an account, so
    // its sale never names it; readSale settles which one this is.
    const movedItems = [...new Set(transfers.map(({ n }) => n.accounts[0]!).filter((a) => sol.isBase58Address(a)))].slice(0, 20);
    const ifCore = { onlyIfCore: true as const, movedItems };
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
        ...ifCore,
        ...(other?.d ? { venue: VENUES[other.n.programId]!.venue.name, program: other.n.programId, instruction: other.d.name } : {}),
        reason: `The item does not appear in this transaction at all${other?.d ? ` (it is ${VENUES[other.n.programId]!.venue.name} ${other.d.name}, a ${other.d.kind === "sale" ? "fill of another item" : other.d.kind.replace("-", " ")})` : ""}. A Metaplex Core item always appears in its own sale.`,
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
      ...ifCore,
      ...(named ? { venue: VENUES[named.programId]!.venue.name, program: named.programId, ...(def ? { instruction: def.name } : {}) } : {}),
      reason: `The item is named in this transaction but did not change owner in it${named ? ` (${VENUES[named.programId]!.venue.name}${def ? ` ${def.name}` : ""})` : ""}. Every sale of a Core item moves it.`,
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
  if (def.layout === "published-unchecked") notes.push(`The buyer and seller slots for ${venueInfo.venue.name} ${def.name} come from the venue's published code, and no real transaction of this kind has been checked against them; the payment must agree with them or the sale is not called.`);
  const self = isSelfFill(buyer, seller);
  if (self) notes.push("The buyer and the seller are the same wallet: a self-fill, which moves no ownership and proves no market price.");
  const sale = { ...named, seller, buyer, layout: def.layout, ...(self ? { selfFill: true as const } : {}) };

  // ------------------------------------------------------------ the money
  const sellerSide = new Set([seller, ...(def.sellerAlso ?? []).map((s) => present(vn.accounts[s])).filter((a): a is string => a !== null)]);
  const notPaidTo = new Set([buyer, newOwner]);
  const subtree = nodes.map((_, i) => i).filter((i) => within(nodes, i, v));
  // The marketplace's own instructions: every one its program ran in this
  // transaction, with everything each called. Magic Eden's buyer funds the
  // escrow in a deposit beside the fill, so the buyer's own payment is read
  // across all of them. Every other instruction is outside the sale.
  const byVenue = runBy(nodes, vn.programId);
  const inVenue = new Set(byVenue);
  const namedByVenue = new Set(byVenue.flatMap((i) => nodes[i]!.accounts));
  const legs = legsOf(p, subtree);
  const venueLegs = legsOf(p, byVenue);
  const outside = legsOf(p, nodes.map((_, i) => i).filter((i) => !inVenue.has(i)));
  const legText = (l: Leg) => (l.currency === "SOL" ? `${units(l.raw, 9)} SOL` : `${l.raw} of the token ${l.currency}, in its smallest unit,`) + ` from ${l.from}`;
  const fromOutside = (who: Set<string>): Leg | undefined => outside.find((l) => who.has(l.to) && l.from !== l.to);
  const toSeller = fromOutside(sellerSide);
  if (toSeller) {
    return { ...sale, status: "cannot-tell", notes, reason: `${legText(toSeller)} reached the seller ${toSeller.to} in an instruction outside ${venueInfo.venue.name}'s own, so how much of what the seller got was paid for the item cannot be told.` };
  }
  const wrappedSeen = legs.some((l) => l.wrapped && sellerSide.has(l.to));
  const net = new Map<string, Map<string, bigint>>();
  for (const l of legs) {
    const m = net.get(l.currency) ?? new Map<string, bigint>();
    m.set(l.from, (m.get(l.from) ?? 0n) - l.raw);
    m.set(l.to, (m.get(l.to) ?? 0n) + l.raw);
    net.set(l.currency, m);
  }
  const single = itemsMoved === 1;
  // Balance changes as the marketplace's instructions left them: every
  // transfer outside them is taken back out, so a side payment or a tip
  // neither adds to nor hides anyone's figure.
  const changes = balanceChanges(p);
  for (const l of outside) {
    const m = changes.get(l.currency) ?? new Map<string, bigint>();
    m.set(l.to, (m.get(l.to) ?? 0n) - l.raw);
    m.set(l.from, (m.get(l.from) ?? 0n) + l.raw);
    changes.set(l.currency, m);
  }
  // Lamports left in accounts this transaction closed went to someone. When
  // the layout names who (the rent slot) and it is not the seller, the
  // seller's balance change is exact; otherwise that amount is the most an
  // inexact figure can be off by.
  const closedRent = p.keys.reduce((s, _, i) => (p.pre[i]! > 0n && p.post[i]! === 0n ? s + p.pre[i]! : s), 0n);
  const openedRent = p.keys.reduce((s, _, i) => (p.pre[i]! === 0n && p.post[i]! > 0n ? s + p.post[i]! : s), 0n);
  const rentTo = def.rentTo === undefined ? null : present(vn.accounts[def.rentTo]);
  /** What the buyer sent out, less what came back, in the marketplace's own transfers. */
  const buyerOut = (cur: string): bigint => {
    let d = 0n;
    for (const l of venueLegs) if (l.currency === cur) d += (l.from === buyer ? l.raw : 0n) - (l.to === buyer ? l.raw : 0n);
    return d > 0n ? d : 0n;
  };

  interface Money { cur: string; wrapped: boolean; sellerRaw: bigint | null; grossRaw: bigint | null; others: [string, bigint][]; basis: NonNullable<ChainSale["priceBasis"]>; slack: bigint }
  let money: Money | null = null;
  const legCurrencies = [...net.entries()].filter(([, m]) => [...sellerSide].some((s) => (m.get(s) ?? 0n) > 0n)).map(([c]) => c);
  if (legCurrencies.length > 1) {
    return { ...sale, status: "cannot-tell", notes, reason: `The seller was paid in ${legCurrencies.length} currencies in this fill, so its price cannot be stated in one.` };
  }
  if (legCurrencies.length === 1) {
    const cur = legCurrencies[0]!;
    const m = net.get(cur)!;
    let sellerRaw = 0n;
    for (const s of sellerSide) sellerRaw += (m.get(s) ?? 0n) > 0n ? m.get(s)! : 0n;
    const others = [...m.entries()].filter(([who, val]) => val > 0n && !sellerSide.has(who) && !notPaidTo.has(who));
    const top = others.reduce((a, [, val]) => (val > a ? val : a), 0n);
    if (top > sellerRaw) {
      return { ...sale, status: "cannot-tell", notes, reason: `The account the ${venueInfo.venue.name} layout names as seller (${seller}) received less than another account paid in this fill, so the layout and the payment disagree about who sold.` };
    }
    money = { cur, wrapped: wrappedSeen, sellerRaw, grossRaw: sellerRaw + others.reduce((a, [, val]) => a + val, 0n), others, basis: "venue-transfers", slack: 0n };
  } else {
    // No transfer instruction reached the seller: the venue moved lamports
    // directly (Tensor's take_bid does). The seller's balance change is the
    // evidence, and it can include rent returned in the same transaction.
    // Only accounts the marketplace's instructions name can have been paid by
    // them: a stranger's 3 SOL to an unrelated wallet once read as part of a
    // 1 SOL sale.
    const sellerCurrencies = [...changes.entries()].filter(([, m]) => [...sellerSide].some((s) => (m.get(s) ?? 0n) > 0n)).map(([c]) => c);
    if (sellerCurrencies.length === 1) {
      const cur = sellerCurrencies[0]!;
      const m = changes.get(cur)!;
      let sellerRaw = 0n;
      for (const s of sellerSide) sellerRaw += (m.get(s) ?? 0n) > 0n ? m.get(s)! : 0n;
      const created = new Set(p.keys.filter((_, i) => p.pre[i] === 0n));
      const others = [...m.entries()].filter(([who, val]) => val > 0n && namedByVenue.has(who) && !sellerSide.has(who) && !notPaidTo.has(who) && who !== rentTo && !(cur === "SOL" && created.has(who)));
      const rentKnownElsewhere = rentTo !== null && !sellerSide.has(rentTo);
      const slack = cur === "SOL" && !rentKnownElsewhere ? closedRent : 0n;
      money = { cur, wrapped: false, sellerRaw, grossRaw: single ? sellerRaw + others.reduce((a, [, val]) => a + val, 0n) : null, others, basis: "balance-changes", slack };
      notes.push(
        "No transfer instruction carried the payment (the venue moved the money directly), so the figures come from balance changes" +
          (slack > 0n
            ? `; up to ${units(slack, 9)} SOL that accounts closed in this transaction returned may be counted in them.`
            : rentKnownElsewhere
              ? `; the rent this transaction returned went to ${rentTo}, which the layout names for it, so it is not in the seller's figure.`
              : "."),
      );
    } else if (sellerCurrencies.length > 1) {
      return { ...sale, status: "cannot-tell", notes, reason: "The seller's balance rose in more than one currency, so the price cannot be stated in one." };
    } else if (single) {
      const outs = [...new Set(venueLegs.map((l) => l.currency))].filter((c) => buyerOut(c) > 0n);
      if (outs.length === 1) {
        const cur = outs[0]!;
        money = { cur, wrapped: venueLegs.some((l) => l.wrapped && l.from === buyer), sellerRaw: null, grossRaw: buyerOut(cur), others: [], basis: "buyer-balance", slack: cur === "SOL" ? openedRent : 0n };
        notes.push("The seller's proceeds are not visible in this transaction, so the price is what the buyer sent out in the marketplace's own instructions.");
      }
    }
  }
  if (!money) {
    return { ...sale, status: "cannot-tell", notes, reason: "No payment to the seller, and no single payment from the buyer, could be found in this transaction, so the amount cannot be told." };
  }
  const toPayee = fromOutside(new Set(money.others.map(([who]) => who)));
  if (toPayee) {
    return { ...sale, status: "cannot-tell", notes, reason: `${legText(toPayee)} reached ${toPayee.to}, which ${venueInfo.venue.name} also paid in this fill, in an instruction outside ${venueInfo.venue.name}'s own, so what was paid for the item cannot be told.` };
  }
  const decimals = decimalsFor(p, money.cur, [...legs, ...venueLegs]);
  const currency = currencyOf(money.cur, money.wrapped, "dec" in decimals ? decimals.dec : 0);
  const aVenue = `${/^[AEIOU]/.test(venueInfo.venue.name) ? "An" : "A"} ${venueInfo.venue.name}`;
  // One wallet on both sides. By the marketplace rows' rule its amount is
  // nobody's payment, and here it is not even readable: what the wallet pays
  // itself cancels out of the transfers, so the figures above can be a sliver
  // of the order (a real 0.3 SOL OpenSea sale, rewritten so its buyer is its
  // seller, leaves 0.0307 SOL in the legs). No price is given at all.
  if (self) {
    const noPrice = "The buyer and the seller are the same wallet, so no money changed hands between two parties and no price can be stated: what the wallet paid itself cancels out of this transaction's transfers.";
    return { ...sale, currency, price: null, priceRaw: null, sellerReceived: null, noPriceReason: noPrice, status: "sale", notes, reason: `${aVenue} fill of this item (${def.name}) with one wallet as buyer and seller. ${noPrice}` };
  }
  if (!single) {
    const noPrice = `This transaction moved ${itemsMoved} items, so no per-item price can be proven from it.`;
    return { ...sale, currency, price: null, priceRaw: null, sellerReceived: null, noPriceReason: noPrice, status: "sale", notes, reason: `${aVenue} sale of this item (${def.name}). ${noPrice}` };
  }
  if (!("dec" in decimals)) {
    const noPrice = `The amount cannot be read: ${decimals.problem}.`;
    return { ...sale, currency, price: null, priceRaw: null, sellerReceived: null, noPriceReason: noPrice, status: "sale", notes, reason: `${aVenue} sale of this item (${def.name}). ${noPrice}` };
  }
  const dec = decimals.dec;
  const { cur, sellerRaw, grossRaw } = money;
  const result: Partial<ChainSale> = {
    currency,
    sellerReceived: sellerRaw === null ? null : units(sellerRaw, dec),
    ...(money.basis !== "buyer-balance" ? { otherRecipients: money.others.slice(0, 12).map(([address, val]) => ({ address, amount: units(val, dec) })) } : {}),
    ...(grossRaw !== null ? { price: units(grossRaw, dec), priceRaw: grossRaw.toString() } : {}),
    priceBasis: money.basis,
    priceExact: money.basis === "venue-transfers" || (money.basis === "balance-changes" && money.slack === 0n),
    ...(money.slack > 0n ? { priceSlack: units(money.slack, dec) } : {}),
  };
  const buyerRaw = buyerOut(cur);
  if (buyerRaw > 0n && (grossRaw === null || buyerRaw <= grossRaw)) result.buyerPaid = units(buyerRaw, dec);
  else if (buyerRaw > 0n) notes.push(`The buyer sent ${units(buyerRaw, dec)} into the marketplace's instructions, more than this fill paid out (${units(grossRaw!, dec)}), so the buyer's own figure is not this item's price and is not given.`);
  else notes.push("The buyer's own balance did not pay for this item in this transaction: an escrow, a bid account or a pool paid on the buyer's behalf.");
  // The order's own price, where the instruction carries it. It has to sit
  // between what the seller kept and what was paid in all, or the layout
  // does not describe this transaction and the figure is not used.
  if (def.priceAt !== undefined) {
    const orderRaw = u64At(vn.data, def.priceAt);
    if (orderRaw !== null && orderRaw > 0n) {
      if ((sellerRaw === null || orderRaw >= sellerRaw) && (grossRaw === null || orderRaw <= grossRaw)) result.orderPrice = units(orderRaw, dec);
      else notes.push(`The price written in the ${def.name} instruction (${units(orderRaw, dec)}) lies outside what was paid in this fill, so it is not used.`);
    }
  }
  // What the seller kept once the network fee it paid as the signer is taken
  // off: the figure a seller reads from their own wallet (0.000840415 SOL
  // where the pool paid them 0.000882 and the fee was 0.000041585).
  if (cur === "SOL" && sellerSide.size === 1 && sellerRaw !== null && p.keys[0] === seller && p.fee > 0n && sellerRaw > p.fee) result.sellerAfterFee = units(sellerRaw - p.fee, dec);
  if (currency.paidInOtherToken) notes.push("Paid in another token: this amount is in that token's own units and is never a SOL figure.");
  const priceText = result.price !== undefined && result.price !== null ? `${result.price} ${currency.code ?? "units of another token"}` : "an amount that could not be stated";
  return {
    ...sale,
    ...result,
    status: "sale",
    notes,
    reason: `${aVenue} sale of this item (${def.name}) for ${priceText}${result.sellerReceived !== null && result.sellerReceived !== undefined ? `, of which the seller received ${result.sellerReceived}` : ""}.`,
  };
}

/** Every Core item of `collection` this transaction moved, for a scan that does not know the item in advance. */
export function itemsOfCollection(raw: unknown, collection: string): string[] {
  const p = parse(raw);
  if (typeof p === "string") return [];
  return [...new Set(p.nodes.filter((n) => isTransfer(n) && n.accounts[1] === collection).map((n) => n.accounts[0]!).filter((a) => sol.isBase58Address(a)))];
}

// ------------------------------------------------------------- reads

/** A reply that is not kept: a miss, or an answer that is not the transaction asked for. It is handed back once and asked for again next time. */
class NotKept extends Error {
  constructor(readonly value: unknown) {
    super("transaction reply not kept");
  }
}

/**
 * The one place this module asks for a transaction, through the server's
 * shared helper (sol.getParsedTransaction), so the format version is decided
 * where every other transaction read decides it: version 1 and up, asked
 * again once when a node names a newer one, and a format this server cannot
 * read is a typed failure, which the callers below report as unread.
 *
 * Confirmed transactions never change, so a read is kept for an hour, in the
 * server's shared, size-bounded cache. A miss (null) is never kept, because a
 * transaction that is not final yet will be soon, and neither is a reply that
 * cannot stand as this signature's transaction. Callers asking for the same
 * signature at once share one read, and each one's wait ends with its own
 * signal: fifty concurrent scans of one collection sent fifty identical reads.
 */
export async function readTransaction(signature: string, opts: { signal?: AbortSignal; trace?: sol.RpcTrace } = {}): Promise<unknown> {
  try {
    const hit = await cached(
      `chain-tx:${signature}`,
      60 * 60_000,
      async () => {
        const tx = await sol.getParsedTransaction<unknown>(signature, { trace: opts.trace });
        if (tx === null || tx === undefined || replyProblem(tx, signature) !== null) throw new NotKept(tx ?? null);
        return tx;
      },
      { signal: opts.signal },
    );
    return hit.data;
  } catch (e) {
    if (e instanceof NotKept) return e.value;
    throw e;
  }
}

/** What one address is on chain, from one account read. */
export type AddressKind =
  | { kind: "core-asset"; collection: string | null }
  | { kind: "core-burned" }
  | { kind: "core-collection"; name: string }
  | { kind: "core-other" }
  | { kind: "wallet" }
  | { kind: "token" }
  | { kind: "program-account"; owner: string }
  | { kind: "no-account" };

/** One account read. A failed read throws: it is never an answer about the address. */
export async function addressKind(address: string, signal?: AbortSignal): Promise<AddressKind> {
  const acct = await sol.getAccountRaw(address, signal);
  if (acct === null) return { kind: "no-account" };
  if (acct.owner === CORE) {
    if (sol.isBurnedCoreStub(acct.data)) return { kind: "core-burned" };
    const d = sol.decodeCoreAccount(acct.data);
    if (d?.kind === "asset") return { kind: "core-asset", collection: d.collection };
    if (d?.kind === "collection") return { kind: "core-collection", name: d.name };
    return { kind: "core-other" };
  }
  if (acct.owner === SYSTEM) return { kind: "wallet" };
  if (TOKEN_PROGRAMS.has(acct.owner)) return { kind: "token" };
  return { kind: "program-account", owner: acct.owner };
}

/** What an address that is not one Core item is, in a sentence. */
export function describeAddress(address: string, k: AddressKind): string {
  switch (k.kind) {
    case "core-asset":
    case "core-burned":
      return `${address} is a Metaplex Core item`;
    case "core-collection":
      return `${address} is a Metaplex Core collection (${k.name}), not one item`;
    case "core-other":
      return `${address} is a Metaplex Core account this server cannot read as an item or a collection`;
    case "wallet":
      return `${address} is a wallet (an account the System Program owns), not an item`;
    case "token":
      return `${address} is an SPL token account or mint, not a Metaplex Core item: a legacy or programmable NFT moves as a token, and its sales are not decoded here`;
    case "program-account":
      return `${address} is an account of the program ${k.owner}, not a Metaplex Core item`;
    case "no-account":
      return `There is no account at ${address} (a compressed NFT's id is never an account and never appears in its own sale, and a mistyped address has no account either)`;
  }
}

/**
 * A non-sale that rests on the item being a Core asset (it is absent, or
 * named without moving) stands only once the item's own account shows it is
 * one. A compressed sale was answered "Contradicted: the item does not appear
 * in this transaction", which is true of every compressed sale; so was a
 * mistyped address, a collection and a wallet.
 */
async function settleAbsence(d: ChainSale, tx: unknown, item: string, signal?: AbortSignal): Promise<ChainSale> {
  let k: AddressKind;
  try {
    k = await addressKind(item, signal);
  } catch (e) {
    return { ...d, status: "cannot-tell", kind: undefined, reason: `${d.reason} Whether ${item} is a Metaplex Core item could not be read just now (${plainReason(e).sentence}), so this neither confirms nor rules out a sale of it.` };
  }
  if (k.kind === "core-asset" || k.kind === "core-burned") {
    return { ...d, reason: `${d.reason} ${item} was read on chain and is a Metaplex Core item${k.kind === "core-burned" ? " (burned since)" : ""}, so this transaction is not a sale of it.` };
  }
  const moved = (d.movedItems ?? []).slice(0, 3).map((m) => {
    const s = decodeSale(tx, m, d.signature ?? undefined);
    const what = s.status === "sale" ? `${s.venue} sale${s.price !== null && s.price !== undefined ? ` for ${s.price} ${s.currency?.code ?? "units of another token"}` : ""}` : s.status === "not-a-sale" ? (s.kind ?? "not a sale").replace("-", " ") : "could not be decided";
    return `${m} (${what})`;
  });
  const movedText = moved.length
    ? ` The Core item${moved.length > 1 ? "s" : ""} this transaction moved: ${moved.join("; ")}${(d.movedItems?.length ?? 0) > 3 ? `, and ${d.movedItems!.length - 3} more` : ""}. Pass the item's own address as item.`
    : " This transaction moved no Metaplex Core item.";
  return { ...d, status: "cannot-tell", kind: undefined, reason: `${describeAddress(item, k)}, so whether this transaction sold it cannot be told from the transaction.${movedText}` };
}

/** The decoder's answer for one transaction of an item's history, in the shape the history rows carry. */
export function provenanceDecode(tx: unknown, mint: string, signature: string): sol.ProvenanceDecode {
  const d = decodeSale(tx, mint, signature);
  return {
    status: d.status,
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.venue ? { venue: d.venue } : {}),
    ...(d.instruction ? { instruction: d.instruction } : {}),
    ...(d.layout ? { layout: d.layout } : {}),
    ...(d.status === "sale"
      ? {
          price: d.price ?? null,
          currency: d.currency?.code ?? null,
          paymentToken: d.currency ? (d.currency.mint ?? NATIVE_SOL) : null,
          sellerReceived: d.sellerReceived ?? null,
          seller: d.seller,
          buyer: d.buyer,
          ...(d.selfFill ? { selfFill: true } : {}),
          ...(d.noPriceReason ? { noPriceReason: d.noPriceReason } : {}),
        }
      : {}),
  };
}

/** An item's history with every marketplace transaction in it decoded, so a proven sale is named as one. */
export function getProvenanceWithSales(mint: string, depth?: number, opts: { fresh?: boolean; budgetMs?: number } = {}): ReturnType<typeof sol.getProvenance> {
  return sol.getProvenance(mint, depth, { ...opts, saleOf: provenanceDecode });
}

/** Read one transaction and decode it for one item. A failed read is a reason, never an answer. */
export async function readSale(signature: string, item: string, opts: { signal?: AbortSignal } = {}): Promise<ChainSale & { readAt: string; endpoint: string | null }> {
  const trace: sol.RpcTrace = {};
  const tx = await readTransaction(signature, { ...opts, trace });
  const readAt = new Date().toISOString();
  let d = decodeSale(tx, item, signature);
  if (d.status === "not-a-sale" && d.onlyIfCore) d = await settleAbsence(d, tx, item, opts.signal);
  return { ...d, readAt, endpoint: trace.endpoint ?? (trace.endpoints?.[0] ?? null) };
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
  /** The collection scanned, or for an item scan the item's collection (null when it has none). */
  collection: string | null;
  /** What was scanned: a collection's account, or one item's own account when an item was given. */
  scanned: "collection" | "item";
  /** On an item scan, the item. */
  item?: string;
  readFrom: "the Solana chain";
  sales: ChainSale[];
  coverage: {
    signaturesListed: number;
    newestListed: string | null;
    oldestListed: string | null;
    transactionsRead: number;
    /** Of those, the ones whose reply could be read as the transaction asked for and decoded. */
    transactionsDecoded: number;
    /** The block time of the oldest transaction read: the scan saw everything newer than this, within what it read. */
    readBackTo: string | null;
    alreadyInFeeds: number;
    failedOnChain: number;
    notRead: number;
    unreadable: number;
    notSales: number;
    /** `code` is the RPC or HTTP code behind a read that failed, kept out of the sentence. */
    cannotTell: { signature: string; reason: string; code?: string }[];
    stoppedBecause: "end-of-list" | "read-cap" | "deadline" | "cancelled";
    cap: { signatures: number; reads: number; deadlineMs: number };
    endpoint: string | null;
  };
  note: string;
}

/** A scan that was not run, because the address is not a collection or an item. */
export interface ChainScanRefusal {
  refused: string;
  addressKind: AddressKind["kind"];
}

/** Within this long, the address check and the signature list are asked for even when the scan's own budget is shorter. */
const SCAN_SETUP_MS = 5_000;

export async function scanCollectionSales(
  address: string,
  opts: { known?: Set<string>; signal?: AbortSignal; maxReads?: number; deadlineMs?: number; signatures?: number } = {},
): Promise<ChainScan | ChainScanRefusal> {
  const started = Date.now();
  const maxReads = opts.maxReads ?? SCAN_MAX_READS;
  const deadlineMs = opts.deadlineMs ?? SCAN_DEADLINE_MS;
  const limit = opts.signatures ?? SCAN_SIGNATURES;
  const trace: sol.RpcTrace = {};
  // Every read ends with the scan's budget, not only the loop between them:
  // with every read hanging, a 15 s scan took 103 s, one endpoint's retries
  // after another. The first two reads get a short floor so a scan asked
  // with almost no budget still says what it did not read.
  const until = started + deadlineMs;
  const bounded = (ms: number) => (opts.signal ? AbortSignal.any([AbortSignal.timeout(Math.max(1, ms)), opts.signal]) : AbortSignal.timeout(Math.max(1, ms)));
  const setupSignal = bounded(Math.max(deadlineMs, SCAN_SETUP_MS));
  const overBudget = (what: string) => (e: unknown) => {
    if (opts.signal?.aborted || !(e instanceof AbortedError || (e instanceof Error && e.name === "AbortError"))) throw e;
    throw new Error(`${what} did not come back within the scan's ${Math.round(Math.max(deadlineMs, SCAN_SETUP_MS) / 1000)} s budget`);
  };

  // What the address is decides what is scanned. An item's address was
  // scanned as if it were a collection: its two real Tensor sales were read,
  // found to move no item "of the collection", and counted as not sales.
  const kind = await addressKind(address, setupSignal).catch(overBudget(`the account at ${address}`));
  let scanned: ChainScan["scanned"];
  let collection: string | null;
  if (kind.kind === "core-collection") {
    scanned = "collection";
    collection = address;
  } else if (kind.kind === "core-asset" || kind.kind === "core-burned") {
    scanned = "item";
    collection = kind.kind === "core-asset" ? kind.collection : null;
  } else {
    const pointer =
      kind.kind === "wallet"
        ? " Pass the collection's on-chain address; get_wallet_activity lists a wallet's own trades."
        : kind.kind === "no-account"
          ? " Check the address for a typo, or pass the collection's on-chain address."
          : " Pass a Metaplex Core collection's on-chain address, or one Core item's.";
    return { refused: `${describeAddress(address, kind)}, so it has no sales of a Core collection to scan, and nothing was read for it.${pointer}`, addressKind: kind.kind };
  }

  // Concurrent scans of one address share one list read, each waiting with
  // its own budget; fifty at once had sent fifty identical lists.
  const list = (
    await cached(`chain-sigs:${address}:${limit}`, 0, () => sol.newestSignatures(address, limit, { trace }), { fresh: true, signal: setupSignal }).catch(
      overBudget(`the signature list for ${address}`),
    )
  ).data;
  if (!Array.isArray(list)) throw new Error("the Solana endpoint answered the signature list with something that is not a list");
  const sigs = list
    .map((s) => rec(s))
    .filter((s): s is Record<string, unknown> => s !== null && isSignature(s.signature))
    .map((s) => ({ signature: s.signature as string, blockTime: usableBlockTime(s.blockTime), failed: s.err !== null && s.err !== undefined }));
  const sales: ChainSale[] = [];
  const cannotTell: { signature: string; reason: string; code?: string }[] = [];
  let read = 0;
  let decoded = 0;
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
    else if (Date.now() >= until) stopped = "deadline";
    if (stopped !== "end-of-list") {
      notRead = sigs.slice(k).filter((x) => !x.failed && !opts.known?.has(x.signature)).length;
      break;
    }
    read++;
    let tx: unknown;
    try {
      tx = await readTransaction(s.signature, { signal: bounded(until - Date.now()), trace });
    } catch (e) {
      // The budget or the caller ending a read is not the transaction being
      // unreadable: it is counted with the ones the scan never reached.
      if (opts.signal?.aborted || Date.now() >= until) {
        read--;
        stopped = opts.signal?.aborted ? "cancelled" : "deadline";
        notRead = sigs.slice(k).filter((x) => !x.failed && !opts.known?.has(x.signature)).length;
        break;
      }
      unreadable++;
      const why = plainReason(e);
      cannotTell.push({ signature: s.signature, reason: `could not be read: ${why.sentence}`, ...(why.code ? { code: why.code } : {}) });
      continue;
    }
    if (s.blockTime !== null) readBackTo = readBackTo === null ? s.blockTime : Math.min(readBackTo, s.blockTime);
    if (tx === null || tx === undefined) {
      unreadable++;
      cannotTell.push({ signature: s.signature, reason: "the endpoint returned no transaction for it" });
      continue;
    }
    // A reply with no status or message, in an unknown format, or for
    // another signature was counted as "not a sale" and the note said every
    // transaction was read and decoded.
    const problem = replyProblem(tx, s.signature);
    if (problem) {
      unreadable++;
      cannotTell.push({ signature: s.signature, reason: problem.slice(0, 200) });
      continue;
    }
    decoded++;
    const items = scanned === "item" ? [address] : itemsOfCollection(tx, address);
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
  const where =
    scanned === "item"
      ? `the item's own account (${address} is one Metaplex Core item${collection ? ` of the collection ${collection}` : ""}, not a collection, so its own history was read for sales of it)`
      : "the collection account";
  return {
    collection,
    scanned,
    ...(scanned === "item" ? { item: address } : {}),
    readFrom: "the Solana chain",
    sales,
    coverage: {
      signaturesListed: sigs.length,
      newestListed: iso(times.length ? Math.max(...times) : null),
      oldestListed: iso(times.length ? Math.min(...times) : null),
      transactionsRead: read,
      transactionsDecoded: decoded,
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
      `The newest ${sigs.length} transaction(s) touching ${where} were listed and ${read} were read` +
      (read ? ` (${decoded} decoded${unreadable ? `, ${unreadable} could not be read or decoded` : ""})` : "") +
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
    // The rule verify_claim follows: a layout no real transaction of its kind
    // has been checked against names a probable sale, and the row says so
    // rather than standing beside the proven ones as their equal.
    ...(s.layout && s.layout !== "published" && s.layout !== "observed"
      ? { layoutUnchecked: true as const, layoutNote: `The buyer and seller slots for ${s.venue} ${s.instruction} have not been checked against a real transaction of this kind, so this row is a probable sale, not a proven one; verify_claim gives no verdict on it.` }
      : {}),
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

/**
 * The marketplace rows' far-above-the-range flag, on the chain scan's rows.
 *
 * A chain row is a sale like any feed row, and a 40 SOL sale of a card that
 * trades at 0.04 needs the same warning wherever it was found. It is judged
 * against every SOL sale already in the answer: Magic Eden's rows, OpenSea's
 * rows that are not the same fill as one of Magic Eden's, and the other chain
 * rows. Nothing new is read. Only SOL is compared with SOL, and a self-fill or
 * a shared transaction has no price to judge or to judge by.
 */
export function chainRowsInRange(rows: Record<string, unknown>[], answer: Record<string, unknown>): { rows: Record<string, unknown>[]; flagged: number } {
  const solPrice = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as unknown[]).filter((r): r is Record<string, unknown> => rec(r) !== null) : []);
  const feed = [
    ...list(answer.sales).map((s) => (s.selfFill ? null : solPrice(s.priceSol))),
    ...list(rec(answer.opensea)?.sales).map((s) => (s.sameTransactionAs || s.selfFill || s.currency !== "SOL" ? null : solPrice(s.price))),
  ];
  const own = rows.map((r) => (r.selfFill || r.sharedTransaction || r.currency !== "SOL" ? null : solPrice(r.price)));
  const far = farAboveRange([...own, ...feed]);
  let flagged = 0;
  const out = rows.map((r, i) => {
    const f = far[i];
    if (!f) return r;
    flagged++;
    return {
      ...r,
      farAboveRecentRange: {
        ...f,
        note: `Far above the other ${f.othersCompared} SOL sales in this answer, the marketplace rows included (median ${f.medianOfOthersSol}, highest ${f.highestOfOthersSol}). Shown as the chain recorded it, not dropped or adjusted; a price this far out can be a mistyped listing, a wash trade or a real sale, and the transaction cannot say which.`,
      },
    };
  });
  return { rows: out, flagged };
}
