import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normaliseEnv } from "../dist/lib/env.js";
import { checkForUpdate, resetUpdateCheck } from "../dist/lib/update.js";
import { accountEvents } from "../dist/sources/opensea.js";
import { inspectUntrusted } from "../dist/lib/untrusted.js";

const fixture = (name) => JSON.parse(readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8"));
const run = (name) => !process.argv[2] || process.argv[2] === name;

if (run("names")) {
  const snapshot = JSON.parse(gunzipSync(readFileSync(new URL("../data/me-collections.json.gz", import.meta.url))));
  for (const symbol of ["fairy_", "zombyte"]) {
    const original = snapshot.collections.find((c) => c.s === symbol).n.trim();
    const cleaned = inspectUntrusted(original);
    assert.equal(cleaned.value, original);
    assert.equal(cleaned.suspicious, false);
  }
  assert.equal(inspectUntrusted("Mad\u200d Lads").value, "Mad Lads");
}

if (run("switches")) {
  const latest = fixture("npm-latest-2026-11-19.json");
  let reads = 0;
  const fakeFetch = async () => { reads++; return Response.json(latest); };
  delete process.env.SOLANA_NFT_MCP_OFFLINE;
  for (const value of ["off", "true", " 1 "]) {
    process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = value;
    normaliseEnv();
    resetUpdateCheck();
    const before = reads;
    await checkForUpdate(latest.version, { fetch: fakeFetch });
    assert.equal(reads - before, value === "off" ? 1 : 0, "update requests for switch " + JSON.stringify(value));
  }
}

if (run("cursor")) {
  const page = fixture("os-memecoin-wallet-2026-11-14.json");
  const wallet = page.asset_events[0].to_address;
  delete process.env.SOLANA_NFT_MCP_OFFLINE;
  process.env.OPENSEA_API_KEY = "local-fixture-only";
  let cursor;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).hostname, "api.opensea.io");
    calls++;
    return Response.json({ ...page, next: cursor });
  };
  for (const [i, value] of [null, 17, "a".repeat(2049)].entries()) {
    cursor = value;
    const before = calls;
    const result = await accountEvents(wallet, i + 1);
    assert.equal(calls - before, 1);
    assert.ok(result.events.length > 0);
    assert.equal(result.truncated, value !== null, "coverage for " + typeof value + " cursor");
    if (value !== null) assert.match(result.walkNote, /cursor/i);
  }
}

if (run("paths")) {
  const toml = readFileSync(new URL("../.gitleaks.toml", import.meta.url), "utf8");
  const pattern = /paths = \['''([^']+)'''\]/.exec(toml)[1];
  const allowed = new RegExp(pattern);
  assert.ok(allowed.test("test/fixtures/mcp-name-search-2026-11-19.json"));
  assert.equal(allowed.test("examples/test/fixtures/copy.json"), false);
}

if (run("contracts")) {
  const home = mkdtempSync(join(tmpdir(), "collection-contracts-"));
  const client = new Client({ name: "collection-contracts", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", new URL("./helpers/feeds-and-groups-preload.mjs", import.meta.url).href, "dist/index.js"],
      env: { HOME: home, USERPROFILE: home, SOLANA_NFT_MCP_TEST_HOME: home,
        OPENSEA_API_KEY: "local-fixture-only", SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1" },
    }));
    const rows = fixture("os-solana-index-p1-2026-11-15.json").collections;
    for (const slug of ["mad-lads", "collector-crypt"]) {
      const row = rows.find((r) => r.collection === slug);
      const answer = await client.callTool({ name: "search_collections", arguments: { query: row.name } });
      const hit = answer.structuredContent.opensea.hits.find((h) => h.openseaSlug === slug);
      const addresses = [...new Set(row.contracts.filter((c) => c.chain === "solana").map((c) => c.address))];
      assert.equal(hit.onchainCollection, addresses.length === 1 ? addresses[0] : null);
      if (addresses.length > 1) assert.equal(hit.onchainCollectionCount, addresses.length);
    }
    const punctuation = await client.callTool({ name: "search_collections", arguments: { query: "!" } });
    assert.equal(punctuation.structuredContent.opensea, undefined);
    assert.match(punctuation.structuredContent.openseaNote, /not searched/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}

if (run("search") || run("refresh") || run("lookup")) {
  const client = new Client({ name: "client-reads", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["dist/index.js"],
      env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SOLANA_NFT_MCP_OFFLINE: "1", SOLANA_NFT_MCP_NO_AUTO_KEYS: "1" },
    }));
    const call = async (name, query) => {
      const r = await client.callTool({ name, arguments: { query } });
      assert.ok(!r.isError);
      assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
      return r.structuredContent;
    };
    if (run("search") || run("refresh")) {
      const previous = fixture("mcp-name-search-2026-11-19.json").structuredContent;
      const answer = await call("search_collections", previous.query);
      assert.deepEqual(answer.foundOnChain.searched, []);
      if (run("search")) assert.match(answer.foundOnChain.readThis, /not searched/i);
      if (run("refresh")) assert.match(answer.magicEdenDirectory.notSearched.join(" "), /offline/i);
      const local = await call("search_collections", "Mad Lads");
      assert.equal(local.results[0].id, "mad_lads");
    }
    if (run("lookup")) {
      const tools = (await client.listTools()).tools;
      assert.ok(tools.find((t) => t.name === "identify").outputSchema.properties.lookup);
      const exact = await call("identify", "mad_lads");
      assert.deepEqual(exact.lookup, { name: "get_collection_stats", arguments: { collection: "mad_lads" } });
      const broad = await call("identify", "candy");
      assert.equal(broad.lookup, null);
    }
  } finally { await client.close(); }
}
console.log("client reads passed");
