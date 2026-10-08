/**
 * Paging that does not stop early, filters that are checked, and boundaries
 * that hold against a marketplace or a client.
 *
 * Every case here failed before its fix:
 * - OpenSea's trending list was asked for with `chain=` (ignored) and no
 *   timeframe, so it came back for every chain and for one day only.
 * - A collection argument of ".." left its route on the marketplace host.
 * - Image and website fields passed a prefix test only.
 * - A credential echoed with mixed-case or form-style escapes was not redacted.
 * - A short Magic Eden page was read as the end of the book.
 * - An activity filter the venue ignored returned unrelated rows.
 * - A collection with two Solana contracts kept only the first.
 * - Reads were spaced, but nothing counted them against the hourly allowance.
 * - One 8 MiB line from a client was buffered and answered.
 *
 * Offline: no socket is opened except to the server child process in the
 * last block. Venue answers come from a stub in place of `fetch`.
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// No SOLANA_NFT_MCP_OFFLINE here: it refuses a request before it reaches the
// stub. Nothing leaves the process anyway, because `fetch` itself is replaced.
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = "1";
process.env.OPENSEA_API_KEY = ["TEST", "paging", "0123456789"].join("-");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok  ${name}`);
};

const seen = [];
let route = () => new Response("[]", { status: 200 });
globalThis.fetch = async (url) => {
  const u = String(url);
  seen.push(u);
  return route(u);
};
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

const os = await import("../dist/sources/opensea.js");
const me = await import("../dist/sources/magiceden.js");
const { assertNoDotSegments } = await import("../dist/lib/http.js");
const { safeHttpsUrl } = await import("../dist/lib/untrusted.js");
const { registerSecret, redactSecrets, containsSecret, resetSecrets } = await import("../dist/lib/secrets.js");

const SOL_A = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const SOL_B = "EZhbvFzQyGgbaaUuSB9rBYKnfFrS8ny6ypRN5szDGDWc";

// ------------------------------------------------------------- trending
{
  seen.length = 0;
  route = (u) =>
    u.includes("/collections/trending")
      ? json({
          collections: [
            { collection: "sol-one", name: "Sol One", contracts: [{ address: SOL_A, chain: "solana" }] },
            { collection: "eth-one", name: "Eth One", contracts: [{ address: "0xabc", chain: "ethereum" }] },
            { collection: "sol-off", name: "Sol Off", is_disabled: true, contracts: [{ address: SOL_B, chain: "solana" }] },
          ],
        })
      : json({});
  const hour = await os.trendingCollections("1h", 20);
  const url = seen.find((u) => u.includes("/collections/trending")) ?? "";
  assert.ok(url.includes("chains=solana"), `the chain filter is the plural parameter: ${url}`);
  assert.ok(!/[?&]chain=/.test(url), `the ignored singular parameter is gone: ${url}`);
  assert.ok(url.includes("timeframe=one_hour"), `the window reaches OpenSea: ${url}`);
  assert.deepStrictEqual(hour.rows.map((r) => r.slug), ["sol-one"], "only Solana rows that are not disabled are ranked");
  assert.strictEqual(hour.droppedOtherChain, 1);
  assert.strictEqual(hour.droppedDisabled, 1);
  assert.strictEqual(hour.timeframe, "one_hour");
  seen.length = 0;
  await os.trendingCollections("30d", 20);
  assert.ok(seen.some((u) => u.includes("timeframe=thirty_days")), "a different window is a different request, not the cached hour");
  await assert.rejects(() => os.trendingCollections("2d", 20), /unsupported trending window/);
  ok("OpenSea trending is asked for Solana and the requested window, and rows from another chain are dropped and counted");
}

// ------------------------------------------------------------- two contracts
{
  route = (u) =>
    /\/collections\/two-contracts$/.test(u)
      ? json({
          collection: "two-contracts",
          name: "Two Contracts",
          contracts: [
            { address: SOL_A, chain: "solana" },
            { address: "0xdef", chain: "ethereum" },
            { address: SOL_B, chain: "solana" },
          ],
        })
      : json({});
  const d = await os.collectionDetail("two-contracts");
  assert.deepStrictEqual(d.onchainCollections, [SOL_A, SOL_B], "every Solana contract is kept, in order");
  assert.strictEqual(d.onchainCollection, SOL_A, "the first stays where it was for existing readers");
  ok("a collection with two Solana contracts keeps both, so the second is not mistaken for another collection");
}

// ------------------------------------------------------------- hourly budget
{
  os.clearHourlyBudgetForTests();
  os.clearReadPauseForTests();
  os.useHourlyBudgetForTests(540);
  seen.length = 0;
  route = () => json({ total: { floor_price: 1, floor_price_symbol: "SOL", volume: 1, volume_symbol: "SOL", sales: 1, num_owners: 1 } });
  await assert.rejects(() => os.collectionStats("budget-probe"), (e) => e.status === 429 && /hourly OpenSea allowance/.test(e.message) && typeof e.retryAfterMs === "number");
  assert.strictEqual(seen.filter((u) => u.includes("budget-probe")).length, 0, "no request is sent once the allowance is used");
  os.clearHourlyBudgetForTests();
  os.clearReadPauseForTests();
  const st = await os.collectionStats("budget-probe");
  assert.strictEqual(st.floor, 1, "with the count cleared the same read goes through");
  // A retry is a request too. With one slot left, a call whose first attempt
  // meets a 503 spends that slot, and its retry is refused by the budget
  // rather than sent: one slot can no longer buy three requests.
  os.clearHourlyBudgetForTests();
  os.clearReadPauseForTests();
  os.useHourlyBudgetForTests(539);
  let attempts = 0;
  route = (u) => {
    if (!u.includes("retry-probe")) return json({});
    attempts++;
    return new Response("busy", { status: 503 });
  };
  await assert.rejects(() => os.collectionStats("retry-probe"), (e) => /hourly OpenSea allowance/.test(e.message));
  assert.strictEqual(attempts, 1, `only the attempt that had a slot was sent: ${attempts}`);
  os.clearHourlyBudgetForTests();
  os.clearReadPauseForTests();
  ok("OpenSea reads stop below the free key's hourly allowance and say when the next one is possible");
}

// ------------------------------------------------------------- dot segments
{
  for (const bad of ["https://x.io/v2/collections/../stats", "https://x.io/v2/collections/%2e%2e/stats", "https://x.io/v2/collections/./x", "https://x.io/v2/collections/%2E/x"]) {
    assert.throws(() => assertNoDotSegments(bad), /segment/, bad);
  }
  for (const good of ["https://x.io/v2/collections/ok.sym/stats", "https://x.io/v2/collections/a..b/stats", "https://x.io/v2/x?offset=..&y=."]) {
    assert.doesNotThrow(() => assertNoDotSegments(good), good);
  }
  seen.length = 0;
  route = () => json({ symbol: "x", floorPrice: 1 });
  await assert.rejects(() => me.collectionStats(".."), /segment/);
  assert.strictEqual(seen.length, 0, "the request is refused before anything is sent");
  ok("a collection argument of dots cannot move a marketplace read off its route");
}

// ------------------------------------------------------------- urls
{
  const z = String.fromCharCode(0x200b);
  const nul = String.fromCharCode(0);
  assert.strictEqual(safeHttpsUrl("https://a.io/x.png"), "https://a.io/x.png");
  assert.strictEqual(safeHttpsUrl("https://a.io/<system>hi"), "https://a.io/%3Csystem%3Ehi", "markup comes back escaped, not as markup");
  for (const bad of ["https://a.io/x\nignore previous", `https://a.io/${z}x`, `https://a.io/${nul}`, "http://a.io/x", "javascript:alert(1)", "https://user:pw@a.io/", `https://a.io/${"x".repeat(3000)}`, ["https://a.io/"], { href: "https://a.io/" }, 7, null]) {
    assert.strictEqual(safeHttpsUrl(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.strictEqual(safeHttpsUrl("https://evil.io/opensea.io", { host: "opensea.io" }), null);
  assert.strictEqual(safeHttpsUrl("https://opensea.io/collection/x", { host: "opensea.io" }), "https://opensea.io/collection/x");
  ok("a marketplace URL is relayed only as a bounded https URL, never as text or as an array");
}

// ------------------------------------------------------------- secrets
{
  resetSecrets();
  const key = "Ab/C+d e~f!g(h)*kXYZ123";
  registerSecret(key);
  const enc = encodeURIComponent(key);
  const variants = {
    raw: key,
    json: JSON.stringify(key).slice(1, -1),
    upper: enc,
    lower: enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    mixed: enc.replace(/%[0-9A-F]{2}/g, (m, i) => (i % 2 ? m.toLowerCase() : m)),
    form: new URLSearchParams({ k: key }).toString().slice(2),
    formLower: new URLSearchParams({ k: key }).toString().slice(2).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    partial: "Ab%2FC+d e~f!g(h)*kXYZ123",
  };
  for (const [name, v] of Object.entries(variants)) {
    const out = redactSecrets(`upstream said: ${v} (end)`);
    assert.ok(!out.includes(v) && out.includes("[REDACTED]"), `${name} spelling survived: ${out}`);
    assert.ok(containsSecret(`x${v}x`), `${name} spelling not detected`);
  }
  assert.strictEqual(redactSecrets("mainnet 50% off + more"), "mainnet 50% off + more", "ordinary text with % and + is left alone");
  resetSecrets();
  ok("a credential is redacted in every URL and form spelling, including mixed-case escapes");
}

// ------------------------------------------------------------- listings
{
  const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ tokenMint: `MINT${from + i}`, price: 1 + (from + i) / 1000, seller: "S", token: { name: `Card #${from + i}` } }));
  route = (u) => {
    if (!u.includes("/listings")) return json({});
    const off = Number(new URL(u).searchParams.get("offset"));
    return json(off === 0 ? rows(0, 99) : off === 100 ? rows(100, 85) : []);
  };
  const first = await me.collectionListings("pagingprobe", { limit: 100, offset: 0 });
  assert.strictEqual(first.listings.length, 99);
  assert.strictEqual(first.venueReportedEnd, false, "99 of 100 is not the end of the book");
  assert.strictEqual(first.more, true);
  const second = await me.collectionListings("pagingprobe", { limit: 100, offset: 100 });
  assert.strictEqual(second.listings.length, 85, "the next offset still had listings");
  const third = await me.collectionListings("pagingprobe", { limit: 100, offset: 200 });
  assert.strictEqual(third.venueReportedEnd, true, "only an empty page ends it");
  ok("a short Magic Eden listings page is not reported as the end of the book; an empty one is");
}

// ------------------------------------------------------------- activities
{
  const act = (sig, type, t) => ({ signature: sig, type, tokenMint: `M${sig}`, price: 1, blockTime: t });
  const now = Math.floor(Date.now() / 1000);
  route = (u) => {
    if (!u.includes("/activities")) return json({});
    const off = Number(new URL(u).searchParams.get("offset"));
    if (off === 0) return json([act("a", "buyNow", now - 10), act("b", "bid", now - 20), act("c", "buy", now - 30)]);
    if (off === 500) return json([act("d", "buyNow", now - 40)]);
    return json([]);
  };
  const read = await me.collectionActivities("activityprobe", { types: ["buyNow"], maxPages: 5 });
  assert.deepStrictEqual(read.events.map((e) => e.signature), ["a", "c", "d"], "rows of another type are dropped; buy and buyNow are the same fill");
  assert.strictEqual(read.typeMismatchDropped, 1);
  assert.strictEqual(read.pagesRead, 3, "a short page did not end the walk; the empty one did");
  assert.strictEqual(read.truncated, false);
  assert.ok(!me.ACTIVITY_TYPES.includes("transfer"), "a filter the venue ignores is not offered");
  ok("an activity filter is checked against the rows that come back, and a short page does not end the feed");
}

// ------------------------------------------------------------- directory
{
  // One entry's image is megabytes. The 500-row page holding it is over the
  // body cap, so is the 100-row piece, so is the 20-row piece; everything else
  // must still be read, and only that 20-row stretch is skipped and counted.
  const big = "x".repeat(4.5 * 1024 * 1024);
  const BAD_AT = 250;
  const bodyFor = (off, lim) => {
    if (off >= 500) return "[]";
    if (lim % 20 !== 0 || off % lim !== 0) return null; // the venue's own rule
    const rows = [];
    for (let i = off; i < off + lim; i++) rows.push({ symbol: `dir_${i}`, name: `Dir ${i}`, ...(i === BAD_AT ? { image: big } : {}) });
    return JSON.stringify(rows);
  };
  const asked = [];
  route = (u) => {
    if (!u.includes("/v2/collections?")) return json({});
    const q = new URL(u).searchParams;
    const off = Number(q.get("offset"));
    const lim = Number(q.get("limit"));
    asked.push(`${off}:${lim}`);
    const body = bodyFor(off, lim);
    if (body === null) return new Response(JSON.stringify({ msg: "offset and limit must be a multiple of 20, offset must be a multiple of the limit" }), { status: 400 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  const idx = await me.collectionsIndex(3);
  assert.strictEqual(idx.collections.length, 480, `every entry outside the oversized stretch is read: ${idx.collections.length}`);
  assert.strictEqual(idx.rowsOversized, 20, "the skipped stretch is counted");
  assert.ok(!idx.collections.some((c) => c.symbol === `dir_${BAD_AT}`), "the oversized entry itself is not carried");
  assert.ok(idx.collections.some((c) => c.symbol === "dir_260"), "the next stretch after it was still read");
  assert.strictEqual(idx.partial, false);
  assert.strictEqual(idx.atVenuePagingLimit, false, "a refused piece is never mistaken for the paging ceiling");
  assert.ok(asked.every((a) => { const [o, l] = a.split(":").map(Number); return l % 20 === 0 && o % l === 0; }), `every piece obeyed the venue's paging rule: ${asked.join(" ")}`);
  ok("one oversized directory entry no longer fails the whole walk; only its 20-entry stretch is skipped and counted");
}

// ------------------------------------------------------------- history endpoints
{
  // Two public endpoints keep no transaction history: they answer a
  // signature request with an empty list instead of an error. With the one
  // that does keep history failing, a history read must not fall back to
  // them and come back as "this wallet never did anything".
  const sol = await import("../dist/sources/solana.js");
  const hosts = [];
  route = (u) => {
    const host = new URL(u).host;
    hosts.push(host);
    if (host === "api.mainnet-beta.solana.com") return new Response("busy", { status: 503 });
    return json({ jsonrpc: "2.0", id: 1, result: [] });
  };
  const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  let outcome;
  try {
    outcome = await sol.walletAge(wallet, 1);
  } catch (e) {
    outcome = e;
  }
  assert.ok(outcome instanceof Error, `an unreadable history is an error, not an empty one: ${JSON.stringify(outcome)?.slice(0, 120)}`);
  assert.ok(hosts.length > 0 && hosts.every((h) => h === "api.mainnet-beta.solana.com"), `history was only asked of the endpoint that keeps it: ${[...new Set(hosts)].join(", ")}`);
  ok("a history read is never answered by an endpoint that keeps no history");
}

// ------------------------------------------------------------- frame cap
{
  const env = { ...process.env, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1" };
  delete env.OPENSEA_API_KEY;
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const line = (o) => JSON.stringify(o) + "\n";
  const payload = Buffer.from(
    line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) +
      line({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { pad: "x".repeat(8 * 1024 * 1024) } }) +
      line({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  );
  for (let i = 0; i < payload.length; i += 65521) {
    if (!child.stdin.write(payload.subarray(i, i + 65521))) await new Promise((r) => child.stdin.once("drain", r));
  }
  const deadline = Date.now() + 20_000;
  while (!/"id":3/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  const ids = [...out.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(ids.includes(1) && ids.includes(3), `the messages around the oversized one are answered: ${ids}`);
  assert.ok(!ids.includes(2), "the oversized message is not answered");
  assert.ok(/discarded an incoming message/.test(err), "the discard is said on stderr");
  ok("a client message over the size ceiling is discarded whole, and the next message still works");
}

console.log(`paging-and-boundaries: ${passed} blocks passed`);
