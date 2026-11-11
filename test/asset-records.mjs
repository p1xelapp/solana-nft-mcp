import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const mint = "59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4";
let failed = 0;
const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-asset-records-"));
for (const profile of ["metadata", "burned"]) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", pathToFileURL(path.join(import.meta.dirname, "helpers/asset-records-preload.mjs")).href, path.join(dist, "index.js")], env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", ASSET_RECORD_PROFILE: profile }, stderr: "ignore" });
  const client = new Client({ name: "asset-records", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: profile === "metadata" ? "get_asset" : "get_asset_provenance", arguments: { mint } }, undefined, { timeout: 30000 });
    const data = result.structuredContent;
    if (profile === "metadata") {
      assert.equal(data.chainIndex.image, "https://example.com/card.png");
      assert.equal(data.chainIndex.attributes[0].value, "003");
      assert.equal(data.chainIndex.attributes[1].clipped, true);
      assert.equal(data.chainIndex.attributesOmitted, 0);
      assert.equal(data.market, undefined);
      console.log("PASS indexed metadata remains available when the marketplace has no record");
    } else {
      assert.equal(data.error, undefined, JSON.stringify(data.error));
      assert.equal(data.burned, true);
      assert.equal(data.currentOwner, null);
      assert.equal(data.name, null);
      assert.deepEqual(data.events.map(e => e.event), ["minted", "burned"]);
      assert.equal(data.historyComplete, true);
      console.log("PASS a burned Core stub retains its readable transaction history");
    }
  } catch (e) { failed++; console.log(`FAIL ${profile}: ${e.message}`); }
  finally { await client.close(); }
}
console.log(`asset-records: ${failed} failed`);
process.exitCode = failed ? 1 : 0;
