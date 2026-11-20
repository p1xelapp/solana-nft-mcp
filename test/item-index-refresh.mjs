import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const missing = "B5G7uZfyxKk7JCQXvCVExsbdqEXyUJQK9LKFofwS4B87";
const leaf = "GDEC7TRDAdU1BUhSSAK2WLc5DqLSCCcq6W2b7rVpfHcS";
for (const unavailable of [false, true]) {
  const client = new Client({name: "index-reader", version: "1"});
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", new URL("./helpers/item-index-refresh.mjs", import.meta.url).href, "dist/index.js"],
      env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1",
        SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", ITEM_REFRESH_UNAVAILABLE: unavailable ? "1" : "" },
    }));
    const observed = [];
    for (const mint of [missing, leaf]) {
      const reply = await client.callTool({ name: "get_asset_trust", arguments: { mint } });
      assert.equal(reply.isError, true);
      observed.push(reply.structuredContent?.error);
    }
    assert.deepEqual(observed, unavailable ? ["upstream-unavailable", "upstream-unavailable"] : ["not-found", "wrong-kind"]);
    const identified = await client.callTool({ name: "identify", arguments: { query: missing } });
    const lookup = identified.structuredContent?.checked.find(entry => entry.source === "asset-index");
    assert.equal(lookup?.result, unavailable ? "error" : "not_found");
    console.log(unavailable ? "Failed refresh: both prior records stay unresolved" : "Fresh reads: missing address and compressed NFT distinguished");
  } finally { await client.close(); }
}
