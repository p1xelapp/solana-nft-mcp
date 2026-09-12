/**
 * Offline regressions for the wave-8 defects.
 *
 * Each block names the wrong ANSWER it prevents, not the function it calls,
 * and every one of them failed before the fix in this pass. Runs against the
 * built output with no network: the status test stubs the module boundary it
 * needs and restores it afterwards.
 */
import assert from "node:assert";

import { summarizeActivity, floorCeiling } from "../dist/wallet.js";
import { dedupeEvents, mergeEventCopies, fallbackIdentity } from "../dist/market.js";
import { rateLimiter, cached, AbortedError } from "../dist/lib/http.js";

let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};

const AT = 1_700_000_000;

// ------------------------------------------------------------------ new 1
// A newest-first wallet feed with a buy at -1 and a sale at 1 reported 2 SOL
// of profit, and one Infinity poisoned every total.
{
  const W = "WALLET";
  // Feed order is newest-first, as Magic Eden serves it.
  const feed = [
    { type: "buyNow", source: "magiceden_v2", signature: "s2", tokenMint: "M", buyer: "x", seller: W, price: 1, blockTime: AT + 100 },
    { type: "buyNow", source: "magiceden_v2", signature: "s1", tokenMint: "M", buyer: W, seller: "x", price: -1, blockTime: AT },
  ];
  const a = summarizeActivity(W, feed, false);
  assert.strictEqual(a.buys.count, 1, "the buy still happened and is still counted");
  assert.strictEqual(a.buys.totalSol, 0, "a negative price never reaches a total");
  assert.strictEqual(a.sells.totalSol, 1, "the real sale is still money");
  assert.strictEqual(a.netFlowSol, 1, "net flow is the sale alone, not a 2 SOL profit");
  assert.strictEqual(a.realized.flips, 0, "no flip can be built on an unusable purchase price");
  assert.strictEqual(a.realized.pnlSol, 0);
  assert.strictEqual(a.pricing.malformedPrices, 1, "the malformed row is counted and named");
  assert.strictEqual(a.pricing.unpricedTrades, 1);

  const inf = summarizeActivity(W, [
    { type: "buyNow", signature: "i2", tokenMint: "M", buyer: "x", seller: W, price: Number.POSITIVE_INFINITY, blockTime: AT + 100 },
    { type: "buyNow", signature: "i1", tokenMint: "M", buyer: W, seller: "x", price: 2, blockTime: AT },
  ], false);
  assert.ok(Number.isFinite(inf.sells.totalSol) && Number.isFinite(inf.netFlowSol) && Number.isFinite(inf.realized.pnlSol), "infinity never reaches any total");
  assert.strictEqual(inf.sells.totalSol, 0, "an infinite sale price is not money");
  assert.strictEqual(inf.realized.flips, 0, "and it cannot close a flip");
  ok("new 1 summarizeActivity: only finite prices above zero are arithmetic");
}

// ------------------------------------------------------------------ new 4
// A corrected item name used to mark the whole event unsettled, removing an
// agreed 2 SOL sale from volume.
{
  const base = { signature: "sig1", tokenMint: "M", type: "buyNow", buyer: "B", seller: "S", price: 2, blockTime: AT, name: "Card", source: "magiceden_v2" };

  const meta = dedupeEvents([{ ...base }, { ...base, name: "Card (corrected)" }]);
  assert.strictEqual(meta.events.length, 1, "one fill answered twice is one event");
  assert.deepStrictEqual(meta.events[0].conflictFields, ["name"], "the conflicting field is tracked by name");
  assert.strictEqual(meta.events[0].unsettled, undefined, "a metadata correction never removes the price");
  assert.strictEqual(meta.events[0].price, 2, "the agreed price survives");
  assert.strictEqual(meta.metadataConflicts, 1, "and it is reported as a metadata conflict");
  assert.strictEqual(meta.conflictingDuplicates, 0, "not as a money conflict");

  const money = dedupeEvents([{ ...base }, { ...base, price: 3 }]);
  assert.deepStrictEqual(money.events[0].conflictFields, ["price"]);
  assert.strictEqual(money.events[0].unsettled, true, "two different prices cannot support a money figure");
  assert.strictEqual(money.conflictingDuplicates, 1);
  assert.strictEqual(money.metadataConflicts, 0);

  const side = dedupeEvents([{ ...base }, { ...base, buyer: "OTHER" }]);
  assert.strictEqual(side.events[0].unsettled, true, "a disagreed side is a money conflict too");

  const merged = mergeEventCopies({ ...base }, { ...base, name: "x", source: "y" });
  assert.deepStrictEqual(merged.conflicts, ["source", "name"].sort((a, b) => (a === "source" ? -1 : 1)), "every conflicting field is listed");
  assert.strictEqual(merged.moneyConflict, false);
  ok("new 4 only a price or a side conflict takes an event out of the money figures");
}

