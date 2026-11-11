/**
 * What the server says when someone pastes the wrong kind of thing, mistypes
 * an address, or meets a slow or busy source.
 *
 * The standard every block holds an answer to: a person who pasted the wrong
 * thing learns in one plain sentence what it is, that nothing is wrong with
 * the service, and what to paste or call instead. No "try again" for
 * something that can never work, and no outage that did not happen. Each
 * block failed before its fix and carries a control that the fix must not
 * disturb.
 *
 * A whole server runs over stdio with every upstream answered by
 * helpers/wrong-input-preload.mjs in a throwaway home folder. Nothing here
 * touches the network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as F from "./helpers/wrong-input-preload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, ".."));
const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-wrong-input-"));
const env = { SOLANA_NFT_MCP_TEST_HOME: home, SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", SOLANA_NFT_MCP_NO_AUTO_KEYS: "1" };
for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", pathToFileURL(path.join(here, "helpers", "wrong-input-preload.mjs")).href, path.join(root, "dist", "index.js")],
  env,
  stderr: "ignore",
});
const client = new Client({ name: "wrong-input", version: "1" }, { capabilities: {} });
await client.connect(transport);

/** One call: the text a person reads, the structured body, and whether it was an error. */
async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const text = r.content?.map((c) => c.text).join("\n") ?? "";
    return { text, data: r.structuredContent ?? {}, isError: r.isError === true };
  } catch (e) {
    return { text: String(e.message), data: {}, isError: true };
  }
}
const fetched = () => (fs.existsSync(path.join(home, "fetches.txt")) ? fs.readFileSync(path.join(home, "fetches.txt"), "utf8").split("\n").filter(Boolean) : []);
const NO_RETRY = /try again|narrower request|outage|api change/i;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// --------------------------------------------------------------- get_asset
await check("a mistyped mint is not found, with no retry advice and no outage", async () => {
  const r = await call("get_asset", { mint: F.MISSING });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, "not-found");
  assert.match(r.text, /typo/);
  assert.doesNotMatch(r.text, NO_RETRY);
});
await check("control: a real item still answers with its chain owner", async () => {
  const r = await call("get_asset", { mint: F.ASSET });
  assert.equal(r.isError, false, r.text.slice(0, 200));
  assert.equal(r.data.onchain.owner, F.WALLET);
  assert.equal(r.data.sourceErrors, undefined, "an item every reader knows has no source error");
});
await check("an index record too big to read is reported as that, not as try again", async () => {
  const r = await call("get_asset", { mint: F.OVERSIZE });
  assert.equal(r.isError, true);
  assert.match(r.text, /more data than this server will read/);
  assert.doesNotMatch(r.text, /could not be completed/);
});
await check("two failing readers both keep their reason inside the cut", async () => {
  const r = await call("get_asset", { mint: F.NOISY });
  assert.equal(r.isError, true);
  assert.match(r.data.detail, /magiceden:/);
  assert.match(r.data.detail, /asset-index:/, `the index's reason was cut off: ${r.data.detail}`);
});
await check("a token mint is named a token, with no single owner", async () => {
  const r = await call("get_asset", { mint: F.TOKEN });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, "wrong-kind");
  assert.match(r.text, /fungible token, not a collectible/);
  assert.match(r.text, /Fixture Coin/);
  assert.doesNotMatch(r.text, new RegExp(F.WALLET), "the index's single owner is not reported");
  assert.doesNotMatch(r.text, NO_RETRY);
});
await check("control: a legacy NFT mint is still an item with its owner", async () => {
  const r = await call("get_asset", { mint: F.LEGACY });
  assert.equal(r.isError, false, r.text.slice(0, 200));
  assert.equal(r.data.chainIndex.owner, F.WALLET);
});
await check("a program id pasted as a mint is named a program, without sending the reader back to get_asset", async () => {
  const r = await call("get_asset", { mint: F.CORE });
  assert.equal(r.isError, true);
  assert.match(r.text, /Metaplex Core program itself/);
  assert.doesNotMatch(r.text, /get_asset still shows|use get_asset/i);
});

