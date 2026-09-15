/**
 * Plain-name resolution: "collector crypt", "mad lads", "candy icon" -> the
 * identifiers the other tools need.
 *
 * Three layers, cheapest first, and the answer always says which layer it
 * came from and how old that layer is:
 *
 *   1. the curated registry (hand-verified, a handful of entries)
 *   2. a bundled snapshot of Magic Eden's whole collection directory
 *      (~30,000 entries, instant, dated)
 *   3. the live directory, walked in the background after the first miss
 *      and cached for a day, so the second ask sees anything newer
 *
 * A "no match" is only claimed when every layer was searched, and the result
 * carries `searched` so a model never turns "not in the snapshot" into "does
 * not exist".
 */

import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as me from "./sources/magiceden.js";
import { findByName, type NameMatch } from "./market.js";
import { searchRegistry } from "./registry.js";
import { clean } from "./lib/untrusted.js";
import { isCollectionSymbol } from "./lib/shapes.js";

interface Snapshot {
  takenAt: string;
  count: number;
  complete: boolean;
  /** True when the walk stopped at Magic Eden's offset ceiling rather than at the end of the catalogue. */
  atVenuePagingLimit?: boolean;
  collections: { s: string; n: string; b: number }[];
}

/**
 * A directory layer is complete only when OUR budget did not run out AND the
 * venue did not refuse to page further. Magic Eden answers 400 past offset
 * 30,000, so a layer can be "everything we were allowed to read" and still be
 * missing collections - which is exactly when "no such collection" is wrong.
 */
const layerComplete = (partial: boolean, atLimit: boolean): boolean => !partial && !atLimit;

let snapshot: Snapshot | null | undefined;

function loadSnapshot(): Snapshot | null {
  if (snapshot !== undefined) return snapshot;
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "me-collections.json.gz");
    const parsed = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8")) as Snapshot;
    snapshot = Array.isArray(parsed.collections) ? parsed : null;
  } catch {
    snapshot = null;
  }
  return snapshot;
}

/** Full directory walk; the live layer. Kicked off in the background, awaited only when already warm. */
const LIVE_PAGES = 80;
/**
 * How long a warmed live layer stays current. Collections are added daily, and
 * a server left running for a week was answering from the layer it walked on
 * the first morning: anything listed since was invisible and nothing said so.
 */
const LIVE_TTL_MS = 24 * 60 * 60_000;
let symbolByName: Map<string, string[]> | null = null;
let liveWarming: Promise<me.CollectionsIndexRead> | null = null;
let liveReady: me.CollectionsIndexRead | null = null;
let liveReadyAt = 0;

const liveExpired = (): boolean => liveReady !== null && Date.now() - liveReadyAt > LIVE_TTL_MS;

/**
 * Start one background walk. The in-flight promise is cleared on BOTH
 * outcomes, so a later expiry can start a fresh one; without that, `liveWarming`
 * stayed a fulfilled promise forever and the layer could never refresh.
 */
function warmLive(): void {
  if (liveWarming) return;
  // The offline suite must stay offline; a background walk started by a
  // pure-logic search would be the one network call nobody asked for.
  if (process.env.COLLECTOR_MCP_OFFLINE === "1") return;
  liveWarming = me
    .collectionsIndex(LIVE_PAGES)
    .then((r) => {
      liveReady = r;
      liveReadyAt = Date.now();
      liveWarming = null;
      // The name-to-symbol index is built once and cached; a fresh live layer
      // is exactly the case where a collection listed since the snapshot can
      // now be resolved, so the index is rebuilt on next use rather than
      // staying at whatever the bundled file knew.
      symbolByName = null;
      return r;
    })
    .catch((e: unknown) => {
      liveWarming = null;
      throw e;
    });
  // A failure here is a background miss, not a user-facing error.
  liveWarming.catch(() => undefined);
}