// ------------------------------------------------------------ new 4 (wallet)
// Wallet activity ignored `unsettled` entirely and used the first copy's price.
{
  const W = "WALLET";
  const deduped = dedupeEvents([
    { type: "buyNow", signature: "d1", tokenMint: "M", buyer: W, seller: "x", price: 2, blockTime: AT },
    { type: "buyNow", signature: "d1", tokenMint: "M", buyer: W, seller: "x", price: 9, blockTime: AT },
  ]);
  assert.strictEqual(deduped.events[0].unsettled, true);
  const a = summarizeActivity(W, deduped.events, false);
  assert.strictEqual(a.buys.count, 1, "the trade happened and is counted");
  assert.strictEqual(a.buys.totalSol, 0, "but no amount can be shown to be the right one");
  assert.strictEqual(a.pricing.unsettled, 1, "and the reason is reported");
  ok("new 4 wallet activity honours `unsettled` the same way collection sales do");
}

// ------------------------------------------------------------------ new 5
// Two distinct unsigned sales sharing only type, price and block time used to
// collapse into one.
{
  const a = { type: "buyNow", price: 1, blockTime: AT };
  const b = { type: "buyNow", price: 1, blockTime: AT };
  assert.strictEqual(fallbackIdentity(a), null, "no mint means no identity");
  const kept = dedupeEvents([a, b]);
  assert.strictEqual(kept.events.length, 2, "two unidentifiable fills are two fills");
  assert.strictEqual(kept.identityUnavailable, 2, "and both are counted as unidentifiable");
  assert.strictEqual(kept.duplicates, 0);

  assert.strictEqual(fallbackIdentity({ tokenMint: "M", type: "buyNow", price: 1 }), null, "a missing block time is not an identity");
  assert.strictEqual(fallbackIdentity({ tokenMint: "M", type: "buyNow", blockTime: AT }), null, "a missing price is not an identity");
  assert.strictEqual(fallbackIdentity({ tokenMint: "M", type: "buyNow", price: -1, blockTime: AT }), null, "an unusable price is not an identity");
  assert.strictEqual(fallbackIdentity({ tokenMint: "M", price: 1, blockTime: AT }), null, "a missing type is not an identity");
  assert.ok(fallbackIdentity({ tokenMint: "M", type: "buyNow", price: 1, blockTime: AT }), "the complete set is an identity");

  const complete = dedupeEvents([
    { tokenMint: "M", type: "buyNow", price: 1, blockTime: AT },
    { tokenMint: "M", type: "buyNow", price: 1, blockTime: AT },
  ]);
  assert.strictEqual(complete.events.length, 1, "complete identical unsigned rows are still one fill");
  assert.strictEqual(complete.identityFallbacks, 2);
  ok("new 5 a fallback identity needs mint, type, price and block time in full");
}

// ------------------------------------------------------------------ new 6
// Stale holdings x live floors was published as a "last-known" figure that no
// moment ever held.
{
  const quotes = [{ collection: "c", count: 10, floorSol: 2, listedCount: 100 }];
  const stale = floorCeiling(quotes, 10, { capped: false, stale: true, cachedAt: "2026-09-12T10:00:00.000Z" }, "2026-09-12T12:00:00.000Z");
  assert.strictEqual(stale.basis, "unavailable", "there is no honest figure to publish");
  assert.strictEqual(stale.figureSol, null, "cached counts are never multiplied by current floors");
  assert.strictEqual(stale.ceilingSol, null);
  assert.deepStrictEqual(stale.perCollection, [], "not even per collection");
  assert.ok(stale.unavailableReason.includes("2026-09-12T10:00:00.000Z"), "the holdings read time is named");
  assert.ok(stale.unavailableReason.includes("2026-09-12T12:00:00.000Z"), "and so is the floor read time");
  assert.strictEqual(stale.holdingsReadAt, "2026-09-12T10:00:00.000Z");
  assert.strictEqual(stale.floorsReadAt, "2026-09-12T12:00:00.000Z");

  const live = floorCeiling(quotes, 10, { capped: false, stale: false }, "2026-09-12T12:00:00.000Z");
  assert.strictEqual(live.basis, "ceiling-at-query-time");
  assert.strictEqual(live.figureSol, 20, "a current read still gets its ceiling");
  ok("new 6 stale holdings produce no figure at all, with both read times and the reason");
}