// ------------------------------------------------- shapes, in every schema
for (const [label, input, want] of [
  [".sol name", "toly.sol", /Solana Name Service name/],
  ["Ethereum address", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", /Ethereum-style address/],
  ["transaction signature", F.SALE_SIG, /transaction signature/],
  ["string that decodes past 32 bytes", "z".repeat(44), /decodes to 33 bytes/],
]) {
  await check(`get_asset refuses a ${label} by naming it`, async () => {
    const r = await call("get_asset", { mint: input });
    assert.equal(r.isError, true);
    assert.match(r.text, want);
  });
}
await check("verify_claim refuses an Ethereum address as a subject", async () => {
  const before = fetched().length;
  const r = await call("verify_claim", { claim: "never-traded", subject: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Ethereum-style address/);
  assert.equal(fetched().length, before, "nothing was read for it");
});

// ---------------------------------------------------------------- identify
for (const [label, input, kind] of [
  [".sol name", "toly.sol", "name-service-name"],
  ["Ethereum address", "0x000000000000000000000000000000000000dEaD", "other-chain-address"],
  ["transaction signature", F.SALE_SIG, "transaction-signature"],
]) {
  await check(`identify settles a ${label} by its shape, with no network read`, async () => {
    const before = fetched().length;
    const r = await call("identify", { query: input });
    assert.equal(r.data.kind, kind);
    assert.equal(fetched().length, before, `requests were sent: ${fetched().slice(before).join(", ")}`);
  });
}
await check("control: a collection whose real name ends in .sol is still looked up", async () => {
  const r = await call("identify", { query: "Pixeltoy.sol" });
  assert.notEqual(r.data.kind, "name-service-name");
});
await check("identify reads the symbol out of a Magic Eden link", async () => {
  const r = await call("identify", { query: "https://magiceden.io/marketplace/mad_lads" });
  assert.equal(r.data.link?.partUsed, "mad_lads");
  assert.equal(r.data.identifiers.meSymbol, "mad_lads");
  assert.ok(!fetched().some((u) => u.startsWith("https://magiceden.io/")), "the link itself was opened");
});
await check("identify reads the address out of an explorer link", async () => {
  const r = await call("identify", { query: `https://www.solscan.io/token/${F.ASSET}` });
  assert.equal(r.data.link?.usedAs, "address");
  assert.equal(r.data.kind, "core-asset");
});
await check("identify refuses a link to another host in a sentence and never opens it", async () => {
  const r = await call("identify", { query: "https://magiceden.io.evil.example/marketplace/mad_lads" });
  assert.match(r.data.summary, /only reads the identifier out of links to/);
  assert.ok(!fetched().some((u) => u.includes("evil.example")), "the foreign link was opened");
  const plain = await call("identify", { query: "http://magiceden.io/marketplace/mad_lads" });
  assert.match(plain.data.summary, /Only https links/);
});
await check("a look-alike spelling keeps its match at low confidence with a warning", async () => {
  const r = await call("identify", { query: "M\u0430d Lads" });
  assert.equal(r.data.identifiers.meSymbol, "mad_lads");
  assert.equal(r.data.confidence, "low");
  assert.match(r.data.spellingWarning ?? "", /common sign of a copy/);
});
await check("control: the plain spelling carries no spelling warning", async () => {
  const r = await call("identify", { query: "Mad Lads" });
  assert.equal(r.data.identifiers.meSymbol, "mad_lads");
  assert.equal(r.data.spellingWarning, undefined);
});
await check("identify names a token mint a token", async () => {
  const r = await call("identify", { query: F.TOKEN });
  assert.equal(r.data.kind, "fungible-token");
  assert.doesNotMatch(r.data.summary, /current holder/);
});
await check("identify does not call an address with no account a wallet", async () => {
  const r = await call("identify", { query: F.MISSING });
  assert.equal(r.data.kind, "no-account");
  assert.doesNotMatch(r.data.summary, /most likely a wallet/);
});
await check("identify names a program id a program", async () => {
  const r = await call("identify", { query: F.CORE });
  assert.equal(r.data.kind, "program");
  assert.doesNotMatch(r.data.summary, /most likely a wallet/);
});
await check("control: a wallet is still a wallet", async () => {
  const r = await call("identify", { query: F.WALLET });
  assert.equal(r.data.kind, "wallet-or-unknown-account");
  assert.match(r.data.summary, /is a wallet/);
});

// --------------------------------------------- compressed NFTs, by the index
for (const tool of ["get_asset_trust", "get_asset_provenance"]) {
  await check(`${tool} names a compressed NFT and points at get_asset`, async () => {
    const r = await call(tool, { mint: F.CNFT });
    assert.equal(r.isError, true);
    assert.equal(r.data.error, "wrong-kind");
    assert.match(r.text, /compressed NFT/);
    assert.match(r.data.next, /get_asset/);
    assert.doesNotMatch(r.text, /burned|Double-check/);
  });
}
await check("control: an address nobody knows is still not found in get_asset_trust", async () => {
  const r = await call("get_asset_trust", { mint: F.MISSING });
  assert.equal(r.data.error, "not-found");
});

// ------------------------------------------------------- holders census
await check("holders refuses an item and names its collection", async () => {
  const r = await call("get_collection_holders", { collection: F.ASSET });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, "wrong-kind");
  assert.match(r.data.message, new RegExp(`single item.*${F.COL}`));
});
await check("holders refuses a wallet and an address with no account", async () => {
  const w = await call("get_collection_holders", { collection: F.WALLET });
  assert.match(w.data.message ?? "", /is a wallet, not a collection/);
  const m = await call("get_collection_holders", { collection: F.MISSING });
  assert.equal(m.data.error, "not-found");
});
await check("control: a collection still gets its census", async () => {
  const r = await call("get_collection_holders", { collection: F.COL });
  assert.equal(r.isError, false, r.text.slice(0, 200));
  assert.equal(r.data.assetsInCollection, 3);
});
await check("a trait without a value is refused with a headline about the trait", async () => {
  const r = await call("get_collection_holders", { collection: F.COL, trait: "rarity" });
  assert.match(r.data.message, /"rarity" came without a value/);
});

// ------------------------------------------------------- serial searches
await check("find_listings #13 matches the serial printed as (13/810)", async () => {
  const r = await call("find_listings", { symbol: "fixture_batman", nameContains: "#13" });
  assert.equal(r.isError, false, r.text.slice(0, 200));
  assert.deepEqual(r.data.deals.map((d) => d.name), ["Absolute Batman #1 (13/810)"]);
  assert.equal(r.data.deals[0].nameMatch.serialMatch, true);
  assert.equal(r.data.search.matchedTitleOnly, 0);
});
await check("a bare number is never labelled a match on the surrounding title", async () => {
  const r = await call("find_listings", { symbol: "fixture_batman", nameContains: "13" });
  assert.equal(r.data.search.matched, 2);
  assert.equal(r.data.search.nameMatchNote, undefined);
});
await check("a serial with no match says what was tried and gives the find_in_group call", async () => {
  const r = await call("find_listings", { symbol: "fixture_batman", nameContains: "#999" });
  assert.match(r.data.search.serialNote, /find_in_group with \{"collections":\["fixture_batman"\],"serials":\[999\]/);
});
await check("control: a word search still matches by text", async () => {
  const r = await call("find_listings", { symbol: "fixture_batman", nameContains: "Batman" });
  assert.equal(r.data.search.matched, 3);
  assert.equal(r.data.search.serialNote, undefined);
});

// ------------------------------------------------- slow and busy sources
await check("a public node's internal error is worded as the RPC being busy", async () => {
  const r = await call("get_asset_provenance", { mint: F.BUSY });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, "upstream-unavailable");
  assert.match(r.data.message, /public Solana endpoint did not answer/);
});
await check("a timeout uses the timeout wording and names this tool's own arguments", async () => {
  const r = await call("find_listings", { symbol: "slowfixture" });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, "timeout");
  assert.match(r.data.next, /a smaller limit or a trait filter/);
});

