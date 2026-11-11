/**
 * Marketplace rows checked against the chain, offline.
 *
 * A child server runs with test/helpers/custody-preload.mjs, whose Magic Eden
 * book for one Core collection starts with listings the sellers no longer
 * hold: one moved to another wallet, one in an OpenSea listing account, one
 * burned, one held by another program's account. The cheapest listing that
 * can be bought is 0.2 SOL; Magic Eden reports 0.1. Each block also runs a
 * control (a backed row, a profile where the chain cannot be read) so a test
 * cannot pass by dropping everything or by trusting everything.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, ".."));
const dist = path.join(root, "dist");

const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encode = (b) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n) { s = chars[Number(n % 58n)] + s; n /= 58n; } return s; };
const key = (label) => encode(createHash("sha256").update(`custody-${label}`).digest());
const M = Object.fromEntries(["A", "B", "C", "D", "E", "F", "G", "H", "N"].map((k) => [k, key(`mint-${k}`)]));
const S = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [i, key(`seller-${i}`)]));
const LISTING_ACCOUNT = key("opensea-listing-account");
const MOVED_TO = key("new-wallet");
const COL = key("collection");
const OPENSEA = "7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

async function server(profile) {
  const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-custody-"));
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(here, "helpers", "custody-preload.mjs")).href, path.join(dist, "index.js")],
    env: {
      ...env,
      SOLANA_NFT_MCP_TEST_HOME: home,
      CUSTODY_PROFILE: profile,
      SOLANA_NFT_MCP_NO_AUTO_KEYS: "1",
      SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1",
      OPENSEA_API_KEY: ["custody", "fixture", "not", "a", "key"].join("-"),
      SOLANA_RPC_URL: "https://custody-rpc.invalid",
      DAS_RPC_URL: "https://custody-rpc.invalid",
    },
    stderr: "ignore",
  });
  const c = new Client({ name: "custody", version: "1" }, { capabilities: {} });
  await c.connect(transport);
  return {
    call: async (name, args) => {
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      return r.structuredContent;
    },
    close: async () => {
      await c.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------ pure parts
const { reconcileFloors } = await import(pathToFileURL(path.join(dist, "lib", "reconcile.js")).href);

await check("one listing relayed by two marketplaces is not a spread", () => {
  const me = { source: "magiceden", value: 0.175, currency: "SOL", listing: { mint: M.A, maker: S[1] } };
  const os = { source: "opensea", value: 0.196, currency: "SOL", listing: { mint: M.A, maker: S[1] } };
  const r = reconcileFloors([me, os]);
  assert.match(r.verdict, /same item from the same seller/);
  assert.doesNotMatch(r.verdict, /12% higher/);
  assert.equal(r.spreadPct, undefined);
  // Control: a different maker is two listings, and the spread stands.
  const r2 = reconcileFloors([me, { ...os, listing: { mint: M.A, maker: S[2] } }]);
  assert.match(r2.verdict, /12% higher/);
  assert.doesNotMatch(r2.verdict, /same item/);
  // OpenSea relaying one of Magic Eden's other listings is named, but the two
  // floors are still different asks and are still compared.
  const r3 = reconcileFloors([{ ...me, listing: { mint: M.D, maker: S[4] }, alsoListed: [{ mint: M.A, maker: S[1] }] }, os]);
  assert.match(r3.verdict, /a listing magiceden also shows/);
  assert.match(r3.verdict, /12% higher/);
});

await check("a floor whose listing the chain shows is stale is never ranked", () => {
  const r = reconcileFloors([
    { source: "magiceden", value: 0.2, currency: "SOL", listingCustody: "backed" },
    { source: "opensea", value: 0.112, currency: "SOL", listingCustody: "not-backed" },
  ]);
  assert.equal(r.comparable, false);
  assert.doesNotMatch(r.verdict, /Lowest reported by opensea/);
  assert.match(r.caveats.join(" "), /no longer held by its seller/);
});

await check("a budget returns what finished and marks the rest not read", async () => {
  const slow = (ms, v) => (signal) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(v), ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
  const custody = await import(pathToFileURL(path.join(dist, "lib", "custody.js")).href);
  const started = Date.now();
  const out = await custody.withinBudget(150, [slow(20, "a"), slow(20, "b"), slow(1000, "c"), slow(20, "d")], (_s, fn) => fn());
  assert(Date.now() - started < 600, "the budget did not hold");
  assert.deepEqual(out.slice(0, 2).map((r) => r.done && r.value), ["a", "b"]);
  assert.equal(out[2].done, false);
  assert.equal(out[2].timedOut, true);
  assert.equal(out[3].timedOut, true);
});

// ------------------------------------------------------------ through the server
const s = await server("normal");
try {
  await check("get_floor_prices publishes the cheapest backed ask beside the venue's figure", async () => {
    const r = await s.call("get_floor_prices", { symbols: ["custody-a", "custody-b", "custody-c", "custody-d", "custody-e", "custody-f"] });
    const first = r.floors[0];
    assert.equal(first.floorSol, 0.2);
    assert.equal(first.venueReportedFloorSol, 0.1);
    assert.equal(first.listingValidityChecked, true);
    assert.equal(first.floorCheck.staleBelowFloor, 3);
    assert.match(first.floorCheck.sentence, /3 cheaper listing/);
    const sixth = r.floors[5];
    assert.equal(sixth.floorSol, 0.1, "past the first five, the venue's figure is kept");
    assert.equal(sixth.listingValidityChecked, false);
    assert.match(sixth.floorCheck.sentence, /Ask for fewer at once/i);
  });

  await check("find_listings leaves stale rows out of the deals and the trait floors", async () => {
    const r = await s.call("find_listings", { symbol: "custody-fixture", limit: 20 });
    const mints = r.deals.map((d) => d.tokenMint);
    for (const k of ["A", "B", "C", "G"]) assert(!mints.includes(M[k]), `stale listing ${k} is still a deal`);
    for (const k of ["D", "E", "F"]) assert(mints.includes(M[k]), `listing ${k} was dropped`);
    assert.equal(r.staleListings.count, 4);
    assert.deepEqual(r.staleListings.byReason, { moved: 1, "opensea-listing": 1, burned: 1, "other-program": 1 });
    assert.match(r.staleListings.examples.find((e) => e.tokenMint === M.B).why, /OpenSea listing account/);
    const f = r.deals.find((d) => d.tokenMint === M.F);
    assert.equal(f.chainCheck.state, "not-checked", "a non-Core row is marked, not guessed");
    const d = r.deals.find((x) => x.tokenMint === M.D);
    assert.equal(d.chainCheck.state, "backed");
    // Gold's venue floor is stale listing A at 0.1; the next backed Gold ask is D.
    assert.equal(d.traits.find((t) => t.value === "Gold").traitFloorSol, 0.2);
    const e = r.deals.find((x) => x.tokenMint === M.E);
    assert.equal(e.traits.find((t) => t.value === "Red").traitFloorSol, 0.25);
    assert.equal(r.traitFloorCheck.replaced, 2);
  });

  await check("lowest serials skip stale rows and measure against the backed floor", async () => {
    const r = await s.call("find_listings", { symbol: "custody-fixture", lowestSerials: true, limit: 3 });
    assert.deepEqual(r.lowestSerials.map((x) => x.serial), [4, 5, 6]);
    assert.equal(r.lowestSerials[0].vsFloor.floorSol, 0.2);
    assert.equal(r.lowestSerials[1].vsFloor.multiple, 1.25);
    assert.equal(r.staleListings.count, 4);
    assert.equal(r.floor.venueReportedFloorSol, 0.1);
  });

  await check("verify_claim floor judges the backed floor and never confirms a stale one", async () => {
    const stale = await s.call("verify_claim", { claim: "floor", subject: "custody_fixture", value: 0.1 });
    assert.equal(stale.verdict, "contradicted");
    assert.doesNotMatch(stale.receipt, /^CONFIRMED/);
    assert.match(stale.explanation, /seller no longer holds/);
    const real = await s.call("verify_claim", { claim: "floor", subject: "custody_fixture", value: 0.2 });
    assert.equal(real.verdict, "confirmed");
  });

  await check("get_collection_stats checks the floor and names a relayed stale listing", async () => {
    const r = await s.call("get_collection_stats", { collection: "custody-fixture", openseaSlug: "custody-os" });
    assert.equal(r.market.floorPriceSol, 0.2);
    assert.equal(r.market.venueReportedFloorSol, 0.1);
    assert.equal(r.opensea.floorListing.custody, "not-backed");
    assert.match(r.reconciliation.verdict, /same item from the same seller/);
    assert.match(r.reconciliation.verdict, /no longer held by its seller/);
  });

  await check("get_asset reports a leftover listing and an OpenSea listing account", async () => {
    const a = await s.call("get_asset", { mint: M.A });
    assert.equal(a.market.listed, false);
    assert.equal(a.market.priceSol, null);
    assert.equal(a.market.staleMarketRow.ownerOnRecord, S[1]);
    assert.match(a.market.staleMarketRow.sentence, /left over from a previous owner/);
    assert.match(a.ownerAgreement, /Magic Eden's record names a different owner/);
    const b = await s.call("get_asset", { mint: M.B });
    assert.equal(b.onchain.heldIn, "opensea-listing-account");
    assert.match(b.onchain.note, /OpenSea listing account/);
    assert.match(b.market.staleMarketRow.sentence, /listed on OpenSea now/);
    // Control: the seller still holds E, so its row stands.
    const e = await s.call("get_asset", { mint: M.E });
    assert.equal(e.market.listed, true);
    assert.equal(e.market.staleMarketRow, undefined);
    assert.match(e.ownerAgreement, /same owner as the chain/);
  });

  await check("get_asset fills a new item's empty marketplace record from the asset index", async () => {
    const n = await s.call("get_asset", { mint: M.N });
    assert.match(n.market.metadataNote, /no metadata for this item yet/);
    assert.equal(n.market.image, "https://example.com/N.png");
    assert.deepEqual(n.market.attributes, [{ trait: "Background", value: "Blue" }]);
  });

  await check("a burned Core item is called burned, with the last holder named as history", async () => {
    const t = await s.call("get_asset_trust", { mint: M.C });
    assert.equal(t.burned, true);
    assert.match(t.explanation, /was burned/);
    assert.match(t.explanation, new RegExp(`${S[3]}, is the last holder before the burn`));
    const a = await s.call("get_asset", { mint: M.C });
    assert.equal(a.onchain.burned, true);
    assert.match(a.onchain.note, /last holder before the burn/);
    // Magic Eden's index still carries the burned item as listed. That row
    // must not come back as a live listing with a price.
    if (a.market) {
      assert.equal(a.market.listed, false, "a burned item is shown as listed");
      assert.equal(a.market.priceSol, null);
    }
  });

  await check("get_wallet_holdings leads with what the wallet holds now", async () => {
    const r = await s.call("get_wallet_holdings", { wallet: S[1] });
    assert.equal(r.heldNow.held, 1);
    assert.equal(r.heldNow.noLongerHeld, 1);
    assert.match(r.ownershipNote, /^1 of the 2 distinct item/);
    assert.deepEqual(r.magicEden.tokens.map((t) => t.mint), [M.H]);
    assert.equal(r.magicEden.noLongerHeld[0].mint, M.A);
    assert.equal(r.chainIndex.items[0].heldNow, true);
  });

  await check("verify_claim ownership does not contradict the seller of a listing", async () => {
    const b = await s.call("verify_claim", { claim: "ownership", subject: M.B, wallet: S[2] });
    assert.equal(b.verdict, "unverifiable");
    assert.match(b.explanation, /OpenSea listing account/);
    // Controls: the seller still holding it confirms; a plain move contradicts.
    assert.equal((await s.call("verify_claim", { claim: "ownership", subject: M.E, wallet: S[5] })).verdict, "confirmed");
    assert.equal((await s.call("verify_claim", { claim: "ownership", subject: M.A, wallet: S[1] })).verdict, "contradicted");
  });

  await check("holders, identify and provenance name OpenSea's listing account", async () => {
    const h = await s.call("get_collection_holders", { collection: COL });
    const row = h.holders.find((x) => x.owner === LISTING_ACCOUNT);
    assert.equal(row.role, "opensea-listing");
    assert.equal(h.heldInOpenSeaListings, 1);
    assert.equal(h.holders.find((x) => x.owner === MOVED_TO).role, "wallet");
    const p = await s.call("identify", { query: OPENSEA });
    assert.match(p.summary, /OpenSea's Solana protocol program/);
    const l = await s.call("identify", { query: LISTING_ACCOUNT });
    assert.equal(l.kind, "venue-account");
    assert.match(l.summary, /OpenSea's Solana protocol program/);
    const prov = await s.call("get_asset_provenance", { mint: M.B, depth: 5 });
    const into = prov.events.find((e) => e.event === "transferred");
    assert.equal(into.marketplace, "OpenSea");
    assert.equal(into.openSeaListing, "into");
    assert.match(prov.currentOwnerNote, /OpenSea/);
  });
} finally {
  await s.close();
}

// ------------------------------------------------------------ the chain cannot be read
const down = await server("rpc-down");
try {
  await check("an unread custody check keeps the venue's floor and says it was not checked", async () => {
    const r = await down.call("get_floor_prices", { symbols: ["custody-fixture"] });
    assert.equal(r.floors[0].floorSol, 0.1);
    assert.equal(r.floors[0].listingValidityChecked, false);
    assert.equal(r.floors[0].floorCheck.status, "unread");
    const l = await down.call("find_listings", { symbol: "custody-fixture", limit: 20 });
    assert.equal(l.deals.length, 7, "unread rows stay");
    assert(l.deals.every((d) => d.chainCheck.state === "unread"));
    assert.equal(l.staleListings, undefined);
    const v = await down.call("verify_claim", { claim: "floor", subject: "custody_fixture", value: 0.1 });
    assert.equal(v.verdict, "unverifiable");
  });
} finally {
  await down.close();
}

console.log(`custody: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
