/**
 * Offline regressions for the hardening pass.
 *
 * One test per finding, each named with the failure it prevents rather than
 * the function it calls. Everything here runs against the BUILT output with no
 * network: the two tests that need an upstream stub `globalThis.fetch` and
 * restore it afterwards.
 */
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSerial, dedupeEvents, summarizeSales, applyNameFilter, fallbackIdentity } from "../dist/market.js";
import { objectRows, assertPageSize } from "../dist/lib/shapes.js";
import { fetchJson } from "../dist/lib/http.js";
import { verifyClaim } from "../dist/verify.js";
import * as das from "../dist/sources/das.js";
import * as me from "../dist/sources/magiceden.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};

// ------------------------------------------------------------------ a15
// "Batman (2011/2016) #10041" used to parse as serial 2011 of 2016 and outrank
// the real #1 in lowest-serial mode.
{
  assert.deepStrictEqual(parseSerial("Batman (2011-2016) #1"), { serial: 1, of: null });
  assert.deepStrictEqual(parseSerial("Batman (2011/2016) #10041"), { serial: 10041, of: null });
  assert.deepStrictEqual(parseSerial("Card 3 of 10"), { serial: 3, of: 10 });
  assert.deepStrictEqual(parseSerial("1/1"), { serial: 1, of: 1 });
  assert.deepStrictEqual(parseSerial("#10041"), { serial: 10041, of: null });
  assert.deepStrictEqual(parseSerial("Shohei Ohtani (12/250)"), { serial: 12, of: 250 });
  assert.deepStrictEqual(parseSerial("Claynosaurz #9"), { serial: 9, of: null });
  assert.strictEqual(parseSerial("no numbers here"), null);
  assert.strictEqual(parseSerial(null), null);
  ok("a15 parseSerial: a year range in brackets is never read as a serial");
}

// ------------------------------------------------------------------ a10
// The sparse first copy of a hydrating fill used to win, so the price that
// arrived on the second copy was thrown away and P&L went to zero.
{
  const merged = dedupeEvents([
    { signature: "sigA", tokenMint: "mintA", type: "buyNow", price: null, buyer: null },
    { signature: "sigA", tokenMint: "mintA", type: "buyNow", price: 1, buyer: "B" },
  ]);
  assert.strictEqual(merged.events.length, 1, "one fill answered twice is one event");
  assert.strictEqual(merged.events[0].price, 1, "the populated price must survive the merge");
  assert.strictEqual(merged.events[0].buyer, "B", "a filled-in buyer must survive the merge");
  assert.strictEqual(merged.duplicates, 1);
  assert.strictEqual(merged.unsettled, 0, "an additive merge is not a conflict");

  const clash = dedupeEvents([
    { signature: "sigB", tokenMint: "mintB", type: "buyNow", price: 1 },
    { signature: "sigB", tokenMint: "mintB", type: "buyNow", price: 9 },
  ]);
  assert.strictEqual(clash.events.length, 1);
  assert.strictEqual(clash.unsettled, 1, "two populated prices that disagree are unsettled");
  assert.strictEqual(clash.events[0].unsettled, true, "the event carries the mark downstream");
  ok("a10 dedupe merges hydration fields and marks real conflicts unsettled");
}

// An unsettled event counts as a sale and never as volume.
{
  const at = 1_700_000_000;
  const s = summarizeSales(
    [
      { signature: "s1", tokenMint: "m1", type: "buyNow", price: 1, blockTime: at },
      { signature: "s1", tokenMint: "m1", type: "buyNow", price: 5, blockTime: at },
    ],
    { windowStartUnix: at - 10, windowEndUnix: at + 10 },
  );
  assert.strictEqual(s.sales, 1, "one fill, answered twice");
  assert.strictEqual(s.volumeSol, 0, "a contested price contributes no volume");
  assert.strictEqual(s.coverage.unsettled, 1);
  ok("a10 an event whose copies disagree is a sale with no money attached");
}

