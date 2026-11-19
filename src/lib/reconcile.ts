/**
 * Cross-source reconciliation - the part no single marketplace API can do.
 *
 * Any one venue answers "what is the floor" with a number and no context. Ask
 * two, and you get two different numbers that may or may not describe the same
 * thing. Collector Crypt is the case that motivated this file: Magic Eden
 * quotes ~0.053 SOL, OpenSea quotes 9 USDC. Printed side by side those look
 * like a 170x discrepancy; converted, they roughly agree. An agent handed both
 * numbers with no guidance will confidently pick one and be wrong about the
 * market.
 *
 * So this module never silently merges. It decides whether two quotes are
 * comparable AT ALL, and when they are not, it says why in a sentence the
 * agent can repeat to the user instead of inventing a comparison.
 *
 * Deliberately no USD conversion: that would need a price feed, which is a
 * dependency, a rate limit, and a source of wrong answers when it is stale.
 * Naming the mismatch is honest and free. Converting it is neither.
 */

export interface FloorQuote {
  /** Which venue this price came from. */
  source: string;
  /** The listed floor, in `currency`. */
  value: number;
  /** Denomination as the venue reported it - never assumed. */
  currency: string;
  /** True when the venue did not answer and this is a cached value from a failed refresh. */
  stale?: boolean;
  /** The listing behind this floor, when the venue named it: the item and the wallet that listed it. */
  listing?: { mint: string; maker: string | null };
  /**
   * Whether the chain shows that listing's item still held by its maker or by
   * the venue's own listing account. `not-backed` means nobody can buy it.
   */
  listingCustody?: "backed" | "not-backed" | "unread" | "not-checked";
  /** Other listings this venue showed, so the same listing relayed by another venue can be recognised. */
  alsoListed?: { mint: string; maker: string | null }[];
  /**
   * "symbol" when the venue named this floor's currency by a symbol only, with
   * no token address to check it against. OpenSea's floor, listing and trait
   * endpoints answer that way; a sale row from the same venue carries the
   * address and is classified by it instead.
   */
  currencyBasis?: "symbol";
  /**
   * What the number is. Magic Eden's floor is the seller's asking price.
   * OpenSea's is what a buyer pays to fill the listing through OpenSea, which
   * its own API schema says can include OpenSea's fee on a listing it relays
   * from another marketplace (read 2026-11-14). Two different things.
   */
  priceIs?: "seller-ask" | "buyer-pays-through-venue";
}

/** The sentence for two floors that are not the same kind of number. */
function basisSentence(quotes: FloorQuote[]): string | null {
  const kinds = new Set(quotes.map((q) => q.priceIs).filter(Boolean));
  if (kinds.size < 2) return null;
  const pays = quotes.filter((q) => q.priceIs === "buyer-pays-through-venue").map((q) => q.source);
  const asks = quotes.filter((q) => q.priceIs === "seller-ask").map((q) => q.source);
  return `${pays.join(" and ")}'s figure is what a buyer pays to fill through it, which for a listing relayed from another marketplace can include charges added to the seller's price; ${asks.join(" and ")}'s is the seller's asking price. Part or all of a gap between them can be those charges rather than a cheaper listing.`;
}

const SYMBOL_ONLY_CAVEAT =
  "OpenSea gives the currency of its floor as a symbol only, with no token address, so that label is OpenSea's and could not be checked against a token's address the way a sale's currency is.";

const sameListing = (a: { mint: string; maker: string | null }, b: { mint: string; maker: string | null }) =>
  a.mint === b.mint && a.maker !== null && a.maker === b.maker;

/**
 * The sentence for one listing quoted by two venues, or null.
 *
 * OpenSea relays other marketplaces' books, so its best listing can be the very
 * listing Magic Eden shows, with OpenSea's own charges on top. Printed as two
 * floors, that read as "OpenSea is 12% higher": a spread between two venues
 * made out of one seller's one ask.
 */
