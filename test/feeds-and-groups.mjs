/**
 * Feeds, money and groups: a currency, a count or a "verified" label only on
 * what was read.
 *
 * Built on replies read on 2026-11-14 and 2026-11-15 (test/fixtures):
 *   Collector Crypt   OpenSea names SOL (address 111...1, 9 decimals) over the
 *                     USDC amount on Magic Eden's USDC fills: 4WrryVKu... is
 *                     52000000 "SOL" units on OpenSea and 50 USDC on Magic Eden
 *   candy-mlb         OpenSea's record names 2022 Leadoff ICONs; its 50 newest
 *                     sales are items of three collections (each item's own
 *                     account, getMultipleAccounts)
 *   Claynosaurz       Magic Eden relays Tensor fills as tensortrade; on chain
 *                     3d4tADbu... the pool paid 5.126 where Magic Eden says 5.76
 *   Gold Series       Magic Eden symbol gold_series_auction_1_candy_digital,
 *                     whose sold items name collection 8BvHMs...
 *   Tensorian         a compressed item Magic Eden lists under one owner while
 *                     the asset index names a wallet
 * A case that changes a captured row says so; nothing else is invented.
 *
 * Usage: node test/feeds-and-groups.mjs [root]  (root defaults to this
 * checkout; pass an older build's folder to see which checks it fails).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.argv[2] ?? project);
const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-feeds-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS = "1";
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = "1";
process.env.OPENSEA_API_KEY = "fixture-not-a-credential";
process.env.SOLANA_RPC_URL = "https://feeds-rpc.invalid";
process.env.DAS_RPC_URL = "https://feeds-rpc.invalid";
delete process.env.SOLANA_NFT_MCP_OFFLINE;

const load = (name) => import(pathToFileURL(path.join(root, "dist", `${name}.js`)).href);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(project, "test", "fixtures", name), "utf8"));
const me = await load("sources/magiceden");
const os = await load("sources/opensea");
const sol = await load("sources/solana");
const market = await load("market");
const wallet = await load("wallet");
const reconcile = await load("lib/reconcile");

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const LEADOFF = "46kCejJ7euGEmLAFqvV1j5yUzEumtwEvS9d65f6PbZ7g";
const AMBASSADORS = "4W6T2gJnbD9D3XDWpk52kbZe6w2tUfFkaxsNyzW8MQmY";
const GOLD = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";
const TORRES_MINT = "GckVrtAxCMVcdXL7hnV9Bx4ckeTtqPTsBuECCLqNuSjr";
const USDC_BUYER = "BUXL8YJggityxZsvGsSkjgVMNEQhjq9ok6o9gudYdjgv";

const osCc = fixture("os-collector-crypt-sales-2026-11-15.json");
const meCc = fixture("me-collector-crypt-sales-2026-11-15.json");
const osMlb = fixture("os-candy-mlb-sales-50-2026-11-15.json");
const mlbAccounts = fixture("candy-mlb-item-accounts-2026-11-15.json");
const clay = fixture("me-claynosaurz-sales-2026-11-15.json");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let route = () => json({ message: "no route" }, 404);
globalThis.fetch = async (url, init) => route(new URL(String(url)), init);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}
const byTx = (rows, prefix) => rows.find((s) => (s.transaction ?? s.signature)?.startsWith(prefix));
const fillKey = (sig, mint, buyer, seller) => [sig, mint, buyer, seller].join("|");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes) => {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
};

// ------------------------------------------------------- payment scale rules

const servePage = (slug, page) => {
  route = (u) => (u.pathname === `/api/v2/events/collection/${slug}` ? json(page) : json({ message: "no route" }, 404));
};
// One captured OpenSea row paid in USDC on its own program, with its payment changed as the case says.
const usdcRow = osCc.asset_events.find((e) => e.payment?.token_address === USDC_MINT);
const withPayment = (payment) => ({ ...osCc, asset_events: [{ ...usdcRow, payment: { ...usdcRow.payment, ...payment } }] });

await check("an OpenSea payment at a scale its currency does not have is malformed and has no price", async () => {
  servePage("scale-control", withPayment({}));
  const control = (await os.recentSales("scale-control", 1)).sales[0];
  assert.equal(control.currency, "USDC");
  assert.equal(control.price, Number(usdcRow.payment.quantity) / 1e6, "control: the captured USDC row is priced");
  // The USDC row given 9 decimals, and given wrapped SOL's address at 0 decimals.
  for (const [name, payment, why] of [
    ["usdc-at-9", { decimals: 9 }, /decimals 9 where USDC has 6/],
    ["wsol-at-0", { token_address: WRAPPED_SOL_MINT, symbol: "WSOL", decimals: 0 }, /decimals 0 where SOL has 9/],
  ]) {
    servePage(name, withPayment(payment));
    const row = (await os.recentSales(name, 1)).sales[0];
    assert.equal(row.price, null, name);
    assert.ok(row.malformedFields.some((f) => why.test(f)), JSON.stringify(row.malformedFields));
  }
});

await check("a quantity longer than any token amount is refused", async () => {
  servePage("forty-digits", withPayment({ quantity: "1".padEnd(40, "0") }));
  const row = (await os.recentSales("forty-digits", 1)).sales[0];
  assert.equal(row.price, null);
  assert.ok(row.malformedFields.some((f) => /larger than any token amount/.test(f)));
  // Control: the largest amount a token can hold is still an amount.
  servePage("u64-max", withPayment({ quantity: "18446744073709551615" }));
  assert.ok((await os.recentSales("u64-max", 1)).sales[0].price > 1e13);
});

await check("a Magic Eden payment at a scale its token does not have is no amount of it", () => {
  const usdc = meCc.find((a) => a.priceInfo?.splPrice?.address === USDC_MINT);
  assert.equal(reconcile.mePayment(usdc).amount, Number(usdc.priceInfo.splPrice.rawAmount) / 1e6, "control: the captured row reads");
  const at9 = reconcile.mePayment({ ...usdc, priceInfo: { ...usdc.priceInfo, splPrice: { ...usdc.priceInfo.splPrice, decimals: 9 } } });
  assert.equal(at9.amount, null);
  assert.match(at9.malformed, /decimals 9 where USDC has 6/);
  const wsol = reconcile.mePayment({ ...usdc, priceInfo: { splPrice: { address: WRAPPED_SOL_MINT, rawAmount: "800000", decimals: 6 } } });
  assert.equal(wsol.priceSol, null, "wrapped SOL at 6 decimals is not 0.8 SOL read as 800");
  assert.match(wsol.malformed, /where SOL has 9/);
  // The same rule in the collection and wallet figures: a captured Claynosaurz
  // order-book fill given that malformed payment record is a sale with no amount.
  const fill = clay.find((a) => a.source === "magiceden_v2");
  const bad = { ...fill, priceInfo: { ...fill.priceInfo, splPrice: { address: WRAPPED_SOL_MINT, rawAmount: String(Math.round(fill.price * 1e6)), decimals: 6 } } };
  const w = { windowStartUnix: fill.blockTime - 1, windowEndUnix: fill.blockTime + 1 };
  const good = market.summarizeSales([fill], w);
  assert.equal(good.volumeSol, fill.price, "control: the captured fill is priced");
  const s = market.summarizeSales([bad], w);
  assert.equal(s.sales, 1);
  assert.equal(s.volumeSol, 0);
  assert.equal(s.coverage.malformedPrices, 1);
  const a = wallet.summarizeActivity(bad.buyer, [bad], false);
  assert.equal(a.buys.count, 1);
  assert.equal(a.buys.totalSol, 0);
  assert.equal(a.pricing.malformedPrices, 1);
});

await check("another token's look-alike symbol is shown on its own and never as the currency", async () => {
  const dc = osMlb.asset_events.find((e) => e.transaction.startsWith("A3SuTWZ4"));
  for (const [symbol, looks] of [["S0L", "SOL"], ["USDC.e", "USDC"]]) {
    servePage(`lookalike-${symbol}`, { ...osMlb, asset_events: [{ ...dc, payment: { ...dc.payment, symbol } }] });
    const row = (await os.recentSales(`lookalike-${symbol}`, 1)).sales[0];
    assert.equal(row.currency, null, `${symbol} became the currency`);
    assert.equal(row.tokenSymbol, symbol);
    assert.equal(row.paidInOtherToken, true);
    assert.match(row.currencyNote, new RegExp(`reads like ${looks} but is not`));
  }
  // Control: the captured memecoin row keeps its symbol, for display only.
  servePage("memecoin", { ...osMlb, asset_events: [dc] });
  const row = (await os.recentSales("memecoin", 1)).sales[0];
  assert.equal(row.currency, null);
  assert.equal(row.tokenSymbol, "DC");
  assert.doesNotMatch(row.currencyNote, /reads like/);
});

// ------------------------------------------------------------ Tensor relays

await check("a Tensor fill Magic Eden relays is a sale whose figure is a quote, kept out of SOL figures", async () => {
  route = (u) => (u.pathname === "/v2/collections/claynosaurz/activities" && u.searchParams.get("offset") === "0" ? json(clay) : json([]));
  const r = await me.recentSales("claynosaurz", 50);
  const relayed = r.sales.filter((s) => s.marketplace === "tensortrade");
  assert.ok(relayed.length > 0, "the captured page relays Tensor fills");
  const pool = byTx(r.sales, "3d4tADbu");
  if (pool) {
    assert.equal(pool.tensorQuoteSol, 5.760249584);
    assert.equal(pool.priceSol, null);
  }
  assert.ok(relayed.every((s) => s.priceSol === null && s.price === null && s.relayedFrom === "tensor" && s.tensorQuoteSol > 0));
  assert.match(r.flagsNote, /not what anyone paid/);
  // Control: Magic Eden's own fills and its pools keep their price.
  assert.ok(r.sales.filter((s) => s.marketplace === "magiceden_v2" || s.marketplace === "mmm").every((s) => s.priceSol > 0));
  const t = clay.map((e) => e.blockTime);
  const w = { windowStartUnix: Math.min(...t) - 1, windowEndUnix: Math.max(...t) + 1 };
  const s = market.summarizeSales(clay, w);
  const own = clay.filter((e) => e.source !== "tensortrade");
  assert.equal(s.sales, clay.length, "every relayed fill is still a sale");
  assert.equal(s.coverage.tensorRelayed, clay.length - own.length);
  assert.equal(s.volumeSol, Math.round(own.reduce((a, e) => a + e.price, 0) * 1e9) / 1e9, "volume is Magic Eden's own fills only");
  assert.equal(s.venues.find((v) => v.venue === "tensortrade")?.volumeSol, 0);
});

await check("one item's Magic Eden sales take a relayed Tensor figure as a quote, and never-traded says so", async () => {
  // Captured Claynosaurz rows, served as each item's own activity page: the
  // token route returns the same activity objects the collection route does.
  const relayed = clay.find((a) => a.source === "tensortrade");
  const own = clay.find((a) => a.source === "magiceden_v2");
  route = (u, init) => {
    if (u.pathname === `/v2/tokens/${relayed.tokenMint}/activities`) return json([relayed]);
    if (u.pathname === `/v2/tokens/${own.tokenMint}/activities`) return json([own]);
    if (u.hostname === "feeds-rpc.invalid") {
      // The item has no account the chain can show, so its history is not
      // decoded here and the claim rests on Magic Eden's record.
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.method === "getAccountInfo") return json({ jsonrpc: "2.0", id: b.id, result: { context: { slot: 1 }, value: null } });
      return json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "not served by this test" } });
    }
    return json({ message: "no route" }, 404);
  };
  const r = await me.tokenSales(relayed.tokenMint);
  assert.equal(r.sales.length, 1, "a relayed fill is still a sale");
  assert.equal(r.sales[0].priceSol, null);
  assert.equal(r.sales[0].price, null);
  assert.equal(r.sales[0].tensorQuoteSol, relayed.price);
  assert.equal(r.sales[0].relayedFrom, "tensor");
  // Control: Magic Eden's own fill keeps its price.
  const mine = await me.tokenSales(own.tokenMint);
  assert.equal(mine.sales[0].priceSol, own.price);
  assert.equal(mine.sales[0].tensorQuoteSol, undefined);
  const verify = await load("verify");
  const claim = await verify.verifyClaim({ claim: "never-traded", subject: relayed.tokenMint });
  assert.equal(claim.verdict, "contradicted", claim.explanation);
  assert.match(claim.explanation, /a Tensor fill Magic Eden relays, at Tensor's quote of [\d.]+ SOL as Magic Eden passed it on, which is not what anyone paid/);
  assert.doesNotMatch(claim.explanation, new RegExp(`for ${relayed.price} SOL`));
});

// ----------------------------------------------------------------- wallets

await check("a wallet's USDC spending is totalled in USDC, not named as an example", () => {
  const events = fixture("me-wallet-usdc-buyer-2026-11-14.json");
  const a = wallet.summarizeActivity(USDC_BUYER, events, false);
  const usdc = events.filter((e) => e.buyer === USDC_BUYER && e.seller !== USDC_BUYER && e.priceInfo?.splPrice?.address === USDC_MINT);
  const total = usdc.reduce((s, e) => s + Number(e.priceInfo.splPrice.rawAmount) / 1e6, 0);
  assert.equal(total, 875, "the captured feed: 800 and 75 USDC");
  assert.deepEqual(a.otherCurrencies, [{ currency: "USDC", paymentToken: USDC_MINT, buys: usdc.length, boughtAmount: total, sells: 0, soldAmount: 0, amountsUnread: 0 }]);
  assert.match(a.caveats.join(" "), /2 buys for 875 USDC/);
  assert.doesNotMatch(a.caveats.join(" "), /USDC, for example/);
  // Control: the SOL total is still the SOL purchases alone.
  const solBuys = events.filter((e) => e.buyer === USDC_BUYER && !e.priceInfo?.splPrice);
  assert.equal(a.buys.totalSol, Math.round(solBuys.reduce((s, e) => s + e.price, 0) * 1e9) / 1e9);
});

await check("one fill the feed labels both buy and buyNow is counted once in a wallet's figures", () => {
  const events = fixture("me-wallet-usdc-buyer-2026-11-14.json");
  const base = wallet.summarizeActivity(USDC_BUYER, events, false);
  const fill = events.find((e) => e.type === "buyNow" && e.buyer === USDC_BUYER && e.seller !== USDC_BUYER && !e.priceInfo?.splPrice && typeof e.signature === "string");
  assert.ok(fill, "the captured feed has a SOL purchase");
  // The same row once more under the other label, as the API can name one fill.
  const twice = wallet.summarizeActivity(USDC_BUYER, [...events, { ...fill, type: "buy" }], false);
  assert.equal(twice.buys.count, base.buys.count);
  assert.equal(twice.buys.totalSol, base.buys.totalSol);
  // Control: a different fill, under its own signature, is counted.
  const other = wallet.summarizeActivity(USDC_BUYER, [...events, { ...fill, type: "buy", signature: `${fill.signature.slice(0, -2)}zz` }], false);
  assert.equal(other.buys.count, base.buys.count + 1);
});

await check("a wallet's OpenSea sales say which are Magic Eden's fills and where OpenSea names another currency", () => {
  // One Collector Crypt buyer's rows from each captured feed: the rows its account feeds would hold for these fills.
  const usdcTwin = meCc.find((a) => a.priceInfo?.splPrice && osCc.asset_events.some((e) => e.transaction === a.signature && e.payment?.symbol === "SOL"));
  const buyer = usdcTwin.buyer;
  const osRows = osCc.asset_events.filter((e) => e.buyer === buyer || e.seller === buyer);
  const meRows = meCc.filter((a) => a.buyer === buyer || a.seller === buyer);
  const r = wallet.openSeaSalesAgainstMagicEden(osRows, meRows);
  const twins = osRows.filter((e) => meRows.some((a) => fillKey(a.signature, a.tokenMint, a.buyer, a.seller) === fillKey(e.transaction, e.nft?.identifier, e.buyer, e.seller)));
  assert.ok(twins.length > 0);
  assert.equal(r.sameFillsAsMagicEden, twins.length);
  assert.equal(r.currencyDisagreesWithMagicEden, twins.filter((e) => e.payment.symbol === "SOL").length);
  assert.match(r.sameFillsNote, /labels Magic Eden's USDC fills SOL/);
  // Control: no Magic Eden rows, no overlap claimed.
  assert.deepEqual(wallet.openSeaSalesAgainstMagicEden(osRows, []), {});
});

// --------------------------------------------------------- item collections

await check("each sold item's collection is read from its own account in one batch", async () => {
  route = (u, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.hostname === "feeds-rpc.invalid" && body.method === "getMultipleAccounts") return json({ ...mlbAccounts.reply, id: body.id });
    return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not served" } });
  };
  const reads = await sol.readAssetCollections(mlbAccounts.request);
  const tally = {};
  for (const r of reads.values()) tally[r.kind === "core-asset" ? r.collection : r.kind] = (tally[r.kind === "core-asset" ? r.collection : r.kind] ?? 0) + 1;
  assert.equal(tally[LEADOFF] + tally[AMBASSADORS] + tally[GOLD], mlbAccounts.request.length);
  assert.ok(tally[AMBASSADORS] > 0 && tally[GOLD] > 0, JSON.stringify(tally));
  assert.equal(reads.get(TORRES_MINT).collection, AMBASSADORS);
  // Control: a failed read is unread for every item, never a collection.
  route = (u, init) => json({ jsonrpc: "2.0", id: JSON.parse(String(init?.body ?? "{}")).id, error: { code: -32603, message: "internal error" } });
  const failedRead = await sol.readAssetCollections(mlbAccounts.request.slice(0, 3));
  assert.ok([...failedRead.values()].every((r) => r.kind === "unread"));
});

await check("the top traders say they cover no stated window", async () => {
  route = (u) => (u.pathname === "/v2/collections/2022_leadoff_icons/leaderboard" ? json(fixture("me-leadoff-leaderboard-2026-11-15.json")) : json([], 404));
  const r = await me.collectionLeaderboard("2022_leadoff_icons", 10);
  assert.equal(r.traders.length, 10, "control: the board is read");
  assert.equal(r.window.from, null);
  assert.equal(r.window.to, r.cachedAt);
  assert.match(r.window.note, /No time window/);
});

// --------------------------------------------- the tools, both feeds at once

/** A child server on the captured replies; `extra` sets the preload's switches. */
async function session(extra = {}) {
  const h = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-feeds-server-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(project, "test/helpers/feeds-and-groups-preload.mjs")).href, path.join(root, "dist/index.js")],
    env: { ...process.env, HOME: h, USERPROFILE: h, SOLANA_NFT_MCP_TEST_HOME: h, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", OPENSEA_API_KEY: "fixture-not-a-credential", SOLANA_RPC_URL: "https://feeds-rpc.invalid", DAS_RPC_URL: "https://feeds-rpc.invalid", ...extra },
    stderr: "ignore",
  });
  const client = new Client({ name: "feeds", version: "1" });
  await client.connect(transport);
  return {
    close: () => client.close(),
    call: async (name, args) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
      assert.notEqual(r.isError, true, r.content?.[0]?.text?.slice(0, 300));
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    },
  };
}

