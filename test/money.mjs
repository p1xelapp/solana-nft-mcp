/**
 * Money: every price in the currency actually paid, counted once, never mixed
 * into SOL figures when it was not SOL.
 *
 * Built on replies Magic Eden and OpenSea gave on 2026-11-14 (test/fixtures,
 * *-2026-11-14.json), read against the transactions they describe:
 *   2tssstvw...AdyF  Magic Eden, 800 USDC, `price` 6.733786 (a SOL equivalent)
 *   56c5h65c...uLY   Magic Eden, 75 USDC, `price` 0.635654
 *   A3SuTWZ4...QSk   OpenSea, 3115.141221 of the DacityCoin token, symbol "DC"
 *   4f2Arm2W...Rc96  one fill in both feeds: Magic Eden 0.0039 (the listing's
 *                    price), OpenSea 0.004368 (what the buyer paid)
 *   3mF1UcUZ...Bp3   an accepted offer, which Magic Eden labels buyNow
 * A case that changes a captured row says so; nothing else is invented.
 *
 * Usage: node test/money.mjs [root]  (root defaults to this checkout; pass an
 * older build's folder to see which checks it fails).
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
const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-money-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS = "1";
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = "1";
process.env.OPENSEA_API_KEY = "fixture-not-a-credential";
delete process.env.SOLANA_RPC_URL;
delete process.env.SOLANA_NFT_MCP_OFFLINE;

const load = (name) => import(pathToFileURL(path.join(root, "dist", `${name}.js`)).href);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(project, "test", "fixtures", name), "utf8"));
const me = await load("sources/magiceden");
const os = await load("sources/opensea");
const market = await load("market");
const wallet = await load("wallet");
const reconcile = await load("lib/reconcile");

const NATIVE_SOL_ADDRESS = "11111111111111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DACITY_MINT = "ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump";
const CAM_MINT = "dk9Dwn5SfkokXz8giAa8bNdVSUibeBJSnGbpNsnLcFJ";
const LINDOR_MINT = "9GrGH2Zq1G3d3zUYs7isrbHr3QmYbyh4MBsR9GsYpAuL";
const TORRES_MINT = "GckVrtAxCMVcdXL7hnV9Bx4ckeTtqPTsBuECCLqNuSjr";
const USDC_BUYER = "BUXL8YJggityxZsvGsSkjgVMNEQhjq9ok6o9gudYdjgv";

const leadoff = fixture("me-leadoff-sales-2026-11-14.json");
const osPage = fixture("os-candy-mlb-sales-2026-11-14.json");
const usdcReplies = fixture("me-usdc-sales-2026-11-14.json").replies;
const offerReplies = fixture("me-accepted-offer-and-pool-2026-11-14.json").replies;
const usdcRows = Object.values(usdcReplies).flat().filter((a) => a.type === "buyNow");
const tokenFeed = (mint) => Object.entries({ ...usdcReplies, ...offerReplies }).find(([k]) => k.includes(mint))?.[1];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let route = () => json({ message: "no route" }, 404);
globalThis.fetch = async (url) => route(new URL(String(url)));

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
const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 1e9) / 1e9;
const windowOf = (events) => {
  const t = events.map((e) => e.blockTime);
  return { windowStartUnix: Math.min(...t) - 1, windowEndUnix: Math.max(...t) + 1 };
};

// ------------------------------------------------------------ OpenSea rows

const servePage = (slug, page) => {
  route = (u) => (u.pathname === `/api/v2/events/collection/${slug}` ? json(page) : json({ message: "no route" }, 404));
};

await check("an OpenSea sale paid in a memecoin is marked as another token and keeps its own symbol", async () => {
  servePage("money-memecoin", osPage);
  const r = await os.recentSales("money-memecoin", 10);
  const dc = byTx(r.sales, "A3SuTWZ4");
  assert.equal(dc.paidInOtherToken, true);
  assert.equal(dc.currency, "DC");
  assert.equal(dc.paymentToken, DACITY_MINT);
  assert.equal(dc.price, 3115.141221);
  // Control: a native SOL sale on the same page is SOL, proved by its address.
  const sol = byTx(r.sales, "4f2Arm2W");
  assert.equal(sol.currency, "SOL");
  assert.equal(sol.paymentToken, NATIVE_SOL_ADDRESS);
  assert.equal(sol.paidInOtherToken, undefined);
});

await check("a token that calls itself SOL or USDC under another address is not counted as either", async () => {
  // The captured memecoin row, relabelled the way a hostile token would label itself.
  for (const fake of ["SOL", "USDC"]) {
    const page = { ...osPage, asset_events: osPage.asset_events.map((e) => (e.transaction.startsWith("A3SuTWZ4") ? { ...e, payment: { ...e.payment, symbol: fake } } : e)) };
    servePage(`money-fake-${fake.toLowerCase()}`, page);
    const r = await os.recentSales(`money-fake-${fake.toLowerCase()}`, 10);
    const row = byTx(r.sales, "A3SuTWZ4");
    assert.equal(row.currency, null, `a token named ${fake} became ${row.currency}`);
    assert.equal(row.paidInOtherToken, true);
    assert.match(row.currencyNote, new RegExp(`is not ${fake}'s`));
    assert.equal(row.farAboveRecentRange, undefined, "a non-SOL amount is never judged against SOL prices");
  }
});

await check("an OpenSea payment with no token address names no currency", async () => {
  // OpenSea's schema requires the address; this row has it removed.
  const page = { ...osPage, asset_events: osPage.asset_events.map((e) => (e.transaction.startsWith("4f2Arm2W") ? { ...e, payment: { quantity: e.payment.quantity, decimals: e.payment.decimals, symbol: e.payment.symbol } } : e)) };
  servePage("money-no-address", page);
  const r = await os.recentSales("money-no-address", 10);
  const row = byTx(r.sales, "4f2Arm2W");
  assert.equal(row.currency, null);
  assert.match(row.currencyNote, /no payment token address/);
  assert.equal(byTx(r.sales, "4EUJrsFB").currency, "SOL", "control: the untouched row is SOL");
});

await check("two OpenSea account events that differ only in payment token are two events", async () => {
  const events = fixture("os-memecoin-wallet-2026-11-14.json").asset_events;
  const sale = events.find((e) => e.transaction.startsWith("A3SuTWZ4") && e.event_type === "sale");
  const twin = { ...sale, payment: { ...sale.payment, token_address: NATIVE_SOL_ADDRESS } };
  assert.equal(wallet.summarizeOpenSeaEvents(sale.buyer, [sale, twin], false).duplicateRowsDropped, 0);
  assert.equal(wallet.summarizeOpenSeaEvents(sale.buyer, [sale, { ...sale }], false).duplicateRowsDropped, 1, "control: an exact copy is still one event");
});

// --------------------------------------------------------- Magic Eden rows

await check("a Magic Eden sale paid in USDC is reported in USDC, its SOL equivalent named as such", async () => {
  route = (u) => {
    const mint = u.pathname.split("/")[3];
    return u.pathname.endsWith("/activities") && tokenFeed(mint) && u.searchParams.get("offset") === "0" ? json(tokenFeed(mint)) : json([]);
  };
  const cam = (await me.tokenSales(CAM_MINT, { maxPages: 1 })).sales[0];
  assert.equal(cam.currency, "USDC");
  assert.equal(cam.price, 800);
  assert.equal(cam.priceSol, null);
  assert.equal(cam.priceSolEquivalent, 6.733786);
  assert.equal(cam.paymentToken, USDC_MINT);
  const lindor = (await me.tokenSales(LINDOR_MINT, { maxPages: 1 })).sales[0];
  assert.equal(lindor.price, 75);
  assert.equal(lindor.currency, "USDC");
  // Control: an accepted offer paid in SOL, which Magic Eden labels buyNow, is a SOL sale.
  const torres = (await me.tokenSales(TORRES_MINT, { maxPages: 1 })).sales;
  assert.equal(torres.length, 1);
  assert.equal(torres[0].currency, "SOL");
  assert.equal(torres[0].priceSol, 0.001);
});

const serveLeadoff = () => {
  route = (u) => (u.pathname === "/v2/collections/2022_leadoff_icons/activities" && u.searchParams.get("offset") === "0" ? json(leadoff) : json([]));
};

await check("Magic Eden pool fills are labelled, and the list says what its price is", async () => {
  serveLeadoff();
  const r = await me.recentSales("2022_leadoff_icons", 50);
  const pools = r.sales.filter((s) => s.marketplace === "mmm");
  assert.ok(pools.length > 0, "the captured page has pool fills");
  assert.ok(pools.every((s) => s.poolFill === true));
  assert.ok(r.sales.filter((s) => s.marketplace !== "mmm").every((s) => s.poolFill === undefined), "control: order-book fills are not pool fills");
  assert.match(r.priceBasis, /price of the order that filled/);
  // An accepted offer arrives as an ordinary sale and stays one.
  assert.equal(byTx(r.sales, "3mF1UcUZ")?.priceSol, 0.0021);
});

await check("a sale far above the others read is flagged with its numbers, never dropped", async () => {
  serveLeadoff();
  const r = await me.recentSales("2022_leadoff_icons", 10);
  const high = byTx(r.sales, "4dtb4hYj");
  assert.equal(high.priceSol, 0.041216718, "the price is shown as reported");
  assert.equal(high.farAboveRecentRange?.othersCompared, 9);
  assert.equal(high.farAboveRecentRange?.priceSol, 0.041216718);
  assert.ok(high.farAboveRecentRange.medianOfOthersSol < 0.003);
  assert.equal(byTx(r.sales, "4f2Arm2W").farAboveRecentRange, undefined, "control: an ordinary price is not flagged");
  assert.equal(r.sales.length, 10);
});

// --------------------------------------------------------------- summaries

await check("collection figures keep USDC sales out of every SOL figure and total them in USDC", () => {
  const events = [...leadoff, ...usdcRows];
  const w = windowOf(events);
  const solOnly = market.summarizeSales(leadoff, w);
  const s = market.summarizeSales(events, w);
  assert.equal(s.sales, solOnly.sales + 2, "the USDC sales are counted as sales");
  assert.equal(s.volumeSol, solOnly.volumeSol, "and add nothing to SOL volume");
  assert.equal(s.pricedSales, solOnly.pricedSales);
  assert.equal(s.highest.priceSol, solOnly.highest.priceSol, "6.73 is not the highest SOL sale");
  assert.deepEqual(s.otherCurrencies, [{ currency: "USDC", paymentToken: USDC_MINT, sales: 2, amount: 875, amountsUnread: 0 }]);
  assert.equal(s.coverage.paidInOtherCurrency, 2);
});

await check("a self-fill is a sale but not money, and its wallet does not rank itself", () => {
  const w = windowOf(leadoff);
  const base = market.summarizeSales(leadoff, w);
  assert.equal(base.coverage.selfFills, 0, "control: the captured page has no self-fill");
  // The captured row with the highest price, with its buyer set as its seller.
  const top = leadoff.reduce((a, b) => (b.price > a.price ? b : a));
  const events = leadoff.map((e) => (e === top ? { ...e, seller: e.buyer } : e));
  const s = market.summarizeSales(events, w);
  assert.equal(s.sales, base.sales);
  assert.equal(s.coverage.selfFills, 1);
  assert.equal(s.volumeSol, Math.round((base.volumeSol - top.price) * 1e9) / 1e9);
  assert.ok(s.highest.priceSol < top.price);
  assert.ok(!s.topBuyers.some((b) => b.wallet === top.buyer && b.spentSol >= top.price));
});

await check("sales far above the window's range are listed with their numbers and still counted", () => {
  const s = market.summarizeSales(leadoff, windowOf(leadoff));
  const far = s.coverage.farAboveRecentRange;
  assert.ok(far.some((f) => f.signature?.startsWith("46unwmvp") && f.priceSol === 0.333694836), JSON.stringify(far.slice(0, 2)));
  assert.equal(s.highest.priceSol, 0.333694836);
  assert.ok(s.highest.farAboveRecentRange, "the highest sale carries its flag");
  assert.equal(s.volumeSol, sum(leadoff.map((e) => e.price)), "nothing was dropped from volume");
  // Control: an ordinary spread of prices flags nothing.
  assert.ok(market.farAboveRange([1, 1.1, 0.9, 1, 1.05, 0.95, 1.2]).every((f) => f === null));
});

await check("several item sales in one transaction say a per-item price cannot be proven", () => {
  const [a, b] = leadoff;
  const rows = (x, y) => [x, y].map((e) => ({ signature: e.signature, mint: e.tokenMint, buyer: e.buyer, seller: e.seller, priceSol: e.price }));
  assert.ok(market.saleRowFlags(rows(a, b)).every((f) => f.sharedTransaction === undefined), "control: two transactions");
  // The second captured row given the first row's signature.
  const shared = market.saleRowFlags(rows(a, { ...b, signature: a.signature }));
  assert.ok(shared.every((f) => f.sharedTransaction?.items === 2));
  assert.match(shared[0].sharedTransaction.note, /cannot prove/);
  const s = market.summarizeSales([a, { ...b, signature: a.signature }], windowOf([a, b]));
  assert.equal(s.coverage.multiItemTransactions, 1);
});

await check("the per-name table leaves a USDC sale out of SOL volume", () => {
  const names = new Map([
    [CAM_MINT, { name: "Cam Schlittler - Momenticons (2/5)" }],
    [leadoff[0].tokenMint, { name: "Austin Meadows (391/500)" }],
  ]);
  const t = market.breakdownByName([...usdcRows, leadoff[0]], names);
  const cam = t.rows.find((r) => r.name === "Cam Schlittler - Momenticons");
  assert.equal(cam.sales, 1);
  assert.equal(cam.pricedSales, 0);
  assert.equal(cam.volumeSol, 0);
  const meadows = t.rows.find((r) => r.name === "Austin Meadows");
  assert.equal(meadows.volumeSol, 0.0039, "control: the SOL sale is priced");
});

await check("wallet totals, net flow and flips leave USDC purchases out", () => {
  const events = fixture("me-wallet-usdc-buyer-2026-11-14.json");
  const a = wallet.summarizeActivity(USDC_BUYER, events, false);
  const solBuys = events.filter((e) => e.buyer === USDC_BUYER && !e.priceInfo?.splPrice);
  assert.equal(a.buys.count, 29, "every purchase is still a purchase");
  assert.equal(a.pricing.nonSolTrades, 2);
  assert.equal(a.buys.totalSol, sum(solBuys.map((e) => e.price)));
  assert.match(a.caveats.join(" "), /paid in a currency other than SOL/);
});

await check("the payment token decides the currency, from the issuers' own addresses", () => {
  const c = reconcile.classifyPaymentToken;
  assert.equal(c("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT", "OpenSea").currency, "USDT");
  assert.equal(c("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD", "OpenSea").currency, "PYUSD");
  assert.equal(c(USDC_MINT, "USDC", "OpenSea").kind, "stablecoin");
  assert.equal(c("So11111111111111111111111111111111111111112", "WSOL", "OpenSea").currency, "SOL");
  // A string that is not a 32-byte key (the chain answers WrongSize) is no stablecoin.
  assert.equal(c("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCemc8NQi1Jg3", "USDT", "OpenSea").currency, null);
  // Control: a symbol alone proves nothing.
  assert.equal(c(undefined, "USDC", "OpenSea").currency, null);
});

await check("OpenSea's floor is labelled as what a buyer pays, Magic Eden's as the seller's ask", () => {
  const labelled = reconcile.reconcileFloors([
    { source: "magiceden", value: 0.0039, currency: "SOL", priceIs: "seller-ask" },
    { source: "opensea", value: 0.004368, currency: "SOL", priceIs: "buyer-pays-through-venue", currencyBasis: "symbol" },
  ]);
  assert.match(labelled.verdict, /what a buyer pays to fill through it/);
  assert.ok(labelled.caveats.some((x) => /symbol only, with no token address/.test(x)));
  // Control: two quotes of the same kind get no such sentence.
  const plain = reconcile.reconcileFloors([
    { source: "magiceden", value: 0.0039, currency: "SOL" },
    { source: "opensea", value: 0.004368, currency: "SOL" },
  ]);
  assert.doesNotMatch(plain.verdict + plain.caveats.join(" "), /what a buyer pays to fill|symbol only/);
});

await check("the fills both feeds list are counted once, by signature, item, buyer and seller", () => {
  const rows = osPage.asset_events.map((e) => ({ transaction: e.transaction, mint: e.nft?.identifier, buyer: e.buyer, seller: e.seller }));
  assert.equal(market.countSameFills(rows, leadoff), 5);
  // Control: a row repeated in the other feed is no longer a unique match.
  assert.equal(market.countSameFills([...rows, rows.find((r) => r.transaction.startsWith("4f2Arm2W"))], leadoff), 4);
});

// --------------------------------------------- the tool, both feeds at once

async function session() {
  const h = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-money-server-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(project, "test/helpers/money-preload.mjs")).href, path.join(root, "dist/index.js")],
    env: { ...process.env, HOME: h, USERPROFILE: h, SOLANA_NFT_MCP_TEST_HOME: h, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", OPENSEA_API_KEY: "fixture-not-a-credential", SOLANA_RPC_URL: "https://money-rpc.invalid", DAS_RPC_URL: "https://money-rpc.invalid" },
    stderr: "ignore",
  });
  const client = new Client({ name: "money", version: "1" });
  await client.connect(transport);
  return {
    close: () => client.close(),
    call: async (name, args) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      assert.notEqual(r.isError, true, r.content?.[0]?.text?.slice(0, 300));
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    },
  };
}

const s = await session();
try {
  const r = await s.call("get_recent_sales", { collection: "2022_leadoff_icons", openseaSlug: "candy-mlb", limit: 10 });
  await check("one fill in both feeds is linked on both rows, each saying which figure it is", () => {
    const meRow = byTx(r.sales, "4f2Arm2W");
    const osRow = byTx(r.opensea.sales, "4f2Arm2W");
    assert.equal(meRow.priceSol, 0.0039);
    assert.equal(osRow.price, 0.004368);
    assert.equal(meRow.sameTransactionAs, "opensea");
    assert.equal(meRow.priceIs, "Magic Eden's order price");
    assert.equal(osRow.sameTransactionAs, "magiceden");
    assert.equal(osRow.openseaToMagicEdenRatio, 1.12);
    assert.match(osRow.sameTransactionNote, /count it once and never add the two amounts/);
    assert.equal(r.opensea.sameTransactions, 5);
    assert.equal(r.sales.filter((x) => x.sameTransactionAs === "opensea").length, 5);
  });
  await check("OpenSea-only sales and the memecoin sale stay unlinked and unpriced in SOL", () => {
    for (const p of ["j3shXmBY", "4xniKuYy", "4a9XbiuX", "56PfWY2a"]) assert.equal(byTx(r.opensea.sales, p).sameTransactionAs, undefined, p);
    const dc = byTx(r.opensea.sales, "A3SuTWZ4");
    assert.equal(dc.paidInOtherToken, true);
    assert.equal(dc.openseaToMagicEdenRatio, undefined);
  });
  const shifted = await s.call("get_recent_sales", { collection: "2022_leadoff_icons", openseaSlug: "candy-mlb-shifted", limit: 10 });
  await check("two feeds dating one fill an hour apart are flagged with both times", () => {
    const row = byTx(shifted.opensea.sales, "4f2Arm2W");
    assert.equal(row.timesDisagree?.seconds, 3600);
    assert.ok(shifted.opensea.sales.filter((x) => x.sameTransactionAs && x !== row).every((x) => x.timesDisagree === undefined), "control: fills dated alike are not flagged");
    assert.equal(byTx(r.opensea.sales, "4f2Arm2W").timesDisagree, undefined, "control: the captured times agree");
  });
} finally {
  await s.close();
}

console.log(`money: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
