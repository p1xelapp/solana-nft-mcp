// A read that failed, or a copy kept after a failed refresh, is never the
// answer. Each check fails one source the way an outage does and holds the
// answer to what was actually read, with a control where every read answers.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sources = JSON.parse(fs.readFileSync(new URL("./fixtures/item-reads-2026-11-19/sources.json", import.meta.url), "utf8"));
const address = (name) => sources[name].params[0] ?? sources[name].params.id;
const batman = JSON.parse(fs.readFileSync(new URL("./fixtures/reads-2026-11-19/batman-index.json", import.meta.url), "utf8"));
const PROV_ITEM = "6F1bweAPCrVw89ViZWDWgh5Ppoxfcm5imLqfDWg2grLZ";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One server with one scenario; `run` gets a call function. */
async function session(scenario, run) {
  const client = new Client({ name: "unread-verdicts", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", new URL("./helpers/unread-verdicts-preload.mjs", import.meta.url).href, "dist/index.js"],
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", UNREAD_SCENARIO: scenario },
      stderr: "ignore",
    }),
  );
  try {
    return await run(async (name, args) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      return { isError: r.isError === true, data: r.structuredContent ?? {}, text: r.content?.[0]?.text ?? "" };
    });
  } finally {
    await client.close();
  }
}

await check("a burned item stays burned when its own account cannot be read and the index, read live, says so", async () => {
  for (const scenario of ["burn-core-down", "burn-core-up"]) {
    const r = await session(scenario, (call) => call("get_asset", { mint: address("burn") }));
    assert.equal(r.isError, false, r.text.slice(0, 300));
    assert.equal(r.data.market?.listed, false, scenario);
    assert.equal(r.data.market?.priceSol, null, scenario);
    assert.equal(r.data.market?.staleMarketRow?.priceSolOnRecord, 12.5, scenario);
    assert.doesNotMatch(r.data.summary ?? "", /same owner/, scenario);
    if (scenario === "burn-core-down") assert.match(r.data.market.staleMarketRow.sentence, /asset index, read just now, records it as burned/);
    // Control: with the account read, the chain itself says burned.
    else assert.match(r.data.market.staleMarketRow.sentence, /the chain shows it was burned/);
  }
});

await check("a provenance served from copies after a failed refresh says so and is not complete", async () => {
  await session("prov-stale", async (call) => {
    const first = await call("get_asset_provenance", { mint: PROV_ITEM });
    assert.equal(first.isError, false, first.text.slice(0, 300));
    assert.notEqual(first.data.stale, true);
    await new Promise((r) => setTimeout(r, 3_000));
    const second = await call("get_asset_provenance", { mint: PROV_ITEM });
    assert.equal(second.isError, false, second.text.slice(0, 300));
    assert.equal(second.data.stale, true);
    assert.equal(second.data.historyComplete, false);
    assert.match(second.data.staleNote, /as they stood then/);
  });
});

await check("an oracle or a collection that was not read leaves blockedByOracle unknown, never empty", async () => {
  for (const scenario of ["trust-oracle-down", "trust-collection-down"]) {
    const r = await session(scenario, (call) => call("get_asset_trust", { mint: address("asset") }));
    assert.equal(r.isError, false, r.text.slice(0, 300));
    assert.equal(r.data.blockedByOracle, null, scenario);
    assert.equal(r.data.incomplete, true, scenario);
  }
  // Control: every read answers, and the oracle's refusal of burns is there.
  const ok = await session("", (call) => call("get_asset_trust", { mint: address("asset") }));
  assert.deepEqual(ok.data.blockedByOracle, ["burn"]);
});

await check("an issuer verdict is not taken from a collection account copied before a failed refresh", async () => {
  await session("holders-stale-authority", async (call) => {
    const first = await call("get_collection_holders", { collection: address("collection") });
    assert.equal(first.data.issuer?.verdict, "issued", JSON.stringify(first.data.issuer));
    // Control: read live, the update authority's own holding has the issuer role.
    assert.ok(first.data.holders.some((h) => h.role === "issuer"), "the live read names the issuer's holding");
    await new Promise((r) => setTimeout(r, 1_000));
    const second = await call("get_collection_holders", { collection: address("collection") });
    assert.equal(second.data.issuer?.verdict, null);
    assert.equal(second.data.issuer?.name, null);
    assert.equal(second.data.issuerRead?.status, "unavailable");
    assert.match(second.data.issuerRead?.reason ?? "", /copy of the collection account read at/);
    // A copied key names no holder's role and is not called the issuer's key.
    assert.equal(second.data.holders.filter((h) => h.role === "issuer").length, 0);
    assert.doesNotMatch(JSON.stringify(second.data.readThis ?? ""), /That is the issuer's key/);
  });
});

await check("identify does not call the index's owner of a Core item current when the item's account was not read", async () => {
  const r = await session("index-only", (call) => call("identify", { query: batman.result.items[0].id }));
  assert.equal(r.data.confidence, "low");
  assert.match(r.data.summary, /could not be read just now, so that is the index's record, not a confirmed current holder/);
  assert.doesNotMatch(r.data.summary, /does not apply to this standard/);
});

await check("a Core group is named a Core group by the trust and history tools", async () => {
  await session("", async (call) => {
    const trust = await call("get_asset_trust", { mint: address("group") });
    assert.equal(trust.isError, true);
    assert.match(trust.data.message, /Metaplex Core group/);
    const prov = await call("get_asset_provenance", { mint: address("group") });
    assert.equal(prov.isError, true);
    assert.match(prov.data.message, /Metaplex Core group/);
    assert.doesNotMatch(prov.text, /possibly burned/);
  });
});

await check("a Core group listed under a collection is named and left out, not counted as an unreadable row", async () => {
  const r = await session("holders-group-row", (call) => call("get_collection_holders", { collection: address("collection") }));
  assert.equal(r.data.coreGroupRows, 1);
  assert.equal(r.data.rowsRejected, 0);
  assert.match(JSON.stringify(r.data), /were Metaplex Core groups, which list other accounts and are not items/);
  // Control: the captured page has no group row.
  const control = await session("", (call) => call("get_collection_holders", { collection: address("collection") }));
  assert.equal(control.data.coreGroupRows, 0);
});

console.log(`unread-is-not-a-verdict: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