// ------------------------------------------------------------------ new 3
// A status probe's deadline used to cancel a shared fetch that an ordinary
// caller had joined.
{
  let fetches = 0;
  let release;
  const gateOpen = new Promise((r) => {
    release = r;
  });
  const producer = async () => {
    fetches++;
    await gateOpen;
    return { floor: 1 };
  };

  const impatient = new AbortController();
  const key = `test:shared:${Date.now()}`;
  const first = cached(key, 60_000, producer, { signal: impatient.signal });
  const second = cached(key, 60_000, producer);

  // The first caller gives up. Its own wait must end; the shared fetch, and
  // the caller that joined it, must not be touched.
  impatient.abort();
  await assert.rejects(first, (e) => e instanceof AbortedError, "the impatient caller's wait ends with its own signal");
  release();
  const joined = await second;
  assert.deepStrictEqual(joined.data, { floor: 1 }, "the caller that joined still gets its answer");
  assert.strictEqual(fetches, 1, "and there was only ever one upstream fetch");
  ok("new 3 one caller's deadline cancels its own wait, never another caller's shared fetch");
}

// ------------------------------------------------------------------ b2
// Waiting for a rate gate was not abortable, so a caller could sit in a queue
// far past its own deadline before anything checked the clock.
{
  const gate = rateLimiter(400, "test source");
  await gate(); // take the first turn so the next one has to wait
  const controller = new AbortController();
  const started = Date.now();
  const waiting = gate(controller.signal);
  controller.abort();
  await assert.rejects(waiting, (e) => e instanceof AbortedError, "an aborted gate wait rejects instead of waiting out the queue");
  assert.ok(Date.now() - started < 300, "and it returns immediately rather than after the interval");
  ok("b2 a gate wait ends when the caller's deadline does");
}

// ------------------------------------------------------------------ new 2
// The shared status budget was spent on rpcHealth() before a single
// marketplace was contacted, so every venue was reported as timed out.
{
  // What is under test is ORDERING: with the chain check awaited first, the
  // venues were only contacted after it finished - and a chain endpoint slow
  // enough to eat the shared budget got every venue reported as timed out
  // without a single request being sent. So the clock is read at the moment
  // the first venue request actually leaves, against a deliberately slow
  // chain check.
  const { sourceStatus } = await import("../dist/status.js");
  const HEALTH_MS = 3_000;
  let healthStarted = 0;
  let healthFinished = 0;
  const slowHealth = async (_timeoutMs, signal) => {
    healthStarted = Date.now();
    await new Promise((resolve) => {
      const t = setTimeout(resolve, HEALTH_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
    healthFinished = Date.now();
    return [{ endpoint: "rpc-mainnet-beta (api.mainnet-beta.solana.com)", ok: true, latencyMs: 5, slot: 1, note: "healthy at slot 1" }];
  };

  const realFetch = globalThis.fetch;
  let firstVenueRequestAt = 0;
  // Offline mode refuses before a request is built, so it is lifted for this
  // one test and every request is answered by the stub - nothing leaves.
  const wasOffline = process.env.COLLECTOR_MCP_OFFLINE;
  delete process.env.COLLECTOR_MCP_OFFLINE;
  globalThis.fetch = async (url) => {
    if (!firstVenueRequestAt) firstVenueRequestAt = Date.now();
    const body = String(url).includes("magiceden")
      ? JSON.stringify({ symbol: "mad_lads", floorPrice: 1_000_000_000, listedCount: 5, volumeAll: 10 })
      : JSON.stringify({ error: "not part of this test" });
    return new Response(body, { status: String(url).includes("magiceden") ? 200 : 503, headers: { "content-type": "application/json" } });
  };

  let report;
  try {
    report = await sourceStatus({ rpcHealth: slowHealth });
  } finally {
    globalThis.fetch = realFetch;
    if (wasOffline !== undefined) process.env.COLLECTOR_MCP_OFFLINE = wasOffline;
  }

  assert.ok(healthFinished - healthStarted >= HEALTH_MS - 100, "the chain check really was slow");
  assert.ok(
    firstVenueRequestAt > 0 && firstVenueRequestAt - healthStarted < 1_000,
    `the first venue request must leave while the chain check is still running (it left ${firstVenueRequestAt - healthStarted}ms after it started)`,
  );
  const meRow = report.sources.find((r) => r.id === "magiceden-v2");
  assert.strictEqual(meRow.ok, true, "a healthy venue behind a slow chain endpoint is still reported healthy");
  assert.ok(!/did not answer within/.test(meRow.note), `and never as a timeout it never reached (${meRow.note})`);
  const chain = report.sources.find((r) => r.id === "rpc-mainnet-beta");
  assert.strictEqual(chain.ok, true, "and the slow chain row is still in the report");
  ok("new 2 a slow chain endpoint cannot spend the status budget before the venues are asked");
}

console.log(`\nwave8 test: ${passed} groups passed (new 1-6, b2)`);
