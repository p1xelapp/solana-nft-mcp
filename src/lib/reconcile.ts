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
  // A cached quote from a failed refresh is shown but never ranked: naming a
  // "cheapest venue" during an outage is a confident wrong answer.
  const staleQuotes = allQuotes.filter((q) => q.stale);
  const quotes = allQuotes.filter((q) => !q.stale);
  // Everything below ranks `quotes` (fresh only) but reports `allQuotes`.
  if (staleQuotes.length > 0) {
    caveats.push(
      `${staleQuotes.map((q) => q.source).join(", ")}: the venue did not answer just now; the value shown is the last one seen and is excluded from the comparison.`,
    );
  }

  if (quotes.length === 0) {
    return {
      comparable: false,
      verdict: "No marketplace returned a floor price for this collection.",
      floors: allQuotes,
      caveats,
    };
  }

  if (quotes.length === 1) {
    const only = quotes[0]!;
    return {
      comparable: false,
      verdict:
        `Only ${only.source} returned a floor (${only.value} ${only.currency}), so there is nothing to compare it ` +
        `against. This is one venue's view, not the market's.`,
      floors: allQuotes,
      caveats,
    };
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
        "collector-mcp does not convert currencies on purpose - a stale price feed produces confident wrong answers, so the mismatch is reported instead of papered over.",
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
      spreadPct === 0
        ? `Both venues show the same floor (${cheapest.value} ${cheapest.currency}).`
        : `Cheapest on ${cheapest.source} at ${cheapest.value} ${cheapest.currency}; ` +
          `${dearest.source} is ${spreadPct}% higher at ${dearest.value} ${dearest.currency}.`,
    floors: sorted,
    cheapest,
    spreadPct,
    caveats: [
      ...caveats,
      "Venue floors move independently and these were read seconds apart, so a small spread may be timing rather than a real arbitrage.",
    ],
  };
}
