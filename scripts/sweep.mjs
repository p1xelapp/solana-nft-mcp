/**
 * Fleet sweep: ask the same questions of many real collections and report what
 * looks wrong.
 *
 * The suites test behaviour against a handful of fixtures. This one walks the
 * registry itself, because the bugs that matter at this scale are the ones a
 * fixture cannot show: a name that belongs to two collections, a venue symbol
 * that points at somebody else's items, a supply that contradicts a listing
 * count. It found all three the first time it ran.
 *
 *   node scripts/sweep.mjs                 40 collections, spread across the families
 *   node scripts/sweep.mjs --sample 120    a bigger bite
 *   node scripts/sweep.mjs --offset 3      a different slice of the same registry
 *
 * Read-only and paced by the server's own gates, but it is a live sweep: a few
 * hundred requests. It prints an anomaly list and writes sweep-report.json.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const SAMPLE = arg("--sample", 40);
const OFFSET = arg("--offset", 0);

const client = new Client({ name: "sweep", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore" }));
const call = async (name, args, ms = 120_000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: ms });
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) return { ERROR: t };
  try {
    return JSON.parse(t);
  } catch {
    return { UNPARSEABLE: t.slice(0, 200) };
  }
};

const { REGISTRY } = await import("../dist/registry.js");
const step = Math.max(1, Math.floor(REGISTRY.length / SAMPLE));
const sample = REGISTRY.filter((_, i) => (i + OFFSET) % step === 0).slice(0, SAMPLE);

const anomalies = [];
const note = (id, what) => {
  anomalies.push({ id, what });
  console.log(`  ! ${id}: ${what}`);
};

console.log(`sweeping ${sample.length} of ${REGISTRY.length} collections\n`);
const tally = { chain: 0, market: 0, rejectedSymbol: 0, uncheckedSymbol: 0, confirmedSymbol: 0 };
const mints = [];

for (const e of sample) {
  const r = await call("get_collection_stats", { collection: e.id });
  if (r.ERROR) {
    note(e.id, `stats: ${String(r.ERROR).slice(0, 110)}`);
    continue;
  }
  if (r.UNPARSEABLE) {
    note(e.id, `unparseable answer: ${r.UNPARSEABLE}`);
    continue;
  }
  if ((r.onchain?.numMinted ?? 0) > 0) tally.chain++;
  if (typeof r.market?.floorPriceSol === "number") tally.market++;
  const verdict = r.symbolResolvedFromDirectory?.checkedAgainstChain;
  if (verdict === "matches") tally.confirmedSymbol++;
  if (verdict === "unknown") tally.uncheckedSymbol++;
  if (r.marketRejected) {
    tally.rejectedSymbol++;
    note(e.id, `symbol ${r.marketRejected.meSymbol} belongs to ${r.marketRejected.belongsToCollection}`);
  }

  const on = r.onchain;
  if (on) {
    if (on.currentSize > on.numMinted) note(e.id, `current size ${on.currentSize} above minted ${on.numMinted}`);
    if (on.burnedOrClosed < 0) note(e.id, `negative burned count ${on.burnedOrClosed}`);
  }
  const m = r.market;
  if (m) {
    if (typeof m.floorPriceSol === "number" && m.floorPriceSol < 0) note(e.id, `negative floor ${m.floorPriceSol}`);
    if (typeof m.listedCount === "number" && m.listedCount < 0) note(e.id, `negative listed count ${m.listedCount}`);
    if (typeof m.listedCount === "number" && on?.numMinted && m.listedCount > on.numMinted) {
      note(e.id, `${m.listedCount} listed against ${on.numMinted} minted, so the two halves disagree about which collection this is`);
    }
  }
  if (/\b(NaN|Infinity)\b/.test(JSON.stringify(r))) note(e.id, "a non-finite number reached the answer");
  if (!r.openseaNote && !r.opensea) note(e.id, "neither an OpenSea block nor a note about its absence");

  const symbol = r.symbolResolvedFromDirectory?.meSymbol ?? r.market?.symbol ?? e.meSymbol;
  if (symbol && !r.marketRejected && typeof r.market?.floorPriceSol === "number") {
    const l = await call("find_listings", { symbol, limit: 3 });
    if (l.ERROR) note(e.id, `listings: ${String(l.ERROR).slice(0, 110)}`);
    else {
      const rows = l.listings ?? l.deals ?? [];
      const cheapest = rows.map((x) => x.priceSol ?? x.price).filter((n) => typeof n === "number")[0];
      if (typeof cheapest === "number" && cheapest < r.market.floorPriceSol * 0.7) {
        note(e.id, `cheapest listing ${cheapest} well below the reported floor ${r.market.floorPriceSol}`);
      }
      const mint = rows.map((x) => x.tokenMint ?? x.mint).find(Boolean);
      if (mint) mints.push({ id: e.id, mint });
    }
  }
}

console.log(`\n${tally.chain}/${sample.length} answered on-chain supply, ${tally.market}/${sample.length} answered a floor`);
console.log(`symbols matched by name: ${tally.confirmedSymbol} confirmed against the chain, ${tally.rejectedSymbol} rejected, ${tally.uncheckedSymbol} unverifiable`);

console.log(`\nfollowing ${Math.min(mints.length, 12)} items into provenance and custody`);
for (const { id, mint } of mints.slice(0, 12)) {
  const p = await call("get_asset_provenance", { mint });
  if (p.ERROR && !/not a Metaplex Core/i.test(String(p.ERROR))) note(id, `provenance: ${String(p.ERROR).slice(0, 110)}`);
  else if (Array.isArray(p.events)) {
    if (p.events.length === 0 && p.historyComplete === true) note(id, "an empty history was called complete");
    if (p.historyComplete === undefined) note(id, "provenance did not say whether it reached the mint");
  }
  const t = await call("get_asset_trust", { mint });
  if (t.ERROR && !/not a Metaplex Core item/i.test(String(t.ERROR))) note(id, `trust: ${String(t.ERROR).slice(0, 110)}`);
}

console.log(`\nsweep finished: ${anomalies.length} anomalies across ${sample.length} collections`);
writeFileSync("sweep-report.json", JSON.stringify({ at: new Date().toISOString(), sampled: sample.length, tally, anomalies }, null, 2));
await client.close();
process.exit(0);