// ------------------------------------------------------------ verify_claim
await check("never-traded on a legacy NFT is contradicted by one recorded sale", async () => {
  const r = await call("verify_claim", { claim: "never-traded", subject: F.LEGACY });
  assert.equal(r.data.verdict, "contradicted", r.data.explanation);
  assert.match(r.data.explanation, new RegExp(F.SALE_SIG));
});
await check("control: a legacy NFT with no recorded sale stays unverifiable and points at get_recent_sales", async () => {
  const r = await call("verify_claim", { claim: "never-traded", subject: F.LEGACY_QUIET });
  assert.equal(r.data.verdict, "unverifiable");
  assert.match(r.data.caveats.join(" "), /get_recent_sales/);
});
await check("never-traded on a collection address says it is a collection", async () => {
  const r = await call("verify_claim", { claim: "never-traded", subject: F.COL });
  assert.equal(r.data.verdict, "unverifiable");
  assert.match(r.data.explanation, /is a collection address, not a single item/);
});
await check("the escrow caveat appears only when the owner is an escrow", async () => {
  const held = await call("verify_claim", { claim: "ownership", subject: F.ASSET, wallet: F.OTHER });
  assert.equal(held.data.verdict, "contradicted");
  assert.doesNotMatch(held.data.caveats.join(" "), /escrow/);
  const listed = await call("verify_claim", { claim: "ownership", subject: F.ESCROWED, wallet: F.OTHER });
  // A listed item sits in the venue's escrow, and the seller cannot be read
  // from there: the answer says so itself and does not call the claim false.
  assert.equal(listed.data.verdict, "unverifiable");
  assert.match(listed.data.explanation, /escrow/);
});