export interface NameResolution {
  query: string;
  matches: {
    symbol: string;
    name: string | null;
    badged: boolean | null;
    score: number;
    reason: string;
    layer: "registry" | "snapshot" | "live";
  }[];
  searched: string[];
  notSearched: string[];
  /** True when the bundled snapshot covers the whole catalogue; null when there is no snapshot. */
  snapshotComplete: boolean | null;
  /** True only when some layer searched was complete - otherwise a miss here proves nothing. */
  directoryComplete: boolean;
  /** Set whenever a layer searched was short of the full catalogue, saying why. */
  directoryNote?: string;
  /** Matches whose names are near-identical to each other - the shape an impersonation takes. */
  lookalikes?: Lookalike[];
  /** Present with `lookalikes`: the sentence to repeat to a person before they act on any of them. */
  warning?: string;
  /** What to tell the person when nothing matched. */
  hint?: string;
}

// ------------------------------------------------------- close spellings

/**
 * Shortest run of single-character edits (insert, delete, substitute, or a
 * transposition of two neighbours) that turns `a` into `b`, giving up as soon
 * as every alternative is past `max`.
 *
 * Damerau rather than plain Levenshtein because the misspellings people
 * actually type are transpositions: "clanyosaurz" is one swap from the real
 * collection and two substitutions under Levenshtein. Bounded on purpose - the
 * only useful answer here is "within 2 edits or not", and the bound is what
 * keeps a directory of 30,000 entries cheap to scan.
 */
function boundedDamerau(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Two rolling rows plus the one before them; the row two back is what makes
  // a transposition a single edit rather than two.
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (prev2[j - 2] ?? 0) + cost);
      row[j] = v;
      if (v < best) best = v;
    }
    // Every path through this row is already past the bound, and rows only
    // grow: no continuation can come back under it.
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

const normaliseName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokensOf = (s: string) => normaliseName(s).split(" ").filter(Boolean);

/** Queries shorter than this are not corrected: at four characters, two edits reach half the directory. */
const MIN_FUZZY_QUERY = 5;
const MAX_EDITS = 2;
/** Score ceiling for a corrected spelling. Below every layer that matched what was actually typed. */
const fuzzyScore = (distance: number): number => (distance === 1 ? 55 : 45);

export interface CloseSpelling {
  symbol: string;
  name: string | null;
  badged: boolean | null;
  score: number;
  reason: string;
  distance: number;
  layer: "snapshot" | "live";
}

/**
 * "Did you mean" for a query that matched nothing.
 *
 * The failure this closes: "claynosaurs" is one letter off a collection that
 * IS in the bundled directory, and the answer was `kind: "unknown"` with an
 * empty result list - a typo presented as an absence. Only runs after the
 * exact and substring layers have missed, only on queries long enough for two
 * edits to still mean something, and every hit is labelled and scored below
 * anything that matched what the person actually typed, so a correction can
 * never be mistaken for a match.
 */
export function closeSpellings(
  index: { symbol: string; name: string; isBadged?: boolean; layer?: "snapshot" | "live" }[],
  query: string,
  limit = 5,
): CloseSpelling[] {
  const q = normaliseName(query);
  if (q.length < MIN_FUZZY_QUERY) return [];
  const qTokens = tokensOf(q);
  const ranked: { whole: boolean; nameLength: number; hit: CloseSpelling }[] = [];
  for (const c of index) {
    if (!c || typeof c.symbol !== "string" || !c.symbol) continue;
    const nSymbol = normaliseName(c.symbol);
    const nName = normaliseName(c.name ?? "");
    // Whole-string first: "claynosaurs" against "claynosaurz".
    let distance = Math.min(
      boundedDamerau(q, nSymbol, MAX_EDITS),
      nName ? boundedDamerau(q, nName, MAX_EDITS) : MAX_EDITS + 1,
    );
    // Whether the WHOLE identifier was a near miss, or only a word inside it.
    // "claynosaurs" is one edit from the symbol `claynosaurz` and also one edit
    // from a word inside "Claynosaurz: The Call of Saga"; the first is what the
    // person meant, so the two cannot be ranked as equals.
    let whole = distance <= MAX_EDITS;
    if (distance > MAX_EDITS) {
      // Token by token: "mad ladz" against the tokens of "mad_lads". Every
      // query token has to find a partner, or this is a different collection
      // rather than a misspelling of this one.
      const candidateTokens = [...new Set([...tokensOf(nSymbol), ...tokensOf(nName)])];
      if (candidateTokens.length === 0) continue;
      let total = 0;
      let matchedAll = true;
      for (const t of qTokens) {
        let best = MAX_EDITS + 1;
        for (const ct of candidateTokens) {
          const d = boundedDamerau(t, ct, MAX_EDITS);
          if (d < best) best = d;
          if (best === 0) break;
        }
        if (best > MAX_EDITS) {
          matchedAll = false;
          break;
        }
        total += best;
      }
      // Total 0 means every token matched exactly, which is not a spelling
      // correction - the layers above own that case.
      if (!matchedAll || total === 0 || total > MAX_EDITS) continue;
      distance = total;
      whole = false;
    }
    if (distance < 1 || distance > MAX_EDITS) continue;
    ranked.push({ whole, nameLength: nName.length || nSymbol.length, hit: {
      symbol: c.symbol,
      name: c.name || null,
      badged: typeof c.isBadged === "boolean" ? c.isBadged : null,
      score: fuzzyScore(distance),
      reason: "close spelling",
      distance,
      layer: c.layer ?? "snapshot",
    } });
  }
  return ranked
    .sort(
      (a, b) =>
        a.hit.distance - b.hit.distance ||
        Number(b.whole) - Number(a.whole) ||
        a.nameLength - b.nameLength ||
        a.hit.symbol.length - b.hit.symbol.length,
    )
    .slice(0, limit)
    .map((r) => r.hit);
}

