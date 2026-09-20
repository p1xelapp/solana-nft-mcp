/**
 * Sibling code paths that disagreed (a
 * summary and its table built from different events, a filter applied in one
 * mode and ignored in another, a rule enforced in one reader and missing
 * from its twin).
 * Every block asserts the correct behaviour and every one failed before its
 * fix. Nothing here touches the network: pure functions are called directly,
 * and the three cases that need a whole tool handler run a child server whose
 * upstreams are stubbed by test/helpers/siblings-preload.mjs.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { summarizeActivity } from "../dist/wallet.js";
import { summarizeSales, breakdownByName, applyNameFilter, parseSerial, baseName, matchSerial } from "../dist/market.js";
import { deriveTrust } from "../dist/lib/coreplugins.js";
import { cached } from "../dist/lib/http.js";
import * as me from "../dist/sources/magiceden.js";
import * as sol from "../dist/sources/solana.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};
delete process.env.SOLANA_RPC_URL;
delete process.env.DAS_RPC_URL;
const denied = async (url) => {
  throw new Error(`network denied by the test: ${String(url).slice(0, 80)}`);
};
globalThis.fetch = denied;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const d = digits[i] * 256 + carry;
      digits[i] = d % 58;
      carry = Math.floor(d / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return digits.reverse().map((d) => ALPHABET[d]).join("");
}
const address = (label) => base58(createHash("sha256").update(label).digest());
const signature = (label) => base58(createHash("sha512").update(label).digest());

// ================================================================ R8-01
// A sale with no usable price still consumes the item's open lot. Leaving it
// open paired the next cycle's sale with the first cycle's cheaper purchase.
{
  const W = address("r8-wallet");
  const X = address("r8-item");
  const ev = (i, over) => ({ signature: signature(`w-${i}`), type: "buyNow", source: "magiceden_v2", tokenMint: X, collectionSymbol: "c", blockTime: 1_700_000_000 + i * 86_400, price: 1, buyer: W, seller: address("x"), ...over });
  const feed = [
    ev(1, { price: 1 }),
    ev(2, { price: null, buyer: address("y"), seller: W }),
    ev(3, { price: 10 }),
    ev(4, { price: 12, buyer: address("y"), seller: W }),
  ].reverse();
  const a = summarizeActivity(W, feed, false);
  assert.strictEqual(a.realized.flips, 1, "one measurable cycle");
  assert.strictEqual(a.realized.pnlSol, 2, `the second cycle earns 2, not 11: ${a.realized.pnlSol}`);
  assert.strictEqual(a.realized.unmeasuredCycles, 1, "the unpriced cycle is counted, not left open");
  assert.strictEqual(a.behaviour.boughtThenSoldPct, 100, "both purchases were resold");
  assert.ok(a.caveats.some((c) => /could not be measured/.test(c)));
  assert.strictEqual(a.currency, "SOL");
  assert.strictEqual(a.source, "magiceden");
  assert.strictEqual(a.flips[0].currency, "SOL");
  ok("R8-01 an unpriced disposal moves inventory; P&L is measured on the cycle it belongs to");
}

// ================================================================ R8-02 / R8-07
// The per-name table is built from the same canonical events as the summary:
// a repeated fill counts once, a disputed price adds nothing, and a name
// filter's unresolved rows are a field, not a sentence.
{
  const t = 1_700_000_000;
  const names = new Map([[address("m1"), { name: "Aaron Judge #4" }], [address("m2"), { name: null }]]);
  const row = (over) => ({ signature: signature("s1"), type: "buyNow", tokenMint: address("m1"), price: 2, blockTime: t + 10, buyer: address("b"), seller: address("s"), ...over });
  const twin = [row({}), row({})];
  const s1 = summarizeSales(twin, { windowStartUnix: t, windowEndUnix: t + 100 });
  const b1 = breakdownByName(twin, names);
  assert.strictEqual(s1.sales, 1);
  assert.strictEqual(b1.rows[0].sales, 1, `byName counts the repeated fill once: ${b1.rows[0].sales}`);
  const disputed = [row({ price: 2 }), row({ price: 3 })];
  const s2 = summarizeSales(disputed, { windowStartUnix: t, windowEndUnix: t + 100 });
  const b2 = breakdownByName(disputed, names);
  assert.strictEqual(s2.volumeSol, 0);
  assert.strictEqual(b2.rows[0].volumeSol, 0, `a disputed price adds nothing to byName either: ${b2.rows[0].volumeSol}`);
  assert.strictEqual(b2.rows[0].sales, 1);
  assert.strictEqual(b2.rows[0].pricedSales, 0);
  assert.strictEqual(b2.rows[0].currency, "SOL");
  assert.strictEqual(s2.currency, "SOL");
  assert.strictEqual(s2.topBuyers[0]?.currency ?? "SOL", "SOL");

  const mixed = [row({}), row({ signature: signature("s2"), tokenMint: address("m2") })];
  const f = applyNameFilter(mixed, names, "ohtani");
  assert.strictEqual(f.status, "applied");
  assert.strictEqual(f.events.length, 0);
  assert.strictEqual(f.resolved, 1);
  assert.strictEqual(f.unresolved, 1, "the unnamed sale could not be judged");
  ok("R8-02/07 byName shares the summary's event identity and money policy; a partial name filter reports what it could not judge");
}

// ================================================================ R8-08 / R8-11
// One unrepresentable time does not cost the whole wallet report or the
// whole leaderboard, and a venue-authored key named "constructor" is a key.
{
  const W = address("r8-time-wallet");
  const good = { signature: signature("g"), type: "buyNow", source: "magiceden_v2", tokenMint: address("i"), collectionSymbol: "constructor", blockTime: 1_700_000_000, price: 2, buyer: W, seller: address("x") };
  const bad = { ...good, signature: signature("bad"), tokenMint: address("j"), blockTime: 1e20 };
  const a = summarizeActivity(W, [bad, good], false);
  assert.strictEqual(a.buys.count, 2, "both rows count");
  assert.strictEqual(a.pricing.unusableTimestamps, 1);
  assert.strictEqual(a.buys.collections.constructor, 2, `an own-property count, not the inherited function: ${String(a.buys.collections.constructor).slice(0, 40)}`);

  globalThis.fetch = async (url) => {
    if (!String(url).includes("/collections/r8-lead/leaderboard")) throw new Error(`unexpected ${url}`);
    return json([{ wallet: address("t1"), totalVolume: 1_000_000_000, lastTradeAt: 1_700_000_000 }, { wallet: address("t2"), totalVolume: 2_000_000_000, lastTradeAt: 1e20 }]);
  };
  const lead = await me.collectionLeaderboard("r8-lead", 10);
  globalThis.fetch = denied;
  assert.strictEqual(lead.traders.length, 2, "the valid trader survives the malformed one");
  assert.strictEqual(lead.traders[1].lastTradeAt, null);
  assert.ok(!/are not in it/.test(lead.caveat), "the leaderboard does not assert absence of other venues");
  ok("R8-08/11 a malformed timestamp nulls one field, never the answer; counters use own properties only");
}

// ================================================================ R8-09 / R8-12
// The base name loses exactly the span the serial was read from, and an
// impossible fraction is no serial at all.
{
  assert.strictEqual(baseName("Superman (2023) #1 (4/750)"), "Superman (2023) #1");
  assert.strictEqual(baseName("Superman (2023) #2 (8/750)"), "Superman (2023) #2");
  assert.notStrictEqual(baseName("Superman (2023) #1 (4/750)"), baseName("Superman (2023) #2 (8/750)"), "two issues are two rows");
  assert.strictEqual(baseName("Shohei Ohtani 7/100"), baseName("Shohei Ohtani 8/100"), "the same card at two serials is one row");
  assert.strictEqual(baseName("Shohei Ohtani (12/250)"), "Shohei Ohtani");
  assert.strictEqual(baseName("Claynosaurz #9"), "Claynosaurz");
  assert.deepStrictEqual(parseSerial("Superman (2023) #1 (4/750)"), { serial: 4, of: 750 });
  assert.strictEqual(matchSerial("Batman (2011/2016) #10041").format, "trailing-hash");
  assert.strictEqual(parseSerial("Card #101/100"), null, "a serial above its edition size is not a serial");
  assert.strictEqual(parseSerial("Card #1/0"), null, "an edition of zero is not an edition");
  assert.deepStrictEqual(parseSerial("Card #7/100"), { serial: 7, of: 100 });
  assert.deepStrictEqual(parseSerial("One of one 1/1"), { serial: 1, of: 1 });
  assert.strictEqual(baseName("Card #101/100"), "Card #101/100", "a name with no readable serial groups by its whole text");
  ok("R8-09/12 the base name keeps the issue number beside an edition fraction; impossible fractions parse as none");
}

// ================================================================ R8-10
// No assurance of absent royalties rests on a collection that was not read.
{
  const unread = deriveTrust({ kind: "asset", collection: address("r8-col"), plugins: [], updateAuthorityIsNone: false, externalPlugins: 0 });
  assert.strictEqual(unread.incomplete, true);
  assert.ok(!unread.assurances.some((a) => /No royalties plugin/.test(a)), `no definite absence over an unread collection: ${unread.assurances.join(" | ")}`);
  assert.ok(unread.warnings.some((w) => /cannot be settled/.test(w)));
  const adapter = deriveTrust({ kind: "asset", collection: null, plugins: [], updateAuthorityIsNone: false, externalPlugins: 1 });
  assert.ok(!adapter.assurances.some((a) => /nothing enforces a creator fee/.test(a)), "an unread adapter can gate transfers");
  const control = deriveTrust({ kind: "asset", collection: null, plugins: [], updateAuthorityIsNone: true, externalPlugins: 0 });
  assert.ok(control.assurances.some((a) => /No royalties plugin/.test(a)), "a complete read still states the absence");
  ok("R8-10 completeness is decided before any assurance built on absence");
}

// ================================================================ R8-13
// A day the window only half covers says so.
{
  const day = 86_400;
  const t0 = 1_700_000_000 - (1_700_000_000 % day);
  const noon = t0 + day / 2;
  const row = (n, at) => ({ type: "buyNow", signature: `d${n}`, tokenMint: `m${n}`, price: 1, blockTime: at, buyer: "b", seller: "s" });
  const s = summarizeSales([row(1, noon + 100), row(2, noon + day - 100)], { windowStartUnix: noon, windowEndUnix: noon + day });
  assert.strictEqual(s.daily.length, 2);
  assert.ok(s.daily.every((d) => d.partial === true), `both half days are partial: ${JSON.stringify(s.daily.map((d) => d.partial))}`);
  assert.strictEqual(s.daily[0].coveredFrom, new Date(noon * 1000).toISOString());
  assert.strictEqual(s.daily[0].coveredTo, new Date((t0 + day) * 1000).toISOString());
  assert.strictEqual(s.daily[1].coveredTo, new Date((noon + day + 1) * 1000).toISOString());
  assert.strictEqual(s.daily[0].currency, "SOL");
  const whole = summarizeSales([row(3, t0 + 100)], { windowStartUnix: t0, windowEndUnix: t0 + day - 1 });
  assert.strictEqual(whole.daily[0].partial, undefined, "a window ending 23:59:59 covers the whole day");
  ok("R8-13 every daily row carries the interval it covers; a window edge inside a day marks it partial");
}

// ================================================================ R8-14
// One observation, one timestamp: the producer's commit time is what every
// waiter and every later hit reports.
{
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  const key = `r8-cache-${realNow()}`;
  const first = await cached(key, 60_000, async () => {
    now += 250;
    return { v: 1 };
  });
  now += 10;
  const hit = await cached(key, 60_000, async () => ({ v: 2 }));
  Date.now = realNow;
  assert.deepStrictEqual(hit.data, first.data);
  assert.strictEqual(hit.cachedAt, first.cachedAt, `the hit reports the same observation time: ${first.cachedAt} vs ${hit.cachedAt}`);
  ok("R8-14 a cached observation has one timestamp");
}

// ================================================================ R8-18
// The feed is described by what it carried, not by a fixed list of absences.
{
  const t = 1_700_000_000;
  const row = (i, source) => ({ signature: signature(`v-${i}`), type: "buyNow", source, tokenMint: address(`vm-${i}`), price: 1, blockTime: t + i, buyer: address("b"), seller: address("s") });
  const s = summarizeSales([row(1, "magiceden_v2"), row(2, "tensortrade")], { windowStartUnix: t, windowEndUnix: t + 100 });
  assert.strictEqual(s.venues.length, 2);
  assert.ok(!/Tensor, OpenSea and peer-to-peer trades are not in it/.test(s.coverage.note), "no fixed absence claim");
  assert.ok(/tensortrade/.test(s.coverage.note), `the observed venues are named: ${s.coverage.note}`);
  assert.ok(/not established/.test(s.coverage.note), "coverage of other venues is stated as unknown");
  assert.strictEqual(s.venues[0].currency, "SOL");
  ok("R8-18 the coverage note names the venues observed and claims nothing about the rest");
}

// ================================================================ R8-04
// Custody starts unknown: the first transfer of an unobserved history is not
// "into escrow", and a mint whose transaction ran a marketplace program does
// not make the next recipient an escrow.
{
  const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
  const SYSTEM = "11111111111111111111111111111111";
  const ME_PROGRAM = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
  const MINT = "BA56URSgTmXFdh83i125szydnvVTuN8U1VSQSckqcnP2";
  const COLLECTION = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n";
  const coreFixture = fs.readFileSync(path.join(here, "fixtures", "core-asset.b64"), "utf8").trim();
  const coreIx = (data, newOwner) => ({ programId: CORE, accounts: [MINT, COLLECTION, address("payer"), address("authority"), newOwner, SYSTEM, CORE], data });
  const meIx = (...accounts) => ({ programId: ME_PROGRAM, accounts: [MINT, ...accounts], data: "1" });
  const tx = (instructions, logs) => ({ blockTime: 1_700_000_000, meta: { err: null, logMessages: logs, innerInstructions: [] }, transaction: { message: { accountKeys: [], instructions } } });
  const TRANSFER_LOG = ["Program log: Instruction: Transfer"];
  const CREATE_LOG = ["Program log: Instruction: Create"];
  const rpcFor = (host, txs) => {
    process.env.SOLANA_RPC_URL = `https://${host}.invalid`;
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).startsWith(process.env.SOLANA_RPC_URL)) throw new Error(`unexpected ${url}`);
      const body = JSON.parse(String(init.body));
      let result;
      if (body.method === "getAccountInfo") result = { context: { slot: 123 }, value: { owner: CORE, data: [coreFixture, "base64"] } };
      else if (body.method === "getSignaturesForAddress") result = txs.map((t) => ({ signature: t.signature, blockTime: 1_700_000_000, err: null }));
      else if (body.method === "getTransaction") result = txs.find((t) => t.signature === body.params[0])?.tx ?? null;
      else throw new Error(`unexpected method ${body.method}`);
      return json({ jsonrpc: "2.0", id: body.id, result });
    };
  };
  const buyer = address("r8-buyer");
  const pool = address("r8-pool");
  const escrow = address("r8-escrow");

  // No mint observed: one marketplace transaction naming the recipient.
  rpcFor("r8-no-mint", [{ signature: signature("r8-fill"), tx: tx([coreIx("F", buyer), meIx(buyer)], TRANSFER_LOG) }]);
  const bare = await sol.getProvenance(MINT, 15, { fresh: true });
  const got = bare.events.find((e) => e.newOwner === buyer);
  assert.ok(got);
  assert.strictEqual(got.escrowDirection, "unknown", `unobserved custody before it: ${got.label}`);
  assert.strictEqual(got.magicEdenEscrow, undefined);

  // Mint straight into a pool and a fill to the buyer, in one marketplace transaction.
  rpcFor("r8-pool-mint", [{ signature: signature("r8-pm"), tx: tx([coreIx("11", pool), meIx(buyer, pool), coreIx("F", buyer)], [...CREATE_LOG, ...TRANSFER_LOG]) }]);
  const pooled = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(pooled.mintObserved, true);
  const fill = pooled.events.find((e) => e.event === "transferred" && e.newOwner === buyer);
  assert.ok(fill);
  assert.notStrictEqual(fill.escrowDirection, "into", `the buyer of a pool mint is not an escrow: ${fill.label}`);

  // Control: a plain mint to a wallet, then a listing, still reads "into".
  rpcFor("r8-control", [
    { signature: signature("r8-list"), tx: tx([coreIx("F", escrow), meIx(escrow)], TRANSFER_LOG) },
    { signature: signature("r8-mint"), tx: tx([coreIx("11", address("minter"))], CREATE_LOG) },
  ]);
  const whole = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(whole.events.find((e) => e.newOwner === escrow).escrowDirection, "into");
  delete process.env.SOLANA_RPC_URL;
  globalThis.fetch = denied;
  ok("R8-04 custody is unknown until an observed mint or a plain transfer establishes it");
}

// ================================================================ R8-03 / R8-05 / R8-06 / R8-15 / R8-16
// Through a real server over stdio: the serial hunt honours the name filter
// and refuses a malformed ask, floors carry their currency and source, the
// two counters are not a burn count, and the OpenSea block always says what
// it is.
{
  const home = fs.mkdtempSync(path.join(tmpdir(), "collector-mcp-round8-"));
  const preload = pathToFileURL(path.join(here, "helpers", "siblings-preload.mjs")).href;
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist", "index.js")],
    env: { ...env, COLLECTOR_TEST_HOME: home, COLLECTOR_MCP_NO_AUTO_KEYS: "1", COLLECTOR_MCP_NO_UPDATE_CHECK: "1", SOLANA_RPC_URL: "https://r8-rpc.invalid", DAS_RPC_URL: "https://r8-rpc.invalid" },
    stderr: "ignore",
  });
  const c = new Client({ name: "round8", version: "1" }, { capabilities: {} });
  await c.connect(transport);
  const call = async (name, args) => (await c.callTool({ name, arguments: args }, undefined, { timeout: 30_000 })).structuredContent;

  const hunt = await call("find_listings", { symbol: "sibling-fixture", lowestSerials: true, nameContains: "Ohtani" });
  assert.strictEqual(hunt.mode, "lowest-serials");
  assert.strictEqual(hunt.filters.nameContains, "Ohtani");
  assert.ok(hunt.lowestSerials.length >= 1, JSON.stringify(hunt).slice(0, 300));
  assert.ok(hunt.lowestSerials.every((r) => /Ohtani/.test(r.name)), `only the filtered player: ${hunt.lowestSerials.map((r) => r.name).join(", ")}`);
  assert.strictEqual(hunt.coverage.nameMatches, 2);
  const broken = hunt.lowestSerials.find((r) => r.serial === 3);
  assert.ok(broken, "the malformed-ask listing is still observed");
  assert.strictEqual(broken.priceSol, null, `a -2 ask is not a price: ${broken.priceSol}`);
  assert.strictEqual(broken.vsFloor, null);
  assert.strictEqual(hunt.coverage.malformedPrices, 1);
  assert.strictEqual(hunt.lowestSerials[0].currency, "SOL");
  assert.strictEqual(hunt.floor.currency, "SOL");

  const floors = await call("get_floor_prices", { symbols: ["sibling-fixture"] });
  assert.strictEqual(floors.floors[0].currency, "SOL");
  assert.strictEqual(floors.floors[0].source, "magiceden");

  const stats = await call("get_collection_stats", { collection: "7chErGXMoYARjjmj9ZWrv7H415Bx1F3WrQt1nVFihuEa" });
  assert.ok(stats.onchain, JSON.stringify(stats).slice(0, 300));
  assert.strictEqual(stats.onchain.burnedOrClosed, undefined, "no burn count from two counters");
  assert.strictEqual(stats.onchain.sizeDelta, -1, `numMinted 10, currentSize 11: ${stats.onchain.sizeDelta}`);
  assert.match(stats.onchain.sizeDeltaNote, /moved/);

  const w = "BA56URSgTmXFdh83i125szydnvVTuN8U1VSQSckqcnP2";
  const act = await call("get_wallet_activity", { wallet: w, pages: 1 });
  assert.strictEqual(act.opensea.status, "not-read", JSON.stringify(act.opensea));
  assert.strictEqual(act.opensea.reason, "auto-keys-disabled");
  assert.strictEqual(act.magiceden.currency, "SOL");
  const off = await call("get_wallet_activity", { wallet: w, pages: 1, includeOpenSea: false });
  assert.strictEqual(off.opensea.status, "disabled");

  await c.close();
  fs.rmSync(home, { recursive: true, force: true });
  ok("R8-03/05/06/15/16 serial hunt filters by name and refuses a malformed ask; floors carry currency and source; counters are not burns; OpenSea always has a status");
}

console.log(`siblings: ${passed} blocks pass`);
