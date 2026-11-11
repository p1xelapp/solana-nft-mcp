/**
 * Offline regressions for facts that went stale and for sales that were
 * reported from one feed as if they were the whole market.
 *
 * In-process blocks import the build directly with a stubbed fetch; the
 * stdio blocks run whole tool handlers against test/helpers/stale-facts-preload.mjs
 * in a throwaway home folder. Nothing here reaches the network.
 *
 * Run: npm run build && node test/stale-facts-and-sales.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let handler = () => ({ status: 404, json: { message: "no handler" } });
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  const answer = await handler({ url: String(url), body });
  return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
};
process.env.OPENSEA_API_KEY = "fixture-only-not-a-credential";
process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS = "1";
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = "1";

const { issuerTableDisagreements, knownIssuer, describeIssuerKey, roleOf } = await import("../dist/issuers.js");
const { explainMechanics, mentions, MECHANICS } = await import("../dist/mechanics.js");
const { splMintAuthority, decodeCoreAccountPlugins, deriveTrust, oracleReadingKey } = await import("../dist/lib/coreplugins.js");
const { REGISTRY, searchRegistry } = await import("../dist/registry.js");
const das = await import("../dist/sources/das.js");
const osrc = await import("../dist/sources/opensea.js");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name} - ${e instanceof Error ? e.message : String(e)}`);
  }
}

const OLD_KEY = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2";
const NEW_KEY = "7wixESeixiY4f2A6JaDKNewNoiip9Tk9s5u1dze7nRwL";
const registryFile = JSON.parse(fs.readFileSync(path.join(root, "data", "candy-collections.json"), "utf8"));
const registryAddresses = registryFile.collections.map((c) => c.address);

// ---------------------------------------------------------------- issuer table
await check("the bundled issuer table and the registry agree on every collection's authority", () => {
  const problems = issuerTableDisagreements(registryAddresses);
  assert.deepStrictEqual(problems, [], problems.slice(0, 5).join("\n"));
});

await check("the release check fails when a collection is signed by a former key, missing, or miscounted", () => {
  const t = JSON.parse(fs.readFileSync(path.join(root, "data", "issuers.json"), "utf8"));
  const current = t.issuers.find((r) => !r.former);
  const former = t.issuers.find((r) => r.former);
  assert.ok(current && former, "the table carries a current and a former key");
  const [moved, ...rest] = current.collectionAddresses;
  // A collection put back under the former key: the case that went unnoticed.
  const backToOld = { issuers: [{ ...current, collectionAddresses: rest, collections: rest.length }, { ...former, collectionAddresses: [moved], collections: 1 }] };
  assert.ok(issuerTableDisagreements(registryAddresses, backToOld).some((p) => p.includes("marked former")));
  // A registry collection no row names.
  const dropped = { issuers: [{ ...current, collectionAddresses: rest, collections: rest.length }, former] };
  assert.ok(issuerTableDisagreements(registryAddresses, dropped).some((p) => p.startsWith(moved) && /names no authority/.test(p)));
  // A count that does not match the list.
  const miscounted = { issuers: [{ ...current, collections: current.collections + 1 }, former] };
  assert.ok(issuerTableDisagreements(registryAddresses, miscounted).some((p) => /says \d+ collection/.test(p)));
  // A table without per-collection lists cannot be checked, and says so.
  assert.ok(issuerTableDisagreements(registryAddresses, { issuers: [{ address: OLD_KEY, issuer: "x", role: "r", collections: 401 }] }).some((p) => /no collection list/.test(p)));
});

await check("the current Candy key is named as current and the old one as former, with dates", () => {
  const cur = knownIssuer(NEW_KEY);
  const old = knownIssuer(OLD_KEY);
  assert.ok(cur && !cur.former && cur.collections === registryAddresses.length, "the new key signs every registered collection");
  assert.ok(old && old.former === true && old.collections === 0, "the old key is kept, as former");
  const curText = describeIssuerKey(cur);
  const oldText = describeIssuerKey(old);
  assert.match(curText, /current update authority of 401/);
  assert.match(oldText, /FORMER key/);
  assert.match(oldText, /2026-10-08/, "the last date it was seen as the authority");
  assert.match(oldText, /mint authority of FsrQuCFEGaokcnFtaSAM2zdczrPcRzcWeDHqZjzQu8ox/, "what it still controls");
  assert.ok(!/authority of 401/.test(oldText), "the old key is not described as the authority of the collections");
  // A key the table does not know stays unknown.
  assert.strictEqual(knownIssuer("11111111111111111111111111111111"), null);
  // As a holder of some other collection, the old key is named as former.
  assert.match(roleOf(OLD_KEY, NEW_KEY).note, /former key/);
});

// ---------------------------------------------------------------- mechanics words
await check("explain_mechanics finds the new entries for the words a holder types", () => {
  const top = (q) => explainMechanics(q)[0]?.id;
  assert.strictEqual(top("listed but I never listed it"), "q-stale-listing-after-move");
  assert.strictEqual(top("stale listing"), "q-stale-listing-after-move");
  assert.strictEqual(top("sealed item"), "venue-candy-sealed-item");
  assert.strictEqual(top("same serial twice"), "venue-candy-duplicate-serials");
  assert.strictEqual(top("usd"), "q-prices-not-converted-to-dollars");
});

await check("Token-2022 is found however it is spelled, and two letters match nothing by substring", () => {
  for (const q of ["token-2022 nft", "Token2022", "token 2022", "token-2022"]) {
    assert.strictEqual(explainMechanics(q)[0]?.id, "standard-token-2022", q);
  }
  assert.strictEqual(explainMechanics("ab").length, 0, "\"ab\" is not a word in any entry");
  assert.ok(!mentions("a table and a label", "ab"));
  // Control: whole words still match.
  assert.ok(mentions("the floor price", "floor"));
  assert.ok(explainMechanics("escrow").length > 0);
});

await check("the Candy words carry today's figures and name the OpenSea protocol", () => {
  const byId = (id) => MECHANICS.find((m) => m.id === id);
  const royalty = byId("venue-candy-royalty-allowlist");
  assert.ok(!/split three ways/.test(royalty.plain), "not every MLB collection splits three ways");
  assert.match(royalty.observed, /89 of 103/);
  assert.match(royalty.observed, /7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V/);
  assert.ok(!/not identified here/.test(royalty.observed));
  const key = byId("venue-candy-one-issuer-key");
  assert.ok(!/a change of key is noticed/.test(key.plain), "the old promise is gone");
  assert.match(key.plain, new RegExp(NEW_KEY));
  const migration = byId("venue-candy-wallet-migration-october-2026");
  assert.match(migration.plain, /announced/);
  assert.match(migration.plain, /October 22/);
  assert.match(migration.observed, /Magic Eden still showed/);
  for (const id of ["q-stale-listing-after-move", "venue-candy-sealed-item", "venue-candy-duplicate-serials", "q-prices-not-converted-to-dollars"]) {
    const e = byId(id);
    assert.ok(e && e.sourceRead === "2026-11-10" && e.source.startsWith("https://"), `${id} is dated and sourced`);
  }
});

// ---------------------------------------------------------------- registry names
await check("hand-written Candy entries carry the collection's own on-chain name; old names still resolve", () => {
  const chainName = new Map(registryFile.collections.map((c) => [c.address, c.name.trim()]));
  for (const e of REGISTRY.filter((x) => x.coreCollection && chainName.has(x.coreCollection) && x.id.startsWith("candy-"))) {
    const expected = `Candy Digital - ${chainName.get(e.coreCollection).replace(/ - Candy Digital$/, "")}`;
    assert.strictEqual(e.name, expected, `${e.id}`);
  }
  assert.strictEqual(searchRegistry("MLB Gold Series Auction #1")[0]?.id, "candy-mlb-gold-auction-1");
  assert.strictEqual(searchRegistry("2026 MLB ICON Series")[0]?.id, "candy-mlb-icon-2026");
});

// ---------------------------------------------------------------- oracle controller
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "candy-oracle-2026-11-08.json"), "utf8"));
await check("an oracle that is an SPL mint names its mint authority; anything else keeps the general sentence", () => {
  assert.strictEqual(splMintAuthority(fixture.oracle.data, fixture.oracle.owner), OLD_KEY);
  // A token ACCOUNT is not a mint, and an account of another program is not either.
  assert.strictEqual(splMintAuthority(Buffer.alloc(165, 1).toString("base64"), fixture.oracle.owner), undefined);
  assert.strictEqual(splMintAuthority(fixture.oracle.data, "11111111111111111111111111111111"), undefined);
  const asset = decodeCoreAccountPlugins(fixture.asset.data);
  const collection = decodeCoreAccountPlugins(fixture.collection.data);
  const key = oracleReadingKey(fixture.oracle.address, 36);
  const answered = { account: fixture.oracle.address, state: "answered", results: { create: "rejected", transfer: "pass", burn: "rejected", update: "rejected" } };
  const named = deriveTrust(asset, collection, new Map([[key, { ...answered, mintAuthority: OLD_KEY }]]), { updateAuthority: NEW_KEY, nameKey: () => "Candy Digital's former key" });
  const line = named.warnings.find((w) => /BLOCKED BY AN ORACLE/.test(w));
  assert.match(line, new RegExp(`mint authority, ${OLD_KEY} \\(Candy Digital's former key\\)`));
  assert.match(line, new RegExp(`NOT the collection's current update authority \\(${NEW_KEY}\\)`));
  const same = deriveTrust(asset, collection, new Map([[key, { ...answered, mintAuthority: NEW_KEY }]]), { updateAuthority: NEW_KEY });
  assert.match(same.warnings.find((w) => /BLOCKED/.test(w)), /the same key as the collection's update authority/);
  // Control: not a mint, so nobody is named.
  const plain = deriveTrust(asset, collection, new Map([[key, answered]]), { updateAuthority: NEW_KEY });
  assert.match(plain.warnings.find((w) => /BLOCKED/.test(w)), /Whoever controls that account can change the answer/);
});

// ---------------------------------------------------------------- asset index royalty
await check("the asset index's royalty is not relayed for Core assets; other standards keep theirs", async () => {
  const MINT_CORE = "5eEj95egk28LLieVkEnGcE5JnwhZ4Z6Vnmi3ooua3J91";
  const MINT_TM = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  handler = ({ body }) => {
    const id = body?.params?.id;
    const iface = id === MINT_TM ? "V1_NFT" : "MplCoreAsset";
    return { json: { jsonrpc: "2.0", id: 1, result: { id, interface: iface, content: { metadata: { name: "Card" } }, ownership: { owner: NEW_KEY }, royalty: { basis_points: id === MINT_TM ? 500 : 0, percent: 0 } } } };
  };
  const core = (await das.getAsset(MINT_CORE)).asset;
  assert.strictEqual(core.royaltyPct, null, "a Core zero is not a royalty");
  assert.match(core.royaltyNote, /Royalties plugin/);
  assert.match(core.royaltyNote, /get_asset_trust/);
  const tm = (await das.getAsset(MINT_TM)).asset;
  assert.strictEqual(tm.royaltyPct, 5, "control: a Token Metadata royalty still comes through");
  assert.strictEqual(tm.royaltyNote, undefined);
});

// ---------------------------------------------------------------- OpenSea label and link
await check("OpenSea's ETH volume label is kept and called OpenSea's own; SOL gets no remark", async () => {
  handler = ({ url }) => ({ json: { total: { floor_price: 0.2, floor_price_symbol: "SOL", volume: 12, volume_symbol: url.includes("eth-label") ? "ETH" : "SOL", sales: 3, num_owners: 2 } } });
  const eth = await osrc.collectionStats("eth-label");
  assert.strictEqual(eth.volumeCurrency, "ETH");
  assert.match(eth.volumeCurrencyNote, /OpenSea's own label/);
  const sol = await osrc.collectionStats("sol-label");
  assert.strictEqual(sol.volumeCurrencyNote, undefined);
  assert.strictEqual(osrc.collectionPageUrl("mad-lads"), "https://opensea.io/collection/mad-lads");
  assert.strictEqual(osrc.collectionPageUrl("x/../evil"), null, "a slug that is not slug-shaped never becomes a link");
});

// ---------------------------------------------------------------- whole handlers over stdio
const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-stale-facts-"));
const preloadUrl = pathToFileURL(path.join(here, "helpers", "stale-facts-preload.mjs")).href;
// The same derivations the preload uses; importing it here would replace this
// process's fetch and home folder.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encode = (b) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const P = {
  sig: (label) => encode(createHash("sha512").update(label).digest()),
  WALLET: encode(createHash("sha256").update("profile-wallet").digest()),
  PORTRAITS: { symbol: "portraits_echoes_across_the_lens_of_time", slug: "portraits-echoes-across-the-lens-of-time" },
  ALLSTAR: { symbol: "2026_mlb_allstar_game_icons_candy_digital", core: "YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX" },
};
const env = { SOLANA_NFT_MCP_TEST_HOME: home, SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", OPENSEA_API_KEY: "fixture-only-not-a-credential", SOLANA_RPC_URL: "https://stale-rpc.invalid", DAS_RPC_URL: "https://stale-rpc.invalid" };
for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k];
const client = new Client({ name: "stale-facts", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preloadUrl, path.join(root, "dist", "index.js")], env, stderr: "ignore" }));
const call = async (name, args, timeout = 90_000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  assert.notStrictEqual(r.isError, true, r.content?.[0]?.text?.slice(0, 300));
  return r.structuredContent ?? JSON.parse(r.content[0].text);
};

await check("one fill in both feeds is marked as the same transaction, neither dropped nor added", async () => {
  const r = await call("get_recent_sales", { collection: "candy-portraits-echoes-across-the-lens-of-time", limit: 10 });
  assert.strictEqual(r.sales.length, 2, "Magic Eden's rows are untouched");
  const rows = r.opensea.sales;
  assert.strictEqual(rows.length, 3, "OpenSea's rows are all kept");
  const same = rows.filter((x) => x.sameTransactionAs === "magiceden");
  assert.strictEqual(same.length, 1, "only the row with the same signature AND item is the same sale");
  assert.strictEqual(same[0].transaction, P.sig("fill-1"));
  assert.match(same[0].sameTransactionNote, /includes the royalty and the marketplace fee/);
  assert.strictEqual(r.opensea.sameTransactions, 1);
  // Control: a shared signature on a different item, and an OpenSea-only sale, stay unmarked.
  assert.ok(rows.filter((x) => x.transaction !== P.sig("fill-1")).every((x) => !x.sameTransactionAs));
  // The link back, under the slug proved against the chain address.
  assert.strictEqual(r.opensea.identity.verdict, "verified");
  assert.strictEqual(r.opensea.openseaUrl, `https://opensea.io/collection/${P.PORTRAITS.slug}`);
});

await check("collection sales say they are Magic Eden's feed and carry OpenSea's window count separately", async () => {
  const r = await call("get_collection_sales", { symbol: P.PORTRAITS.symbol, days: 7 });
  assert.match(r.figuresCover, /Magic Eden's activity feed/);
  assert.ok(!/^the whole collection over the window$/.test(r.figuresCover));
  const o = r.openseaSameWindow;
  assert.strictEqual(o.status, "read");
  assert.strictEqual(o.sales, 3, "OpenSea's own count for the window");
  assert.strictEqual(o.openseaUrl, `https://opensea.io/collection/${P.PORTRAITS.slug}`);
  assert.match(o.note, /not added to Magic Eden's/);
  assert.strictEqual(r.sales, 0, "Magic Eden's figure is not topped up with OpenSea's");
  // Control: a collection OpenSea cannot prove is not read, and gets no link.
  const other = await call("get_collection_sales", { symbol: P.ALLSTAR.symbol, days: 7 });
  assert.strictEqual(other.openseaSameWindow.status, "not-read");
  assert.strictEqual(other.openseaSameWindow.openseaUrl, undefined);
  assert.match(other.openseaSameWindow.note, new RegExp(P.ALLSTAR.core));
});

await check("the two static tools are not open-world, and the server says who it is", async () => {
  const { tools } = await client.listTools();
  const hint = (n) => tools.find((t) => t.name === n).annotations.openWorldHint;
  assert.strictEqual(hint("explain_mechanics"), false);
  assert.strictEqual(hint("get_integration_recipe"), false);
  assert.strictEqual(hint("get_asset"), true, "control: a tool that reads the network stays open-world");
  const info = client.getServerVersion();
  assert.strictEqual(info.title, "Solana NFT MCP");
  assert.strictEqual(info.websiteUrl, "https://p1xel.app/solana-nft-mcp/");
  const recipe = await call("get_integration_recipe", { goal: "floor-dashboard" });
  const terms = recipe.sourceTerms.find((t) => t.source === "OpenSea API");
  assert.ok(terms.urls.includes("https://opensea.io/tos"));
  assert.match(terms.asks, /Link back to OpenSea/);
});

await check("the glossary beside explain_mechanics matches whole words only", async () => {
  const ab = await call("explain_mechanics", { topic: "ab" });
  assert.strictEqual(ab.count, 0);
  assert.strictEqual(ab.vocabulary.length, 0, "\"ab\" inside \"table\" or \"label\" is not a match");
  const floor = await call("explain_mechanics", { topic: "floor" });
  assert.ok(floor.vocabulary.length > 0, "control: a real word still finds its term");
});

await check("a default wallet profile answers inside the budget and names the floor it could not read", async () => {
  const t0 = Date.now();
  const r = await call("get_wallet_profile", { wallet: P.WALLET }, 120_000);
  const took = (Date.now() - t0) / 1000;
  assert.ok(took < 45, `took ${took.toFixed(1)} s`);
  assert.deepStrictEqual(r.timeBudget.notPriced, ["slow_floor"]);
  assert.ok(r.floorCeiling, "the ceiling is still computed from what was read");
  assert.strictEqual(r.holdings.totalItems, 3);
});

await check("control: with every floor answering, no time-budget note appears", async () => {
  const r = await call("get_wallet_profile", { wallet: P.WALLET, priceTop: 1 });
  assert.strictEqual(r.timeBudget, undefined);
});

await client.close();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\nstale-facts-and-sales: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
