import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const item = "59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4";
const collection = "EmFy7YohG4GZxgE5DEDgHuuvibqXK2jRLcXcJa3RvDRX";
const emptyCollection = "58BZER6WANRWCvJCFXLSgWBz29dcPnR8RvSmN7LT2Mut";
const versions = ["2025-11-25", "2025-06-18"];
const validator = new AjvJsonSchemaValidator();

function checkParameters(schema) {
  if (!schema || typeof schema !== "object") return;
  assert.ok(!Object.hasOwn(schema, "$ref"));
  for (const name of Object.keys(schema.properties ?? {})) assert.match(name, /^[A-Za-z0-9_.-]{1,64}$/);
  for (const child of Object.values(schema)) checkParameters(child);
}

for (const version of versions) {
  // Override only the offered revision. Discovery, validation and calls use the SDK client.
  class Reader extends Client {
    async request(message, ...options) {
      if (message.method !== "initialize") return super.request(message, ...options);
      const result = await super.request({ ...message, params: { ...message.params, protocolVersion: version } }, ...options);
      assert.equal(result.protocolVersion, version);
      return result;
    }
  }
  const client = new Reader({ name: "stdio-reader", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", new URL("./helpers/claim-reads.mjs", import.meta.url).href, process.argv[2] ?? "dist/index.js"],
      env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1" },
    }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 21);
    assert.equal(new Set(tools.map(t => t.name)).size, 21);
    const prompts = (await client.listPrompts()).prompts.map(p => p.name).sort();
    assert.deepEqual(prompts, ["collection_report", "getting_started", "wallet_report"]);
    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, name);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      return result.structuredContent;
    }
    const found = await call("identify", { query: item });
    assert.deepEqual(found.lookup, { name: "get_asset", arguments: { mint: item } });
    const asset = await call(found.lookup.name, found.lookup.arguments);
    assert.equal(asset.mint, item);
    assert.equal(asset.onchain.owner, "AgJbH68itZ7VzsCxhMvW3d3ebddXi3sjTMjrgPEV6n1B");
    const invalid = await client.callTool({ name: "identify", arguments: { query: "\u200b" } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.structuredContent.message, /nothing to identify/i);
    assert.ok(invalid.structuredContent.next);
    const receipt = await call("verify_claim", { claim: "supply", subject: emptyCollection, value: 0 });
    assert.equal(receipt.verdict, "confirmed");
    const census = await call("get_collection_holders", { collection, max: 100 });
    assert.equal(census.matched, 100);
    assert.equal(census.assets.length + census.assetsOmitted, census.matched);
    assert.equal(census.ownershipVerifiedOnchain, false);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.ok(tool.description.length > 0 && tool.description.length <= 1024, tool.name);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object", tool.name);
      for (const keyword of ["oneOf", "anyOf", "allOf"]) assert.ok(!(keyword in tool.inputSchema), tool.name);
      checkParameters(tool.inputSchema);
      validator.getValidator(tool.inputSchema);
    }
    console.log(version, "21 tools, 3 prompts, 4 fixture reads and 1 typed error");
  } finally {
    await client.close();
  }
}
