import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { address, allowOwner, group, reply } from "./helpers/item-reads.mjs";

const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../dist"));
const moduleAt = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { verifyClaim } = await moduleAt("verify.js");
const { identify, fungibleToken } = await moduleAt("identify.js");
const { token } = await moduleAt("sources/magiceden.js");
const { getAsset, getAssetsByOwner } = await moduleAt("sources/das.js");
const { deriveTrust, decodeCoreAccountPlugins } = await moduleAt("lib/coreplugins.js");
process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS = "1";
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = "1";
let failed = 0;
async function check(label, run) {
  if (process.argv[3] && !label.includes(process.argv[3])) return;
  try { await run(); console.log("PASS", label); }
  catch (e) { failed++; console.log("FAIL", label, e.message); }
}

await check("an unread owner program leaves a different wallet's ownership claim open", async () => {
  const claim = { claim: "ownership", subject: address("asset"), wallet: address("usd") };
  const unknown = await verifyClaim(claim);
  allowOwner();
  const moved = await verifyClaim(claim);
  const held = await verifyClaim({ ...claim, wallet: address("owner") });
  assert.deepEqual([unknown.verdict, moved.verdict, held.verdict], ["unverifiable", "contradicted", "confirmed"]);
});
await check("an SPL token account has no mint decimals", async () => {
  const mint = await fungibleToken(address("usd"), null);
  assert.equal(mint?.decimals, 6);
  const account = await fungibleToken(address("tokenAccount"), null);
  assert.equal(account, null, "read " + account?.decimals + " decimals from a token holder account");
});
await check("a venue record must name the requested mint", async () => {
  assert.equal((await token(address("asset"))).mintAddress, address("asset"));
  await assert.rejects(token(address("usd")), /mint|item|asset/i);
});
await check("unread collection rules leave custody and metadata permissions open", () => {
  const decode = (name) => decodeCoreAccountPlugins(JSON.parse(reply(name)).result.value.data[0]);
  const partial = deriveTrust(decode("bare"), null);
  const full = deriveTrust(decode("asset"), decode("collection"));
  assert.equal(full.ownerIsNotSoleController, true);
  assert.equal(full.frozen, false);
  assert.equal(partial.incomplete, true);
  assert.equal(partial.ownerIsNotSoleController, null);
  assert.equal(partial.frozen, null);
  assert.doesNotMatch(partial.warnings.join(" "), /Metadata is mutable/);
});
await check("a capped short wallet page reports its omitted rows", async () => {
  const items = JSON.parse(reply("wallet")).result.items;
  const owner = items[0].ownership.owner;
  const complete = await getAssetsByOwner(owner, items.length);
  assert.equal(complete.truncated, false);
  assert.equal(complete.items.length, items.length);
  const one = await getAssetsByOwner(owner, 1);
  assert.equal(one.items.length, 1);
  assert.equal(one.truncated, true);
});
await check("identify keeps a burned item's last holder historical", async () => {
  const r = await identify(address("burn"));
  assert.match(r.summary, /burned/i);
  assert.doesNotMatch(r.summary, /as the current holder/i);
  assert.ok(r.suggestedNextTools.includes("get_asset_provenance"));
});
await check("a successful index canary cannot settle a failed compressed item lookup", async () => {
  assert.equal(JSON.parse(reply("leafDas")).result.compression.compressed, true);
  const r = await identify(address("leaf"));
  assert.notEqual(r.kind, "no-account", r.summary);
  assert.doesNotMatch(r.summary, /index has no record/i);
  assert.ok(r.checked.some(c => c.source === "asset-index" && c.result === "error"));
});
async function withServer(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./helpers/item-reads.mjs", import.meta.url).href, path.join(dist, "index.js")],
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1" },
    stderr: "ignore",
  });
  const client = new Client({ name: "item-reads", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await run(client);
  } finally { await client.close(); }
}
await check("unavailable indexes do not rule out a Token Metadata item", () => withServer(async client => {
    const call = (mint) => client.callTool({ name: "get_asset", arguments: { mint } });
    const good = await call(address("asset"));
    assert.equal(good.structuredContent.onchain.owner, address("owner"));
    const missing = await call(address("legacy"));
    assert.equal(missing.isError, true);
    assert.doesNotMatch(JSON.stringify(missing.structuredContent), /not an item|neither Magic Eden nor the chain's asset index has it/i);
}));
await check("a zero-supply Token-2022 collectible has no circulating holder", async () => {
  const zero = (await getAsset(address("zeroMint"))).asset;
  const live = (await getAsset(address("liveMint"))).asset;
  const rawSupply = name => Buffer.from(JSON.parse(reply(name)).result.value.data[0], "base64").readBigUInt64LE(36);
  assert.deepEqual([rawSupply("zeroMint"), rawSupply("liveMint")], [0n, 1n]);
  assert.deepEqual([zero.standard, zero.owner, live.standard, live.owner],
    ["token-2022", null, "token-2022", JSON.parse(reply("liveDas")).result.ownership.owner]);
  assert.match((await identify(address("zeroMint"))).summary, /zero supply/i);
});
await check("a Core group has an update authority and no item holder", () => withServer(async client => {
  const result = await identify(group);
  const item = await client.callTool({ name: "get_asset", arguments: { mint: group } });
  const control = await client.callTool({ name: "get_asset", arguments: { mint: address("asset") } });
  assert.equal(result.kind, "core-group", result.summary);
  assert.doesNotMatch(result.summary, /current holder/);
  assert.equal(item.isError, true);
  assert.match(JSON.stringify(item.structuredContent), /Core group/i);
  assert.equal(control.structuredContent.onchain.owner, address("owner"));
}));
await check("wallet ownership requires a fresh read on every call", () => withServer(async client => {
  const wallet = JSON.parse(reply("wallet")).result.items[0].ownership.owner;
  const call = async () => (await client.callTool({ name: "get_wallet_holdings", arguments: { wallet, limit: 60 } })).structuredContent;
  const first = await call();
  const next = await call();
  assert.equal(first.heldNow.noLongerHeld, 41);
  assert.equal(first.ownershipVerifiedOnchain, true);
  assert.equal(next.heldNow.unread, 41, JSON.stringify(next.heldNow));
  assert.equal(next.ownershipVerifiedOnchain, false);
  assert.doesNotMatch(next.heldNow.sentence, /0 of the 41 distinct item\(s\) shown are held/);
}));
process.exitCode = failed ? 1 : 0;
