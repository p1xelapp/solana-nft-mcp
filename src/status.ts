/**
 * Live source status.
 *
 * The problem this solves: when a venue stops answering, an agent tells the
 * user "the tool is broken". It is not - one venue is. This module asks every
 * wired source one cheap question and reports, per source, whether it answered
 * and how fast, next to the catalog row that says what that source is for and
 * what replaces it. The summary line is written to be repeated verbatim to a
 * person.
 *
 * It never throws. A status check that can fail is a status check that reports
 * "unknown" exactly when you need it most.
 */

import { SOURCES, WIRED_SOURCES, type SourceEntry } from "./sources/catalog.js";
import * as me from "./sources/magiceden.js";
import * as os from "./sources/opensea.js";
import * as cs from "./sources/cryptoslam.js";
import * as das from "./sources/das.js";
import { rpcHealth } from "./sources/solana.js";

export interface SourceStatusRow {
  id: string;
  name: string;
  tier: number;
  kind: string;
  /** true = answered, false = did not, null = not checked (no key, or link-only). */
  ok: boolean | null;
  latencyMs: number | null;
  /** Plain words: what happened, or why nothing was tried. */
  note: string;
  catalog: SourceEntry;
}

export interface SourceStatusReport {
  checkedAt: string;
  /** One sentence, safe to repeat to a person. */
  summary: string;
  sources: SourceStatusRow[];
  /** What a reader should do with this. */
  readThis: string[];
}

// Known-good probes. Small, cheap, and boring on purpose: a status check that
// costs a real query is a status check people turn off.
const ME_PROBE_SYMBOL = "mad_lads";
const OS_PROBE_SLUG = "mad-lads";
const CS_PROBE_CONTRACT = "panini-america";

const short = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").trim().slice(0, 180);
};

/** Run one probe, and turn any outcome - including a throw - into a row. */
async function probe(
  entry: SourceEntry,
  run: () => Promise<{ ok: boolean; note: string }>,
): Promise<SourceStatusRow> {
  const started = Date.now();
  try {
    // A status check that waits 45 s on one flaky source (measured, CryptoSlam)
    // blows past MCP clients' default request timeout and reports nothing at
    // all. A source that has not answered in 8 s is reported as slow-or-down.
    const deadline = new Promise<{ ok: boolean; note: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, note: `${entry.name} did not answer within 8 s (slow or down on their side)` }), 8_000).unref(),
    );
    const { ok, note } = await Promise.race([run(), deadline]);
    return { ...base(entry), ok, latencyMs: Date.now() - started, note };
  } catch (e) {
    return {
      ...base(entry),
      ok: false,
      latencyMs: Date.now() - started,
      note: `${entry.name} did not answer: ${short(e)}`,
    };
  }
}

function base(entry: SourceEntry) {
  return { id: entry.id, name: entry.name, tier: entry.tier, kind: entry.kind, catalog: entry };
}

function unchecked(entry: SourceEntry, note: string): SourceStatusRow {
  return { ...base(entry), ok: null, latencyMs: null, note };
}

/**
 * Ping every wired source once and describe what came back.
 *
 * Sequential on purpose: each source has its own rate gate, and a status check
 * that fires every request at once is the burst those gates exist to prevent.
 */
