/**
 * Ask the venue about a name instead of trusting the directory for it.
 *
 * Magic Eden refuses to page past offset 30,000 and its catalogue is bigger
 * than that, so the bundled directory snapshot is a PREFIX of the venue, never
 * the venue. The collections missing from it are not obscure ones: DeGods,
 * Okay Bears, Cets on Creck and Degenerate Ape Academy were all absent on
 * while knock-offs wearing their names (degodscasino, anti_okay_bears,
 * ai_okay_bears_) were present and scored. Asking for "DeGods" therefore came
 * back with eight imitations and none of the real thing, which is worse than
 * coming back empty: a reader takes the top row.
 *
 * A collection's symbol is almost always its own name, lowercased with the
 * spaces filled in. That path has no offset and no ceiling, so this turns the
 * name into the one or two symbols it could be and asks the venue about each.
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
import { BoundedMap } from "./lib/bounded.js";
import { clean } from "./lib/untrusted.js";

/** An upstream error's words, made safe for a note this server returns. */
const upstreamText = (e: unknown): string => clean(e instanceof Error ? e.message : String(e)).slice(0, 70);

/**
 * Symbols a collection with this name plausibly has, most likely first.
 *
 * Kept to TWO, and usually one, because every candidate is a gated request on
 * the critical path of a question somebody is waiting for. Measured with four:
 * a name the venue does not have cost 7.8 s to rule out, and identify() as a
 * whole went past its own 25-second deadline. The third and fourth spellings
 * had never once been the one that hit.
 */
export function symbolCandidates(name: string): string[] {
  const base = name
    .normalize("NFKD")
    // Strip accents, so "Clésy" and "Clesy" try the same symbols.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  // A sentence is not a collection name. Probing one spends requests on a
  // question the venue was never going to answer.
  if (words.length === 0 || words.length > 4 || base.length > 60) return [];
  // Underscore is what Magic Eden uses; no separator is the other real form
  // (`kanpaipandas`). For a single word the two are the same string, so most
  // names cost exactly one request to rule out.
  return [...new Set([words.join("_"), words.join("")])].filter((s) => s.length >= 2 && s.length <= 80);
}

export interface DirectSymbolHit {
  found: true;
  symbol: string;
  /** The venue's own name for it, which is what was matched against. */
  venueName: string;
  /**
   * True when the symbol is the exact slugification of the name but nothing
   * is listed under it, so the venue's own name could not be read. A hit on
   * the strength of the slug alone; the caller reports it as such.
   */
  provisional?: boolean;
  note: string;
}

/** The venue has the symbol this name slugifies to, and calls it something else. */
export interface DirectConflict {
  symbol: string;
  venueName: string;
}

export interface DirectSymbolMiss {
  found: false;
  /**
   * True only when every candidate was answered with a definite 404, or with
   * a collection whose own name proves it is not this one. False when a
   * candidate failed for any other reason, because a rate limit is not
   * evidence about the world.
   */
  conclusive: boolean;
  /**
   * Set when the exact slug exists under a DIFFERENT name. Not a hit: the
   * caller is told both names and decides, because "solana_monkey_business"
   * being called "SMB Gen2" is a rebrand and "audit_crown" being called
   * "Entirely Different" is a different collection, and this code cannot
   * tell those apart. Guessing picked the wrong one at 223x the price once.
   */
  conflict?: DirectConflict;
  note: string;
}

export type DirectSymbolOutcome = DirectSymbolHit | DirectSymbolMiss;

const MISS_TTL_MS = 10 * 60_000;
/** Recent names the venue did not know. Bounded: a session that asks about thousands of unknown names must not keep every one. */
const misses = new BoundedMap<{ conflict?: DirectConflict }>(2_000, MISS_TTL_MS);

const conflictNote = (name: string, c: DirectConflict): string =>
  `Magic Eden has a collection under the symbol "${c.symbol}", which is exactly what "${name}" slugifies to, but the marketplace calls it ` +
  `"${c.venueName}". That is either a rebrand or a different collection wearing the symbol, and this server will not choose for you: ` +
  `if "${c.venueName}" is the one you meant, pass the symbol "${c.symbol}" directly.`;

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
/**
 * How long the whole probe may take.
 *
 * This runs on the critical path of a question somebody is waiting for, and it
 * shares one rate gate with every other Magic Eden call - including the
 * background walk that refreshes the directory, which is 61 pages long. Behind
 * that walk, two ungated-looking requests can wait a very long time. The probe
 * is an EXTRA chance at an answer, so it gets a budget and gives up politely:
 * an unfinished probe is inconclusive, which is already handled honestly.
 */
const PROBE_BUDGET_MS = 6_000;

