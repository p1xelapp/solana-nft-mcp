import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { reads, statsCalls } from "./helpers/market-reads-preload.mjs";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const load = name => import(pathToFileURL(path.join(root, "dist", name + ".js")));
const { decodeSale } = await load("lib/chain-sales");
const me = await load("sources/magiceden");
const { REGISTRY } = await load("registry");
const tx = reads.find(r => r.method === "getTransaction").reply.result;
const item = "HAgVUKJodK3RJSc3bwZ2JosbNRLwUuVEMfySzvCebBx2";
const gold = "gold_series_auction_1_candy_digital";
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { failed++; console.error("FAIL", name, e.message); }
}
await check("a recorded sale has its order price and buyer total", () => {
  const sale = decodeSale(tx, item);
  assert.equal(sale.orderPrice, 0.01);
  assert.equal(sale.buyerPaid, 0.0112);
});
for (const field of ["err", "innerInstructions", "fee", "preTokenBalances", "postTokenBalances"]) {
  await check("a receipt needs " + field, () => {
    const incomplete = structuredClone(tx);
    delete incomplete.meta[field];
    assert.equal(decodeSale(incomplete, item).status, "cannot-tell");
  });
}
await check("Tensor pool proceeds go to shared escrow and exclude returned rent", () => {
  const poolFill = prefix => JSON.parse(readFileSync(new URL("./fixtures/chain-sales/" + prefix + ".json", import.meta.url))).reply.result;
  const s = decodeSale(poolFill("2wnJvvCX"), "HBN5KG2g2DyTSR67J5DEw84LqYQ5ghttSBKQmaAmgvPK");
  assert.equal(s.sellerReceived, 0.06515454);
  assert.equal(s.price, 0.069300738);
  assert.equal(s.buyerPaid, s.price);
  assert.equal(s.priceBasis, "venue-transfers");
  assert.match(s.notes.join(" "), /escrow/);
  const extra = decodeSale(poolFill("2vd5bUhp"), "9SBtFodVNyf5vpybCfPY8Lg2TYHpnMv3gtUgzLWPeTb5");
  assert.equal(extra.status, "cannot-tell");
  assert.equal(extra.price, undefined);
});
await check("presence and price share the same live stats read", async () => {
  assert.equal(await me.symbolIsKnown(gold), true);
  const stats = await me.collectionStats(gold);
  assert.equal(stats.floorPriceSol, reads.find(r => r.url.endsWith("/stats")).reply.floorPrice / 1e9);
  assert.equal(statsCalls, 1);
});
await check("another collection's stats cannot establish a price or an identity", async () => {
  await assert.rejects(me.collectionStats("collector_crypt"), /symbol/i);
  await assert.rejects(me.symbolIsKnown("collector_crypt"), /symbol/i);
});
await check("Collector Crypt's description agrees with its payment mints", () => {
  const rows = reads.find(r => r.url.includes("/activities?")).reply;
  assert.ok(rows.some(r => r.priceInfo?.splPrice?.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  assert.ok(rows.some(r => !r.priceInfo?.splPrice && r.price > 0));
  assert.doesNotMatch(REGISTRY.find(r => r.meSymbol === "collector_crypt").notes, /SOL on Magic Eden,/i);
});

async function session(preload, env, run) {
  const home = mkdtempSync(path.join(tmpdir(), "market-reads-"));
  const client = new Client({ name: "market-reads", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", new URL("./helpers/" + preload, import.meta.url).href, path.join(root, "dist/index.js")],
    env: { ...process.env, HOME: home, USERPROFILE: home, SOLANA_NFT_MCP_TEST_HOME: home, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", ...env }, stderr: "pipe" });
  try {
    await client.connect(transport);
    await run(async (name, args) => {
      const out = await client.callTool({ name, arguments: args });
      assert.ok(!out.isError, out.content[0]?.text);
      return out.structuredContent;
    });
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}
await session("market-reads-preload.mjs", {}, async call => {
  const search = collection => call("find_in_group", { collections: [collection], lowestOnly: true, pagesPerCollection: 1 });
  await check("a missing owner account leaves a Core listing's custody open", async () => {
    const symbol = "2022_candy_celebratory_collection";
    const floor = (await call("get_floor_prices", { symbols: [symbol] })).floors[0];
    assert.equal(floor.floorCheck.status, "not-checked");
    assert.equal(floor.floorCheck.staleBelowFloor, 3);
    assert.equal(floor.listingValidityChecked, false);
    const receipt = await call("verify_claim", { claim: "floor", subject: symbol, value: 0.2 });
    assert.equal(receipt.verdict, "unverifiable");
    assert.match(receipt.explanation, /no account/);
    assert.doesNotMatch(receipt.explanation, /this collection is not Metaplex Core/i);
  });
  await check("a moved serial cannot set the group's floor or win its serial search", async () => {
    const r = await search("2023_candy_celebratory_collection");
    assert.equal(r.scanned[0].listingsRead, 3);
    assert.equal(r.matches.length, 0);
    assert.equal(r.scanned[0].floorSol, null);
  });
  await check("a serial still in venue custody stays in the group results", async () => {
    const r = await search("2022_leadoff_icons");
    assert.ok(r.matches.length);
    assert.equal(r.matches[0].chainCheck?.state, "backed");
    assert.ok(r.scanned[0].floorSol > 0);
  });
  await check("a precisely quoted floor must match the custody-backed ask", async () => {
    const subject = "2022_leadoff_icons";
    const ask = reads.find(r => r.url.includes("/" + subject + "/listings?")).reply[0].price;
    const receipt = value => call("verify_claim", { claim: "floor", subject, value });
    assert.equal((await receipt(ask)).verdict, "confirmed");
    assert.equal((await receipt(ask + 0.00000001)).verdict, "contradicted");
  });
});
await session("feeds-and-groups-preload.mjs", {
  OPENSEA_API_KEY: "fixture-only",
  SOLANA_RPC_URL: "https://feeds-rpc.invalid", DAS_RPC_URL: "https://feeds-rpc.invalid",
}, async call => {
  await check("one shared SOL fill cannot establish the currency of another fill", async () => {
    const r = await call("get_recent_sales", { collection: "2022_leadoff_icons", openseaSlug: "candy-mlb", limit: 50 });
    const sales = r.opensea.sales;
    assert.ok(sales.some(x => x.currency === "SOL" && x.sameTransactionAs));
    const other = sales.find(x => x.transaction?.startsWith("4a9XbiuX"));
    assert.ok(other && !other.sameTransactionAs);
    assert.equal(other.currency, null);
    assert.equal(other.price, null);
    assert.equal(other.currencyUnconfirmed, true);
  });
});
await session("feeds-and-groups-preload.mjs", {
  OPENSEA_API_KEY: "fixture-only", FEEDS_TEST_MISSING_TIME: "1",
  SOLANA_RPC_URL: "https://feeds-rpc.invalid", DAS_RPC_URL: "https://feeds-rpc.invalid",
}, async call => {
  await check("a sale without a time leaves the window count open", async () => {
    const r = await call("get_collection_sales", { symbol: "2022_leadoff_icons", days: 45 });
    assert.equal(r.openseaSameWindow.status, "read");
    assert.ok(r.openseaSameWindow.sales > 0);
    assert.equal(r.openseaSameWindow.missingTime, 1);
    assert.equal(r.openseaSameWindow.countIsLowerBound, true);
    assert.ok(r.openseaSameWindow.currencyCorrections.unconfirmed > 0);
  });
});
process.exitCode = failed ? 1 : 0;
