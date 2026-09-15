/**
 * Ask the venue about a name instead of trusting the directory for it.
 *
 * Magic Eden refuses to page past offset 30,000 and its catalogue is bigger
 * than that, so the bundled directory snapshot is a PREFIX of the venue, never
 * the venue. The collections missing from it are not obscure ones: DeGods,
 * Okay Bears, Cets on Creck and Degenerate Ape Academy were all absent on
 * 2026-09-15 while knock-offs wearing their names (degodscasino, anti_okay_bears,
 * ai_okay_bears_) were present and scored. Asking for "DeGods" therefore came
 * back with eight imitations and none of the real thing, which is worse than
 * coming back empty: a reader takes the top row.
 *
 * A collection's symbol is almost always its own name, lowercased with the
 * spaces filled in. That path has no offset and no ceiling, so this turns the
 * name into the two or three symbols it could be and asks the venue about each.
 *
 * The rule that keeps it honest: a symbol is accepted only when the venue's
 * OWN name for it matches the name that was asked for. Without that check,
 * "Batman" would confidently return whatever collection happens to own the
 * symbol `batman`.
 */
import * as me from "./sources/magiceden.js";
import { collectionNameKey } from "./names.js";
import { HttpError } from "./lib/http.js";
import { NotFoundError } from "./lib/errors.js";

/** Symbols a collection with this name plausibly has, most likely first. */
export function symbolCandidates(name: string): string[] {
  const base = name
    .normalize("NFKD")
    // Strip accents, so "Clésy" and "Clesy" try the same symbols.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];
  const out = [words.join("_"), words.join(""), words.join("-")];
  // A trailing "s" that the venue dropped, or the other way round, is the one
  // near-miss common enough to be worth a probe: "Froganas" is `froganas`
  // while the collection is named "Frogana".
  if (words.length === 1 && words[0]!.length > 4) {
    const w = words[0]!;
    out.push(w.endsWith("s") ? w.slice(0, -1) : `${w}s`);
  }
  return [...new Set(out)].filter((s) => s.length >= 2 && s.length <= 80).slice(0, 4);
}

export interface DirectSymbolHit {
  found: true;
  symbol: string;
  /** The venue's own name for it, which is what was matched against. */
  venueName: string;
  note: string;
}

export interface DirectSymbolMiss {
  found: false;
  /**
   * True only when every candidate was answered with a definite 404. False
   * when a candidate failed for any other reason, because a rate limit is not
   * evidence about the world.
   */
  conclusive: boolean;
  note: string;
}

export type DirectSymbolOutcome = DirectSymbolHit | DirectSymbolMiss;

const misses = new Map<string, number>();
const MISS_TTL_MS = 10 * 60_000;

/**
 * Find the Magic Eden symbol for a collection NAME by asking the venue.
 *
 * Never throws: this runs beside the directory layers as an extra chance, and
 * an upstream having a bad minute must not take the answer down with it.
 *
 * The distinction that matters, and that this got wrong the first time: a 404
 * means "no collection has this symbol", while a 429 means "the venue would
 * not say". Treating the second as the first is how a rate limit becomes a
 * confident claim about the world, and how a negative gets cached from a
 * transport failure. Only an all-404 sweep is conclusive, and only a
 * conclusive miss is remembered.
 */