// ------------------------------------------------------------- lookalikes

export interface Lookalike {
  symbol: string;
  name: string | null;
  badged: boolean | null;
}

export const LOOKALIKE_WARNING =
  "Several collections carry nearly the same name; fakes imitate popular names. Prefer the badged one or confirm the collection address from the project's official channel.";

/**
 * Words a copy adds to a borrowed name. Stripped before comparison because
 * "Mad Lads Official" is not a different collection from "Mad Lads" to a
 * reader - it is the shape an impersonation takes, and it is exactly the pair
 * that must trip this warning.
 */
const DECORATION = new Set(["official", "originals", "original", "verified", "nft", "nfts", "collection", "collections", "the"]);

/**
 * Case, spacing, punctuation, trailing digits and decoration removed, so two
 * entries that a person would read as the same name compare equal.
 */
function lookalikeKey(s: string): string {
  const tokens = tokensOf(s)
    .map((t) => t.replace(/\d+$/, ""))
    .filter((t) => t && !DECORATION.has(t));
  return tokens.join(" ");
}

/**
 * Which of these entries imitate each other's names.
 *
 * The failure this closes: a search for a popular collection returns the real
 * one and a copy with a near-identical name, ranked by score alone, and the
 * copy's mint address goes into an answer as if the two were the same thing.
 * Either a shared normalised name or a single edit between two of them is
 * enough - both are what a person's eye skips over.
 */
export function findLookalikes(entries: { symbol: string; name: string | null; badged: boolean | null }[]): Lookalike[] {
  const keyed = entries
    .map((e) => ({ entry: e, key: lookalikeKey(e.name ?? e.symbol) }))
    .filter((k) => k.key.length > 0);
  const flagged = new Set<number>();
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i]!;
      const b = keyed[j]!;
      if (a.entry.symbol === b.entry.symbol) continue;
      if (a.key === b.key || boundedDamerau(a.key, b.key, 1) === 1) {
        flagged.add(i);
        flagged.add(j);
      }
    }
  }
  return [...flagged]
    .sort((x, y) => x - y)
    .map((i) => {
      const e = keyed[i]!.entry;
      return { symbol: e.symbol, name: e.name, badged: e.badged };
    });
}

// ------------------------------------------------- name -> venue symbol

/**
 * The Magic Eden symbol for a collection this server knows only by name and
 * on-chain address.
 *
 * Why it exists: every Candy Digital collection is in the registry with its
 * Metaplex Core address, which answers supply, provenance and custody, but
 * with no marketplace symbol, which is what floors, sales and listings need.
 * Asked for market data, a model had to invent one - it guessed
 * `absolute_batman_2024_1_candy_digital` for a collection Magic Eden lists as
 * `absolute_batman_2024`, got nothing back, and reported the collection as
 * untraded. The directory already holds the answer.
 *
 * Deliberately strict. The name has to match a directory entry exactly once
 * the punctuation is stripped, and exactly one distinct symbol has to come
 * back. A near match is not used at all, because the cost of being wrong here
 * is a confident floor printed under the wrong collection's name.
 */
