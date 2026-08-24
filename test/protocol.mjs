/**
 * Offline protocol test (CI-safe, no network): spawns the built server over
 * stdio and verifies the full MCP surface - tools, resource, prompt - plus
 * schema-level input rejection. Live data paths are covered by smoke.mjs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const client = new Client({ name: "protocol-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const { tools } = await client.listTools();
assert.strictEqual(tools.length, 8, `expected 8 tools, got ${tools.length}`);
for (const t of tools) {
  assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
}

const { resources } = await client.listResources();
assert.ok(resources.some((r) => r.uri === "collector://registry"), "registry resource missing");

const reg = await client.readResource({ uri: "collector://registry" });
const entries = JSON.parse(reg.contents[0].text);
assert.ok(Array.isArray(entries) && entries.length >= 5, "registry should have >=5 entries");

const { prompts } = await client.listPrompts();
assert.ok(prompts.some((p) => p.name === "collection_report"), "collection_report prompt missing");

// Schema rejection must not require network.
const bad = await client.callTool({ name: "get_asset", arguments: { mint: "nope" } }).catch((e) => e);
const badText = bad?.content?.[0]?.text ?? String(bad?.message ?? bad);
assert.ok(/base58|invalid|must be/i.test(badText), `bad address not rejected cleanly: ${badText.slice(0, 120)}`);

// Registry search is pure logic - no network.
const search = await client.callTool({ name: "search_collections", arguments: { query: "candy gold" } });
assert.ok(JSON.parse(search.content[0].text).results[0].id === "candy-mlb-gold-auction-1");

console.log("protocol test: all assertions passed (8 tools, resource, prompt, validation)");
await client.close();
