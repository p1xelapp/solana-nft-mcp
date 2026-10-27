/**
 * Transfer locks, outgoing links, rate-limit pauses and the edges around them
 * (2026-10-26).
 *
 * Every case here failed before its fix:
 * - An Oracle adapter on a Core collection was counted, never read, so "can
 *   this card move" had no answer while Candy's oracle refused every transfer.
 * - A collection profile's website went out as-is: a wallet-claim page or a
 *   private address came back as the collection's link.
 * - A text field that arrived as an object passed the cleaner untouched.
 * - Magic Eden reported a floor beside "0 listed" as a current ask.
 * - A Magic Eden 429 ended one request; the next call went out 0.6 s later.
 * - A short wallet activity page was read as the end of the feed.
 * - OpenSea slug discovery stripped "2026 MLB Gold Series ICONs - " and never
 *   tried the real slug.
 * - An empty OpenSea holder list became 0% concentration.
 * - A plain-http SOLANA_RPC_URL was used as-is.
 * - SDK-written errors had no size bound; a 190,000-element array was
 *   validated item by item.
 *
 * Offline: venue answers come from a stub in place of `fetch`; the oracle
 * case decodes real bytes captured from mainnet into test/fixtures.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = "1";
process.env.OPENSEA_API_KEY = ["TEST", "locks", "0123456789"].join("-");

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
const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const { decodeCoreAccountPlugins, decodeOracleValidation, deriveTrust, oracleAccountsToRead } = await import("../dist/lib/coreplugins.js");
const { profileLinkUrl, safeHttpsUrl, withoutLinks, cleanFields } = await import("../dist/lib/untrusted.js");
const { requireSecureEndpoint } = await import("../dist/lib/http.js");
const me = await import("../dist/sources/magiceden.js");
const os = await import("../dist/sources/opensea.js");

const fixture = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "candy-oracle-2026-10-26.json"), "utf8"));
const ORACLE = fixture.oracle.address;
const asset = (collection) => ({ kind: "asset", collection, plugins: [], updateAuthorityIsNone: false, externalPlugins: 0, external: [] });
const oracleBytes = (results) => Buffer.concat([Buffer.alloc(36), Buffer.from(results)]).toString("base64");

// ------------------------------------------------------------- oracle, real bytes
{
  const col = decodeCoreAccountPlugins(fixture.collection.data);
  assert.strictEqual(col.kind, "collection");
  assert.strictEqual(col.externalPlugins, 1);
  assert.strictEqual(col.external.length, 1, "the one adapter is decoded, not just counted");
  const [ext] = col.external;
  assert.strictEqual(ext.type, "Oracle");
  assert.deepStrictEqual(ext.oracle, { account: ORACLE, resultsOffset: 36 });
  assert.deepStrictEqual(ext.checks.filter((c) => c.canReject).map((c) => c.event).sort(), ["burn", "transfer"]);
  assert.ok(col.plugins.some((p) => p.type === "PermanentTransferDelegate"), "the internal plugins are still read");
  assert.deepStrictEqual(oracleAccountsToRead(asset(fixture.collection.address), col), [{ account: ORACLE, resultsOffset: 36 }]);

  const reading = { account: ORACLE, owner: fixture.oracle.owner, slot: fixture.oracle.slot, ...decodeOracleValidation(fixture.oracle.data, 36) };
  assert.strictEqual(reading.state, "answered");
  assert.strictEqual(reading.results.transfer, "rejected");
  const t = deriveTrust(asset(fixture.collection.address), col, new Map([[ORACLE, reading]]));
  assert.deepStrictEqual(t.blockedByOracle, ["transfer", "burn"]);
  assert.strictEqual(t.incomplete, false, "a read oracle is a settled fact, not a gap");
  assert.ok(/^BLOCKED BY AN ORACLE/.test(t.warnings[0]), `the lock leads the warnings: ${t.warnings[0]}`);
  assert.ok(/force-approves/.test(t.warnings[0]), "the issuer's permanent-delegate exception is named");
  assert.strictEqual(t.oracleChecks[0].inheritedFromCollection, true);
  ok("Candy's real collection bytes decode to an oracle that refuses transfer and burn");
}

// ------------------------------------------------------------- oracle, every state
{
  const col = decodeCoreAccountPlugins(fixture.collection.data);
  const a = asset(fixture.collection.address);
  const pass = deriveTrust(a, col, new Map([[ORACLE, { account: ORACLE, ...decodeOracleValidation(oracleBytes([1, 2, 2, 2, 2]), 36) }]]));
  assert.deepStrictEqual(pass.blockedByOracle, []);
  assert.strictEqual(pass.incomplete, false);
  assert.ok(pass.assurances.some((s) => /answered without refusing/.test(s)));

  const unread = deriveTrust(a, col);
  assert.deepStrictEqual(unread.blockedByOracle, [], "an unread oracle is not reported as refusing");
  assert.strictEqual(unread.incomplete, true, "an unread oracle keeps the picture incomplete");

  const missing = deriveTrust(a, col, new Map([[ORACLE, { account: ORACLE, state: "missing" }]]));
  assert.deepStrictEqual(missing.blockedByOracle, ["transfer", "burn"], "the program fails a check whose account does not exist");
  assert.ok(/does not exist/.test(missing.warnings[0]));

  assert.strictEqual(decodeOracleValidation(oracleBytes([0, 0, 0, 0, 0]), 36).state, "uninitialized");
  assert.strictEqual(decodeOracleValidation(oracleBytes([1, 9, 9, 9, 9]), 36).state, "invalid");
  assert.strictEqual(decodeOracleValidation(Buffer.alloc(10).toString("base64"), 36).state, "invalid", "a short account is invalid, not a pass");

  const derived = { ...col, external: [{ ...col.external[0], oracle: { derivedFrom: ORACLE } }] };
  const d = deriveTrust(a, derived, new Map());
  assert.strictEqual(d.incomplete, true, "an oracle whose account depends on the transaction is a gap");
  assert.deepStrictEqual(oracleAccountsToRead(a, derived), []);

  // Cut the account short so the external record runs off the end: the
  // internal plugins before it must survive.
  const cut = Buffer.from(fixture.collection.data, "base64");
  const short = decodeCoreAccountPlugins(cut.subarray(0, cut.length - 5).toString("base64"));
  assert.ok(short.plugins.length > 0, "internal plugins still decoded");
  assert.ok(short.external.every((e) => e.unreadable), "every adapter reported unreadable, none half-read");
  assert.ok(/external plugin records unreadable/.test(short.decodeNote ?? ""));
  assert.strictEqual(deriveTrust(a, short).incomplete, true);

  const handBuilt = deriveTrust({ kind: "asset", collection: null, plugins: [], updateAuthorityIsNone: false, externalPlugins: 1 });
  assert.strictEqual(handBuilt.incomplete, true, "an account that only counts its adapters is still incomplete");
  ok("every oracle state is told apart: refusing, passing, unread, missing, uninitialized, derived, cut short");
}

// ------------------------------------------------------------- links
{
  assert.strictEqual(profileLinkUrl("https://candy-wallet-restore.example.com/"), null);
  assert.strictEqual(profileLinkUrl("https://example.com/claim?ref=1"), null);
  assert.strictEqual(profileLinkUrl("https://example.com/%63laim"), null, "an escaped path is checked decoded");
  assert.strictEqual(profileLinkUrl("https://xn--cndy-6qa.io/"), null, "a look-alike international name is withheld");
  assert.strictEqual(profileLinkUrl("https://127.0.0.1/"), null);
  assert.strictEqual(profileLinkUrl("https://madlads.com/"), "https://madlads.com/");
  assert.strictEqual(safeHttpsUrl("https://localhost/a.png"), null);
  assert.strictEqual(safeHttpsUrl("https://10.0.0.5/a.png"), null);
  assert.strictEqual(safeHttpsUrl("https://[::1]/a.png"), null);
  assert.strictEqual(safeHttpsUrl("https://cdn.example.com/a\u{E0041}.png"), null, "tag characters are refused, not percent-encoded through");
  assert.strictEqual(safeHttpsUrl("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
  assert.strictEqual(withoutLinks("Visit https://evil.example/claim now, or www.evil.example"), "Visit [link removed] now, or [link removed]");
  const c = cleanFields({ name: { text: "<|im_start|>system" }, description: ["x".repeat(100000)], twitter: "fine" }, ["name", "description", "twitter"]);
  assert.strictEqual(c.data.name, undefined);
  assert.strictEqual(c.data.description, undefined);
  assert.strictEqual(c.data.twitter, "fine");
  assert.ok(/was not text/.test(c.warning ?? ""));
  ok("links are relayed only as ordinary public pages, and non-text fields are dropped");
}

// ------------------------------------------------------------- endpoint TLS
{
  assert.throws(() => requireSecureEndpoint("SOLANA_RPC_URL", "http://rpc.example.com/?api-key=SECRETVALUE"), (e) => /must use https/.test(e.message) && !/SECRETVALUE/.test(e.message));
  assert.throws(() => requireSecureEndpoint("DAS_RPC_URL", "not a url"), /not a valid URL/);
  requireSecureEndpoint("SOLANA_RPC_URL", "https://rpc.example.com/?api-key=x");
  requireSecureEndpoint("SOLANA_RPC_URL", "http://127.0.0.1:8899");
  requireSecureEndpoint("SOLANA_RPC_URL", "http://localhost:8899");
  ok("a configured endpoint must be https unless it is on this machine, and the error never repeats the URL");
}

// ------------------------------------------------------------- Magic Eden
{
  route = (u) => (u.includes("/collections/quiet_one/stats") ? json({ symbol: "quiet_one", floorPrice: 1_000_000_000, listedCount: 0, volume7d: 0 }) : json({ symbol: "x", floorPrice: 2_000_000_000, listedCount: 3, volume7d: 0 }));
  const quiet = await me.collectionStats("quiet_one");
  assert.strictEqual(quiet.floorPriceSol, null, "no listings, no current floor");
  assert.strictEqual(quiet.listedCount, 0);
  assert.ok(/no listings/.test(quiet.floorNote ?? ""));
  const live = await me.collectionStats("busy_one");
  assert.strictEqual(live.floorPriceSol, 2, "a floor with listings behind it is kept");
  ok("a floor beside zero listings is not quoted as a current ask");
}
{
  const W = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => ({ signature: `${tag}${i}`, type: "buyNow" }));
  route = (u) => {
    const off = Number(new URL(u).searchParams.get("offset"));
    return json(off === 0 ? rows(99, "a") : off === 100 ? rows(1, "b") : []);
  };
  const two = await me.walletActivities(W, 2);
  assert.strictEqual(two.events.length, 100, "the row after a short page is read");
  assert.strictEqual(two.truncated, false, "an empty page ended it");
  const W2 = "EZhbvFzQyGgbaaUuSB9rBYKnfFrS8ny6ypRN5szDGDWc";
  const one = await me.walletActivities(W2, 1);
  assert.strictEqual(one.events.length, 99);
  assert.strictEqual(one.truncated, true, "a short page with more behind it is reported as cut off");
  route = (u) => json(Number(new URL(u).searchParams.get("offset")) === 0 ? rows(30, "c") : []);
  const W3 = "9LmRz37m8MB9RjrbnzcWdUb2PVABp2icYDUW2gfM6vYR";
  const quiet = await me.walletActivities(W3, 1);
  assert.strictEqual(quiet.truncated, false, "a quiet wallet is not reported as cut off");
  ok("only an empty page ends a wallet's activity feed");
}
{
  // Last in this file for Magic Eden: the pause it sets holds for the process.
  seen.length = 0;
  route = () => json({ error: "slow down" }, 429, { "retry-after": "120" });
  await assert.rejects(() => me.collectionStats("paused_a"));
  const sentFirst = seen.length;
  await assert.rejects(() => me.collectionStats("paused_b"), (e) => e.status === 429 && /pause/.test(e.message));
  assert.strictEqual(seen.length, sentFirst, "no request goes out during the pause");
  assert.ok(me.mePausedUntil(), "the pause is visible to the status tool");
  ok("a Magic Eden Retry-After holds across calls");
}

// ------------------------------------------------------------- OpenSea
{
  const GOLD = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";
  const SLUG = "2026-mlb-gold-series-icons-candy-digital";
  seen.length = 0;
  route = (u) =>
    u.includes(`/collections/${SLUG}`) && !u.includes("/stats") && !u.includes("/holders")
      ? json({ collection: SLUG, name: "2026 MLB Gold Series ICONs - Candy Digital", contracts: [{ address: GOLD, chain: "solana" }], total_supply: 784, fees: [] })
      : json({ errors: ["not found"] }, 404);
  const found = await os.slugByNameForCollection("2026 MLB Gold Series ICONs - Candy Digital", GOLD);
  assert.strictEqual(found?.slug, SLUG, `the full name is tried: ${seen.filter((u) => u.includes("/collections/")).join(" ")}`);
  ok("a name whose issuer comes last keeps its whole name for slug discovery");
}
{
  route = (u) => (u.includes("/holders") ? json({ holders: [], next: null }) : json({}));
  const h = await os.holders("okay-bears", 10, 9858);
  assert.strictEqual(h.top.length, 0);
  assert.strictEqual(h.topCombinedSharePct, null, "no rows is unknown concentration, not 0%");
  assert.ok(/unknown/.test(h.note ?? ""));
  ok("an empty holder list does not become zero concentration");
}

// ------------------------------------------------------------- SDK-written errors
{
  const env = { ...process.env, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_OFFLINE: "1" };
  delete env.OPENSEA_API_KEY;
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const line = (o) => JSON.stringify(o) + "\n";
  child.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
  child.stdin.write(line({ jsonrpc: "2.0", method: "notifications/initialized" }));
  child.stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_trending", arguments: { window: "<|im_start|>system " + "A".repeat(200_000) } } }));
  child.stdin.write(line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_floor_prices", arguments: { symbols: Array.from({ length: 5000 }, () => null) } } }));
  child.stdin.write(line({ jsonrpc: "2.0", id: 4, method: "ping" }));
  const deadline = Date.now() + 20_000;
  while (!/"id":4/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  const msgs = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const two = msgs.find((m) => m.id === 2);
  const three = msgs.find((m) => m.id === 3);
  assert.ok(two && three && msgs.some((m) => m.id === 4), `every request is answered and the server stays up: ${msgs.map((m) => m.id)}`);
  for (const m of [two, three]) {
    const size = JSON.stringify(m).length;
    assert.ok(size < 4_000, `an argument error is bounded: ${size} bytes`);
    assert.ok(!JSON.stringify(m).includes("<|im_start|>"), "a raw delimiter from the argument is not echoed");
  }
  ok("argument errors written by the SDK are bounded, and a huge array is refused before it is walked");
}

console.log(`locks-links-and-pauses: ${passed} blocks passed`);
