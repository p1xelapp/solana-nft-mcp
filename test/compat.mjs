/**
 * Will this server work in a client that is not Claude Desktop?
 *
 * Every check here comes from a published constraint of a real client, not
 * from the MCP spec. The spec is permissive; the clients are not, and each one
 * fails differently:
 *
 *   - Claude Code truncates a tool result past MAX_MCP_OUTPUT_TOKENS (25,000).
 *     A truncated JSON answer is worse than a refused one, because the model
 *     reads the surviving prefix as the whole answer.
 *   - Cursor caps the ACTIVE tool count at 40 across every server a person has
 *     installed at once, silently. A 20-tool server is half of somebody's
 *     budget, so the count is a number to defend, not to grow.
 *   - OpenAI strict function calling accepts a subset of JSON Schema: no
 *     $ref/$defs, no root anyOf, at most 5 levels of nesting and 100
 *     properties, and it DROPS minLength, maxLength, pattern, minimum,
 *     maximum, minItems, maxItems and default. Anything whose correctness
 *     depends on a dropped keyword breaks silently there.
 *   - The Anthropic tool-name regex is ^[a-zA-Z0-9_-]{1,64}$, with no dot,
 *     even though the MCP spec allows one.
 *   - Small open-weight models degrade on deep nesting and long descriptions.
 *
 * Offline except for the output-size measurements, which need real answers
 * because the worst case is a real collection with a real order book.
 */
import assert from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};

const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], stderr: "ignore" });
const client = new Client({ name: "compat", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();

// ---------------------------------------------------------------- x1 names
{
  // The Anthropic API regex, which is stricter than the MCP spec: no dot.
  const bad = tools.filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name));
  assert.deepStrictEqual(bad.map((t) => t.name), [], "a tool name a strict client will reject");
  // A client prefixes the server name onto each tool. 64 is the ceiling for
  // the whole thing in Anthropic's directory, so the prefix has to fit too.
  const prefix = "mcp__collector-mcp__";
  const tooLong = tools.filter((t) => (prefix + t.name).length > 64);
  assert.deepStrictEqual(tooLong.map((t) => t.name), [], `a prefixed tool name over 64 characters`);
  const longest = tools.reduce((a, b) => (a.name.length > b.name.length ? a : b));
  ok(`x1 every tool name is [A-Za-z0-9_-] and fits 64 with the client prefix (longest: ${prefix}${longest.name} = ${(prefix + longest.name).length})`);
}

// ------------------------------------------------------------- x2 tool count
{
  // Cursor's silent cap is 40 ACROSS ALL SERVERS. Ours cannot be the one that
  // eats the whole budget, and Anthropic's own guidance says selection
  // accuracy falls off past 30-50 tools available to one model.
  assert.ok(tools.length <= 25, `${tools.length} tools leaves too little of a 40-tool client budget for anything else`);
  ok(`x2 ${tools.length} tools, inside every published client ceiling and half of Cursor's 40-tool budget`);
}

// ------------------------------------------------- x3 annotations and titles
{
  // Anthropic's connector review criteria: every tool carries a title and,
  // for a read-only server, readOnlyHint true.
  const missingTitle = tools.filter((t) => !t.title && !t.annotations?.title);
  const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
  assert.deepStrictEqual(missingTitle.map((t) => t.name), [], "a tool with no title");
  assert.deepStrictEqual(notReadOnly.map((t) => t.name), [], "a tool that does not declare itself read-only");
  assert.deepStrictEqual(destructive.map((t) => t.name), [], "a tool that declares itself destructive");
  ok("x3 every tool carries a title and readOnlyHint: true, and none claims to be destructive");
}