// ------------------------------------------------------------------ a11
// Identical unsigned rows repeated across pages used to double the sales count.
{
  const row = { tokenMint: "mintC", type: "buyNow", buyer: "B", seller: "S", price: 2, blockTime: 1_700_000_000 };
  assert.ok(fallbackIdentity(row), "an unsigned row with fields has a fallback identity");
  assert.strictEqual(fallbackIdentity({}), null, "a row with nothing to identify it is left alone");

  const d = dedupeEvents([{ ...row }, { ...row }]);
  assert.strictEqual(d.events.length, 1, "the same unsigned fill twice is one fill");
  assert.strictEqual(d.identityFallbacks, 2, "both unsigned rows relied on the weaker identity, and both are reported");

  const different = dedupeEvents([{ ...row }, { ...row, tokenMint: "mintD" }]);
  assert.strictEqual(different.events.length, 2, "different items are different sales");
  ok("a11 unsigned rows get a reported fallback identity");
}

// ------------------------------------------------------------------ a12
// A buy at -1 and a sale at 1 used to report a negative purchase total and a
// 2 SOL profit.
{
  const at = 1_700_000_000;
  const s = summarizeSales(
    [
      { signature: "n1", tokenMint: "m1", type: "buyNow", price: -1, blockTime: at },
      { signature: "n2", tokenMint: "m2", type: "buyNow", price: Number.POSITIVE_INFINITY, blockTime: at },
      { signature: "n3", tokenMint: "m3", type: "buyNow", price: 0, blockTime: at },
      { signature: "n4", tokenMint: "m4", type: "buyNow", price: 2, blockTime: at },
    ],
    { windowStartUnix: at - 10, windowEndUnix: at + 10 },
  );
  assert.strictEqual(s.sales, 4, "every completed sale is still counted");
  assert.strictEqual(s.pricedSales, 1, "only the finite positive price is money");
  assert.strictEqual(s.volumeSol, 2, "nothing negative or infinite reaches the total");
  assert.ok(Number.isFinite(s.volumeSol) && Number.isFinite(s.averageSol));
  assert.strictEqual(s.coverage.malformedPrices, 3, "the rejected rows are counted and named");
  ok("a12 negative, zero and infinite prices are malformed, never arithmetic");
}

// ------------------------------------------------------------------ a5
// A stale feed must not describe the window up to now.
{
  const at = 1_700_000_000;
  const live = summarizeSales([], { windowStartUnix: at - 10, windowEndUnix: at, stale: false });
  assert.strictEqual(live.freshness.stale, false);
  assert.ok(/everything Magic Eden held for the window at the moment of this read/.test(live.coverage.note));

  const stale = summarizeSales([], { windowStartUnix: at - 10, windowEndUnix: at, stale: true, cachedAt: "2026-09-12T00:00:00.000Z" });
  assert.strictEqual(stale.freshness.stale, true);
  assert.strictEqual(stale.freshness.coversUpTo, "2026-09-12T00:00:00.000Z", "a cached read covers up to when it was taken");
  assert.ok(/LAST-KNOWN/.test(stale.coverage.note), "a stale read says so in words");
  assert.ok(!/everything Magic Eden held/.test(stale.coverage.note), "and never claims complete coverage");
  ok("a5 a stale feed is labelled last-known and never called complete");
}

// ------------------------------------------------------------------ a4
// A failed name lookup must not answer "zero matching sales".
{
  const events = [{ tokenMint: "m1", type: "buyNow", price: 1, blockTime: 1 }];
  const names = new Map([["m1", { name: "Shohei Ohtani (12/250)" }]]);

  const applied = applyNameFilter(events, names, "ohtani");
  assert.strictEqual(applied.status, "applied");
  assert.strictEqual(applied.events.length, 1);

  const unavailable = applyNameFilter(events, null, "ohtani");
  assert.strictEqual(unavailable.status, "unavailable", "no index means the filter could not run");
  assert.strictEqual(unavailable.events, null, "and there is NO filtered set to mistake for an answer");

  const none = applyNameFilter(events, names, "batman");
  assert.strictEqual(none.status, "applied");
  assert.strictEqual(none.events.length, 0, "a real zero is still a real zero");
  ok("a4 a failed name lookup is unavailable, never an empty filtered result");
}

// ------------------------------------------------------------------ a1
// 1e400 arrives as Infinity and used to confirm "within 2%" against anything.
{
  const floor = await verifyClaim({ claim: "floor", subject: "mad_lads", value: Number.POSITIVE_INFINITY });
  assert.strictEqual(floor.verdict, "unverifiable", "an infinite claim cannot be confirmed");
  assert.ok(/not a finite number above zero/.test(floor.explanation));

  const supply = await verifyClaim({ claim: "supply", subject: "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K", value: Number.POSITIVE_INFINITY });
  assert.strictEqual(supply.verdict, "unverifiable");
  ok("a1 an infinite claimed value is refused before any comparison");
}

