// A slow answer says where its time went, and a source that asked this
// server to slow down is named, so a wait does not read as this server being
// broken. A client that asks for progress hears how a long read is going.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sources = JSON.parse(fs.readFileSync(new URL("./fixtures/item-reads-2026-11-19/sources.json", import.meta.url), "utf8"));
const asset = sources.asset.params[0];

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

async function session(scenario, run) {
  const client = new Client({ name: "slow-answers", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", new URL("./helpers/unread-verdicts-preload.mjs", import.meta.url).href, "dist/index.js"],
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", UNREAD_SCENARIO: scenario },
      stderr: "ignore",
    }),
  );
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

await check("a source that answered 429 is named in the answer's timing, in both copies", async () => {
  await session("rate-limited-once", async (client) => {
    const r = await client.callTool({ name: "get_asset_trust", arguments: { mint: asset } });
    assert.notEqual(r.isError, true);
    const t = r.structuredContent.timing;
    assert.ok(t, "a 429 adds a timing block even to a quick answer");
    const rpc = t.sources.find((s) => s.source === "the free public Solana RPC");
    assert.equal(rpc?.rateLimited, 1);
    assert.match(t.note, /the free public Solana RPC: .*1 answer asking this server to slow down \(HTTP 429\)/);
    assert.match(t.note, /its limit for free public use, not a fault in the question or in this server/);
    // A 429 is a request to slow down, not a source that was down.
    assert.equal(rpc.failed, 0);
    assert.doesNotMatch(t.note, /not answering/);
    // The text copy is the same JSON, with the same block.
    assert.deepEqual(JSON.parse(r.content[0].text).timing, t);
    // No address of a configured endpoint, and no key, is ever in it.
    assert.doesNotMatch(JSON.stringify(t), /https?:\/\//);
  });
  // Control: the same call with nothing pushed back and nothing slow has no block.
  await session("", async (client) => {
    const r = await client.callTool({ name: "get_asset_trust", arguments: { mint: asset } });
    assert.equal(r.structuredContent.timing, undefined);
  });
});

await check("a long read sends progress to a client that asked, and the slow answer says where its time went", async () => {
  await session("slow-asset", async (client) => {
    const progress = [];
    const r = await client.callTool({ name: "get_asset_trust", arguments: { mint: asset } }, undefined, { timeout: 60_000, onprogress: (p) => progress.push(p) });
    assert.notEqual(r.isError, true);
    assert.ok(progress.length >= 1, "at least one progress message in a nine-second read");
    assert.match(progress[0].message, /^Still reading after \d/);
    assert.ok(progress.every((p, i) => i === 0 || p.progress > progress[i - 1].progress), "progress only rises");
    const t = r.structuredContent.timing;
    assert.ok(t && t.tookMs >= 8_000, `took ${t?.tookMs}`);
    assert.match(t.note, /^This answer took \d+(\.\d)? s\./);
  });
});

await check("schemas carry no dialect label, so a 2020-12 client reads them as the protocol says", async () => {
  await session("", async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 21);
    for (const t of tools) {
      assert.equal("$schema" in t.inputSchema, false, t.name);
      if (t.outputSchema) assert.equal("$schema" in t.outputSchema, false, t.name);
    }
    // Control: the client still validates an answer against its unlabelled schema.
    const r = await client.callTool({ name: "get_asset_trust", arguments: { mint: asset } });
    assert.notEqual(r.isError, true);
  });
});

await check("a reply the runtime could not parse is worded as a source answering badly, not as the runtime's text", async () => {
  const { plainReason } = await import("../dist/lib/http.js");
  for (const e of [new TypeError("Cannot read properties of null (reading 'items')"), new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON")]) {
    const r = plainReason(e);
    assert.doesNotMatch(r.sentence, /Cannot read|Unexpected token|doctype/);
    assert.match(r.sentence, /a source sent back data in a shape this server could not read/);
  }
  // Control: this server's own sentences still pass through as they are.
  assert.match(plainReason(new Error("Solana RPC -32603: Internal error")).sentence, /internal error/);
});

console.log(`slow-answers: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