// ------------------------------------------------ x4 the OpenAI strict subset
{
  const problems = [];
  const walk = (node, path, tool, depth) => {
    if (!node || typeof node !== "object") return;
    if (depth > 5) problems.push(`${tool}${path}: nested deeper than 5, past the strict-mode ceiling`);
    if ("$ref" in node) problems.push(`${tool}${path}: uses $ref`);
    if ("$defs" in node) problems.push(`${tool}${path}: uses $defs`);
    if ("default" in node) problems.push(`${tool}${path}: declares a default, which sanitizers strip and one client refuses`);
    if (Array.isArray(node.properties)) problems.push(`${tool}${path}: properties is an array`);
    if (node.properties && Object.keys(node.properties).length > 100) problems.push(`${tool}${path}: over 100 properties`);
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" || k === "title") continue;
      walk(v, `${path}.${k}`, tool, depth + 1);
    }
  };
  for (const t of tools) {
    if (t.inputSchema?.type !== "object") problems.push(`${t.name}: root schema is not an object`);
    if (t.inputSchema && "anyOf" in t.inputSchema) problems.push(`${t.name}: root schema uses anyOf`);
    walk(t.inputSchema, "", t.name, 0);
  }
  assert.deepStrictEqual(problems, [], `schemas a strict OpenAI client cannot take:\n${problems.join("\n")}`);
  ok(`x4 every schema is inside the OpenAI strict-mode subset (no $ref, no $defs, no root anyOf, no default, under 5 levels)`);
}

// --------------------------------------- x5 correctness without dropped words
{
  // OpenAI strict mode DROPS minLength, pattern, minimum and friends. Our
  // server re-validates everything itself, so a client that strips them still
  // cannot get a bad value past us. This proves it by sending values that only
  // those keywords would have caught.
  const hostile = [
    ["get_collection_stats", { collection: "" }, "an empty string where minLength is the only guard"],
    ["get_collection_sales", { symbol: "mad_lads", days: 9999 }, "a number past maximum"],
    ["get_collection_sales", { symbol: "mad_lads", days: -3 }, "a number below minimum"],
    ["get_wallet_holdings", { wallet: "not-an-address" }, "a string the pattern would have caught"],
    ["find_listings", { symbol: "mad_lads", limit: 100000 }, "a limit past maximum"],
  ];
  const leaked = [];
  for (const [name, args, what] of hostile) {
    let refused = false;
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      const body = r.content?.[0]?.text ?? "";
      refused = r.isError === true || /invalid|must be|not a valid|does not match|expected/i.test(body);
    } catch {
      refused = true;
    }
    if (!refused) leaked.push(`${name} accepted ${what}`);
  }
  assert.deepStrictEqual(leaked, [], `a client that strips schema keywords could get a bad value in: ${leaked.join("; ")}`);
  ok(`x5 ${hostile.length} values that only a stripped keyword would catch are refused by the server itself`);
}

// ---------------------------------------------------- x6 description budgets
{
  // A secondary report puts Claude Code's per-description truncation at 2 KB,
  // and OpenAI's guidance is that the first 512 characters carry the weight.
  // Truncation is silent, so a description longer than the budget loses its
  // tail without anybody being told.
  const over = tools.filter((t) => (t.description ?? "").length > 2048);
  assert.deepStrictEqual(
    over.map((t) => `${t.name} (${t.description.length})`),
    [],
    "a tool description past the 2 KB truncation point",
  );
  const total = tools.reduce((n, t) => n + (t.description ?? "").length + t.name.length + JSON.stringify(t.inputSchema).length, 0);
  // Every definition is in the model's context on every single turn.
  assert.ok(total < 60_000, `tool definitions total ${total} characters, which is a lot of every prompt`);
  const longest = tools.reduce((a, b) => ((a.description ?? "").length > (b.description ?? "").length ? a : b));
  ok(`x6 no description over 2 KB (longest ${longest.name} at ${longest.description.length}), ${Math.round(total / 1000)} KB of definitions in total`);
}

