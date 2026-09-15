/**
 * Keyless live check: are the sources still answering, and still answering the
 * same shape?
 *
 * No fixtures, no key, five real calls covering every source family:
 *   get_floor_prices      -> Magic Eden v2
 *   get_asset_provenance  -> public Solana RPC + the Metaplex Core layout,
 *                            asserted down to a decoded transfer owner
 *   get_source_status     -> the undocumented DAS capability on the public RPC
 *   get_asset             -> that capability actually feeding an asset read
 *   identify              -> the routing that decides which source to ask
 *
 * The two DAS checks exist because the asset and wallet coverage added in 1.8
 * rests entirely on an UNDOCUMENTED capability: the public RPC can withdraw
 * getAsset with a -32601 at any time, and without these the whole suite stayed
 * green while that half of the server was dark.
 *
 * Every failure names the SOURCE, because that is the only useful sentence
 * when this fails: nothing here tests our own logic deeply (test/protocol.mjs
 * does that offline), it tests whether the outside world moved.
 *
 * Run: node test/live.mjs   (after npm run build). Budget: 150 seconds - the
 * status probe reads every endpoint, and the shared RPC gate paces them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

// A Magic Eden collection with years of continuous liquidity; if this one has
// no floor, the venue is down, not the collection.
const ME_SYMBOL = "mad_lads";
// A Metaplex Core asset from Candy Digital's 2026 MLB ICON Series. Minted and
// immutable: it cannot stop existing, so a failure here is the RPC, the Core
// layout, or our decoder - never "the data went away".
const CORE_MINT = "5eEj95egk28LLieVkEnGcE5JnwhZ4Z6Vnmi3ooua3J91";
const NAME_QUERY = "mad lads";

const BUDGET_MS = 145_000;
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

// A live check that hangs is a live check that never emails anyone. Hard stop
// inside the budget, with the same wording a real failure uses.
const watchdog = setTimeout(() => {
  console.log("RESULT: FAILED (timed out)");
  console.error(`\n❌ LIVE CHECK TIMED OUT after ${elapsed()} - a source stopped responding without closing the connection.`);
  process.exit(1);
}, BUDGET_MS);
watchdog.unref?.();

const failures = [];
// Sources that are down but deliberately do not fail the run: an optional one
// whose outage is reported rather than paged. The closing line must NAME any
// that land here. It used to print "every source family answered" over exactly
// this state, which is the one sentence a health check must never get wrong.
const degraded = [];
function fail(source, what, detail) {
  console.error(`❌ ${what} [${source}] - ${detail}`);
  failures.push(`${what} (${source})`);
}
function pass(source, what, detail) {
  console.log(`✅ ${what} [${source}] ${detail} (${elapsed()})`);
}

function parse(res) {
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(text.slice(0, 300));
  return JSON.parse(text);
}

const client = new Client({ name: "collector-mcp-live", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    // Deliberately no OPENSEA_API_KEY: this check must prove the keyless path.
    env: getDefaultEnvironment(),
  }),
);
console.log(`connected over stdio (${elapsed()})\n`);

// -- Magic Eden ----------------------------------------------------------
try {
  const r = parse(await client.callTool({ name: "get_floor_prices", arguments: { symbols: [ME_SYMBOL] } }));
  const quote = r.floors?.[0];
  if (!quote) fail("Magic Eden v2", "get_floor_prices", "returned no rows at all - the response shape changed");
  else if (quote.error) fail("Magic Eden v2", "get_floor_prices", `Magic Eden refused: ${quote.error}`);
  else if (typeof quote.floorSol !== "number")
    fail("Magic Eden v2", "get_floor_prices", `no floor for ${ME_SYMBOL}: ${JSON.stringify(quote).slice(0, 160)}`);
  else pass("Magic Eden v2", "get_floor_prices", `${ME_SYMBOL} floor ${quote.floorSol} SOL, ${quote.listed} listed`);
} catch (e) {
  fail("Magic Eden v2", "get_floor_prices", e.message);
}

// -- Solana RPC + Metaplex Core layout ----------------------------------
try {
  const r = parse(await client.callTool({ name: "get_asset_provenance", arguments: { mint: CORE_MINT } }));
  if (!r.currentOwner) {
    fail("public Solana RPC", "get_asset_provenance", "no current owner - the Core account layout may have moved");
  } else if (!Array.isArray(r.events) || r.events.length === 0) {
    fail("public Solana RPC", "get_asset_provenance", "no events decoded - getSignaturesForAddress or the TransferV1 layout changed");
  } else {
    // "Some events exist" is not a working decoder. A broken TransferV1 layout
    // still yields transfer rows - with a missing or garbage newOwner - and
    // this check stayed green through exactly that. Demand a decoded owner,
    // and demand the mint whenever the history claims to be complete.
    const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const minted = r.events.some((e) => e.event === "minted");
    const transfers = r.events.filter((e) => e.event === "transferred");
    const decoded = transfers.filter((e) => typeof e.newOwner === "string" && base58.test(e.newOwner));
    if (transfers.length === 0) {
      fail("public Solana RPC", "get_asset_provenance", `${r.events.length} events but not one transfer on an asset with a known trading history - the TransferV1 decode stopped matching`);
    } else if (decoded.length === 0) {
      fail(
        "public Solana RPC",
        "get_asset_provenance",
        `${transfers.length} transfer(s) and none carried a decodable newOwner (saw ${JSON.stringify(transfers[0].newOwner ?? null)}) - the TransferV1 account layout moved`,
      );
    } else if (r.historyComplete && !minted) {
      fail("public Solana RPC", "get_asset_provenance", "history is reported complete but carries no mint event - the earliest instruction is no longer being recognised");
    } else {
      pass(
        "public Solana RPC",
        "get_asset_provenance",
        `"${r.name}" ${r.events.length} events, ${decoded.length}/${transfers.length} transfer(s) with a decoded owner${minted ? " incl. mint" : ""}, served by ${r.rpcEndpointsUsed?.join(", ") || r.rpcEndpointUsed}`,
      );
    }
    if (r.rpcEndpointNote) console.log(`   note: ${r.rpcEndpointNote}`);
  }
} catch (e) {
  fail("public Solana RPC", "get_asset_provenance", e.message);
}

// -- the asset index (DAS) on the public RPC -----------------------------
// Undocumented and withdrawable: a -32601 turns get_asset's second reader and
// the whole chain-index half of get_wallet_holdings off, silently.
try {
  // This one call pings every wired source in turn, and the slowest of them
  // sets the pace. The client's default 60s request timeout is not enough for
  // a probe that waits on every source by design, so this call gets its own.
  const r = parse(await client.callTool({ name: "get_source_status", arguments: {} }, undefined, { timeout: 120_000 }));
  const row = (r.sources ?? []).find((s) => s.id === "das-public");
  if (!row) {
    fail("asset index (DAS)", "get_source_status", "no das-public row in the status report - the source catalog or the status wiring changed");
  } else if (row.ok !== true) {
    fail(
      "asset index (DAS)",
      "get_source_status",
      `the public RPC is not serving the DAS methods: ${row.note}. If this is a -32601 "Method not found", the capability was withdrawn - get_asset loses its second owner read and get_wallet_holdings loses the chain-index side entirely.`,
    );
  } else {
    pass("asset index (DAS)", "get_source_status", `das-public answering (tier ${row.tier}, ${row.latencyMs}ms): ${row.note}`);
  }
} catch (e) {
  fail("asset index (DAS)", "get_source_status", e.message);
}

try {
  const r = parse(await client.callTool({ name: "get_asset", arguments: { mint: CORE_MINT } }));
  if (!r.chainIndex) {
    fail(
      "asset index (DAS)",
      "get_asset",
      `no chainIndex block for a known Core mint - the index did not answer: ${JSON.stringify(r.sourceErrors ?? {}).slice(0, 200)}`,
    );
  } else if (!r.chainIndex.owner) {
    fail("asset index (DAS)", "get_asset", "the index answered without an owner - getAsset's ownership shape changed");
  } else {
    pass(
      "asset index (DAS)",
      "get_asset",
      `chainIndex owner ${r.chainIndex.owner} (${r.chainIndex.standard}${r.chainIndex.stale ? ", STALE" : ""}); agreement: ${r.ownerAgreement ?? "not reported"}`,
    );
  }
} catch (e) {
  fail("asset index (DAS)", "get_asset", e.message);
}

// -- routing across sources ---------------------------------------------
try {
  const r = parse(await client.callTool({ name: "identify", arguments: { query: NAME_QUERY } }));
  // identify's contract is that it always reports what it checked, even when
  // it finds nothing - an empty answer with no evidence trail is the failure.
  if (!Array.isArray(r.checked) || r.checked.length === 0) {
    fail("identify (multi-source)", "identify", `no evidence trail in the result: ${JSON.stringify(r).slice(0, 200)}`);
  } else if (!r.tradesOn?.includes("Magic Eden")) {
    fail("identify (multi-source)", "identify", `"${NAME_QUERY}" resolved but no venue was found for it; checked ${r.checked.map((c) => c.source).join(", ")}`);
  } else {
    pass("identify (multi-source)", "identify", `"${NAME_QUERY}" -> ${r.kind}, trades on ${r.tradesOn.join("/")}, confidence ${r.confidence}, ${r.checked.length} sources checked`);
  }
} catch (e) {
  fail("identify (multi-source)", "identify", e.message);
}

// -----------------------------------------------------------------------
await client.close();
clearTimeout(watchdog);

// One machine-readable verdict line, always printed last. The workflow echoes
// it into the run summary, because a green tick alone cannot tell PASSED from
// "passed with a source missing" - and only one of those is healthy.
const result = (word) => console.log(`RESULT: ${word}`);

if (failures.length > 0) {
  result(`FAILED (${failures.join(", ")})`);
  console.error(`\nLIVE CHECK FAILED in ${elapsed()}: ${failures.join(", ")}.`);
  console.error("One named source stopped answering or changed shape. Check its status page (docs/SOURCES.md lists them) before changing any code.");
  process.exit(1);
}
if (degraded.length > 0) {
  // Exit 0 on purpose - an optional source's outage is not worth a weekly
  // email - but the verdict is DEGRADED, never PASSED, and it names the
  // source. The old line said "PASSED WITH A DEGRADED SOURCE", which every
  // skim read as a pass.
  result(`DEGRADED (${degraded.map((d) => String(d).split(" ")[0].toLowerCase().replace(/[^a-z]/g, "")).join(", ")})`);
  console.log(
    `\nLIVE CHECK DEGRADED in ${elapsed()}: ${degraded.join("; ")}. ` +
      `Every required source family answered, including the undocumented asset index; the source(s) named above did NOT. ` +
      `Not failing the run: nothing required depends on them.`,
  );
  process.exit(0);
}
result("PASSED");
console.log(`\nLIVE CHECK PASSED in ${elapsed()} - every source family answered, including the undocumented asset index.`);
process.exit(0);