export async function sourceStatus(): Promise<SourceStatusReport> {
  const checkedAt = new Date().toISOString();
  const rows: SourceStatusRow[] = [];

  // --- chain endpoints: one batched getHealth + getSlot each -------------
  let health: Awaited<ReturnType<typeof rpcHealth>> = [];
  try {
    health = await rpcHealth();
  } catch (e) {
    // rpcHealth is written not to throw; if it ever does, say so rather than
    // letting one source take down the whole report.
    health = [];
    rows.push(unchecked(byId("rpc-mainnet-beta"), `The Solana endpoint check itself failed: ${short(e)}`));
  }
  for (const h of health) {
    // rpcHealth labels endpoints "<id> (<host>)"; match the row back to its
    // catalog entry by id prefix, and fall back to the canonical entry for a
    // user's own endpoint, which has no public row of its own.
    const id = h.endpoint.split(" (")[0] ?? "";
    const entry = SOURCES.find((s) => s.id === id) ?? byId("rpc-custom");
    rows.push({
      ...base(entry),
      ok: h.ok,
      latencyMs: h.latencyMs,
      note: h.ok ? `answered in ${h.latencyMs}ms, ${h.note}` : `${h.endpoint} did not answer: ${h.note}`,
    });
  }

  // --- Magic Eden -------------------------------------------------------
  rows.push(
    await probe(byId("magiceden-v2"), async () => {
      // `fresh` on purpose: a cached floor would report the venue healthy
      // while it is down, which is the exact lie this tool exists to prevent.
      const stats = await me.collectionStats(ME_PROBE_SYMBOL, { fresh: true });
      return {
        ok: true,
        note: `answered with ${ME_PROBE_SYMBOL} floor ${stats.floorPriceSol ?? "none listed"} SOL`,
      };
    }),
  );

  // --- asset index on the public RPC (undocumented, so probed every time) --
  rows.push(
    await probe(byId("das-public"), async () => {
      // `fresh` on purpose: the ten-minute capability memo would report the
      // index healthy minutes after the methods were withdrawn, which is the
      // exact lie this tool exists to prevent.
      const cap = await das.capability({ fresh: true });
      // "Withdrawn" and "busy" are different sentences: one means the tools
      // that lean on this index are gone until further notice, the other means
      // ask again in a minute. Reporting a bad minute as a withdrawal is the
      // false alarm this wording exists to prevent.
      return {
        ok: cap.available,
        note: cap.available
          ? `getAsset answered via ${cap.endpoint}; ${cap.note}`
          : cap.state === "withdrawn"
            ? `not serving DAS methods: ${cap.note}`
            : `temporarily unreachable: ${cap.note}`,
      };
    }),
  );

  // --- OpenSea (optional) ----------------------------------------------
  const openSea = byId("opensea-v2");
  if (!os.openSeaEnabled()) {
    rows.push(
      unchecked(
        openSea,
        "off - no OPENSEA_API_KEY set. Every tool still answers; the OpenSea half of cross-venue questions is absent and named, not silently dropped.",
      ),
    );
  } else {
    rows.push(
      await probe(openSea, async () => {
        const stats = await os.collectionStats(OS_PROBE_SLUG, { fresh: true });
        if (stats.stale) {
          return { ok: false, note: `did not answer just now; showing the last value seen at ${stats.cachedAt}` };
        }
        return { ok: true, note: `answered with ${OS_PROBE_SLUG} floor ${stats.floor ?? "none"} ${stats.floorCurrency ?? ""}`.trim() };
      }),
    );
  }

  // --- CryptoSlam -------------------------------------------------------
  rows.push(
    await probe(byId("cryptoslam"), async () => {
      const feed = await cs.recentMints(CS_PROBE_CONTRACT, 1, { fresh: true });
      if (feed.stale) {
        return { ok: false, note: `did not answer just now; showing the last feed seen at ${feed.cachedAt}` };
      }
      return { ok: true, note: `answered with ${feed.pulls.length} recent pull(s) from ${CS_PROBE_CONTRACT}` };
    }),
  );

  // --- described but not called -----------------------------------------
  for (const entry of SOURCES) {
    if (rows.some((r) => r.id === entry.id)) continue;
    if (entry.id === "rpc-custom") continue; // already represented above when set
    rows.push(
      unchecked(
        entry,
        entry.kind === "explorer-links"
          ? "not read by this server - we only build a URL you can open to check an answer by hand"
          : entry.kind === "standard-docs"
            ? "a specification, not a feed - nothing to ping"
            : `not wired yet${entry.keyEnvVar ? ` (would need ${entry.keyEnvVar})` : ""}; listed so a missing number from it is a known gap`,
      ),
    );
  }

  rows.sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
  return { checkedAt, summary: summarize(rows), sources: rows, readThis: READ_THIS };
}

const READ_THIS = [
  "A source marked not answering means that venue is down or rate-limiting right now. The other sources still answer, and every tool says which venue is missing from its result.",
  "Tier 1 is an account read straight from the chain and settles ownership. Tier 2 is somebody else's database - a marketplace's view of the market, or an index's view of the chain, either of which can lag it. Tier 4 is a link for a person, never read by this server.",
  "This check reads live endpoints, so running it repeatedly spends the same rate limit the tools use.",
];

function byId(id: string): SourceEntry {
  const entry = SOURCES.find((s) => s.id === id);
  // A wired probe with no catalog row would be a source nobody described.
  if (!entry) throw new Error(`source catalog has no entry "${id}"`);
  return entry;
}

/**
 * The one line a person reads. Counts only sources that were actually asked -
 * "3 of 4" must never quietly include four reference links.
 */
function summarize(rows: SourceStatusRow[]): string {
  const checked = rows.filter((r) => r.ok !== null);
  const answering = checked.filter((r) => r.ok);
  const down = checked.filter((r) => !r.ok);
  const parts = [`${answering.length} of ${checked.length} sources answering`];
  if (down.length > 0) parts.push(`${down.map((r) => r.name).join(", ")} not answering`);
  if (!os.openSeaEnabled()) parts.push("OpenSea off (no key)");
  const planned = rows.filter((r) => r.ok === null && r.catalog.keyRequired && !r.catalog.wired).length;
  const links = rows.filter((r) => r.catalog.kind === "explorer-links").length;
  if (planned > 0 || links > 0) parts.push(`${planned} planned source(s) and ${links} reference link(s) not checked`);
  return `${parts.join("; ")}.`;
}

/** Wired source ids, so a caller can say what "all sources" currently means. */
export const WIRED_SOURCE_IDS: readonly string[] = WIRED_SOURCES.map((s) => s.id);