// ------------------------------------------------------------------ b11
// One null row used to crash a mapper and return nothing at all.
{
  assert.throws(() => objectRows("Venue", "listings", [null]), /malformed row/);
  assert.throws(() => objectRows("Venue", "listings", [{}, "text"]), /malformed row/);
  assert.throws(() => objectRows("Venue", "listings", [[]]), /malformed row/);
  assert.throws(() => objectRows("Venue", "listings", { items: [] }), /unexpected shape/);
  assert.deepStrictEqual(objectRows("Venue", "listings", [{ a: 1 }]), [{ a: 1 }]);
  assert.deepStrictEqual(objectRows("Venue", "listings", []), [], "an empty page is a legitimate answer");
  ok("b11 a malformed row is an upstream failure, not an empty result");
}

// ------------------------------------------------------------------ b13
{
  assert.throws(() => assertPageSize("Venue", "listings", new Array(200).fill({}), 100), /not honouring its own page size/);
  assert.doesNotThrow(() => assertPageSize("Venue", "listings", new Array(100).fill({}), 100));
  ok("b13 a page bigger than requested is refused before anything maps over it");
}

// ------------------------------------------------------------------ helpers
const realFetch = globalThis.fetch;
const restore = () => {
  globalThis.fetch = realFetch;
};
const jsonResponse = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

// ------------------------------------------------------------------ b1
// A hostile endpoint declaring gigabytes used to be buffered in full.
{
  let sent = 0;
  globalThis.fetch = () => {
    sent++;
    // Declared far above the 4 MB ceiling. The body is small on purpose: the
    // test is that the DECLARATION alone is enough to refuse it, without the
    // bytes ever being read.
    return Promise.resolve(jsonResponse({ ok: true }, { "content-length": String(8 * 1024 * 1024 * 1024) }));
  };
  try {
    await assert.rejects(
      fetchJson("Hostile venue", "https://example.invalid/huge", {}, { retries: 0 }),
      /refuses bodies over 4 MB/,
      "a declared 8 GB body must be refused",
    );
    assert.strictEqual(sent, 1, "and refused without retrying it");
  } finally {
    restore();
  }

  // No Content-Length at all: the stream itself has to be counted.
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull(controller) {
            // 1 MB per pull; the reader must abort once past 4 MB.
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  try {
    await assert.rejects(
      fetchJson("Hostile venue", "https://example.invalid/stream", {}, { retries: 0 }),
      /more than 4 MB of body/,
      "an undeclared endless body must be aborted at the limit",
    );
  } finally {
    restore();
  }
  ok("b1 an oversized body is refused by declaration and aborted by stream");
}

// ------------------------------------------------------------------ b12
// [A,B,C] and [A,X,C] used to share a cache key, so X was served B's row,
// dropped by the identity check, and reported unresolved for ten minutes.
{
  const A = "11111111111111111111111111111112";
  const B = "11111111111111111111111111111113";
  const C = "11111111111111111111111111111114";
  const X = "11111111111111111111111111111115";
  const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";
  const asset = (id, name) => ({ id, interface: "MplCoreAsset", content: { metadata: { name } } });

  const batches = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "getAsset") return jsonResponse({ jsonrpc: "2.0", id: 1, result: { id: body.params.id } });
    if (body.method === "getAssetBatch") {
      const ids = body.params.ids;
      batches.push(ids.join(","));
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: ids.map((id) => asset(id, `name-${id.slice(-1)}`)) });
    }
    throw new Error(`unexpected method ${body.method}`);
  };
  try {
    assert.ok(CANARY.length > 0);
    const first = await das.getAssetNames([A, B, C]);
    assert.strictEqual(first.names.size, 3);
    const second = await das.getAssetNames([A, X, C]);
    assert.strictEqual(second.names.size, 3, "a different id set must not be served the first set's rows");
    assert.ok(second.names.has(X), `${X} must resolve, not be reported unresolved from a colliding cache key`);
    assert.strictEqual(second.unresolved, 0);
    assert.strictEqual(batches.length, 2, "the second, different chunk must actually be requested");
    assert.notStrictEqual(batches[0], batches[1]);
  } finally {
    restore();
  }
  ok("b12 a different id chunk gets a different cache key");
}