export async function findSymbolByName(name: string, opts: { signal?: AbortSignal } = {}): Promise<DirectSymbolOutcome> {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const outOfTime = () => Date.now() > deadline;
  const wanted = collectionNameKey(name);
  if (!wanted) return { found: false, conclusive: true, note: "the name has no letters or digits to turn into a symbol" };
  // The negative cache is keyed by the SPELLINGS that were tried, not the
  // name. "Candy Digital - Audit Crown" and "Audit Crown" share a name key
  // but try different symbols, and the first's all-404 used to answer the
  // second without ever asking the venue about `audit_crown`.
  const cacheKey = symbolCandidates(name).join("|") || wanted;
  const cachedMiss = misses.get(cacheKey);
  if (cachedMiss !== undefined) {
    return cachedMiss.conflict
      ? { found: false, conclusive: true, conflict: cachedMiss.conflict, note: conflictNote(name, cachedMiss.conflict) }
      : { found: false, conclusive: true, note: "asked the marketplace for this name recently and every spelling answered 404" };
  }

  const tried: string[] = [];
  const unreadable: string[] = [];
  let conflict: DirectConflict | undefined;
  for (const symbol of symbolCandidates(name)) {
    if (opts.signal?.aborted || outOfTime()) {
      return {
        found: false,
        conclusive: false,
        note:
          `the ${PROBE_BUDGET_MS / 1000}s budget for asking the marketplace about this name ran out after trying ` +
          `${tried.join(", ") || "nothing"}, so this check proves nothing either way`,
      };
    }
    tried.push(symbol);

    // Deliberately NOT the collection metadata endpoint. Magic Eden rate
    // limits /collections/{symbol} far harder than the rest: stats and
    // listings both answered 200 for `degods` in the same second that
    // metadata answered 429. A probe built on the endpoint
    // that refuses first is a probe that never works.
    let exists = false;
    try {
      const stats = await me.collectionStats(symbol);
      exists = stats.floorPriceSol !== null || stats.listedCount !== null;
    } catch (e) {
      // "No such collection" is an answer. A refusal to answer is not.
      if (e instanceof NotFoundError || (e instanceof HttpError && e.status === 404)) continue;
      unreadable.push(`${symbol} (${upstreamText(e)})`);
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
      // Both of these are marketplace-authored text, and both end up quoted
      // inside a note this server returns. Neutralised here, at the boundary,
      // because a later equality test constrains WHICH string is emitted and
      // not which characters it may contain.
      const rawNamed = typeof token?.collectionName === "string" && token.collectionName.trim() ? token.collectionName : null;
      const named = rawNamed ? clean(rawNamed).slice(0, 120) : null;
      // "DeGods #1234" -> "DeGods". Trailing serials, and nothing else.
      const rawItem = typeof token?.name === "string" ? token.name.replace(/\s*[#(]?\s*\d+\s*(?:\/\s*\d+)?\s*\)?\s*$/, "").trim() : "";
      const fromItem = rawItem ? clean(rawItem).slice(0, 120) : "";
      venueName = named ?? (fromItem || null);
    } catch (e) {
      unreadable.push(`${symbol} listings (${upstreamText(e)})`);
      continue;
    }
    // The venue's own name is the proof, and the only proof. An exact
    // slugification of the query used to override a DIFFERENT venue name on
    // the theory that collections get rebranded without their symbol
    // changing (`solana_monkey_business` is "SMB Gen2" now). True, and also
    // exactly how "Audit Crown" resolved to a collection called "Entirely
    // Different" with found: true, after which identify() attached that
    // collection's floor and sales to the name that was asked for. A rebrand
    // and an impostor look identical from here, so a conflict is reported as
    // one, never resolved.
    const canonical = symbol === symbolCandidates(name)[0];
    const nameMatches = venueName !== null && collectionNameKey(venueName) === wanted;
    if (nameMatches) {
      return {
        found: true,
        symbol,
        venueName: venueName as string,
        note:
          `Magic Eden symbol found by asking the marketplace for "${symbol}" directly, because the bundled directory ` +
          `stops at the marketplace's paging ceiling of 30,000 collections. An item listed under it is named ` +
          `"${venueName}", which matches what was asked for and is why it was accepted.`,
      };
    }
    if (!canonical) continue;
    if (venueName !== null) {
      conflict ??= { symbol, venueName };
      continue;
    }
    // Nothing listed, so nothing to read the name from. The symbol is still
    // an exact slugification, which is why this is accepted rather than
    // dropped - as provisional, and the note says the name was never
    // confirmed.
    return {
      found: true,
      provisional: true,
      symbol,
      venueName: name,
      note:
        `Magic Eden has a collection under the symbol "${symbol}", which is exactly what this name slugifies to. ` +
        `Nothing is listed under it, so the marketplace's own name for it could not be read and was not confirmed; treat this as provisional.`,
    };
  }

  if (unreadable.length > 0) {
    return {
      found: false,
      conclusive: false,
      ...(conflict ? { conflict } : {}),
      note:
        `the marketplace would not answer for ${unreadable.join("; ")}, so this check proves nothing about whether the collection exists` +
        (conflict ? `. ${conflictNote(name, conflict)}` : ""),
    };
  }
  misses.set(cacheKey, conflict ? { conflict } : {});
  if (conflict) return { found: false, conclusive: true, conflict, note: conflictNote(name, conflict) };
  return { found: false, conclusive: true, note: `no collection at the marketplace under any spelling tried: ${tried.join(", ")}` };
}

/** Test seam: forget the negative cache. */
export function resetDirectSymbolCache(): void {
  misses.clear();
}