const s = await session();
try {
  const cc = await s.call("get_recent_sales", { collection: "collector_crypt", limit: 50 });
  await check("OpenSea's SOL label on a Magic Eden USDC fill gives way to Magic Eden's row of the fill", () => {
    const meRows = cc.sales;
    const usdcKeys = new Set(meRows.filter((m) => m.currency === "USDC").map((m) => fillKey(m.signature, m.tokenMint, m.buyer, m.seller)));
    const labelledSol = osCc.asset_events.filter((e) => e.payment.symbol === "SOL" && usdcKeys.has(fillKey(e.transaction, e.nft.identifier, e.buyer, e.seller)));
    assert.ok(labelledSol.length > 0, "the captured pages share fills OpenSea labels SOL");
    for (const e of labelledSol) {
      const row = byTx(cc.opensea.sales, e.transaction);
      assert.equal(row.currency, null, e.transaction);
      assert.equal(row.price, null);
      assert.equal(row.currencyDisagreesWithMagicEden, true);
      assert.equal(row.rawQuantity, e.payment.quantity, "OpenSea's raw units stay beside it");
      assert.match(row.currencyNote, /OpenSea labels this fill SOL .* paid in USDC/);
    }
    const ex = byTx(cc.opensea.sales, "4WrryVKu");
    assert.match(ex.currencyNote, /52000000 units at 9 decimals/);
    assert.match(ex.currencyNote, /50 USDC, Magic Eden's order price/);
    assert.equal(cc.opensea.currencyCorrections.disagreesWithMagicEden, labelledSol.length);
    assert.ok(!cc.opensea.sales.some((x) => x.currency === "SOL"), "no OpenSea row is left calling itself SOL");
    assert.match(cc.opensea.flagsNote, new RegExp(`^${cc.opensea.sales.length} sale\\(s\\) were not paid in SOL`));
    // Control: OpenSea's own USDC sales keep their currency and price, and Magic Eden's rows are untouched.
    const own = cc.opensea.sales.filter((x) => x.paymentToken === USDC_MINT);
    assert.ok(own.length > 0 && own.every((x) => x.currency === "USDC" && x.price > 0));
    assert.equal(byTx(cc.sales, "4WrryVKu").price, 50);
    assert.equal(byTx(cc.sales, "4WrryVKu").currency, "USDC");
  });

  const lo = await s.call("get_recent_sales", { collection: "2022_leadoff_icons", openseaSlug: "candy-mlb", limit: 50 });
  await check("rows of other collections under a group slug leave the block, and the slug is called a group", () => {
    // The collection each captured item account names, decoded here from bytes 34 to 65.
    const collectionOf = new Map(mlbAccounts.request.map((m, i) => {
      const b = Buffer.from(mlbAccounts.reply.result.value[i].data[0], "base64");
      return [m, b[33] === 2 ? base58(b.subarray(34, 66)) : null];
    }));
    const foreign = osMlb.asset_events.filter((e) => collectionOf.get(e.nft.identifier) !== LEADOFF);
    assert.ok(foreign.length > 0 && foreign.length < 50, `${foreign.length} foreign rows`);
    assert.equal(lo.opensea.identity.verdict, "group");
    assert.match(lo.opensea.identity.note, new RegExp(`${foreign.length} of the 50 sale rows read were items of other collections`));
    assert.equal(lo.opensea.collectionCheck.inOtherCollections, foreign.length);
    assert.equal(lo.opensea.collectionCheck.inThisCollection, 50 - foreign.length);
    assert.equal(lo.opensea.sales.length, lo.opensea.collectionCheck.inThisCollection);
    assert.ok(!lo.opensea.sales.some((x) => x.mint === TORRES_MINT), "the Candy Ambassadors card is not a Leadoff sale");
    assert.deepEqual(new Set(lo.opensea.collectionCheck.otherCollections.map((c) => c.collection)), new Set([AMBASSADORS, GOLD]));
    // Control: the Leadoff card sold on both feeds is still there and still linked.
    const meadows = byTx(lo.opensea.sales, "4f2Arm2W");
    assert.equal(meadows.sameTransactionAs, "magiceden");
    assert.equal(meadows.currency, "SOL");
  });

  const only = await s.call("get_recent_sales", { collection: "2022_leadoff_icons", openseaSlug: "leadoff-only", limit: 50 });
  await check("a slug whose record and every row's item name this collection is verified", () => {
    assert.equal(only.opensea.identity.verdict, "verified", only.opensea.identity.note);
    assert.equal(only.opensea.collectionCheck.inThisCollection, only.opensea.collectionCheck.rowsChecked);
    assert.equal(only.opensea.collectionCheck.notRead, undefined);
  });

  await check("OpenSea sales newer than Magic Eden's newest point to the chain scan", () => {
    const meNewest = Math.max(...fixture("me-leadoff-sales-2026-11-14.json").map((a) => a.blockTime));
    const newer = lo.opensea.sales.filter((x) => !x.sameTransactionAs && Date.parse(x.time) / 1000 > meNewest);
    assert.ok(newer.length > 0);
    assert.match(lo.chainScanHint, new RegExp(`OpenSea lists ${newer.length} sale\\(s\\) after Magic Eden's newest`));
    assert.doesNotMatch(lo.chainScanHint, /newest sale here is from/, "Magic Eden's newest sale is under three days old");
    // Control: no Core collection is known for Collector Crypt, so there is nothing to scan.
    assert.equal(cc.chainScanHint, undefined);
  });

  const ws = await s.call("get_collection_sales", { symbol: "2022_leadoff_icons", days: 45 });
  await check("OpenSea's window count is this collection's rows only, read from each item's account", () => {
    const w = ws.openseaSameWindow;
    assert.equal(w.status, "read");
    assert.equal(w.slug, "candy-mlb");
    assert.equal(w.identity, "group");
    assert.ok(w.otherCollectionSales > 0);
    assert.equal(w.sales + w.otherCollectionSales + w.notChecked, w.salesUnderSlug);
    assert.equal(w.notChecked, 0, "control: every captured item account was served");
    assert.ok(w.alsoInMagicEdenFeed <= w.sales);
    assert.match(ws.figuresCover, /Tensor fills it does not relay/);
    assert.match(ws.figuresCover, /chainScan: true/);
  });

  const stats = await s.call("get_collection_stats", { collection: "2022_leadoff_icons", openseaSlug: "candy-mlb" });
  await check("a slug that counts more items than the collection ever minted is a group, and its floor is not ranked", () => {
    assert.equal(stats.onchain.numMinted, 384993, "control: the captured collection account");
    assert.equal(stats.opensea.totalSupply, 387528, "control: OpenSea's captured record");
    assert.equal(stats.opensea.identity.verdict, "group");
    assert.match(stats.opensea.identity.note, /counts 387528 items there, more than the 384993/);
    assert.equal(stats.reconciliation.comparable, false);
    assert.match(stats.reconciliation.verdict, /Not ranked/);
    assert.doesNotMatch(stats.opensea.supplyDisagreement?.note ?? "", /this same collection/);
  });

  const gold = await s.call("get_recent_sales", { collection: "gold_series_auction_1_candy_digital", limit: 5, chainScan: true });
  const goldByAddress = await s.call("get_recent_sales", { collection: GOLD, limit: 5, chainScan: true });
  await check("Gold Series ICONs by its Magic Eden symbol reaches its collection, as by address", () => {
    assert.notEqual(gold.chainScan.status, "not-run", gold.chainScan.reason);
    assert.equal(gold.chainScan.status, goldByAddress.chainScan.status);
    assert.equal(gold.sales.length, 5, "control: Magic Eden's rows are read by symbol");
  });

  const goldPlain = await s.call("get_recent_sales", { collection: "gold_series_auction_1_candy_digital", limit: 5 });
  await check("a feed whose newest sale is weeks old points to the chain scan", () => {
    assert.match(goldPlain.chainScanHint, /Magic Eden's newest sale here is from 2026-10-10/);
    assert.match(goldPlain.chainScanHint, /chainScan: true/);
    assert.equal(gold.chainScanHint, undefined, "control: an answer that already scanned is not told to");
  });

  const tensorian = await s.call("get_asset", { mint: "GDEC7TRDAdU1BUhSSAK2WLc5DqLSCCcq6W2b7rVpfHcS" });
  await check("a non-Core item listed under one owner while the asset index names another is flagged", () => {
    assert.equal(tensorian.market.listed, true, "Magic Eden's record is shown as it is");
    assert.equal(tensorian.market.listingNotConfirmed, true);
    assert.equal(tensorian.market.ownerDisagreesWithIndex.indexOwner, tensorian.chainIndex.owner);
    assert.equal(tensorian.market.ownerDisagreesWithIndex.indexOwnerIsWallet, true);
    assert.match(tensorian.ownerAgreement, /names another wallet .* not confirmed by the chain/);
    assert.doesNotMatch(tensorian.ownerAgreement, /was not compared/);
  });
} finally {
  await s.close();
}

// The same Collector Crypt pages with Magic Eden's rows not there to check
// OpenSea's SOL label by: its feed down, or none of its rows the same fill.
for (const [mode, why] of [
  ["down", /Magic Eden's rows, which would show what each of its fills was paid in, could not be read just now/],
  ["unmatched", /none of the Magic Eden rows read in this answer is the same fill/],
]) {
  const t = await session({ FEEDS_TEST_ME: mode });
  try {
    const r = await t.call("get_recent_sales", { collection: "collector_crypt", limit: 50 });
    await check(`OpenSea's SOL label is not taken as SOL when Magic Eden's rows are ${mode === "down" ? "not read" : "no fill of OpenSea's"}`, () => {
      const labelledSol = osCc.asset_events.filter((e) => e.payment.symbol === "SOL");
      assert.ok(labelledSol.length > 0, "the captured page labels Magic Eden's USDC fills SOL");
      for (const e of labelledSol) {
        const row = byTx(r.opensea.sales, e.transaction);
        assert.equal(row.currency, null, e.transaction);
        assert.equal(row.price, null);
        assert.equal(row.currencyUnconfirmed, true);
        assert.equal(row.rawQuantity, e.payment.quantity, "OpenSea's raw units stay beside it");
        assert.match(row.currencyNote, why);
      }
      assert.ok(!r.opensea.sales.some((x) => x.currency === "SOL"), "no OpenSea row is left calling itself SOL");
      assert.equal(r.opensea.currencyCorrections.unconfirmed, labelledSol.length);
      assert.match(r.opensea.currencyCorrectionsNote, why);
      assert.match(r.opensea.flagsNote, new RegExp(`^${r.opensea.sales.length} sale\\(s\\) were not paid in SOL`));
      if (mode === "down") assert.ok(r.sourceErrors?.magiceden, "the failed read is named");
      // Control: OpenSea's own USDC sales keep their currency and price.
      const own = r.opensea.sales.filter((x) => x.paymentToken === USDC_MINT);
      assert.ok(own.length > 0 && own.every((x) => x.currency === "USDC" && x.price > 0));
    });
  } finally {
    await t.close();
  }
}

{
  const t = await session({ FEEDS_TEST_ACCOUNTS: "down" });
  try {
    const r = await t.call("get_recent_sales", { collection: "2022_leadoff_icons", openseaSlug: "leadoff-only", limit: 50 });
    await check("an OpenSea slug is not called verified when the chain did not answer for its rows' items", () => {
      assert.equal(r.opensea.identity.verdict, "unverified", r.opensea.identity.note);
      assert.match(r.opensea.identity.note, /the chain did not answer for the items of \d+ of the \d+ sale rows, so whether the slug also carries other collections' items was not read/);
      assert.ok(r.opensea.collectionCheck.notRead > 0);
      assert.ok(r.opensea.sales.every((x) => x.inThisCollection === null), "each row says it was not checked");
    });
  } finally {
    await t.close();
  }
}

console.log(`feeds-and-groups: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