// ------------------------------------------------------------------ b13 (live path)
// The same rule, through a real source: a venue over-serving a page is refused.
{
  globalThis.fetch = () => Promise.resolve(jsonResponse(new Array(250).fill({ tokenMint: "m", price: 1 })));
  try {
    await assert.rejects(
      me.collectionListings("some_collection_probe_b13", { limit: 100, offset: 0 }),
      /not honouring its own page size/,
      "250 listings for a request of 100 must be refused, not appended",
    );
  } finally {
    restore();
  }
  ok("b13 an over-served listings page is refused at the source boundary");
}

// ------------------------------------------------------------------ b14
// Three raw NUL bytes used as join separators made git classify the largest
// source file as BINARY: `git show --stat` printed "Bin 30018 -> 38819 bytes"
// and --numstat printed "- -", so every change to it was undiffable in git, on
// GitHub and in review. The escape `\u0000` is the same byte at runtime and
// leaves the file as text.
{
  const roots = [join(here, "..", "src"), join(here, "..", "test"), join(here, "..", "scripts")];
  const offenders = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|mjs|js|json)$/.test(entry.name)) continue;
      scanned++;
      const bytes = readFileSync(full);
      const nuls = bytes.filter((b) => b === 0).length;
      if (nuls > 0) offenders.push(`${full} (${nuls} raw NUL byte${nuls === 1 ? "" : "s"})`);
    }
  };
  for (const r of roots) walk(r);
  assert.ok(scanned > 20, `the scan must actually have read the tree, saw ${scanned} files`);
  assert.deepStrictEqual(
    offenders,
    [],
    `a raw NUL byte makes git treat the file as binary and undiffable - write the escape \\u0000 inside the string literal instead:\n  ${offenders.join("\n  ")}`,
  );
  ok(`b14 no source file carries a raw NUL byte (${scanned} files scanned)`);
}

// ------------------------------------------------------------------ b15
// get_wallet_holdings asks two readers. When both failed, the escrow answer
// Magic Eden gave was wrapped in a plain Error, so the wording layer said
// "try again" about an address that will never list, and the reason was cut
// off in the detail. The typed failure has to survive the join.
{
  const { EscrowError, TypedError, firstTypedFailure } = await import("../dist/lib/errors.js");
  const escrow = new EscrowError("Magic Eden will not list holdings for X - it blocks this address");
  const busy = new Error("the public Solana RPC asset index (DAS) did not answer");
  const settled = (a, b) => [
    { status: "rejected", reason: a },
    { status: "rejected", reason: b },
  ];
  assert.strictEqual(firstTypedFailure(settled(escrow, busy)), escrow, "the escrow reason wins over a busy index");
  assert.strictEqual(firstTypedFailure(settled(busy, escrow)), escrow, "order of the readers does not matter");
  assert.ok(firstTypedFailure(settled(escrow, busy)) instanceof TypedError);
  assert.strictEqual(firstTypedFailure(settled(busy, new Error("x"))), null, "two plain failures stay a plain failure");
  assert.strictEqual(firstTypedFailure([{ status: "fulfilled", value: 1 }, { status: "rejected", reason: escrow }]), escrow);
  assert.strictEqual(firstTypedFailure([]), null);
  ok("b15 a typed failure from either wallet reader survives both readers failing");
}

