/**
 * Offline regressions for the pre-release gauntlet findings.
 *
 * One block per defect, named by the wrong answer it prevents rather than the
 * function it calls. Everything here runs against the BUILT output with no
 * network: the upstream is a scripted transport, and an unexpected request
 * fails the run loudly rather than escaping the machine.
 *
 * Run: npm run build && node test/release-checks.mjs
 */

import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const calls = [];
let handler = () => {
  throw new Error("no fetch handler installed");
};

globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), method: body?.method ?? null });
  const answer = await handler({ url: String(url), body });
  return {
    ok: answer.status === undefined || answer.status < 400,
    status: answer.status ?? 200,
    headers: { get: () => null },
    body: { cancel: async () => undefined },
    json: async () => answer.json,
    text: async () => JSON.stringify(answer.json ?? ""),
  };
};

const das = await import("../dist/sources/das.js");
const me = await import("../dist/sources/magiceden.js");
const { closeSpellings } = await import("../dist/names.js");
const { chainCountIsATotal } = await import("../dist/wallet.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  calls.length = 0;
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name} - ${e instanceof Error ? e.message : String(e)}`);
  }
}

const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";
const OWNER_MIXED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OWNER_ALL_BAD = "7HHs3KRC9sBBmLrDNVy3nBQ8dKZwLjKM3gLFVbMpNpFR";
const GOOD_ROW = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const rpcOk = (result) => ({ json: { jsonrpc: "2.0", id: 1, result } });
const ownerRow = (id) => ({
  id,
  interface: "MplCoreAsset",
  content: { metadata: { name: "Test Card" } },
  ownership: { owner: OWNER_MIXED, frozen: false },
  grouping: [{ group_key: "collection", group_value: CANARY }],
});

// ------------------------------------------------------------------ D11
// A row with no `id` became a holding with `mint: ""`, counted in
// chainIndex.count and published with countIsATotal: true - a wrong holdings
// count carried with full confidence during an index outage.
await check("D11 an id-less asset-index row is dropped and counted, never held", async () => {
  handler = ({ body }) => {
    if (body.method === "getAsset") return rpcOk({ id: body.params.id });
    if (body.method === "getAssetsByOwner") return rpcOk({ items: [ownerRow(GOOD_ROW), { grouping: {} }, { id: "not base58 at all !!" }], total: 3 });
    throw new Error(`unexpected method ${body.method}`);
  };
  const page = await das.getAssetsByOwner(OWNER_MIXED, 100);
  assert.strictEqual(page.items.length, 1, "only the row that carried a usable id is a holding");
  assert.strictEqual(page.items[0].mint ?? page.items[0].id, GOOD_ROW);
  assert.strictEqual(page.rowsRejected, 2, "both unusable rows are counted, not silently dropped");
  assert.ok(
    !page.items.some((a) => a.id === ""),
    "no holding may carry an empty mint",
  );
});

await check("D11 a page where no row carries an id is an upstream failure, not an empty wallet", async () => {
  handler = ({ body }) => {
    if (body.method === "getAsset") return rpcOk({ id: body.params.id });
    if (body.method === "getAssetsByOwner") return rpcOk({ items: [{ grouping: {} }, {}], total: 2 });
    throw new Error(`unexpected method ${body.method}`);
  };
  await assert.rejects(
    () => das.getAssetsByOwner(OWNER_ALL_BAD, 100),
    /not one carried a usable id/,
    "an all-unusable page must be refused, not counted as zero holdings",
  );
});

await check("D11 a count is only a total when nothing was dropped and nothing was truncated", () => {
  assert.strictEqual(chainCountIsATotal(false, 0), true);
  assert.strictEqual(chainCountIsATotal(false, 1), false, "one dropped row makes the count a floor");
  assert.strictEqual(chainCountIsATotal(true, 0), false, "a truncated walk is not a total either");
  assert.strictEqual(chainCountIsATotal(true, 3), false);
});

// ------------------------------------------------------------------- D8
// Magic Eden echoes an unknown symbol back as {symbol, listedCount: 0}, so a
// made-up collection came back through four market tools as real and quiet.
await check("D8 a symbol the venue does not list is unknown, not a quiet market", async () => {
  handler = ({ url }) => {
    if (url.includes("/stats")) return { json: { symbol: "zzz_not_real_1234", listedCount: 0 } };
    if (url.includes("/activities")) return { json: [] };
    return { json: {} }; // the metadata echo: no name
  };
  assert.strictEqual(await me.symbolIsKnown("zzz_not_real_1234"), false);
  await assert.rejects(
    () => me.assertSymbolKnown("zzz_not_real_1234"),
    /Magic Eden has no collection with this symbol/,
    "the refusal has to say what is wrong and what resolves it",
  );
  assert.ok(
    /search_collections resolves a name to a symbol/.test(me.SYMBOL_UNKNOWN_MESSAGE),
    "the message names the next step",
  );
});

await check("D8 a real collection with no stats yet is known from its activity feed", async () => {
  handler = ({ url }) => {
    if (url.includes("/stats")) return { json: { symbol: "brand_new_drop_1", listedCount: 0 } };
    if (url.includes("/activities")) return { json: [{ type: "buyNow", price: 1, tokenMint: GOOD_ROW }] };
    return { json: {} };
  };
  assert.strictEqual(await me.symbolIsKnown("brand_new_drop_1"), true, "trades before stats is a real collection");
});

await check("D8 an unreadable venue is never reported as an absent collection", async () => {
  handler = () => ({ status: 503, json: {} });
  await assert.rejects(
    () => me.symbolIsKnown("outage_symbol_9"),
    (e) => !/has no collection with this symbol/.test(e.message),
    "a failure to read must not become a claim that the collection does not exist",
  );
});

await check("D8 a rate-limited metadata endpoint neither grants nor vetoes the verdict", async () => {
  // Magic Eden answers 429 on /collections/{symbol} for real collections for
  // minutes at a time. That read may only ever say yes: failing the whole
  // check would break every market tool during a rate limit, and letting it
  // grant an absence would trust a read that never happened.
  handler = ({ url }) => {
    if (url.includes("/stats")) return { json: { symbol: "rate_limited_meta_1", listedCount: 0 } };
    if (url.includes("/activities")) return { json: [] };
    return { status: 429, json: {} };
  };
  const verdict = await me.symbolKnowledge("rate_limited_meta_1");
  assert.strictEqual(verdict.known, false, "two readable, empty reads still establish the absence");
  assert.ok(/could not be read/.test(verdict.checked), `the verdict has to admit the layer it could not read: ${verdict.checked}`);
});

await check("D8 the quiet-market note is only written about a feed that carried events", async () => {
  handler = ({ url }) => {
    if (url.includes("/activities")) return { json: [] };
    if (url.includes("/stats")) return { json: { symbol: "empty_feed_sym", volumeAll: 12 } };
    return { json: {} };
  };
  const read = await me.recentSales("empty_feed_sym", 10);
  assert.strictEqual(read.sales.length, 0);
  assert.ok(!/quiet or listing-heavy/.test(read.note ?? ""), "nothing scanned is not evidence of a quiet market");
  assert.ok(/no events at all/.test(read.note ?? ""), "the note says the feed was empty instead");
});

// ------------------------------------------------------------------- D3
// "claynosaurs" is one letter off a collection that IS in the bundled
// directory, and the answer was an empty result - a typo read as an absence.
await check("D3 a one-letter misspelling resolves as a close spelling, scored below a match", () => {
  const index = [
    { symbol: "claynosaurz", name: "Claynosaurz", isBadged: true },
    { symbol: "mad_lads", name: "Mad Lads", isBadged: true },
    { symbol: "degods", name: "DeGods" },
  ];
  const clay = closeSpellings(index, "claynosaurs");
  assert.strictEqual(clay[0]?.symbol, "claynosaurz", "the directory entry one edit away must be offered");
  assert.strictEqual(clay[0]?.reason, "close spelling");
  assert.ok(clay[0].score < 95, `a correction must score below an exact name match, got ${clay[0].score}`);

  const lads = closeSpellings(index, "mad ladz");
  assert.strictEqual(lads[0]?.symbol, "mad_lads", "a misspelt word in a two-word name must still resolve");
  assert.strictEqual(lads[0]?.reason, "close spelling");

  // A transposition is one edit, not two.
  assert.strictEqual(closeSpellings(index, "clanyosaurz")[0]?.symbol, "claynosaurz");

  // Bounds: four characters is too short to correct, and three edits is a
  // different collection rather than a misspelling of this one.
  assert.deepStrictEqual(closeSpellings(index, "clay"), [], "a 4-character query is not corrected");
  assert.deepStrictEqual(closeSpellings(index, "clarinet music"), [], "three or more edits is not a misspelling");
  // An exact match is not a "close spelling": the layers above own that case.
  assert.deepStrictEqual(closeSpellings(index, "claynosaurz"), []);
  assert.ok(closeSpellings(index, "clay").length <= 5);
});

// ------------------------------------------------------------------ D15
// Six address fields and one number published a JSON Schema a client cannot
// validate against, so an agent that pre-validates would send a 1 MB
// "address" or 1e308 and only find out from the server.
await check("D15 every published string bound has a maxLength and every number a maximum", async () => {
  const client = new Client({ name: "gauntlet-test", version: "1.0.0" });
  const env = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "COMSPEC"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.COLLECTOR_MCP_OFFLINE = "1";
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));
  try {
    const { tools } = await client.listTools();
    assert.strictEqual(tools.length, 21, "the frozen tool surface");
    const gaps = [];
    const walk = (tool, name, schema) => {
      if (!schema || typeof schema !== "object") return;
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (types.includes("string") && !schema.enum && schema.maxLength === undefined) gaps.push(`${tool}.${name}: string with no maxLength`);
      if (types.includes("number") || types.includes("integer")) {
        if (schema.maximum === undefined && schema.exclusiveMaximum === undefined) gaps.push(`${tool}.${name}: number with no maximum`);
      }
      for (const [k, v] of Object.entries(schema.properties ?? {})) walk(tool, `${name}.${k}`, v);
      if (schema.items) walk(tool, `${name}[]`, schema.items);
      for (const branch of schema.anyOf ?? schema.oneOf ?? schema.allOf ?? []) walk(tool, name, branch);
    };
    for (const t of tools) {
      for (const [k, v] of Object.entries(t.inputSchema?.properties ?? {})) walk(t.name, k, v);
    }
    assert.deepStrictEqual(gaps, [], `unvalidatable schema fields:\n  ${gaps.join("\n  ")}`);

    // And the bound is real, not only declared.
    const tooLong = await client.callTool({ name: "get_asset", arguments: { mint: "1".repeat(5000) } }).catch((e) => e);
    const text = JSON.stringify(tooLong);
    assert.ok(/validation|Invalid|base58|at most/i.test(text), `an over-long address must be refused: ${text.slice(0, 200)}`);
  } finally {
    await client.close();
  }
});

console.log(`\ngauntlet test: ${passed} groups passed (D11 x3, D8 x5, D3, D15)`);
if (failures.length) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
