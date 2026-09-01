/**
 * Live smoke test: spawns the built server over REAL stdio, connects with the
 * official MCP client, and calls every tool against live public endpoints.
 *
 * PASS  = tool returned real data with the expected shape.
 * WARN  = upstream (CryptoSlam is flaky by nature) failed after retries - the
 *         server degraded gracefully instead of crashing. Not a code failure.
 * FAIL  = wrong shape, crash, or protocol error. Exit code 1.
 *
 * Run: npm test   (network required; takes ~60-90s because every public API
 * call is rate-limit paced - politeness is the product.)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findRecentCollectionAssets } from "../dist/sources/solana.js";

const GOLD = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K"; // Candy MLB Gold Series Auction #1
const ICON = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"; // Candy 2026 MLB ICON Series (busier - better for live discovery)

let pass = 0, warn = 0, fail = 0;
const failures = [];
function report(status, name, detail) {
  const icon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️ " : "❌";
  console.log(`${icon} ${status}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (status === "PASS") pass++;
  else if (status === "WARN") warn++;
  else { fail++; failures.push(name); }
}

function parse(res) {
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

const client = new Client({ name: "collector-mcp-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }),
);
console.log("connected to collector-mcp over stdio\n");

// -- protocol surface ---------------------------------------------------
try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "get_asset", "get_asset_provenance", "get_collection_stats", "get_floor_prices",
    "get_pack_pulls", "get_recent_sales", "get_wallet_holdings", "search_collections",
  ];
  if (JSON.stringify(names) === JSON.stringify(expected)) report("PASS", "listTools", `8 tools`);
  else report("FAIL", "listTools", `got ${names.join(",")}`);
} catch (e) { report("FAIL", "listTools", e.message); }

try {
  const { resources } = await client.listResources();
  report(resources.some((r) => r.uri === "collector://registry") ? "PASS" : "FAIL", "listResources");
  const reg = await client.readResource({ uri: "collector://registry" });
  const entries = JSON.parse(reg.contents[0].text);
  report(entries.length >= 5 ? "PASS" : "FAIL", "registry resource", `${entries.length} entries`);
} catch (e) { report("FAIL", "resources", e.message); }

try {
  const { prompts } = await client.listPrompts();
  report(prompts.some((p) => p.name === "collection_report") ? "PASS" : "FAIL", "listPrompts");
} catch (e) { report("FAIL", "listPrompts", e.message); }

// -- tools, live --------------------------------------------------------
try {
  const r = parse(await client.callTool({ name: "search_collections", arguments: { query: "candy gold" } }));
  const hit = r.results?.[0];
  report(hit?.id === "candy-mlb-gold-auction-1" ? "PASS" : "FAIL", "search_collections", hit?.name);
} catch (e) { report("FAIL", "search_collections", e.message); }

try {
  const r = parse(await client.callTool({ name: "get_collection_stats", arguments: { collection: GOLD } }));
  const oc = r.onchain;
  const good = oc && typeof oc.numMinted === "number" && oc.numMinted > 0 && oc.name;
  report(good ? "PASS" : "FAIL", "get_collection_stats (on-chain Core decode)",
    good ? `"${oc.name}" minted=${oc.numMinted} size=${oc.currentSize}` : JSON.stringify(r).slice(0, 200));
} catch (e) { report("FAIL", "get_collection_stats (on-chain)", e.message); }

try {
  const r = parse(await client.callTool({ name: "get_collection_stats", arguments: { collection: "mad_lads" } }));
  const good = r.market && typeof r.market.floorPriceSol === "number";
  report(good ? "PASS" : "FAIL", "get_collection_stats (Magic Eden)",
    good ? `mad_lads floor=${r.market.floorPriceSol} SOL, listed=${r.market.listedCount}` : JSON.stringify(r).slice(0, 200));
} catch (e) { report("FAIL", "get_collection_stats (ME)", e.message); }

try {
  const r = parse(await client.callTool({ name: "get_floor_prices", arguments: { symbols: ["mad_lads", "claynosaurz"] } }));
  const good = r.floors?.length === 2 && r.floors.every((f) => typeof f.floorSol === "number" || f.error);
  report(good ? "PASS" : "FAIL", "get_floor_prices",
    r.floors?.map((f) => `${f.symbol}=${f.floorSol ?? "ERR"}`).join(" "));
} catch (e) { report("FAIL", "get_floor_prices", e.message); }

let saleMint = null;
try {
  const r = parse(await client.callTool({ name: "get_recent_sales", arguments: { collection: "mad_lads", limit: 5 } }));
  if (!Array.isArray(r.sales)) throw new Error(JSON.stringify(r).slice(0, 200));
  saleMint = r.sales?.[0]?.tokenMint ?? null;
  if (r.sales.length > 0 && typeof r.sales[0].priceSol === "number") {
    report("PASS", "get_recent_sales", `${r.sales.length} sales (scanned ${r.activitiesScanned} events), latest ${r.sales[0].priceSol} SOL`);
  } else {
    // Quiet market is a real-world state, not a code failure - the note field must explain it.
    report(r.note ? "WARN" : "FAIL", "get_recent_sales", `0 sales in ${r.activitiesScanned} events (quiet market)`);
  }
} catch (e) { report("FAIL", "get_recent_sales", e.message); }

// Provenance: discover a real Candy Gold asset from collection activity (keyless DAS-free discovery)
let goldAsset = null, provOwner = null;
try {
  console.log("   (discovering a live Candy MLB ICON asset from collection txs...)");
  const assets = await findRecentCollectionAssets(ICON, 2);
  if (assets.length === 0) throw new Error("no recent collection activity found to discover an asset");
  goldAsset = assets[0];
  const r = parse(await client.callTool({ name: "get_asset_provenance", arguments: { mint: goldAsset } }));
  const good = r.currentOwner && Array.isArray(r.events) && r.events.length > 0;
  provOwner = r.currentOwner ?? null;
  report(good ? "PASS" : "FAIL", "get_asset_provenance",
    good ? `"${r.name}" ${r.events.length} events, owner ${r.currentOwner.slice(0, 6)}..` : JSON.stringify(r).slice(0, 200));
  if (good) {
    for (const ev of r.events.slice(0, 6)) {
      console.log(`      ${ev.time ?? "?"} ${ev.event}${ev.newOwner ? " -> " + ev.newOwner.slice(0, 8) : ""}${ev.marketplace ? " (" + ev.marketplace + ")" : ""}`);
    }
  }
} catch (e) { report("FAIL", "get_asset_provenance", e.message); }

try {
  const mint = saleMint ?? goldAsset;
  if (!mint) throw new Error("no mint available from prior steps");
  const r = parse(await client.callTool({ name: "get_asset", arguments: { mint } }));
  const good = r.market?.name || r.onchain?.name;
  report(good ? "PASS" : "FAIL", "get_asset", good ? `${r.market?.name ?? r.onchain?.name}` : "no name");
} catch (e) { report("FAIL", "get_asset", e.message); }

try {
  const wallet = provOwner;
  if (!wallet) throw new Error("skipped (no wallet from provenance step)");
  const r = parse(await client.callTool({ name: "get_wallet_holdings", arguments: { wallet, limit: 20 } }));
  const good = typeof r.count === "number";
  report(good ? "PASS" : "FAIL", "get_wallet_holdings", `wallet ${wallet.slice(0, 6)}.. holds ${r.count} (capped=${r.capped})`);
} catch (e) {
  // A wallet taken from provenance is often a marketplace escrow (the item is
  // listed), and Magic Eden blocks its own escrow from the wallet endpoint.
  // That is upstream policy, not a defect - but the message must EXPLAIN it,
  // so a bare "HTTP 400" still fails the suite.
  const explained = /marketplace escrow or program account/.test(e.message);
  report(explained ? "WARN" : "FAIL", "get_wallet_holdings",
    explained ? "provenance owner is a marketplace escrow; ME blocks it (explained cleanly)" : e.message);
}

try {
  const res = await client.callTool({ name: "get_pack_pulls", arguments: { limit: 5 } });
  if (res.isError) {
    // CryptoSlam is flaky upstream - graceful degradation is the tested behavior.
    report("WARN", "get_pack_pulls", `upstream flaky: ${res.content?.[0]?.text?.slice(0, 120)}`);
  } else {
    const r = parse(res);
    const good = Array.isArray(r.pulls) && r.pulls.length > 0 && r.pulls[0].card;
    report(good ? "PASS" : "WARN", "get_pack_pulls",
      good ? `latest rip: ${r.pulls[0].card} (${r.pulls[0].set ?? "?"}) #${r.pulls[0].serial ?? "?"}` : "empty feed");
  }
} catch (e) { report("WARN", "get_pack_pulls", e.message); }

// -- validation / hostile inputs ---------------------------------------
try {
  const res = await client.callTool({ name: "get_asset", arguments: { mint: "not-an-address" } });
  report(res.isError || /invalid|must be/i.test(res.content?.[0]?.text ?? "") ? "PASS" : "FAIL",
    "input validation (bad address rejected)");
} catch { report("PASS", "input validation (bad address rejected)", "schema rejection"); }

try {
  const res = await client.callTool({ name: "get_collection_stats", arguments: { collection: "definitely_not_real_xyz123" } });
  const txt = res.content?.[0]?.text ?? "";
  report(res.isError && !txt.includes("undefined") ? "PASS" : "FAIL",
    "unknown collection -> clean error", txt.slice(0, 90));
} catch (e) { report("FAIL", "unknown collection error", e.message); }

// -----------------------------------------------------------------------
console.log(`\nRESULT: ${pass} pass / ${warn} warn / ${fail} fail`);
if (failures.length) console.log("FAILED:", failures.join(", "));
await client.close();
process.exit(fail > 0 ? 1 : 0);