/**
 * One spelling for a collection name, whichever source wrote it.
 *
 * The same collection is "Absolute Batman (2024-) #1" on chain, "Absolute
 * Batman (2024) #1" when a person types it, and "Absolute Batman (2024-) #1 -
 * Candy Digital" in the venue directory. Punctuation and the issuer's name
 * carry no information here, so both come off before anything is compared.
 */
export const collectionNameKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^\s*candy digital\s*[-:]\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s*candy digital\s*$/, "")
    .trim();

const nameKey = collectionNameKey;
const withoutIssuer = collectionNameKey;

function symbolIndex(): Map<string, string[]> {
  if (symbolByName) return symbolByName;
  const map = new Map<string, string[]>();
  const add = (name: string, symbol: string) => {
    for (const k of new Set([nameKey(name), withoutIssuer(name)])) {
      if (!k) continue;
      const rows = map.get(k);
      if (rows) rows.push(symbol);
      else map.set(k, [symbol]);
    }
  };
  for (const row of loadSnapshot()?.collections ?? []) add(row.n, row.s);
  // The live layer only contributes once a background walk has landed; it is
  // never waited for here.
  for (const row of liveReady?.collections ?? []) add(row.name, row.symbol);
  symbolByName = map;
  return map;
}

export interface SymbolFromDirectory {
  symbol: string;
  /** Plain words for an answer: where this identifier came from and how far it can be trusted. */
  note: string;
}

export function symbolForCollectionName(name: string): SymbolFromDirectory | null {
  const hits = symbolIndex().get(nameKey(name));
  if (!hits) return null;
  const distinct = [...new Set(hits)];
  if (distinct.length !== 1) return null;
  const snap = loadSnapshot();
  return {
    symbol: distinct[0]!,
    note:
      `Magic Eden symbol matched by exact name in the bundled directory snapshot` +
      (snap?.takenAt ? ` taken ${snap.takenAt}` : "") +
      `, not hand-verified. If the market figures look like a different collection, pass the symbol yourself.`,
  };
}


const toMatches = (hits: NameMatch[], layer: "snapshot" | "live") =>
  hits.map((h) => ({ symbol: h.symbol, name: h.name || null, badged: h.isBadged, score: h.score, reason: h.why, layer }));

/**
 * Resolve a name. Never blocks on the 40-second live walk: the first miss
 * starts it and says so; later calls use it once it has landed.
 */