// ------------------------------------------------------------------ b16
// A server on someone else's machine cannot tell them it is stale unless it
// checks. The check must never throw, never run offline, and only speak when
// the registry's version is actually newer.
{
  const { checkForUpdate, resetUpdateCheck, compareVersions, updateNotice } = await import("../dist/lib/update.js");
  assert.strictEqual(compareVersions("1.9.0", "1.8.2"), 1);
  assert.strictEqual(compareVersions("1.8.2", "1.10.0"), -1);
  assert.strictEqual(compareVersions("v2.0.0", "2.0.0"), 0);
  assert.strictEqual(compareVersions("garbage", "1.0.0"), 0, "an unreadable version compares as equal, never as newer");

  const stub = (version, status = 200) => async () => ({ ok: status === 200, status, json: async () => ({ version }) });
  const saved = process.env.COLLECTOR_MCP_OFFLINE;

  process.env.COLLECTOR_MCP_OFFLINE = "1";
  resetUpdateCheck();
  let u = await checkForUpdate("1.8.2", { fetch: () => { throw new Error("must not be called offline"); } });
  assert.strictEqual(u.checked, false);
  assert.strictEqual(u.behind, false);
  assert.strictEqual(updateNotice(u), null);
  delete process.env.COLLECTOR_MCP_OFFLINE;

  resetUpdateCheck();
  u = await checkForUpdate("1.8.2", { fetch: stub("1.9.0") });
  assert.strictEqual(u.behind, true);
  assert.strictEqual(u.latest, "1.9.0");
  assert.match(updateNotice(u), /1\.8\.2 is behind: 1\.9\.0 is published/);
  assert.match(u.howTo, /npm run build/);

  resetUpdateCheck();
  u = await checkForUpdate("1.8.2", { fetch: stub("0.0.1") });
  assert.strictEqual(u.behind, false, "a placeholder older than the running build is not an update");
  assert.strictEqual(updateNotice(u), null);

  resetUpdateCheck();
  u = await checkForUpdate("1.8.2", { fetch: async () => { throw new Error("ENOTFOUND registry.npmjs.org"); } });
  assert.strictEqual(u.behind, false);
  assert.match(u.reason, /not reachable/);
  assert.strictEqual(updateNotice(u), null, "an unreachable registry says nothing");

  resetUpdateCheck();
  const first = checkForUpdate("1.8.2", { fetch: stub("1.9.0") });
  const second = checkForUpdate("1.8.2", { fetch: () => { throw new Error("asked twice"); } });
  assert.strictEqual(await first, await second, "one process asks the registry once");

  if (saved !== undefined) process.env.COLLECTOR_MCP_OFFLINE = saved;
  resetUpdateCheck();
  ok("b16 the update check speaks only when the registry is newer, never offline, never twice, never by throwing");
}

// ------------------------------------------------------------------ b17
// The three OpenSea reads added in 1.8.4 parse defensively: a missing list is
// a shape change (throw, named), a bad row is skipped, a duplicate trait value
// in two currencies keeps the SOL one, OpenSea's own percentage is ignored in
// favour of a share computed from a supply the caller vouches for, and an
// empty floor series is a null summary rather than NaN arithmetic.
{
  const os = await import("../dist/sources/opensea.js");
  const realFetch = globalThis.fetch;
  const savedKey = process.env.OPENSEA_API_KEY;
  process.env.OPENSEA_API_KEY = "test-key-never-sent";
  os.resetKeyCache();
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const routes = new Map();
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [path, body] of routes) if (u.includes(path)) return json(body);
    return new Response("{}", { status: 404 });
  };
  try {
    routes.set("/traits/tf-test/floors", { chain: "solana", floors: [
      { trait_type: "Hat", value: "Crown", floor_price: 2.5, payment_token_symbol: "USDC" },
      { trait_type: "Hat", value: "Crown", floor_price: 0.01, payment_token_symbol: "SOL" },
      { trait_type: "Hat", value: "None", floor_price: "bad" },
      { trait_type: 7, value: "x", floor_price: 1 },
    ] });
    const tf = await os.traitFloors("tf-test");
    assert.strictEqual(tf.count, 1, "one usable trait value survives");
    assert.deepStrictEqual(tf.floors.get("Hat::Crown"), { traitType: "Hat", value: "Crown", floor: 0.01, currency: "SOL" }, "the SOL quote wins over the USDC one");

    routes.set("/traits/tf-empty/floors", { chain: "solana" });
    await assert.rejects(os.traitFloors("tf-empty"), /no trait floor list/, "a missing list is a named shape change");

    routes.set("/collections/fh-test/floor_prices", { floor_prices: [
      { time: 1_700_000_100, token_unit: 2.0, usd_price: "300" },
      { time: 1_700_000_000, token_unit: 1.0, usd_price: "150" },
      { time: 1_700_000_200, token_unit: 1.5 },
      { time: "nope", token_unit: 9 },
    ] });
    const fh = await os.floorHistory("fh-test", "7d");
    assert.strictEqual(fh.points.length, 3, "the unreadable point is dropped");
    assert.strictEqual(fh.summary.start, 1.0, "points are ordered by time, not by arrival");
    assert.strictEqual(fh.summary.end, 1.5);
    assert.strictEqual(fh.summary.high, 2.0);
    assert.strictEqual(fh.summary.changePct, 50);

    routes.set("/collections/fh-empty/floor_prices", { floor_prices: [] });
    const empty = await os.floorHistory("fh-empty", "7d");
    assert.strictEqual(empty.summary, null, "no samples is a null summary, never NaN");

    routes.set("/collections/h-test/holders", { holders: [
      { address: "A".repeat(32), quantity: 250, percentage: 0 },
      { address: "B".repeat(32), quantity: 50, percentage: 0 },
      { address: 5, quantity: 1 },
    ] });
    const h = await os.holders("h-test", 10, 1000);
    assert.strictEqual(h.top.length, 2);
    assert.strictEqual(h.top[0].sharePct, 25, "share comes from the supply the caller passed, not OpenSea's zero");
    assert.strictEqual(h.topCombinedSharePct, 30);
    const h2 = await os.holders("h-test", 10, null);
    assert.strictEqual(h2.top[0].sharePct, null, "no supply, no share, no guess");
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.OPENSEA_API_KEY;
    else process.env.OPENSEA_API_KEY = savedKey;
    os.resetKeyCache();
  }
  ok("b17 OpenSea trait floors, floor history and holders parse defensively and never invent a share");
}

