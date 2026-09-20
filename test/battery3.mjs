/**
 * The third battery: what the first two still do not touch.
 *
 * Battery one is Candy and fixtures. Battery two is messy input, the rest of
 * Solana, OpenSea and hostility. Neither covers these, and each one is a real
 * way somebody uses this or a real way it could be wrong:
 *
 *   1. VISUALS. "Chart the last month" is one of the most common asks, and a
 *      series with a silent hole in it draws a lie. A chart is also where a
 *      unit error becomes visible and enormous.
 *   2. UNITS. Magic Eden prices in lamports, OpenSea in whatever the listing
 *      used. A raw lamport number that escapes into an answer is off by a
 *      billion, and it looks like a plausible large number rather than an error.
 *   3. HOSTILE UNICODE. Not hypothetical: a collection named "ꙅɿɒɘd ɘidmoƹ" -
 *      "Zombie bears" written in mirrored Cyrillic lookalikes - came back in a
 *      real search for "okay bears" during testing.
 *   4. OTHER STANDARDS. Compressed NFTs live only in the asset index and have
 *      no Core account at all.
 *   5. SCALE. A wallet with thousands of items, and a collection with tens of
 *      thousands.
 *   6. BUILDERS. A recipe is only worth having if the calls it names actually
 *      run and produce the field the recipe says they will.
 *
 * Rate-limited reads are SKIP, never failures. Run: node test/battery3.mjs [area]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], stderr: "ignore" });
const client = new Client({ name: "battery3", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const checks = [];
const check = (id, area, what, fn) => checks.push({ id, area, what, fn });
const BUSY = /rate limit|429|too many|busy|timed out|abort/i;
const SKIP = Symbol("skip");

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 });
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _isError: r.isError === true };
  }
}
const asText = (v) => JSON.stringify(v ?? "").toLowerCase();

const WALLET = "9yzmxQHCz24LDhu9rkjNQhKfKZWbe79B1NJzTy9ExqyP";
const BIG_COLLECTION = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"; // 27,876 minted

// ================================================== V. charts and visuals
check("V1", "visuals", "a sales window returns a per-day series a chart can use", async () => {
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 14, maxPages: 4 });
  if (BUSY.test(asText(r))) return SKIP;
  if (!Array.isArray(r.daily)) return "no daily series at all, so 'chart the last month' cannot be answered";
  if (r.daily.length === 0) return SKIP;
  for (const d of r.daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date ?? "")) return `a row with no usable date: ${JSON.stringify(d).slice(0, 80)}`;
    if (typeof d.sales !== "number" || d.sales < 0) return `a day with an impossible sale count: ${JSON.stringify(d).slice(0, 80)}`;
    if (typeof d.volumeSol !== "number" || !Number.isFinite(d.volumeSol) || d.volumeSol < 0) return `a day with an impossible volume: ${JSON.stringify(d).slice(0, 80)}`;
  }
  return true;
});
check("V2", "visuals", "the per-day series is in date order, so a chart is not drawn backwards", async () => {
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 14, maxPages: 4 });
  if (BUSY.test(asText(r)) || !Array.isArray(r.daily) || r.daily.length < 2) return SKIP;
  const dates = r.daily.map((d) => d.date);
  const sorted = [...dates].sort();
  return JSON.stringify(dates) === JSON.stringify(sorted) || `days are out of order: ${dates.slice(0, 4).join(", ")}`;
});
check("V3", "visuals", "a day with no sales is absent rather than invented as zero", async () => {
  // Either shape is drawable, but the answer has to say which it is, or a
  // reader fills the gaps with zeros and draws a crash that never happened.
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 14, maxPages: 4 });
  if (BUSY.test(asText(r)) || !Array.isArray(r.daily) || r.daily.length < 2) return SKIP;
  const days = new Set(r.daily.map((d) => d.date));
  const first = new Date(r.daily[0].date);
  const last = new Date(r.daily[r.daily.length - 1].date);
  const span = Math.round((last - first) / 86_400_000) + 1;
  if (span === days.size) return true;
  // Gaps exist. The answer must not claim to be a continuous series.
  return /every day|continuous|gap|no sales/i.test(asText(r))
    ? true
    : `the series skips ${span - days.size} day(s) with nothing saying so, and a reader will fill them with zeros`;
});
check("V4", "visuals", "the day totals add up to the window total", async () => {
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 14, maxPages: 4 });
  if (BUSY.test(asText(r)) || !Array.isArray(r.daily) || r.daily.length === 0) return SKIP;
  const summed = r.daily.reduce((n, d) => n + d.sales, 0);
  return summed === r.sales || `the per-day rows total ${summed} sales but the window says ${r.sales}`;
});
check("V5", "visuals", "a holdings breakdown carries shares that do not exceed the whole", async () => {
  const r = await call("get_wallet_profile", { wallet: WALLET });
  if (BUSY.test(asText(r))) return SKIP;
  const rows = r.holdings?.byCollection ?? [];
  if (rows.length === 0) return SKIP;
  // The field is shareOfWalletPct. Naming it wrong made this check skip
  // silently, which is worse than failing: a check that never runs is a check
  // nobody notices has stopped testing anything.
  const pct = rows.map((c) => c.shareOfWalletPct).filter((n) => typeof n === "number");
  if (pct.length !== rows.length) return `${rows.length - pct.length} of ${rows.length} collection rows carry no share`;
  const total = pct.reduce((a, b) => a + b, 0);
  if (total > 100.5) return `collection shares total ${total.toFixed(1)} per cent`;
  // A pie chart drawn from a truncated list has to say it is truncated.
  const shown = rows.length;
  const all = r.holdings?.collections ?? shown;
  return shown === all || r.holdings?.moreCollections !== undefined
    ? true
    : `${shown} of ${all} collections returned with nothing saying the rest were left out`;
});
check("V6", "visuals", "a table of floors never mixes currencies in one column", async () => {
  const r = await call("get_floor_prices", { symbols: ["mad_lads", "claynosaurz", "degods"] });
  if (BUSY.test(asText(r))) return SKIP;
  const rows = r.floors ?? r.results ?? [];
  if (rows.length === 0) return SKIP;
  const priced = rows.filter((x) => typeof x.floorPriceSol === "number" || typeof x.floor === "number");
  return priced.every((x) => !x.currency || /sol/i.test(x.currency)) || "a floor row in another currency sits in a SOL column";
});

// ============================================================== W. units
check("W1", "units", "no floor is reported in lamports", async () => {
  // Magic Eden answers 4087000000 for a 4.087 SOL floor. A lamport figure that
  // escapes looks like a plausible large number, not like an error.
  const out = [];
  for (const sym of ["mad_lads", "degods", "claynosaurz"]) {
    const r = await call("get_collection_stats", { collection: sym });
    if (BUSY.test(asText(r))) continue;
    const f = r.market?.floorPriceSol;
    if (typeof f === "number" && f > 100_000) out.push(`${sym} floor ${f}`);
  }
  return out.length === 0 || `a lamport figure reached an answer as SOL: ${out.join(", ")}`;
});
check("W2", "units", "no sale price is reported in lamports", async () => {
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 7, maxPages: 2 });
  if (BUSY.test(asText(r))) return SKIP;
  const suspects = [r.highest?.priceSol, r.lowest?.priceSol, r.medianSol, r.averageSol, r.volumeSol].filter((n) => typeof n === "number" && n > 1_000_000);
  return suspects.length === 0 || `a figure in the lamport range was labelled SOL: ${suspects.join(", ")}`;
});
check("W3", "units", "a listing price is in the same unit as the floor it is compared against", async () => {
  const [stats, book] = await Promise.all([call("get_collection_stats", { collection: "mad_lads" }), call("find_listings", { symbol: "mad_lads", limit: 3 })]);
  if (BUSY.test(asText(stats)) || BUSY.test(asText(book))) return SKIP;
  const floor = stats.market?.floorPriceSol;
  const ask = book.deals?.[0]?.priceSol;
  if (typeof floor !== "number" || typeof ask !== "number") return SKIP;
  const ratio = ask / floor;
  return (ratio > 0.01 && ratio < 100) || `a listing at ${ask} against a floor of ${floor} is a unit mismatch, not a price`;
});
check("W4", "units", "every currency that appears is named", async () => {
  const r = await call("get_collection_stats", { collection: BIG_COLLECTION });
  if (BUSY.test(asText(r))) return SKIP;
  const os = r.opensea;
  if (!os || os.error || typeof os.floor !== "number") return SKIP;
  return typeof os.floorCurrency === "string" && os.floorCurrency.length > 0 ? true : "an OpenSea floor with no currency beside it";
});

// ================================================= X. hostile unicode names
check("X1", "unicode", "a mirrored-Cyrillic imitation is not returned as a plain name", async () => {
  // Real, seen in a live search: "ꙅɿɒɘd ɘidmoƹ" is "Zombie bears" in mirrored
  // lookalike glyphs, sitting in the directory beside the real Okay Bears.
  const r = await call("search_collections", { query: "okay bears" });
  if (BUSY.test(asText(r))) return SKIP;
  const raw = JSON.stringify(r);
  const hasMirrored = /[Ѐ-ӿꙀ-ꚟɐ-ʯ]/.test(raw);
  if (!hasMirrored) return SKIP;
  return /untrusted|lookalike|warning|not a|imitation|different thing/i.test(raw.toLowerCase())
    ? true
    : "a name built from lookalike glyphs came back with nothing marking it";
});
check("X2", "unicode", "a right-to-left override in a collection name cannot reverse an answer", async () => {
  const r = await call("search_collections", { query: "mad‮lads" });
  return !JSON.stringify(r).includes("‮") || "a direction-override character survived into the answer";
});
check("X3", "unicode", "a zero-width character cannot hide a difference between two names", async () => {
  const r = await call("identify", { query: "mad​lads" });
  if (BUSY.test(asText(r))) return SKIP;
  return !JSON.stringify(r).includes("​") || "a zero-width space survived into the answer";
});
check("X4", "unicode", "an emoji in a collection name does not break the answer", async () => {
  const r = await call("search_collections", { query: "🐻 bears" });
  return typeof r === "object" && !r._isError ? true : `an emoji query errored: ${(r._raw ?? "").slice(0, 100)}`;
});
check("X5", "unicode", "a name of combining characters is bounded rather than passed on", async () => {
  const r = await call("search_collections", { query: `a${"́".repeat(400)}` });
  const raw = JSON.stringify(r);
  return raw.length < 60_000 || `a combining-character bomb produced ${raw.length} characters`;
});

// ============================================== Y. other standards and scale
check("Y1", "standards", "compressed holdings are counted explicitly, not left to be inferred", async () => {
  // cNFTs have no Core account and live only in the chain's asset index. This
  // wallet holds none, and "none" is exactly the answer that must be STATED:
  // an omitted count reads as "not checked", and a reader cannot tell a wallet
  // with no compressed items from a reader that cannot see them.
  const profile = await call("get_wallet_profile", { wallet: WALLET });
  if (BUSY.test(asText(profile))) return SKIP;
  const n = profile.holdings?.compressed;
  if (typeof n !== "number") return "the holdings summary carries no compressed count at all";
  if (n === 0) return true;
  // There are some: one of them has to be readable as an asset.
  const holdings = await call("get_wallet_holdings", { wallet: WALLET, limit: 100 });
  if (BUSY.test(asText(holdings))) return SKIP;
  const hit = (holdings.chainIndex?.items ?? []).find((i) => i.compressed === true);
  if (!hit) return true;
  const r = await call("get_asset", { mint: hit.mint });
  if (BUSY.test(asText(r))) return SKIP;
  return !r._isError || `a compressed asset could not be read: ${(r._raw ?? "").slice(0, 120)}`;
});
check("Y2", "standards", "the holdings answer says which standards it found", async () => {
  const r = await call("get_wallet_holdings", { wallet: WALLET, limit: 50 });
  if (BUSY.test(asText(r))) return SKIP;
  const byStandard = r.chainIndex?.byStandard;
  return byStandard && Object.keys(byStandard).length > 0 ? true : "holdings came back with no breakdown by standard";
});
check("Y3", "scale", "a 27,876-item collection answers with supply from the chain", async () => {
  const r = await call("get_collection_stats", { collection: BIG_COLLECTION });
  if (BUSY.test(asText(r))) return SKIP;
  const minted = r.onchain?.numMinted;
  return typeof minted === "number" && minted > 10_000 ? true : `a large collection reported ${minted} minted`;
});
check("Y4", "scale", "a large collection's listed count never exceeds what was minted", async () => {
  const r = await call("get_collection_stats", { collection: BIG_COLLECTION });
  if (BUSY.test(asText(r))) return SKIP;
  const { numMinted: minted } = r.onchain ?? {};
  const listed = r.market?.listedCount;
  if (typeof minted !== "number" || typeof listed !== "number") return SKIP;
  return listed <= minted || `${listed} listed against ${minted} minted`;
});
check("Y5", "scale", "a wallet read that hit a cap says so instead of reporting a total", async () => {
  const r = await call("get_wallet_holdings", { wallet: WALLET, limit: 5 });
  if (BUSY.test(asText(r))) return SKIP;
  const me = r.magicEden;
  if (!me) return SKIP;
  return /capped|limit|more|floor, not a total|countisatotal/i.test(asText(r)) || "a capped read presented itself as the whole wallet";
});
check("Y6", "scale", "asking for one item costs one item, not the book", async () => {
  const r = await call("find_listings", { symbol: "mad_lads", limit: 1 });
  if (BUSY.test(asText(r))) return SKIP;
  return (r.deals?.length ?? 0) <= 1 || `limit 1 returned ${r.deals.length} rows`;
});

// ===================================================== Z. builders, end to end
check("Z1", "builders", "the sales-bot recipe names a tool, and that tool runs", async () => {
  const recipe = await call("get_integration_recipe", { goal: "sales-bot" });
  const { tools } = await client.listTools();
  const named = tools.map((t) => t.name).filter((n) => asText(recipe).includes(n.toLowerCase()));
  if (named.length === 0) return "the recipe names no tool of this server";
  // Run the first tool the recipe names, with the argument it would need.
  const args = { get_collection_sales: { symbol: "mad_lads", days: 1, maxPages: 1 }, get_recent_sales: { collection: "mad_lads", limit: 2 }, identify: { query: "mad lads" }, get_collection_stats: { collection: "mad_lads" }, find_listings: { symbol: "mad_lads", limit: 2 } };
  const runnable = named.find((n) => args[n]);
  if (!runnable) return SKIP;
  const out = await call(runnable, args[runnable]);
  if (BUSY.test(asText(out))) return SKIP;
  return !out._isError || `the recipe's own first call failed: ${runnable}`;
});
check("Z2", "builders", "a polling bot can tell one sale from the same sale seen twice", async () => {
  // The field a deduplicating bot keys on has to exist and be unique.
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 7, maxPages: 2 });
  if (BUSY.test(asText(r))) return SKIP;
  const sig = r.highest?.signature;
  return typeof sig === "string" && sig.length > 40 ? true : "a sale with no transaction signature to deduplicate on";
});
check("Z3", "builders", "a bot is told how far back the feed was actually read", async () => {
  const r = await call("get_collection_sales", { symbol: "mad_lads", days: 7, maxPages: 2 });
  if (BUSY.test(asText(r))) return SKIP;
  const c = r.coverage;
  return c && (c.oldestSeen || c.truncated !== undefined) ? true : "no coverage block, so a bot cannot tell a quiet week from a short read";
});
check("Z4", "builders", "every recipe goal this server advertises can be fetched", async () => {
  const { RECIPE_GOALS } = await import("../dist/recipes.js");
  for (const goal of RECIPE_GOALS) {
    const r = await call("get_integration_recipe", { goal });
    if (r._isError) return `the recipe for "${goal}" could not be fetched`;
  }
  return true;
});
check("Z5", "builders", "a website builder gets an image for an item, or is told there is none", async () => {
  const holdings = await call("get_wallet_holdings", { wallet: WALLET, limit: 20 });
  if (BUSY.test(asText(holdings))) return SKIP;
  const mint = holdings.chainIndex?.items?.[0]?.mint;
  if (!mint) return SKIP;
  const r = await call("get_asset", { mint });
  if (BUSY.test(asText(r))) return SKIP;
  const raw = asText(r);
  return /image|uri|no image|not carried/i.test(raw) || "an asset answer with nothing to render and nothing saying so";
});
check("Z6", "builders", "a number a builder would print carries the time it was read", async () => {
  const r = await call("get_floor_prices", { symbols: ["mad_lads"] });
  if (BUSY.test(asText(r))) return SKIP;
  return /cachedat|readat|at"/i.test(asText(r)) || "a floor with no read time, which a cache would print as current forever";
});

// ---------------------------------------------------------------- run them
const areas = [...new Set(checks.map((c) => c.area))];
const only = process.argv[2];
const selected = only ? checks.filter((c) => c.area === only || c.id === only) : checks;
if (only && selected.length === 0) {
  console.error(`no area "${only}". Areas: ${areas.join(", ")}`);
  process.exit(2);
}

const results = [];
const started = Date.now();
for (const c of selected) {
  let verdict;
  try {
    verdict = await c.fn();
  } catch (e) {
    verdict = BUSY.test(String(e?.message)) ? SKIP : `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  const skipped = verdict === SKIP;
  const passed = verdict === true;
  results.push({ id: c.id, area: c.area, what: c.what, passed, skipped, reason: passed || skipped ? null : String(verdict) });
  console.log(`${skipped ? "skip  " : passed ? "  ok  " : "FAIL  "}${c.id} ${c.what}${passed || skipped ? "" : `\n        ${String(verdict).slice(0, 260)}`}`);
}

const failed = results.filter((r) => !r.passed && !r.skipped);
const skipped = results.filter((r) => r.skipped);
console.log(`\nbattery3: ${results.length - failed.length - skipped.length}/${results.length} passed, ${skipped.length} skipped, ${failed.length} failed, in ${Math.round((Date.now() - started) / 1000)}s`);
for (const a of areas) {
  const rows = results.filter((r) => r.area === a);
  if (rows.length === 0) continue;
  console.log(`  ${a}: ${rows.filter((r) => r.passed).length}/${rows.length}${rows.some((r) => r.skipped) ? ` (${rows.filter((r) => r.skipped).length} skipped)` : ""}`);
}
writeFileSync(join(root, "battery3-report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
await client.close();
process.exit(failed.length > 0 ? 1 : 0);