export function oneListingTwoVenues(quotes: FloorQuote[]): { sentence: string; sources: [string, string]; sameFloor: boolean } | null {
  for (const q of quotes) {
    if (!q.listing) continue;
    for (const p of quotes) {
      if (p === q) continue;
      // Both floors are the one listing: the gap between them is not a spread.
      if (p.listing && sameListing(p.listing, q.listing)) {
        return {
          sources: [p.source, q.source],
          sameFloor: true,
          sentence:
            `The lowest listing on ${q.source} (${q.value} ${q.currency}) is the same item from the same seller as the lowest on ${p.source}: one listing seen on two marketplaces, ` +
            `not two separate offers, so the gap between the two figures is not a price difference between marketplaces.`,
        };
      }
      // It is one of the other venue's listings, just not its floor: the two
      // floors are still different asks, so no claim is made about the gap.
      if ((p.alsoListed ?? []).some((l) => sameListing(l, q.listing!))) {
        return {
          sources: [p.source, q.source],
          sameFloor: false,
          sentence: `The lowest listing on ${q.source} (${q.value} ${q.currency}) is the same item from the same seller as a listing ${p.source} also shows: one listing seen on two marketplaces, not a separate offer.`,
        };
      }
    }
  }
  return null;
}

export interface Reconciliation {
  /** True only when every quote shares a denomination and there are 2+. */
  comparable: boolean;
  /** One plain sentence, safe to repeat verbatim to a person. */
  verdict: string;
  floors: FloorQuote[];
  /** Only set when `comparable` - never guessed across currencies. */
  cheapest?: FloorQuote;
  /** Percentage the dearest venue sits above the cheapest, when comparable. */
  spreadPct?: number;
  /** Nuances that change how the numbers should be read. */
  caveats: string[];
}

const pct = (a: number, b: number) => Math.round(((a - b) / b) * 1000) / 10;

/**
 * Build a reconciliation from whatever venues actually answered.
 *
 * `quotes` should contain only venues that returned a usable floor; callers
 * filter out errors and nulls rather than passing placeholders, so "one venue
 * answered" is distinguishable from "one venue exists".
 */