// ----------------------------------------------------- groups and symbols
await check("find_in_group past the end says so instead of 'every collection read'", async () => {
  const r = await call("find_in_group", { group: "DC", startAt: 1000, batch: 5 });
  assert.equal(r.data.pastTheEnd, true);
  assert.match(r.data.readThis[0], /past the end/);
  assert.doesNotMatch(r.data.readThis.join(" "), /has now been read/);
});
await check("an unknown group names the valid groups in the headline", async () => {
  const r = await call("find_in_group", { group: "Marvel" });
  assert.equal(r.isError, true);
  assert.match(r.data.message, /no group called "Marvel".*DC/);
  assert.doesNotMatch(r.text, NO_RETRY);
});
await check("a symbol in the wrong case is lower-cased before use", async () => {
  const r = await call("get_floor_prices", { symbols: ["Mad_Lads"] });
  assert.equal(r.data.floors[0].symbol, "mad_lads");
  assert.notEqual(r.data.floors[0].symbolKnown, false);
});
await check("search_collections refuses a query that is empty once cleaned", async () => {
  const r = await call("search_collections", { query: "\u200b\u200b" });
  assert.equal(r.isError, true);
  assert.match(r.data.message, /empty/);
});
await check("search_collections folds full-width letters before matching", async () => {
  const r = await call("search_collections", { query: "\uff2d\uff41\uff44 \uff2c\uff41\uff44\uff53" });
  assert.ok(r.data.magicEdenDirectory.matches.some((m) => m.symbol === "mad_lads"), JSON.stringify(r.data.magicEdenDirectory.matches.slice(0, 3)));
});

await client.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`wrong-input: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