export function resolveName(query: string, limit = 8): NameResolution {
  const q = clean(query).trim();
  const searched: string[] = [];
  const notSearched: string[] = [];
  const out: NameResolution["matches"] = [];

  for (const e of searchRegistry(q).slice(0, limit)) {
    if (e.meSymbol) out.push({ symbol: e.meSymbol, name: e.name, badged: null, score: 100, reason: "curated registry entry", layer: "registry" });
  }
  searched.push("curated registry");

  // The same entries the layers above scored, kept for the spelling fallback
  // with the layer they came from so a correction cites its own source.
  let fuzzyIndex: { symbol: string; name: string; isBadged?: boolean; layer?: "snapshot" | "live" }[] = [];
  const snap = loadSnapshot();
  // A snapshot taken at the venue's paging ceiling is not the catalogue, even
  // when the file says complete: both flags have to agree.
  const snapshotComplete = snap ? layerComplete(snap.complete !== true, snap.atVenuePagingLimit === true) : null;
  if (snap) {
    // The bundled snapshot is a captured venue payload, so it gets the same
    // boundary treatment as a live directory read: a "symbol" that does not
    // obey the symbol grammar is not an identifier and is dropped, and a name
    // is neutralised and capped before it can be indexed, scored or returned.
    const index = snap.collections
      .filter((c) => c && isCollectionSymbol(c.s))
      .map((c) => ({ symbol: c.s, name: clean(c.n ?? "").slice(0, 120), isBadged: c.b === 1 }));
    out.push(...toMatches(findByName(index, q).slice(0, limit), "snapshot"));
    fuzzyIndex = index.map((c) => ({ ...c, layer: "snapshot" as const }));
    searched.push(
      `Magic Eden directory snapshot (${snap.count.toLocaleString("en-US")} collections, taken ${snap.takenAt.slice(0, 10)}${snapshotComplete ? "" : ", short of the full catalogue"})`,
    );
  } else {
    notSearched.push("bundled directory snapshot (file missing from this install)");
  }

  const expired = liveExpired();
  let liveCompleteLayer: boolean | null = null;
  if (liveReady) {
    liveCompleteLayer = layerComplete(liveReady.partial, liveReady.atVenuePagingLimit);
    out.push(...toMatches(findByName(liveReady.collections, q).slice(0, limit), "live"));
    fuzzyIndex = fuzzyIndex.concat(liveReady.collections.map((c) => ({ symbol: c.symbol, name: c.name ?? "", isBadged: c.isBadged, layer: "live" as const })));
    searched.push(
      `Magic Eden live directory (${liveReady.collections.length.toLocaleString("en-US")} collections, read ${liveReady.cachedAt.slice(0, 16)}Z` +
        (liveCompleteLayer ? "" : ", short of the full catalogue") +
        (expired ? ", over a day old and being re-read in the background - ask again for anything listed since" : "") +
        ")",
    );
    // Serve the old layer, labelled, and start one refresh behind it.
    if (expired) warmLive();
  } else {
    warmLive();
    notSearched.push("Magic Eden live directory: refresh started in the background (about a minute); ask again for anything newer than the snapshot");
  }

  const directoryComplete = snapshotComplete === true || liveCompleteLayer === true;
  const directoryNote = directoryComplete
    ? undefined
    : "Magic Eden refuses to page past offset 30,000, so the directory layers stop short of its full catalogue. A collection beyond that ceiling can be absent here while being perfectly real on the venue - absence in this list is not evidence.";

  // Merge on symbol, best score and the most authoritative layer wins.
  const rank = { registry: 3, live: 2, snapshot: 1 } as const;
  const bySymbol = new Map<string, NameResolution["matches"][number]>();
  for (const m of out) {
    const prev = bySymbol.get(m.symbol);
    if (!prev || m.score > prev.score || (m.score === prev.score && rank[m.layer] > rank[prev.layer])) bySymbol.set(m.symbol, m);
  }
  const matches = [...bySymbol.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  // Only after every layer above has missed: a typo is not an absence.
  const didYouMean = matches.length === 0 ? closeSpellings(fuzzyIndex, q) : [];
  for (const s of didYouMean) {
    matches.push({ symbol: s.symbol, name: s.name, badged: s.badged, score: s.score, reason: s.reason, layer: s.layer });
  }

  // Computed over what the caller will actually see, after merging: a warning
  // about entries that were dropped from the list would name nothing.
  const lookalikes = findLookalikes(matches.map((m) => ({ symbol: m.symbol, name: m.name, badged: m.badged })));

  return {
    query: q,
    matches,
    ...(lookalikes.length ? { lookalikes, warning: LOOKALIKE_WARNING } : {}),
    searched,
    notSearched,
    snapshotComplete,
    directoryComplete,
    directoryNote,
    hint: didYouMean.length
      ? `Nothing in the layers searched is spelled "${q}". The ${didYouMean.length} entr${didYouMean.length === 1 ? "y" : "ies"} returned are the closest SPELLINGS (reason "close spelling", within ${MAX_EDITS} edits) - suggestions to confirm, not a match for what was typed. Check the name before calling another tool with the symbol.`
      : matches.length === 0
        ? "No collection by that name in the layers searched. It may be new, listed only on another venue, or spelled differently; a mint address from one of its items lets identify() find it from the chain instead." +
          (directoryComplete ? "" : " The layers searched are also short of Magic Eden's full catalogue - see directoryNote.")
        : undefined,
  };
}