export async function findSymbolByName(name: string, opts: { signal?: AbortSignal } = {}): Promise<DirectSymbolOutcome> {
  const wanted = collectionNameKey(name);
  if (!wanted) return { found: false, conclusive: true, note: "the name has no letters or digits to turn into a symbol" };
  const cachedMiss = misses.get(wanted);
  if (cachedMiss !== undefined && Date.now() - cachedMiss < MISS_TTL_MS) {
    return { found: false, conclusive: true, note: "asked the venue for this name recently and every spelling answered 404" };
  }

  const tried: string[] = [];
  const unreadable: string[] = [];
  for (const symbol of symbolCandidates(name)) {
    if (opts.signal?.aborted) {
      return { found: false, conclusive: false, note: `ran out of time after trying ${tried.join(", ") || "nothing"}` };
    }
    tried.push(symbol);

    // Deliberately NOT the collection metadata endpoint. Magic Eden rate
    // limits /collections/{symbol} far harder than the rest: measured on
    // 2026-09-15, stats and listings both answered 200 for `degods` in the
    // same second that metadata answered 429. A probe built on the endpoint
    // that refuses first is a probe that never works.
    let exists = false;
    try {
      const stats = await me.collectionStats(symbol);
      exists = stats.floorPriceSol !== null || stats.listedCount !== null;
    } catch (e) {
      // "No such collection" is an answer. A refusal to answer is not.
      if (e instanceof NotFoundError || (e instanceof HttpError && e.status === 404)) continue;
      unreadable.push(`${symbol} (${e instanceof Error ? e.message.slice(0, 70) : String(e)})`);
      continue;
    }
    if (!exists) continue;

    // The symbol is real. Now prove it is the collection that was ASKED for,
    // because a symbol existing says nothing about whose it is: without this,
    // "Batman" would confidently return whatever owns the symbol `batman`.
    // A listing carries the collection's own name, and failing that an item
    // name with a serial on the end.
    let venueName: string | null = null;
    try {
      const listings = await me.collectionListings(symbol, { limit: 1 });
      const token = listings.listings?.[0]?.token;
      const named = typeof token?.collectionName === "string" && token.collectionName.trim() ? token.collectionName : null;
      // "DeGods #1234" -> "DeGods". Trailing serials, and nothing else.
      const fromItem = typeof token?.name === "string" ? token.name.replace(/\s*[#(]?\s*\d+\s*(?:\/\s*\d+)?\s*\)?\s*$/, "").trim() : "";
      venueName = named ?? (fromItem || null);
    } catch (e) {
      unreadable.push(`${symbol} listings (${e instanceof Error ? e.message.slice(0, 70) : String(e)})`);
      continue;
    }
    // A collection can be rebranded without its symbol changing: the venue
    // calls `solana_monkey_business` "SMB Gen2" now. So an exact slugification
    // of what was asked for is its own proof - not a substring, not a variant
    // spelling, the whole query turned into the whole symbol. Only the first
    // candidate qualifies, and every other spelling still has to be confirmed
    // by name.
    const canonical = symbol === symbolCandidates(name)[0];
    const nameMatches = venueName !== null && collectionNameKey(venueName) === wanted;
    if (!nameMatches && !canonical) continue;
    if (!nameMatches && canonical && venueName === null) {
      // Nothing listed, so nothing to read the name from. The symbol is still
      // an exact slugification, which is why this is accepted rather than
      // dropped, and the note says the name was never confirmed.
      return {
        found: true,
        symbol,
        venueName: name,
        note:
          `Magic Eden has a collection under the symbol "${symbol}", which is exactly what this name slugifies to. ` +
          `Nothing is listed under it, so the venue's own name for it could not be read and was not confirmed.`,
      };
    }
    return {
      found: true,
      symbol,
      venueName: venueName ?? name,
      note: nameMatches
        ? `Magic Eden symbol found by asking the venue for "${symbol}" directly, because the bundled directory ` +
          `stops at the venue's paging ceiling of 30,000 collections. An item listed under it is named ` +
          `"${venueName}", which matches what was asked for and is why it was accepted.`
        : `Magic Eden symbol found by asking the venue for "${symbol}" directly, which is exactly what this name ` +
          `slugifies to. The venue currently calls it "${venueName}" rather than "${name}" - collections get ` +
          `rebranded without their symbol changing, so check that is the one you meant.`,
    };
  }

  if (unreadable.length > 0) {
    return {
      found: false,
      conclusive: false,
      note: `the venue would not answer for ${unreadable.join("; ")}, so this check proves nothing about whether the collection exists`,
    };
  }
  misses.set(wanted, Date.now());
  return { found: false, conclusive: true, note: `no collection at the venue under any spelling tried: ${tried.join(", ")}` };
}

/** Test seam: forget the negative cache. */
export function resetDirectSymbolCache(): void {
  misses.clear();
}