export function reconcileFloors(allQuotes: FloorQuote[], extraCaveats: string[] = []): Reconciliation {
  const mirror = oneListingTwoVenues(allQuotes);
  // The matching rows are evidence for the comparison, not another listing
  // page to repeat in both the text and structured answer.
  allQuotes = allQuotes.map((q) => {
    const quote = { ...q };
    delete quote.alsoListed;
    return quote;
  });
  const caveats = [
    "A floor is the lowest current ASK, not a valuation and not a recent trade price. On a thin order book one listing sets it.",
    ...extraCaveats,
  ];
  if (allQuotes.some((q) => q.source === "opensea")) {
    caveats.push("OpenSea aggregates listings across marketplaces. Its reported floor does not identify the venue that can fill the listing; check the order before treating this comparison as an execution price.");
  }
  // A cached quote from a failed refresh is shown but never ranked: naming a
  // "cheapest venue" during an outage is a confident wrong answer.
  const staleQuotes = allQuotes.filter((q) => q.stale);
  // So is a floor whose listing the chain shows cannot be filled: the item
  // left the seller, and the number is a record of an old ask.
  const deadQuotes = allQuotes.filter((q) => !q.stale && q.listingCustody === "not-backed");
  const quotes = allQuotes.filter((q) => !q.stale && q.listingCustody !== "not-backed");
  // The remaining quotes can include unchecked custody. Ranking reported
  // amounts does not establish that their orders can be filled.
  if (staleQuotes.length > 0) {
    caveats.push(
      `${staleQuotes.map((q) => q.source).join(", ")}: the marketplace did not answer just now; the value shown is the last one seen and is excluded from the comparison.`,
    );
  }
  if (deadQuotes.length > 0) {
    caveats.push(
      `${deadQuotes.map((q) => `${q.source} (${q.value} ${q.currency})`).join(", ")}: the item in the checked listing is no longer held by its seller or the marketplace. That listing is excluded from the comparison.`,
    );
  }
  const lead = mirror ? `${mirror.sentence} ` : "";

  if (quotes.length === 0) {
    return {
      comparable: false,
      verdict: `${lead}${allQuotes.length ? "No current floor remains to compare after excluding the quotes shown below." : "No marketplace returned a floor price for this collection."}`,
      floors: allQuotes,
      caveats,
    };
  }

  if (quotes.length === 1) {
    const only = quotes[0]!;
    return {
      comparable: false,
      verdict:
        `${lead}Only ${only.source} returned a floor${deadQuotes.length ? " not excluded as stale" : ""} (${only.value} ${only.currency}), so there is nothing to compare it ` +
        `against. This is one marketplace's view, not the market's.`,
      floors: allQuotes,
      caveats,
    };
  }

  // Both floors are the same listing: there is one ask, not two to rank.
  if (mirror?.sameFloor && mirror.sources.every((s) => quotes.some((q) => q.source === s))) {
    return { comparable: false, verdict: mirror.sentence, floors: allQuotes, caveats };
  }

  // Two floors are about to be set beside each other by currency, and one of
  // those currencies rests on a venue's word alone.
  if (quotes.some((q) => q.currencyBasis === "symbol")) caveats.push(SYMBOL_ONLY_CAVEAT);
  // An ask and a buyer's cost are not the same number; their gap is not a spread.
  const basis = basisSentence(quotes);
  if (basis) caveats.push(basis);

  const currencies = [...new Set(quotes.map((q) => q.currency))];

  if (currencies.length > 1) {
    const rendered = quotes.map((q) => `${q.source} ${q.value} ${q.currency}`).join(", ");
    return {
      comparable: false,
      verdict:
        `These floors are quoted in different currencies (${rendered}) and are NOT directly comparable as ` +
        `printed. Do not call one cheaper than the other without converting them to a common denomination first.`,
      floors: allQuotes,
      caveats: [
        ...caveats,
        "solana-nft-mcp does not convert currencies on purpose - a stale price feed produces confident wrong answers, so the mismatch is reported instead of papered over.",
      ],
    };
  }

  const sorted = [...quotes].sort((a, b) => a.value - b.value);
  const cheapest = sorted[0]!;
  const dearest = sorted[sorted.length - 1]!;
  const spreadPct = cheapest.value > 0 ? pct(dearest.value, cheapest.value) : 0;

  return {
    comparable: true,
    verdict:
      lead +
      (spreadPct === 0
        ? `Both sources report the same floor (${cheapest.value} ${cheapest.currency}).`
        : `Lowest reported by ${cheapest.source} at ${cheapest.value} ${cheapest.currency}; ` +
          `${dearest.source} is ${spreadPct}% higher at ${dearest.value} ${dearest.currency}.` +
          (basis ? ` ${basis}` : "")),
    floors: sorted,
    cheapest,
    spreadPct,
    caveats: [
      ...caveats,
      "Marketplace floors move independently and these were read seconds apart, so a small spread may be timing rather than a real arbitrage.",
    ],
  };
}

// ------------------------------------------------------- payment currency

/**
 * What OpenSea names as the payment token of a sale in native SOL: the System
 * Program's address (seen on every SOL sale in its Solana event feed,
 * 2026-11-14).
 */
export const NATIVE_SOL = "11111111111111111111111111111111";
/** Wrapped SOL's mint. A sale settled in it is a sale in SOL. */
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/** The currencies this server names from a token's address. Any other token is "another token". */
export type KnownCurrency = "SOL" | "USDC" | "USDT" | "PYUSD";

/**
 * Dollar stablecoins, by mint. Each address was read from its issuer's own
 * page (Circle, Tether, Paxos) and checked on chain as a 6-decimal mint on
 * 2026-11-14. A symbol is never enough: anyone can create a token called USDC.
 * This is the only table of them: the feed rows, the sale decoder and
 * verify_claim all name a currency through it.
 */
const STABLECOINS: ReadonlyMap<string, Exclude<KnownCurrency, "SOL">> = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
  // Token-2022; its on-chain metadata names it PayPal USD.
  ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD"],
]);

