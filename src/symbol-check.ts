/**
 * Does this marketplace symbol actually describe this on-chain collection?
 *
 * The failure that made this necessary, found by sweeping 37 real collections:
 * the registry entry "2023 Tickets" carries the Core collection 34fpWW... with
 * 2 items minted. Matching that name against the venue directory produced the
 * symbol `2023_tickets`, whose listings belong to a DIFFERENT chain collection
 * (HscoKN...). The answer then printed "2 minted" from the chain beside
 * "10 listed, floor 0.1 SOL" from the venue, as though they described one
 * thing. Two names can be the same name.
 *
 * A symbol handed over by hand is trusted. A symbol MATCHED by name is checked
 * once against the chain: take one listed item, ask the asset index which
 * collection it belongs to, and compare. Cheap, decisive, and cached, because
 * the answer only changes when a collection is relisted under a new symbol.
 *
 * Three verdicts, and "unknown" is not "matches": a check that could not run
 * leaves the caller to say the symbol is unverified, never to imply it passed.
 */
import * as me from "./sources/magiceden.js";
import * as das from "./sources/das.js";
import { BoundedMap } from "./lib/bounded.js";

export type SymbolVerdict = "matches" | "different" | "unknown";

export interface SymbolCheck {
  verdict: SymbolVerdict;
  /** Plain words for the answer, always safe to print. */
  detail: string;
  /** The item the check was made on, when one was read. */
  sampledMint?: string;
  /** The collection that item actually belongs to, when the index named one. */
  sampledCollection?: string;
}

const TTL_MS = 6 * 60 * 60_000;
/** Verdicts taken recently. Bounded, because the symbol side of the key is whatever a caller typed. */
const cache = new BoundedMap<SymbolCheck>(2_000, TTL_MS);
const key = (symbol: string, collection: string) => `${symbol}::${collection}`;

/** The stored verdict, when one was taken recently. Never triggers a read. */
export function cachedSymbolCheck(symbol: string, coreCollection: string): SymbolCheck | null {
  return cache.get(key(symbol, coreCollection)) ?? null;
}

/**
 * Check a symbol against a collection address. Never throws: an upstream that
 * will not answer produces "unknown" with the reason, because a failed check
 * must not become a claim in either direction.
 */
export async function checkSymbolMatchesCollection(symbol: string, coreCollection: string): Promise<SymbolCheck> {
  const cached = cachedSymbolCheck(symbol, coreCollection);
  if (cached) return cached;
  const store = (value: SymbolCheck): SymbolCheck => {
    cache.set(key(symbol, coreCollection), value);
    return value;
  };
  let mint: string | undefined;
  try {
    const book = await me.collectionListings(symbol, { limit: 1 });
    mint = book.listings.find((l) => typeof l.tokenMint === "string")?.tokenMint;
    if (!mint) {
      return store({
        verdict: "unknown",
        detail: `Nothing is listed under "${symbol}" right now, so there was no item to check it against this collection.`,
      });
    }
  } catch (e) {
    return store({
      verdict: "unknown",
      detail: `The marketplace did not answer for "${symbol}", so the symbol could not be checked against this collection: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  try {
    const read = await das.getAsset(mint);
    const belongsTo = read.asset?.collection ?? null;
    if (!belongsTo) {
      return store({
        verdict: "unknown",
        detail: `The asset index does not say which collection ${mint} belongs to, so the symbol could not be checked.`,
        sampledMint: mint,
      });
    }
    if (belongsTo === coreCollection) {
      return store({
        verdict: "matches",
        detail: `Checked: an item listed under "${symbol}" belongs to this collection on chain.`,
        sampledMint: mint,
        sampledCollection: belongsTo,
      });
    }
    return store({
      verdict: "different",
      detail:
        `"${symbol}" is a DIFFERENT collection. An item listed under it belongs to ${belongsTo} on chain, not to ${coreCollection}. ` +
        `Two collections can share a name, and this symbol was matched by name rather than verified by hand.`,
      sampledMint: mint,
      sampledCollection: belongsTo,
    });
  } catch (e) {
    return store({
      verdict: "unknown",
      detail: `The asset index did not answer for ${mint}, so the symbol could not be checked: ${e instanceof Error ? e.message : String(e)}`,
      sampledMint: mint,
    });
  }
}
