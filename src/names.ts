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
  /** What to tell the person when nothing matched. */
  hint?: string;
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

  const snap = loadSnapshot();
  // A snapshot taken at the venue's paging ceiling is not the catalogue, even
  // when the file says complete: both flags have to agree.
  const snapshotComplete = snap ? layerComplete(snap.complete !== true, snap.atVenuePagingLimit === true) : null;
  if (snap) {
    const index = snap.collections.map((c) => ({ symbol: c.s, name: c.n, isBadged: c.b === 1 }));
    out.push(...toMatches(findByName(index, q).slice(0, limit), "snapshot"));
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

  return {
    query: q,
    matches,
    searched,
    notSearched,
    snapshotComplete,
    directoryComplete,
    directoryNote,
    hint:
      matches.length === 0
        ? "No collection by that name in the layers searched. It may be new, listed only on another venue, or spelled differently; a mint address from one of its items lets identify() find it from the chain instead." +
          (directoryComplete ? "" : " The layers searched are also short of Magic Eden's full catalogue - see directoryNote.")
        : undefined,
  };
}