/** The currency a token address stands for: native or wrapped SOL, a listed stablecoin, or null for any other token. */
export function currencyByMint(address: string): KnownCurrency | null {
  if (address === NATIVE_SOL || address === WRAPPED_SOL) return "SOL";
  return STABLECOINS.get(address) ?? null;
}

/**
 * The decimals each named currency has on chain: SOL 9 (lamports), the three
 * stablecoins 6 (each mint read on chain on 2026-11-14). A payment that names
 * one of these tokens at another scale is not that amount: USDC at 9 decimals
 * turned 800 into 0.8, and wrapped SOL at 6 turned 0.8 into 800.
 */
const DECIMALS: Readonly<Record<KnownCurrency, number>> = { SOL: 9, USDC: 6, USDT: 6, PYUSD: 6 };

/** Why an amount in a named currency cannot be read at the scale given, or null when the scale is right. */
export function decimalsProblem(currency: string | null, decimals: unknown): string | null {
  if (currency === null || !Object.hasOwn(DECIMALS, currency)) return null;
  const want = DECIMALS[currency as KnownCurrency];
  return decimals === want ? null : `decimals ${typeof decimals === "number" ? decimals : "missing"} where ${currency} has ${want}`;
}

/**
 * The largest raw amount a token can hold: SPL token and lamport amounts are
 * unsigned 64-bit integers. A longer quantity is not an amount of anything.
 */
const U64_MAX = 18_446_744_073_709_551_615n;

/** Raw units that fit an on-chain amount: digits only, at most a u64. */
export function rawUnitsFit(raw: string): boolean {
  return /^\d{1,20}$/.test(raw) && BigInt(raw) <= U64_MAX;
}

/** Names a token can give itself to pass for a currency it is not. */
const CLAIMED_NAMES = new Set(["SOL", "WSOL", "USDC", "USDT", "PYUSD"]);
const TOKEN_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TICKER = /^[A-Za-z0-9._-]{1,12}$/;

/**
 * A symbol that reads as one of the named currencies at a glance: "S0L" with
 * a zero, "USDC.e", "SOLANA". Only used to word the note; a symbol never
 * decides a currency either way.
 */
function looksLikeClaimedName(sym: string): string | null {
  const upper = sym.toUpperCase();
  const letters = upper.replace(/0/g, "O").replace(/1/g, "L").replace(/5/g, "S").replace(/[^A-Z]/g, "");
  for (const name of CLAIMED_NAMES) if (letters === name || letters.startsWith(name) || upper.startsWith(name)) return name;
  return null;
}

export interface PaymentCurrency {
  /**
   * "SOL" or a named stablecoin, proved by the payment token's address. Null
   * for every other token and whenever the currency is not established: a
   * token's own symbol is whatever its creator typed ("S0L", "USDC.e"), and in
   * this field it read as the real thing at a glance.
   */
  currency: string | null;
  kind: "sol" | "stablecoin" | "other-token" | "unknown";
  /** The payment token's address, when the venue gave one that is an address. */
  paymentToken: string | null;
  /** Another token's own symbol, for display only, when the venue gave one that is a plain ticker. Never a currency. */
  tokenSymbol?: string;
  /** Why the currency reads the way it does, when a reader needs telling. */
  note?: string;
}

/**
 * The currency a payment was made in, decided by the payment token's ADDRESS.
 *
 * OpenSea accepts any SPL token as payment and relays the token's own symbol,
 * and a token's symbol is whatever its creator typed. A sale paid in a token
 * named "SOL" used to arrive as `currency: "SOL"` and be compared with Magic
 * Eden's SOL prices as if it were one. The symbol now only labels a token
 * this server cannot name; it never makes a payment SOL or a dollar.
 */
