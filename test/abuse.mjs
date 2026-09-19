/**
 * What someone can do to this server, and to the person running it.
 *
 * Every other suite asks whether an answer is correct. This one assumes the
 * caller is hostile and asks what they can get: text that steers the model,
 * the operator's API key, a path on the operator's disk, or anything about
 * the operator at all. It runs a real server over stdio against a hostile
 * marketplace, so what it asserts is what a user would actually receive.
 *
 * Nothing here touches the network.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, homedir, userInfo } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};

const CANARY = "ABUSE-CANARY-KEY-0123456789";
const home = fs.mkdtempSync(path.join(tmpdir(), "collector-mcp-abuse-"));
const preload = pathToFileURL(path.join(here, "helpers", "abuse-preload.mjs")).href;

const base = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC };
for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", preload, path.join(root, "dist", "index.js")],
  env: { ...base, COLLECTOR_TEST_HOME: home, COLLECTOR_TEST_CANARY: CANARY, COLLECTOR_MCP_NO_UPDATE_CHECK: "1", SOLANA_RPC_URL: "https://abuse-rpc.invalid", DAS_RPC_URL: "https://abuse-rpc.invalid" },
  stderr: "ignore",
});
const client = new Client({ name: "abuse", version: "1" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args) => await client.callTool({ name, arguments: args }, undefined, { timeout: 40_000 });
const textOf = (r) => JSON.stringify(r);

// ================================================================ A-01
// An item name is text an attacker minted. The structure that would make it
// read as a new turn, a system prompt or a tool call must not survive into
// the answer.
{
  const r = await call("find_listings", { symbol: "abuse", limit: 5 });
  const body = textOf(r);

  // The exact separators that end a turn in the common chat formats.
  for (const marker of ["\n\nHuman:", "\n\nAssistant:", "<|im_start|>", "<|im_end|>"]) {
    assert.ok(!body.includes(marker), `a minted name carried ${JSON.stringify(marker)} into the answer intact`);
  }
  // Invisible characters cannot be used to hide text from the reader.
  for (const ch of ["\u200b", "\u200c", "\u200d", "\u2060", "\u0000", "\u001b"]) {
    assert.ok(!body.includes(ch), `an invisible or control character survived: ${JSON.stringify(ch)}`);
  }
  // The words themselves are allowed to survive: a name is data, and deleting
  // it would hide a real listing. What matters is that it cannot pose as
  // anything but data.
  assert.ok(/ignore all previous instructions/i.test(body), "the name is still reported, because a collector needs to see what was minted");
  assert.ok(/instruction|neutralis|neutraliz|data to display|never as instructions/i.test(body), "the answer says the text was neutralised and is data");
  ok("A-01 a minted name cannot pose as a new turn, a system prompt or a tool call");
}

// ================================================================ A-02
// The operator's API key. The upstream in this fixture reflects it back in an
// error body, which is what a real one does when it rejects a header.
{
  const probes = [
    ["get_source_status", {}],
    ["get_collection_stats", { collection: "abuse", openseaSlug: "abuse" }],
    ["find_listings", { symbol: "abuse", openseaSlug: "abuse", limit: 3 }],
  ];
  let redactedSomewhere = false;
  for (const [name, args] of probes) {
    const body = textOf(await call(name, args));
    for (const form of [CANARY, JSON.stringify(CANARY).slice(1, -1), encodeURIComponent(CANARY)]) {
      assert.ok(!body.includes(form), `${name} leaked the API key (${form === CANARY ? "raw" : "encoded"})`);
    }
    if (body.includes("[REDACTED]")) redactedSomewhere = true;
  }
  assert.ok(redactedSomewhere, "the reflection was redacted rather than silently dropped, so the operator can see it happened");
  ok("A-02 an upstream that echoes the operator's key cannot get it into an answer");
}

// ================================================================ A-03
// Anything about the person running the server. There is no such data in the
// server, and these are the questions someone would use to go looking.
{
  const hunts = [
    ["explain_mechanics", { topic: "who runs this server" }],
    ["explain_mechanics", { topic: "operator email address configuration" }],
    ["search_collections", { query: "config secrets home directory" }],
    ["get_source_status", {}],
  ];
  const user = userInfo().username;
  for (const [name, args] of hunts) {
    const body = textOf(await call(name, args));
    // A path on the operator's disk.
    assert.ok(!/[A-Za-z]:\\\\Users\\\\|[A-Za-z]:\\\\\\\\Users/.test(body), `${name} returned a Windows user path`);
    assert.ok(!body.includes(homedir()), `${name} returned the operator's home directory`);
    if (user && user.length > 2) assert.ok(!new RegExp(`\\b${user}\\b`, "i").test(body), `${name} returned the operator's username`);
    // An email address of any kind.
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(body), `${name} returned an email address`);
  }
  ok("A-03 no tool returns a path, a username or an email belonging to whoever runs it");
}

// ================================================================ A-04
// get_source_status names the environment variables it reads. It must name
// them and never show a value, because that is the one result whose whole job
// is to describe configuration.
{
  const body = textOf(await call("get_source_status", {}));
  assert.ok(body.includes("OPENSEA_API_KEY"), "the variable is named, so a user knows what to set");
  assert.ok(!body.includes(CANARY), "its value is not shown");
  assert.ok(!body.includes(home), "the key file's directory is not shown");
  ok("A-04 the status tool names the variables it reads and never a value or a path");
}

// ================================================================ A-05
// Arguments a hostile caller would try. Every one must be refused by the
// schema, not partially acted on.
{
  const nasty = [
    ["get_asset", { mint: "../../../../etc/passwd" }],
    ["get_asset", { mint: "file:///C:/Windows/win.ini" }],
    ["get_asset", { mint: "$(whoami)" }],
    ["find_listings", { symbol: "../../secret" }],
    ["find_listings", { symbol: "abuse", nameContains: "x".repeat(5000) }],
    ["get_collection_holders", { collection: "'; DROP TABLE assets; --" }],
    ["get_wallet_activity", { wallet: "\u0000\u0000\u0000" }],
  ];
  for (const [name, args] of nasty) {
    const r = await call(name, args);
    assert.strictEqual(r.isError, true, `${name} did not refuse ${JSON.stringify(args).slice(0, 60)}`);
    const body = textOf(r);
    assert.ok(!/root:|win\.ini|\[extensions\]/i.test(body), `${name} returned file contents for ${JSON.stringify(args).slice(0, 40)}`);
    assert.ok(!body.includes(homedir()), `${name} leaked a path while refusing`);
  }
  ok("A-05 traversal, file URLs, shell and SQL shapes are refused by the schema and leak nothing");
}

// ================================================================ A-06
// The server is read-only. Nothing it exposes can sign, move or spend, and
// the tool list is the place a caller checks that.
{
  const tools = (await client.listTools()).tools;
  const writing = tools.filter((t) => /^(buy|sell|list|transfer|send|sign|mint|burn|approve|delegate|swap|withdraw|deposit)/i.test(t.name));
  assert.deepStrictEqual(writing, [], `a tool name implies it can change something: ${writing.map((t) => t.name).join(", ")}`);
  for (const t of tools) {
    assert.strictEqual(t.annotations?.readOnlyHint, true, `${t.name} does not declare readOnlyHint`);
  }
  ok(`A-06 all ${tools.length} tools declare themselves read-only and none is named for an action that moves anything`);
}

await client.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`abuse: ${passed} blocks pass`);
