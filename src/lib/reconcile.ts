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
}

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
  // Everything below ranks `quotes` (fresh and fillable only) but reports `allQuotes`.
  if (staleQuotes.length > 0) {
    caveats.push(
      `${staleQuotes.map((q) => q.source).join(", ")}: the marketplace did not answer just now; the value shown is the last one seen and is excluded from the comparison.`,
    );
  }
  if (deadQuotes.length > 0) {
    caveats.push(
      `${deadQuotes.map((q) => `${q.source} (${q.value} ${q.currency})`).join(", ")}: the chain shows the listing behind this floor is no longer held by its seller or the marketplace, so nobody can buy at that price; it is shown and excluded from the comparison.`,
    );
  }
  const mirror = oneListingTwoVenues(allQuotes);
  const lead = mirror ? `${mirror.sentence} ` : "";

  if (quotes.length === 0) {
    return {
      comparable: false,
      verdict: `${lead}No marketplace returned a floor price for this collection${deadQuotes.length ? " that the chain shows can be bought" : ""}.`,
      floors: allQuotes,
      caveats,
    };
  }

  if (quotes.length === 1) {
    const only = quotes[0]!;
    return {
      comparable: false,
      verdict:
        `${lead}Only ${only.source} returned a floor${deadQuotes.length ? " that the chain shows can be bought" : ""} (${only.value} ${only.currency}), so there is nothing to compare it ` +
        `against. This is one marketplace's view, not the market's.`,
      floors: allQuotes,
      caveats,
    };
  }

  // Both floors are the same listing: there is one ask, not two to rank.
  if (mirror?.sameFloor && mirror.sources.every((s) => quotes.some((q) => q.source === s))) {
    return { comparable: false, verdict: mirror.sentence, floors: allQuotes, caveats };
  }

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
          `${dearest.source} is ${spreadPct}% higher at ${dearest.value} ${dearest.currency}.`),
    floors: sorted,
    cheapest,
    spreadPct,
    caveats: [
      ...caveats,
      "Marketplace floors move independently and these were read seconds apart, so a small spread may be timing rather than a real arbitrage.",
    ],
  };
}