export function classifyPaymentToken(address: unknown, symbol: unknown, venue: string): PaymentCurrency {
  const sym = typeof symbol === "string" && TICKER.test(symbol.trim()) ? symbol.trim() : null;
  const given = address !== undefined && address !== null && address !== "";
  const addr = typeof address === "string" && TOKEN_ADDRESS.test(address) ? address : null;
  if (addr === NATIVE_SOL || addr === WRAPPED_SOL) {
    const odd = sym !== null && !/^w?sol$/i.test(sym);
    return {
      currency: "SOL",
      kind: "sol",
      paymentToken: addr,
      ...(odd ? { note: `${venue} labels this payment "${sym}", but its token address is SOL's, so it is counted as SOL.` } : {}),
    };
  }
  const stable = addr !== null ? STABLECOINS.get(addr) : undefined;
  if (addr !== null && stable !== undefined) {
    const odd = sym !== null && sym.toUpperCase() !== stable;
    return {
      currency: stable,
      kind: "stablecoin",
      paymentToken: addr,
      ...(odd ? { note: `${venue} labels this payment "${sym}", but its token address is ${stable}'s, so it is counted as ${stable}.` } : {}),
    };
  }
  if (addr !== null) {
    const posing = sym !== null && CLAIMED_NAMES.has(sym.toUpperCase());
    const lookalike = sym !== null && !posing ? looksLikeClaimedName(sym) : null;
    return {
      currency: null,
      kind: "other-token",
      paymentToken: addr,
      ...(sym !== null ? { tokenSymbol: sym } : {}),
      note: posing
        ? `${venue} labels this payment "${sym}", but its token address ${addr} is not ${sym.toUpperCase()}'s: anyone can create a token with that name. It was paid in another token and is not counted as ${sym.toUpperCase()}.`
        : lookalike
          ? `Paid in another token whose symbol "${sym}" reads like ${lookalike} but is not: its address ${addr} is not ${lookalike}'s. The amount is in that token's own units, and the sale is left out of every SOL figure.`
          : `Paid in another token (${sym ?? "no symbol given"}, address ${addr}), not SOL or a dollar stablecoin. The amount is in that token's own units, and the sale is left out of every SOL figure.`,
    };
  }
  return {
    currency: null,
    kind: "unknown",
    paymentToken: null,
    note: given
      ? `${venue} gave a payment token that is not an address, so the currency is not established and the sale is left out of every SOL figure.`
      : `${venue} gave no payment token address${sym ? ` (only the label "${sym}")` : ""}, so the currency is not established and the sale is left out of every SOL figure.`,
  };
}

/**
 * Raw token units as an amount: a non-negative integer and a whole number of
 * decimals, or null. The whole part is exact; the fraction is a double, lossy
 * only past 15 digits, which no real price has.
 */
export function unitsToAmount(raw: unknown, decimals: unknown): number | null {
  const s = typeof raw === "string" ? raw : typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : null;
  if (s === null || !rawUnitsFit(s)) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const q = BigInt(s);
  const scale = 10n ** BigInt(decimals);
  const amount = Number(q / scale) + Number(q % scale) / Number(scale);
  return Number.isFinite(amount) ? amount : null;
}

/** What a sale was paid in and how much, from one Magic Eden activity row. */
export interface MePayment extends PaymentCurrency {
  /** The amount paid, in `currency` (token units for another token). Null when it cannot be read. */
  amount: number | null;
  /** The amount in SOL, only when the payment was SOL. */
  priceSol: number | null;
  /** Magic Eden's `price` on a stablecoin sale: a SOL equivalent at its own rate, not what was paid. */
  priceSolEquivalent: number | null;
  /** Set when `priceInfo.splPrice` names SOL or a stablecoin at a scale that token does not have, or an amount no token can hold. */
  malformed?: string;
}

const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** Magic Eden's venue label for a fill it relays from Tensor. */
export const TENSOR_RELAY_SOURCE = "tensortrade";

/**
 * The figure Magic Eden gives on a fill it relays from Tensor, or null for any
 * other row.
 *
 * A Claynosaurz fill against a Tensor pool (3d4tADbu..., Tensor's AMM
 * program TAMM6ub33...) read on chain on 2026-11-15: Magic Eden said
 * 5.760249584, the pool paid 5.126093668 and the seller received 4.756060184.
 * Neither side paid or received Magic Eden's figure. The feed does not say
 * which relayed rows are pool fills, so every one is treated as a quote: the
 * sale is counted, its figure is shown under its own name, and it is left out
 * of every SOL figure.
 */