// ------------------------------------------------------------------ b18
// Every Candy Digital collection is in the registry from the tracker export:
// unique ids, valid Core addresses, findable by a plain name, and the
// hand-written entries are not duplicated by the generated ones.
{
  const { REGISTRY, searchRegistry } = await import("../dist/registry.js");
  const candy = REGISTRY.filter((e) => e.id.startsWith("candy-") && e.coreCollection);
  assert.ok(candy.length >= 398, `expected every Candy collection, saw ${candy.length}`);
  const ids = new Set(REGISTRY.map((e) => e.id));
  assert.strictEqual(ids.size, REGISTRY.length, "registry ids are unique");
  const cores = REGISTRY.map((e) => e.coreCollection).filter(Boolean);
  assert.strictEqual(new Set(cores).size, cores.length, "no Core address appears twice");
  for (const e of candy) assert.match(e.coreCollection, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `bad address on ${e.id}`);
  const hit = searchRegistry("leadoff icons 2022");
  assert.ok(hit.some((e) => /2022 Leadoff ICONs/.test(e.name)), "a Candy collection is found by its plain name");
  const gold = REGISTRY.find((e) => e.coreCollection === "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K");
  assert.strictEqual(gold.id, "candy-mlb-gold-auction-1", "the hand-written Gold entry wins over the generated one");
  ok(`b18 the registry carries every Candy collection (${candy.length} generated, ${REGISTRY.length} total) with unique ids and addresses`);
}

// ------------------------------------------------------------------ b19
// COLLECTOR_MCP_LOG=1 writes one JSON line per tool call to stderr, with the
// tool name, timing, outcome and argument NAMES only. Nothing reaches stdout.
{
  const { spawn } = await import("node:child_process");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, COMSPEC: process.env.COMSPEC, COLLECTOR_MCP_OFFLINE: "1", COLLECTOR_MCP_LOG: "1" };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "pipe" });
  let stderr = "";
  const client = new Client({ name: "log-test", version: "1.0.0" });
  await client.connect(transport);
  transport.stderr.on("data", (b) => { stderr += String(b); });
  await client.callTool({ name: "explain_mechanics", arguments: { topic: "escrow" } }).catch(() => undefined);
  await client.callTool({ name: "get_asset", arguments: { mint: "1".repeat(32) } }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await client.close();
  const lines = stderr.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2, `expected a log line per call, saw ${lines.length}: ${stderr.slice(0, 200)}`);
  const first = lines.find((l) => l.tool === "explain_mechanics");
  assert.ok(first, "the log names the tool that was called");
  assert.ok(typeof first.ms === "number" && first.ms >= 0);
  assert.deepStrictEqual(first.args, ["topic"], "argument names are logged, values are not");
  assert.ok(!stderr.includes("1".repeat(32)), "a mint address never reaches the log");
  const failed = lines.find((l) => l.tool === "get_asset");
  assert.ok(failed && failed.ok === false && typeof failed.kind === "string", "a failed call logs ok:false with a kind");
  void spawn;
  ok("b19 COLLECTOR_MCP_LOG=1 writes one JSON line per call with the tool, timing, outcome and argument names only");
}

console.log(`\nhardening test: ${passed} groups passed (a1, a4, a5, a10, a11, a12, a15, b1, b11, b12, b13, b14, b15, b16, b17, b18, b19)`);
