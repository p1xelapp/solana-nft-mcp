import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../dist"));
const { deriveTrust, decodeCoreAccountPlugins, oracleReadingKey } = await import(pathToFileURL(path.join(dist, "lib/coreplugins.js")).href);
const { getAccountRaw, getCoreAccountRaw, getCoreAccountWithMeta } = await import(pathToFileURL(path.join(dist, "sources/solana.js")).href);
const { MECHANICS } = await import(pathToFileURL(path.join(dist, "mechanics.js")).href);

const address = "FsrQuCFEGaokcnFtaSAM2zdczrPcRzcWeDHqZjzQu8ox";
const base = { kind: "asset", collection: null, plugins: [], externalPlugins: 0, external: [], updateAuthorityIsNone: false };
const oracle = (events, resultsOffset = 0) => ({ type: "Oracle", authority: "update authority", oracleBase: address, oracle: { account: address, resultsOffset }, checks: events.map(event => ({ event, canReject: true, canApprove: false, canListen: false })) });
const reading = (burn, transfer) => ({ account: address, state: "answered", results: { create: "pass", update: "pass", burn, transfer } });
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

await check("an asset oracle overrides only the lifecycle events it registers", () => {
  const asset = { ...base, externalPlugins: 1, external: [oracle(["transfer"], 5)] };
  const collection = { ...base, kind: "collection", externalPlugins: 1, external: [oracle(["transfer", "burn"])] };
  const readings = new Map([[oracleReadingKey(address, 0), reading("rejected", "rejected")], [oracleReadingKey(address, 5), reading("pass", "pass")]]);
  const trust = deriveTrust(asset, collection, readings);
  assert.deepEqual(trust.blockedByOracle, ["burn"]);
  assert.equal(trust.incomplete, false);
  assert.deepEqual(trust.oracleChecks.find(x => x.inheritedFromCollection)?.events, ["burn"]);
  const sameEvents = deriveTrust({ ...asset, external: [oracle(["transfer", "burn"], 5)] }, collection, readings);
  assert.deepEqual(sameEvents.blockedByOracle, []);
});

await check("an unread inherited oracle remains incomplete for events the asset does not override", () => {
  const asset = { ...base, externalPlugins: 1, external: [oracle(["transfer"], 5)] };
  const collection = { ...base, kind: "collection", externalPlugins: 1, external: [oracle(["burn"])] };
  const trust = deriveTrust(asset, collection, new Map([[oracleReadingKey(address, 5), reading("pass", "pass")]]));
  assert.equal(trust.incomplete, true);
  assert.deepEqual(trust.blockedByOracle, []);
});

const realFetch = globalThis.fetch;
let value = {};
globalThis.fetch = async (_url, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: value }), { headers: { "content-type": "application/json" } });
delete process.env.SOLANA_RPC_URL;
delete process.env.SOLANA_NFT_MCP_OFFLINE;
try {
  for (const [name, read] of [["oracle", () => getAccountRaw(address)], ["Core plugins", () => getCoreAccountRaw(address)], ["Core ownership", () => getCoreAccountWithMeta(address, { fresh: true })]]) {
    await check(`a missing account response field is unread for ${name}`, async () => {
      value = { context: { slot: 1 } };
      await assert.rejects(read, e => !/not.?found|does not exist/i.test(e.message) && !/NotFound/.test(e.constructor.name));
    });
  }
  await check("an explicit null account remains a successful missing-account read", async () => {
    value = { context: { slot: 1 }, value: null };
    assert.equal(await getAccountRaw(address), null);
    assert.equal(await getCoreAccountRaw(address), null);
  });
} finally { globalThis.fetch = realFetch; }

await check("a partial plugin header does not establish an empty plugin registry", () => {
  const str = s => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const bytes = Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 1), Buffer.from([0]), str("Card"), str("https://example.com/card.json"), Buffer.from([0])]);
  const complete = deriveTrust(decodeCoreAccountPlugins(bytes.toString("base64")));
  assert.equal(complete.incomplete, false);
  const partial = deriveTrust(decodeCoreAccountPlugins(Buffer.concat([bytes, Buffer.from([3, 99])]).toString("base64")));
  assert.equal(partial.incomplete, true);
  assert.ok(!partial.assurances.some(s => s.includes("nothing but the owner's own signature")));
});

await check("AddBlocker does not promise that owner-managed plugins cannot be added", () => {
  const trust = deriveTrust({ ...base, plugins: [{ type: "AddBlocker", authority: "none" }] });
  assert.ok(!trust.assurances.some(s => /no new plugins|rules you get/.test(s)));
  assert.match(trust.assurances.join(" "), /owner-managed plugins can still be added/i);
});

await check("the plugin family summary distinguishes transfer persistence from removal", () => {
  const entry = MECHANICS.find(e => e.id === "standard-core-plugin-classes");
  assert.ok(!/never go away|fall away/.test(entry.plain));
  assert.match(entry.plain, /removed/);
  assert.match(entry.plain, /authority resets on transfer/);
  assert.ok(entry.plain.split(/\s+/).length <= 80);
});

console.log(`core-reading: ${failed} failed`);
process.exitCode = failed ? 1 : 0;
