/**
 * Offline regressions for the hardening pass.
 *
 * One test per finding, each named with the failure it prevents rather than
 * the function it calls. Everything here runs against the BUILT output with no
 * network: the two tests that need an upstream stub `globalThis.fetch` and
 * restore it afterwards.
 */
import assert from "node:assert";
import { parseSerial, dedupeEvents, summarizeSales, applyNameFilter, fallbackIdentity } from "../dist/market.js";
import { objectRows, assertPageSize } from "../dist/lib/shapes.js";
import { fetchJson } from "../dist/lib/http.js";
import { verifyClaim } from "../dist/verify.js";
import * as das from "../dist/sources/das.js";
import * as me from "../dist/sources/magiceden.js";

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

console.log(`\nhardening test: ${passed} groups passed (a1, a4, a5, a10, a11, a12, a15, b1, b11, b12, b13)`);