export function tensorRelayQuote(row: { source?: unknown; price?: unknown } | null | undefined): number | null {
  return row?.source === TENSOR_RELAY_SOURCE ? positive(row.price) : null;
}

export const TENSOR_RELAY_NOTE =
  "A Tensor fill Magic Eden relays (venue tensortrade). Its figure is Tensor's quote as Magic Eden passed it on, not what anyone paid: on a Tensor pool fill read on chain on 2026-11-15, Magic Eden said 5.76 where the pool paid 5.13 and the seller received 4.76, and this feed does not say which relayed rows are pool fills. The sale is counted and its figure is kept out of every SOL figure; verify_claim with claim sale reads what the transaction moved.";

/**
 * Magic Eden's `price` is SOL, except on a sale paid in an SPL token, where it
 * is a SOL equivalent at Magic Eden's rate and the amount paid sits in
 * `priceInfo.splPrice` (an 800 USDC sale arrived as price 6.733786, read
 * against its transaction on 2026-11-14). A row without `splPrice` is SOL, as
 * Magic Eden reports it. What `price` holds for a token that is neither SOL
 * nor a dollar stablecoin was not checked, so it is passed on as nothing.
 */
export function mePayment(row: { price?: unknown; priceInfo?: unknown } | null | undefined): MePayment {
  const info = row?.priceInfo;
  const spl = info !== null && typeof info === "object" ? (info as { splPrice?: unknown }).splPrice : undefined;
  if (spl === undefined || spl === null) {
    const sol = positive(row?.price);
    return { currency: "SOL", kind: "sol", paymentToken: null, amount: sol, priceSol: sol, priceSolEquivalent: null };
  }
  const s = typeof spl === "object" ? (spl as { address?: unknown; rawAmount?: unknown; decimals?: unknown }) : {};
  const c = classifyPaymentToken(s.address, undefined, "Magic Eden");
  // A named currency at a scale it does not have is no amount of it, and an
  // amount longer than any token can hold is no amount at all.
  const scale = decimalsProblem(c.currency, s.decimals);
  const rawGiven = typeof s.rawAmount === "string" ? s.rawAmount : typeof s.rawAmount === "number" ? String(s.rawAmount) : null;
  const tooLong = rawGiven !== null && /^\d+$/.test(rawGiven) && !rawUnitsFit(rawGiven);
  const malformed = scale ?? (tooLong ? "an amount longer than any token can hold" : null);
  const amount = malformed ? null : unitsToAmount(s.rawAmount, s.decimals);
  const bad = malformed ? { malformed: `splPrice: ${malformed}` } : {};
  if (c.kind === "sol") {
    return {
      ...c,
      amount,
      priceSol: amount,
      priceSolEquivalent: null,
      ...bad,
      ...(malformed ? { note: `Magic Eden names SOL as the payment but gives ${malformed}, so the amount cannot be read and the sale is left out of every SOL figure.` } : {}),
    };
  }
  if (c.kind === "stablecoin") {
    return {
      ...c,
      amount,
      priceSol: null,
      priceSolEquivalent: positive(row?.price),
      ...bad,
      note: `Paid in ${c.currency}${malformed ? `; Magic Eden gives ${malformed}, so the amount cannot be read` : amount === null ? "; the amount Magic Eden sent could not be read" : ""}. Magic Eden's price on this row (priceSolEquivalent) is a SOL equivalent at its own rate, not what was paid, so the sale is left out of every SOL figure.`,
    };
  }
  if (c.kind === "other-token") {
    return {
      ...c,
      amount,
      priceSol: null,
      priceSolEquivalent: null,
      note: `${c.note} What Magic Eden's price field holds for such a token was not checked, so it is given neither as SOL nor as a SOL equivalent.`,
    };
  }
  return { ...c, amount: null, priceSol: null, priceSolEquivalent: null };
}