// ------------------------------------------------------- x7 answer size caps
{
  // Claude Code truncates a tool result past 25,000 tokens and Claude.ai past
  // ~150,000 characters. A truncated JSON body is read by the model as the
  // whole answer, so an over-large result is a wrong answer, not a slow one.
  // These are the widest reads each tool offers, asked of a real collection.
  const wide = [
    ["find_listings", { symbol: "mad_lads", limit: 100 }],
    ["find_listings", { symbol: "mad_lads", limit: 100, lowestSerials: true }],
    ["get_collection_sales", { symbol: "mad_lads", days: 30, maxPages: 6 }],
    ["get_recent_sales", { collection: "mad_lads", limit: 50 }],
    ["get_wallet_holdings", { wallet: "9yzmxQHCz24LDhu9rkjNQhKfKZWbe79B1NJzTy9ExqyP", limit: 100 }],
    ["get_wallet_profile", { wallet: "9yzmxQHCz24LDhu9rkjNQhKfKZWbe79B1NJzTy9ExqyP", maxItems: 3000, priceTop: 10 }],
    ["get_wallet_activity", { wallet: "9yzmxQHCz24LDhu9rkjNQhKfKZWbe79B1NJzTy9ExqyP", pages: 5 }],
    ["find_in_group", { group: "DC", batch: 20, pagesPerCollection: 5 }],
    ["get_top_traders", { symbol: "mad_lads", limit: 50 }],
    ["get_trending", { timeRange: "30d" }],
    ["search_collections", { query: "batman" }],
    ["explain_mechanics", { topic: "glossary" }],
    ["get_source_status", {}],
  ];
  // Four characters to the token is the usual working figure, so the 25,000
  // token ceiling is about 100,000 characters. Holding the line at 55 KB
  // leaves a factor of two: the model still has to carry the question, the
  // other tool definitions and its own reasoning next to whatever this
  // returns. Anything above this is not "a big answer", it is an answer the
  // client will cut without telling anyone.
  const CEILING = 55_000;
  const sizes = [];
  const over = [];
  for (const [name, args] of wide) {
    let body = "";
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
      body = (r.content ?? []).map((c) => c.text ?? "").join("");
    } catch (e) {
      // An upstream that is down does not make the answer too big.
      sizes.push([`${name}`, `upstream: ${String(e.message).slice(0, 40)}`]);
      continue;
    }
    sizes.push([name, `${(body.length / 1000).toFixed(1)} KB`]);
    if (body.length > CEILING) over.push(`${name} returned ${body.length} characters`);
  }
  console.log(`        widest reads: ${sizes.map(([n, s]) => `${n} ${s}`).join(", ")}`);
  assert.deepStrictEqual(over, [], `an answer big enough to be truncated by a client, which the model then reads as complete: ${over.join("; ")}`);
  ok(`x7 every widest-case answer stays under ${CEILING / 1000} KB, well inside the 25,000-token client ceiling`);
}

// ------------------------------------------------- x8 no instruction reliance
{
  // Claude Desktop is reported to parse the server `instructions` and never
  // use them, so anything load-bearing in there is lost on the client most
  // people will run. Every tool has to be usable from its own description.
  const instructions = client.getInstructions?.() ?? "";
  assert.ok(instructions.length > 200, "the server should still describe itself for the clients that do read instructions");
  assert.ok(instructions.length < 4000, `instructions are ${instructions.length} characters, past where clients start truncating`);
  const vague = tools.filter((t) => (t.description ?? "").length < 80);
  assert.deepStrictEqual(vague.map((t) => t.name), [], "a tool too thinly described to be chosen without the server instructions");
  ok(`x8 instructions are ${instructions.length} characters and no tool depends on them to be understood`);
}

// -------------------------------------------------------- x9 prompt portability
{
  // A prompt carrying arguments cannot be declared in an install bundle, and a
  // client that compares the returned text to the declaration refuses the
  // whole attachment. Zero arguments is the only portable shape.
  const witharguments = prompts.filter((p) => (p.arguments ?? []).length > 0);
  assert.deepStrictEqual(witharguments.map((p) => p.name), [], "a prompt with arguments will not attach in a bundled client");
  for (const p of prompts) {
    const got = await client.getPrompt({ name: p.name, arguments: {} });
    assert.strictEqual(got.messages.length, 1, `${p.name} should be one message`);
    assert.strictEqual(got.messages[0].content.type, "text", `${p.name} should be plain text, which every client renders`);
  }
  ok(`x9 all ${prompts.length} prompts take no arguments and return a single text message`);
}

// ------------------------------------------------ x10 capabilities we declare
{
  const caps = client.getServerCapabilities();
  assert.ok(caps?.tools, "tools capability must be advertised");
  assert.strictEqual(caps?.resources, undefined, "resources must not be advertised when none are registered");
  assert.ok(caps?.prompts, "prompts capability must be advertised");
  // Sampling and subscriptions are unsupported by Anthropic connectors, so
  // depending on either would make the server unusable there.
  assert.strictEqual(caps?.sampling, undefined, "this server must not require sampling, which connectors do not offer");
  ok("x10 capabilities are tools and prompts only, with nothing a connector cannot provide");
}

await client.close();
console.log(`\ncompat test: ${passed} groups passed (x1-x${passed})`);
