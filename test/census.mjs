/**
 * The collection census, and the paths around it: a private RPC key
 * that reached an answer, provenance rows out of order, a census that
 * counted copies twice, venue and wallet totals, and packaging.
 *
 * Every block asserts the CORRECT behaviour and every one failed before its
 * fix. Nothing here touches the network: the two blocks that need a real
 * server spawn one over stdio with every upstream stubbed by a preload, a
 * throwaway home folder, and real sockets refused. Case numbers follow
 * the report the fixes came from.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { cached, AbortedError } from "../dist/lib/http.js";
import { registerUrlCredentials, redactSecrets, resetSecrets } from "../dist/lib/secrets.js";
import { bestDeals } from "../dist/market.js";
import { summarizeActivity, summarizeOpenSeaEvents } from "../dist/wallet.js";
import * as me from "../dist/sources/magiceden.js";
import * as os from "../dist/sources/opensea.js";
import * as sol from "../dist/sources/solana.js";
import * as das from "../dist/sources/das.js";
import { normaliseTraits } from "../dist/sources/das.js";
import { verifyClaim } from "../dist/verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};

delete process.env.OPENSEA_API_KEY;
delete process.env.COLLECTOR_MCP_NO_AUTO_KEYS;
delete process.env.COLLECTOR_MCP_OFFLINE;
delete process.env.SOLANA_RPC_URL;
delete process.env.DAS_RPC_URL;

const denied = async (url) => {
  throw new Error(`network denied by the test: ${String(url).slice(0, 80)}`);
};
globalThis.fetch = denied;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const d = digits[i] * 256 + carry;
      digits[i] = d % 58;
      carry = Math.floor(d / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return digits.reverse().map((d) => ALPHABET[d]).join("");
}
const address = (label) => base58(createHash("sha256").update(label).digest());
const signature = (label) => base58(createHash("sha512").update(label).digest());

const homes = [];
const freshHome = () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "collector-mcp-round5-"));
  homes.push(dir);
  return dir;
};
const serverEnvBase = () => {
  const base = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
};

// Shared provenance fixture pieces. Data "F" is discriminator 14 (TransferV1),
// "11" is a leading zero byte (CreateV1), "3" is byte 2 (AddPluginV1).
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SYSTEM = "11111111111111111111111111111111";
const ME_PROGRAM = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
const MINT = "BA56URSgTmXFdh83i125szydnvVTuN8U1VSQSckqcnP2";
const COLLECTION = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n";
const coreFixture = fs.readFileSync(path.join(here, "fixtures", "core-asset.b64"), "utf8").trim();
const coreAccounts = (newOwner, asset = MINT) => [asset, COLLECTION, address("payer"), address("authority"), newOwner, SYSTEM, CORE];
const coreIx = (data, newOwner, asset = MINT) => ({ programId: CORE, accounts: coreAccounts(newOwner, asset), data });
const meIx = (...accounts) => ({ programId: ME_PROGRAM, accounts: [MINT, ...accounts], data: "1" });
const tx = (instructions, logs, inner = []) => ({
  blockTime: 1_700_000_000,
  meta: { err: null, logMessages: logs, innerInstructions: inner },
  transaction: { message: { accountKeys: [], instructions } },
});
const TRANSFER_LOG = ["Program log: Instruction: Transfer"];
const CREATE_LOG = ["Program log: Instruction: Create"];
const NOISE_LOG = ["Program log: Instruction: AddPlugin"];
/** One synthetic RPC per scenario. `stopAfter` moves the clock forward after that many transaction reads. */
function rpcFor(host, txs, opts = {}) {
  let reads = 0;
  process.env.SOLANA_RPC_URL = `https://${host}.invalid`;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(process.env.SOLANA_RPC_URL)) throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init.body));
    let result;
    if (body.method === "getAccountInfo") result = { context: { slot: 123 }, value: { owner: CORE, data: [coreFixture, "base64"] } };
    else if (body.method === "getSignaturesForAddress") result = txs.map((t) => ({ signature: t.signature, blockTime: 1_700_000_000, err: null }));
    else if (body.method === "getTransaction") {
      reads++;
      result = txs.find((t) => t.signature === body.params[0])?.tx ?? null;
      if (opts.stopAfter === reads && opts.onStop) opts.onStop();
    } else throw new Error(`unexpected method ${body.method}`);
    return json({ jsonrpc: "2.0", id: body.id, result });
  };
}
const kinds = (r) => r.events.map((e) => e.event);

// ================================================================ R5-01
// A private RPC URL carries its key in the query string, the path or the
// userinfo. An upstream that echoed the key inside a JSON-RPC error message
// put it into `sourceErrors` on a SUCCESSFUL get_asset answer, because only
// the host label had been protected, never the provider's own text.
{
  resetSecrets();
  assert.strictEqual(registerUrlCredentials("https://rpc.invalid/?api-key=QUERY-CANARY-1234567890"), 1);
  assert.ok(registerUrlCredentials("https://rpc.invalid/v2/PATH-CANARY-abc123def456ghij/") >= 1, "a long path segment is a token");
  assert.strictEqual(registerUrlCredentials("https://rpc.invalid/v2/"), 0, "a short route word is not a secret");
  assert.strictEqual(registerUrlCredentials("https://user:USERINFO-CANARY-9876543210@rpc.invalid/"), 1, "the password is a credential; a four-letter username is too short to protect");
  assert.strictEqual(registerUrlCredentials("not a url"), 0);
  const text = "rejected QUERY-CANARY-1234567890 and PATH-CANARY-abc123def456ghij and USERINFO-CANARY-9876543210 but kept v2";
  const out = redactSecrets(text);
  assert.ok(!/CANARY/.test(out), `every URL credential is redacted: ${out}`);
  assert.ok(out.includes("kept v2"), "ordinary words survive");

  // End to end through the chain reader: the upstream reflects the key.
  resetSecrets();
  const canary = "ROUND4-FAKE-RPC-CREDENTIAL-12345";
  process.env.SOLANA_RPC_URL = `https://private-rpc.invalid/?api-key=${canary}`;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `authentication rejected credential ${canary} at ${url}` } });
  };
  let message = "";
  try {
    await sol.getCoreAccount(address("any-asset"));
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.ok(message.length > 0, "the upstream error surfaced at all");
  assert.ok(!message.includes(canary), `the RPC key reached an error message: ${message}`);
  assert.ok(message.includes("[REDACTED]"), `the reflection was redacted rather than dropped: ${message}`);

  // And through the asset index, where the key sits in the path.
  resetSecrets();
  const dasCanary = "DAS-PATH-CANARY-0123456789abcdef";
  process.env.DAS_RPC_URL = `https://private-das.invalid/v2/${dasCanary}`;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `bad key ${dasCanary} on ${url}` } });
  };
  let dasMessage = "";
  try {
    await das.getAsset(address("any-asset"));
  } catch (e) {
    dasMessage = e instanceof Error ? e.message : String(e);
  }
  assert.ok(!dasMessage.includes(dasCanary), `the index key reached an error message: ${dasMessage}`);
  delete process.env.SOLANA_RPC_URL;
  delete process.env.DAS_RPC_URL;
  resetSecrets();
  globalThis.fetch = denied;
  ok("R5-01 a private endpoint's key is registered from the URL and never survives an upstream that echoes it");
}

// ================================================================ R5-02
// One transaction can move the asset twice. Keeping only the first TransferV1
// reported the intermediary as the final owner of a complete trail.
{
  const mid = address("intermediary");
  const owner = address("final-owner");
  const txs = [
    { signature: signature("swap"), tx: tx([coreIx("F", mid), coreIx("F", owner)], [...TRANSFER_LOG, ...TRANSFER_LOG]) },
    { signature: signature("mint"), tx: tx([coreIx("11", address("minter"))], CREATE_LOG) },
  ];
  rpcFor("two-transfers", txs);
  const r = await sol.getProvenance(MINT, 15, { fresh: true });
  const transfers = r.events.filter((e) => e.event === "transferred");
  assert.strictEqual(transfers.length, 2, "both transfers are rows");
  assert.deepStrictEqual(transfers.map((t) => t.newOwner), [mid, owner], "rows are in execution order");
  assert.match(transfers[1].note ?? "", /moved the asset 2 times/);
  assert.strictEqual(r.historyComplete, true);

  // Inner instructions belong after their parent, not after every outer one.
  const inner = [{ index: 0, instructions: [coreIx("F", mid)] }];
  rpcFor("inner-order", [
    { signature: signature("cpi"), tx: tx([meIx(mid), coreIx("F", owner)], [...TRANSFER_LOG, ...TRANSFER_LOG], inner) },
    { signature: signature("mint2"), tx: tx([coreIx("11", address("minter"))], CREATE_LOG) },
  ]);
  const r2 = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(
    r2.events.filter((e) => e.event === "transferred").map((t) => t.newOwner),
    [mid, owner],
    "a transfer inside the first instruction's CPI comes before the second outer instruction",
  );
  // A CPI-only transaction: nothing in the outer list, the transfer inside an
  // inner group. The first interleave dropped groups with no outer parent.
  rpcFor("cpi-only", [
    { signature: signature("cpi-only"), tx: tx([], TRANSFER_LOG, [{ index: 0, instructions: [coreIx("F", owner)] }]) },
    { signature: signature("mint3"), tx: tx([coreIx("11", address("minter"))], CREATE_LOG) },
  ]);
  const r3 = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(r3.events.filter((e) => e.event === "transferred").map((t) => t.newOwner), [owner], "an inner group with no outer parent is still decoded");
  globalThis.fetch = denied;
  ok("R5-02 every transfer in a transaction is kept, in execution order, so the final owner is the last row");
}

// ================================================================ R5-08 / R5-09
// The walk reads newest first, so what the budget abandons is OLDER than what
// was decoded: the gap belongs before the decoded rows, and custody after a
// hole is unknown, not "not in escrow".
{
  const buyer = address("buyer");
  const escrow = address("escrow");
  const escrow2 = address("escrow-two");
  // Decoded transactions are cached for an hour, so every scenario names its
  // own: a cached read is not a read, and the budget check counts reads.
  const noise = (tag, n) => ({ signature: signature(`noise-${tag}-${n}`), tx: tx([coreIx("3", address("nobody"))], NOISE_LOG) });
  const mintTx = { signature: signature("the-mint"), tx: tx([coreIx("11", address("minter"))], CREATE_LOG) };
  const realNow = Date.now;
  const jump = () => {
    Date.now = () => realNow() + 1_000_000;
  };

  // Budget runs out after the newest transaction: the abandoned ones are older.
  rpcFor("budget-position", [noise("bp", 1), noise("bp", 2), mintTx], { stopAfter: 1, onStop: jump });
  const budgeted = await sol.getProvenance(MINT, 15, { fresh: true, budgetMs: 100_000 });
  Date.now = realNow;
  assert.strictEqual(budgeted.abandonedTransactions, 2);
  assert.strictEqual(budgeted.events[0].event, "unread_gap", "unread older history sits BEFORE the decoded newest event");
  assert.strictEqual(budgeted.events[0].reason, "budget");
  assert.strictEqual(budgeted.events[0].unreadTransactions, 2);
  assert.strictEqual(budgeted.events.at(-1).event, "other", "the decoded newest event is last");
  assert.strictEqual(budgeted.historyComplete, false);

  // Depth and budget together: oldest first, the anchor, the depth window,
  // then the decoded suffix. Nothing unread follows the newest event.
  rpcFor("depth-plus-budget", [noise("db", 1), noise("db", 2), noise("db", 3), mintTx], { stopAfter: 1, onStop: jump });
  const both = await sol.getProvenance(MINT, 3, { fresh: true, budgetMs: 100_000 });
  Date.now = realNow;
  assert.strictEqual(both.skippedTransactions, 1);
  assert.strictEqual(both.abandonedTransactions, 2);
  assert.deepStrictEqual(kinds(both), ["unread_gap", "unread_gap", "unread_gap", "other"], `holes first, in order: ${JSON.stringify(kinds(both))}`);
  assert.deepStrictEqual(both.events.slice(0, 3).map((e) => e.reason), ["budget", "depth", "budget"]);
  assert.deepStrictEqual(both.events.slice(0, 3).map((e) => e.unreadTransactions), [1, 1, 1]);

  // A depth gap, then a fill: the buyer's wallet was passed into the venue's
  // program, and with custody unknown that must not become "into escrow".
  const fill = { signature: signature("fill"), tx: tx([coreIx("F", buyer), meIx(buyer)], TRANSFER_LOG) };
  rpcFor("custody-after-gap", [fill, noise("cg", 1), noise("cg", 2), mintTx]);
  const gapped = await sol.getProvenance(MINT, 3, { fresh: true });
  const bought = gapped.events.find((e) => e.newOwner === buyer);
  assert.ok(bought, "the fill is in the trail");
  assert.ok(!/transfer to a Magic Eden escrow/.test(bought.label ?? ""), `custody after a hole is unknown, never "into escrow": ${bought.label}`);
  assert.strictEqual(bought.escrowDirection, "unknown");
  assert.strictEqual(bought.magicEdenEscrow, undefined, "no escrow claim is made about the buyer's wallet");

  // An unreadable middle transaction is a hole IN PLACE, and custody read
  // before it does not carry over it.
  const listing = { signature: signature("list"), tx: tx([coreIx("F", escrow), meIx(escrow)], TRANSFER_LOG) };
  const relist = { signature: signature("relist"), tx: tx([coreIx("F", escrow2), meIx(escrow2)], TRANSFER_LOG) };
  const unreadable = { signature: signature("unreadable"), tx: null };
  rpcFor("unreadable-middle", [relist, unreadable, listing, mintTx]);
  const holed = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(holed.unreadableTransactions, 1);
  assert.deepStrictEqual(kinds(holed), ["minted", "transferred", "unread_gap", "transferred"], JSON.stringify(kinds(holed)));
  assert.strictEqual(holed.events[2].reason, "unreadable");
  assert.strictEqual(holed.events[2].signature, signature("unreadable"), "the hole names the transaction it stands for");
  const later = holed.events.find((e) => e.newOwner === escrow2);
  assert.ok(!/transfer from a Magic Eden escrow/.test(later.label ?? ""), `custody does not carry across an unreadable transaction: ${later.label}`);
  assert.strictEqual(later.escrowDirection, "unknown");
  assert.strictEqual(holed.historyComplete, false);

  // Control: a complete trail still reads direction both ways.
  rpcFor("complete-direction", [fill, listing, mintTx]);
  const whole = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(whole.historyComplete, true);
  assert.strictEqual(whole.events.find((e) => e.newOwner === escrow).escrowDirection, "into");
  assert.strictEqual(whole.events.find((e) => e.newOwner === buyer).escrowDirection, "out_of");
  assert.ok(!whole.events.some((e) => e.event === "unread_gap"));
  globalThis.fetch = denied;
  ok("R5-08/09 a budget gap sits before the decoded rows, an unreadable transaction is a hole in place, and custody after any hole is unknown");
}

// ================================================================ R5-11
// Another asset's decoded TransferV1 that names THIS asset as its recipient
// was turned into a transfer of this asset by a transaction-wide log line,
// and a true never-traded claim came back contradicted.
{
  const other = address("some-other-asset");
  const foreign = { signature: signature("foreign"), tx: tx([coreIx("F", MINT, other)], TRANSFER_LOG) };
  const mintTx = { signature: signature("mint-3"), tx: tx([coreIx("11", address("minter"))], CREATE_LOG) };
  rpcFor("foreign-transfer", [foreign, mintTx]);
  const r = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.ok(!r.events.some((e) => e.event === "transferred"), `a transfer OF another asset is not a transfer of this one: ${JSON.stringify(kinds(r))}`);
  assert.strictEqual(r.unreadableTransactions, 0, "a decoded foreign instruction is not a hole either");
  assert.strictEqual(r.historyComplete, true);
  const verdict = await verifyClaim({ claim: "never-traded", subject: MINT });
  assert.strictEqual(verdict.verdict, "confirmed", `a complete history with no transfer of this asset confirms: ${verdict.explanation}`);

  // Control: an UNDECODABLE instruction about this asset with a transfer log
  // is still a probable transfer.
  rpcFor("undecodable-own", [{ signature: signature("own"), tx: tx([{ programId: CORE, accounts: coreAccounts(address("someone")) }], TRANSFER_LOG) }, mintTx]);
  const own = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.ok(own.events.some((e) => e.event === "transferred" && /inferred/.test(e.note ?? "")), "an undecodable instruction on this asset with a transfer log still counts");
  globalThis.fetch = denied;
  ok("R5-11 only an instruction whose subject is this asset can put a transfer into its history");
}

// ================================================================ R5-12
// comparison: "unavailable" next to a 50% discount figure. The number is the
// comparison; when one side is stale the number is null.
{
  const listings = [{ tokenMint: "M", price: 1, token: { name: "one", attributes: [{ trait_type: "Hat", value: "Crown" }] } }];
  const attributes = [{ traitType: "Hat", value: "Crown", floorSol: 2, listedCount: 3 }];
  const stale = bestDeals(listings, attributes, { listingsStale: false, listingsReadAt: null, traitFloorsStale: true, traitFloorsReadAt: "2026-09-16T00:00:00.000Z" });
  assert.match(stale.comparison, /unavailable/);
  assert.strictEqual(stale.deals[0].underStrongestTraitFloorPct, null, "no numeric discount from a stale floor");
  const fresh = bestDeals(listings, attributes, { listingsStale: false, listingsReadAt: null, traitFloorsStale: false, traitFloorsReadAt: null });
  assert.strictEqual(fresh.deals[0].underStrongestTraitFloorPct, 50, "the same inputs, both current, still yield the figure");
  ok("R5-12 a discount figure exists only when the comparison it expresses is available");
}

// ================================================================ R5-13
// An abandoned cache producer that settled AFTER its replacement overwrote the
// replacement's newer answer. Commit is now guarded by ownership.
{
  let finishOld;
  const abort = new AbortController();
  const old = cached("round5:commit-race", 60_000, () => new Promise((resolve) => (finishOld = resolve)), { signal: abort.signal });
  abort.abort();
  await assert.rejects(old, AbortedError);
  const fresh = await cached("round5:commit-race", 60_000, async () => ({ owner: "new-owner", slot: 200 }));
  assert.strictEqual(fresh.data.slot, 200);
  finishOld({ owner: "old-owner", slot: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  const read = await cached("round5:commit-race", 60_000, async () => {
    throw new Error("cache unexpectedly empty");
  });
  assert.strictEqual(read.data.slot, 200, "older abandoned work must not replace newer evidence");

  // The other order: the replacement is still running when the old one
  // settles. The old one must not commit either.
  let finishOld2;
  let finishNew2;
  const abort2 = new AbortController();
  const old2 = cached("round5:commit-race-2", 60_000, () => new Promise((resolve) => (finishOld2 = resolve)), { signal: abort2.signal });
  abort2.abort();
  await assert.rejects(old2, AbortedError);
  const newP = cached("round5:commit-race-2", 60_000, () => new Promise((resolve) => (finishNew2 = resolve)));
  finishOld2({ slot: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  finishNew2({ slot: 200 });
  assert.strictEqual((await newP).data.slot, 200);
  const read2 = await cached("round5:commit-race-2", 60_000, async () => {
    throw new Error("cache unexpectedly empty");
  });
  assert.strictEqual(read2.data.slot, 200);
  ok("R5-13 a replaced cache producer never commits, whichever order the two settle in");
}

// ================================================================ R5-14
// One unrepresentable timestamp on a full page became `oldestSeen`, satisfied
// the window check and ended the walk after page one with truncated: false.
{
  const row = (i, blockTime) => ({ signature: signature(`sale-${i}`), type: "buyNow", tokenMint: address(`m-${i}`), blockTime, price: 1, buyer: address("b"), seller: address("s") });
  const page1 = Array.from({ length: 499 }, (_, i) => row(i, 1_700_000_000 - i));
  page1.push(row("broken", -1e20));
  const page2 = [row("older", 1_699_000_000)];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("/collections/r5-sales/activities")) throw new Error(`unexpected ${u}`);
    return json(u.includes("offset=0") ? page1 : page2);
  };
  const r = await me.collectionActivities("r5-sales", { maxPages: 3, sinceUnix: 1_699_500_000, types: ["buyNow"] });
  assert.strictEqual(r.pagesRead, 2, "a malformed timestamp cannot stop the walk at page one");
  assert.strictEqual(r.events.length, 501);
  assert.strictEqual(r.oldestSeen, 1_699_000_000, "the boundary is set by a usable time");
  globalThis.fetch = denied;
  ok("R5-14 only a representable timestamp can establish the sales pagination boundary");
}

// ================================================================ R5-15 / R5-23
// A self-fill (same wallet on both sides) was booked as 2 SOL spent, and an
// even-length hold sample took its upper middle as the median.
{
  const W = address("the-wallet");
  const ev = (i, over) => ({ signature: signature(`w-${i}`), type: "buyNow", source: "magiceden_v2", tokenMint: address(`t-${i}`), collectionSymbol: "c", blockTime: 1_700_000_000 + i * 86_400, price: 2, buyer: W, seller: address("x"), ...over });
  const self = summarizeActivity(W, [ev(1, { seller: W })], false);
  assert.strictEqual(self.netFlowSol, 0, "a self-fill moves no SOL in or out");
  assert.strictEqual(self.selfFills, 1);
  assert.strictEqual(self.buys.count, 0);
  assert.strictEqual(self.sells.count, 0);
  assert.ok(self.caveats.some((c) => /both buyer and seller/.test(c)), "the self-fill is named, not hidden");

  // Holds of 1 and 20 days, three purchases: median 10.5 and a flipper.
  const feed = [
    ev(1, { tokenMint: address("a"), blockTime: 1_700_000_000 }),
    ev(2, { tokenMint: address("a"), blockTime: 1_700_000_000 + 86_400, buyer: address("y"), seller: W, price: 3 }),
    ev(3, { tokenMint: address("b"), blockTime: 1_700_000_000 + 2 * 86_400 }),
    ev(4, { tokenMint: address("b"), blockTime: 1_700_000_000 + 22 * 86_400, buyer: address("y"), seller: W, price: 3 }),
    ev(5, { tokenMint: address("c"), blockTime: 1_700_000_000 + 23 * 86_400 }),
  ].reverse();
  const flips = summarizeActivity(W, feed, false);
  assert.strictEqual(flips.behaviour.medianHoldDays, 10.5, `median of 1 and 20 is 10.5, got ${flips.behaviour.medianHoldDays}`);
  assert.strictEqual(flips.behaviour.label, "flipper", `2 of 3 resold inside 14 days median: ${flips.behaviour.why}`);
  ok("R5-15/23 a self-fill is outside the money totals, and an even-length median averages the middle pair");
}

// ================================================================ R5-16 / R5-17
// A sale of item A hid a gift of item B in the same transaction, and two
// identical copies of one sale counted as two buys.
{
  const W = address("os-wallet");
  const sale = { event_type: "sale", event_timestamp: 1_700_000_000, transaction: "tx1", buyer: W, seller: address("seller"), nft: { identifier: address("item-a"), collection: "col" }, payment: { quantity: "1", decimals: 0 } };
  const gift = { event_type: "transfer", event_timestamp: 1_700_000_000, transaction: "tx1", from_address: address("friend"), to_address: W, nft: { identifier: address("item-b"), collection: "col" } };
  const settlement = { ...gift, from_address: address("seller"), nft: { identifier: address("item-a"), collection: "col" } };
  const v = summarizeOpenSeaEvents(W, [sale, gift, settlement], false);
  assert.strictEqual(v.bought, 1);
  assert.strictEqual(v.receivedWithoutSale.length, 1, "the gift of B survives the sale of A");
  assert.strictEqual(v.receivedWithoutSale[0].mint, address("item-b"));
  const itemless = summarizeOpenSeaEvents(W, [{ ...sale, nft: undefined }, gift], false);
  assert.strictEqual(itemless.receivedWithoutSale.length, 0);
  assert.strictEqual(itemless.settlementUncertain, 1, "a sale naming no item makes a same-transaction transfer uncertain, not settled");
  const out = summarizeOpenSeaEvents(W, [{ event_type: "transfer", event_timestamp: 1, transaction: "tx9", from_address: W, to_address: address("cousin"), nft: { identifier: address("item-c"), collection: "col" } }], false);
  assert.strictEqual(out.transfersOut, 1);
  assert.deepStrictEqual(out.sentWithoutSale.map((r) => [r.mint, r.to]), [[address("item-c"), address("cousin")]], "an outgoing transfer is itemised, not just counted");

  // Exact duplicate rows from the feed are dropped before counting.
  process.env.OPENSEA_API_KEY = "test-key-never-sent";
  os.resetKeyCache();
  globalThis.fetch = async (url) => {
    if (!String(url).includes("/events/accounts/")) throw new Error(`unexpected ${url}`);
    return json({ asset_events: [sale, { ...sale }, { ...sale, payment: { quantity: "2", decimals: 0 } }] });
  };
  const feed = await os.accountEvents(W, 1);
  assert.strictEqual(feed.events.length, 2, "one exact copy dropped, the differing row kept");
  assert.strictEqual(feed.duplicates, 1);
  const counted = summarizeOpenSeaEvents(W, feed.events, feed.truncated, feed.duplicates);
  assert.strictEqual(counted.bought, 2, "two DIFFERENT sale rows are two sales");
  assert.strictEqual(counted.duplicateRowsDropped, 1);
  delete process.env.OPENSEA_API_KEY;
  os.resetKeyCache();
  globalThis.fetch = denied;
  ok("R5-16/17 settlement matches on transaction AND item, and an exact duplicate sale counts once");
}

// ================================================================ R5-18
// Negative floors, volumes, counts and holder quantities passed the finite
// check and were published as figures.
{
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("magiceden.dev") && u.includes("/stats")) return json({ symbol: "neg", floorPrice: -1_000_000_000, listedCount: -3, volumeAll: -4, avgPrice24hr: -2_000_000_000 });
    if (u.includes("/collections/neg/stats")) return json({ total: { floor_price: -3, floor_price_symbol: "SOL", volume: -10, sales: -2, num_owners: -5 } });
    if (u.includes("/traits/neg/floors")) return json({ chain: "solana", floors: [{ trait_type: "Hat", value: "Crown", floor_price: -2, payment_token_symbol: "SOL" }, { trait_type: "Hat", value: "Free", floor_price: 0, payment_token_symbol: "SOL" }] });
    if (u.includes("/collections/neg/holders")) return json({ holders: [{ address: address("h1"), quantity: -2 }, { address: address("h2"), quantity: 1.5 }, { address: address("h3"), quantity: 3 }] });
    throw new Error(`unexpected ${u}`);
  };
  const m = await me.collectionStats("neg");
  assert.ok([m.floorPriceSol, m.volumeAllSol, m.avgPrice24hSol, m.listedCount].every((x) => x === null), `negative Magic Eden figures are unknown: ${JSON.stringify(m)}`);
  process.env.OPENSEA_API_KEY = "test-key-never-sent";
  os.resetKeyCache();
  await assert.rejects(os.collectionStats("neg"), /all negative/, "a stats block of only negatives is refused by name, never shown as zeros");
  const tf = await os.traitFloors("neg");
  assert.strictEqual(tf.count, 0, "a negative or zero trait floor is not a price");
  const h = await os.holders("neg", 10, 100);
  assert.deepStrictEqual(h.top.map((r) => r.items), [3], "only a positive whole quantity is a holding");
  assert.ok(h.top.every((r) => r.sharePct >= 0));
  delete process.env.OPENSEA_API_KEY;
  os.resetKeyCache();
  globalThis.fetch = denied;
  ok("R5-18 money and counts are finite and nonnegative or they are unknown");
}

// ================================================================ R5-06 / R5-19 (unit)
// Index-supplied traits: invalid rows counted before the cap, clipped values
// flagged, omitted rows counted.
{
  const empties = Array.from({ length: 64 }, () => ({ trait_type: "", value: "" }));
  const late = normaliseTraits([...empties, { trait_type: "Item Type", value: "Pack" }]);
  assert.strictEqual(late.rows.length, 1, "a valid trait after 64 empty ones is kept");
  assert.strictEqual(late.omitted, 0);
  const many = normaliseTraits(Array.from({ length: 70 }, (_, i) => ({ trait_type: `t${i}`, value: "v" })));
  assert.strictEqual(many.rows.length, 64);
  assert.strictEqual(many.omitted, 6, "rows past the cap are counted, not forgotten");
  const clipped = normaliseTraits([{ trait_type: "Edition", value: "P".repeat(128) + "X" }]);
  assert.strictEqual(clipped.rows[0].value.length, 128);
  assert.strictEqual(clipped.rows[0].clipped, true, "a cut value says so");
  assert.strictEqual(normaliseTraits([{ trait_type: "Edition", value: "P".repeat(128) }]).rows[0].clipped, undefined, "a value at the bound is whole");
  ok("R5-06/19 trait rows are counted before they are capped, and a clipped value is marked");
}

// ================================================================ R5-03 .. R5-07, R5-10, R5-20
// The census over real stdio, against a synthetic index.
{
  const home = freshHome();
  const log = path.join(home, "requests.log");
  fs.writeFileSync(log, "");
  const preload = pathToFileURL(path.join(here, "helpers", "census-preload.mjs")).href;
  // Same derivation the preload uses, so the test names the fixture's collections.
  const col = (label) => address(`census-collection-${label}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist", "index.js")],
    env: {
      ...serverEnvBase(),
      COLLECTOR_TEST_HOME: home,
      COLLECTOR_TEST_LOG: log,
      DAS_RPC_URL: "https://census.invalid",
      COLLECTOR_MCP_NO_AUTO_KEYS: "1",
      COLLECTOR_MCP_NO_UPDATE_CHECK: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "round5", version: "0" });
  await client.connect(transport);
  const read = async (label, args = {}) => {
    const res = await client.callTool({ name: "get_collection_holders", arguments: { collection: col(label), ...args } });
    return { res, body: res.structuredContent ?? JSON.parse(res.content[0].text), bytes: Buffer.byteLength(JSON.stringify(res)) };
  };
  try {
    // R5-03: a short page bigger than the cap is not a complete census.
    const capped = await read("cap-short", { max: 1 });
    assert.strictEqual(capped.body.truncated, true, "rows beyond the cap were seen: not complete");
    assert.strictEqual(capped.body.assetsInCollection, 1);
    assert.strictEqual(capped.body.membershipComplete, false);
    assert.ok(capped.body.readThis.some((s) => /INCOMPLETE/.test(s)), "the sentence says so");
    assert.ok(!capped.body.readThis.some((s) => /Every asset the index reports/.test(s)));
    const filtered = await read("cap-filter", { max: 1, trait: "Item Type", value: "Pack" });
    assert.strictEqual(filtered.body.matched, 0);
    assert.strictEqual(filtered.body.truncated, true, "a match beyond the cap cannot become a confident zero");

    // R5-04: one mint on two pages counts once; a conflicting copy is dropped and named.
    const dup = await read("duplicate");
    assert.strictEqual(dup.body.assetsInCollection, 1001, `1001 unique mints, got ${dup.body.assetsInCollection}`);
    assert.strictEqual(dup.body.duplicateRows, 1);
    assert.strictEqual(dup.body.conflictingRows, 0);
    const con = await read("conflict");
    assert.strictEqual(con.body.assetsInCollection, 999, "a mint whose two copies disagree on owner is out");
    assert.strictEqual(con.body.conflictingRows, 1);
    assert.strictEqual(con.body.membershipComplete, false);

    // R5-05: membership is evidence.
    const foreign = await read("wrong-group");
    assert.strictEqual(foreign.body.assetsInCollection, 0, "a row naming another collection is not a member");
    assert.strictEqual(foreign.body.foreignGroupRows, 1);
    const unverified = await read("unverified");
    assert.strictEqual(unverified.body.assetsInCollection, 0);
    assert.strictEqual(unverified.body.unverifiedRows, 1);
    assert.ok(unverified.body.readThis.some((s) => /unverified/.test(s)));
    const legacy = await read("non-core");
    assert.strictEqual(legacy.body.assetsInCollection, 1);
    assert.ok(legacy.body.readThis.some((s) => /not Metaplex Core/.test(s)), "a non-Core row is counted with a scope warning");

    // R5-06: trait comparison is exact-pair on unclipped values, uncertain otherwise.
    const dt = await read("duplicate-trait", { trait: "Item Type", value: "Pack" });
    assert.strictEqual(dt.body.matched, 1, "an asset carrying the pair matches even when the trait name appears twice");
    const tail = await read("trait-tail", { trait: "Item Type", value: "Pack" });
    assert.strictEqual(tail.body.matched, 1, "a valid trait after 64 empty rows still matches");
    const clip = await read("clipped", { trait: "Edition", value: "P".repeat(128) });
    assert.strictEqual(clip.body.matched, 0, "a 129-character value is not its 128-character prefix");
    assert.strictEqual(clip.body.filter.undecided, 1);
    assert.strictEqual(clip.body.filter.incomplete, true);
    assert.ok(clip.body.readThis.some((s) => /uncertain/.test(s)));

    // R5-07: a burned record is not a holding.
    const burnt = await read("burnt");
    assert.strictEqual(burnt.body.distinctHolders, 0);
    assert.strictEqual(burnt.body.burnt, 1);
    assert.strictEqual(burnt.body.assets[0].burnt, true, "the row is still listed, flagged");
    assert.ok(burnt.body.readThis.some((s) => /burned/.test(s)));

    // R5-03 (rejected row): no unqualified completeness sentence.
    const bad = await read("bad-id");
    assert.strictEqual(bad.body.rowsRejected, 1);
    assert.strictEqual(bad.body.membershipComplete, false);
    assert.ok(!bad.body.readThis.some((s) => /Every asset the index reports/.test(s)));

    // R5-10: a 2,000-row census fits what a client carries; the counts are whole.
    const big = await read("big");
    assert.strictEqual(big.body.assetsInCollection, 2000);
    assert.strictEqual(big.body.distinctHolders, 2000);
    assert.ok(big.bytes <= 100_000, `a default census must fit a client: ${big.bytes} bytes`);
    assert.ok(big.body.holdersOmitted > 0 && big.body.assetsOmitted > 0, "the lists are bounded and say so");
    assert.strictEqual(big.body.holders.length + big.body.holdersOmitted, 2000);

    // R5-20: a half trait pair is refused BEFORE the index is read.
    fs.writeFileSync(log, "");
    const half = await client.callTool({ name: "get_collection_holders", arguments: { collection: col("half"), trait: "Item Type" } });
    assert.strictEqual(half.isError, true);
    assert.match(half.content[0].text, /trait and value go together/);
    const requests = fs.readFileSync(log, "utf8").split("\n").filter((l) => l === "getAssetsByGroup");
    assert.strictEqual(requests.length, 0, "an invalid filter must not walk the collection before refusing");
  } finally {
    await client.close();
  }
  ok("R5-03..07/10/20 the census reports coverage honestly, counts each mint once, needs membership evidence, bounds its lists and refuses bad input first");
}

// ================================================================ R5-01 (stdio) / R5-10 (image)
// Through a real server: a reflected RPC key stays out of a SUCCESSFUL
// answer, and a 130,000-character image URL does not become a 263 KB result.
{
  const home = freshHome();
  const canary = "ROUND4_FAKE_RPC_CREDENTIAL_12345";
  const preload = pathToFileURL(path.join(here, "helpers", "asset-image-preload.mjs")).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist", "index.js")],
    env: {
      ...serverEnvBase(),
      COLLECTOR_TEST_HOME: home,
      COLLECTOR_TEST_CANARY: canary,
      SOLANA_RPC_URL: `https://private-rpc.invalid/?api-key=${canary}`,
      COLLECTOR_MCP_NO_AUTO_KEYS: "1",
      COLLECTOR_MCP_NO_UPDATE_CHECK: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "round5", version: "0" });
  await client.connect(transport);
  try {
    const answer = await client.callTool({ name: "get_asset", arguments: { mint: "11111111111111111111111111111111" } });
    assert.ok(!answer.isError, `the venue answered, so this is a normal result: ${answer.content?.[0]?.text?.slice(0, 200)}`);
    const text = JSON.stringify(answer);
    assert.ok(!text.includes(canary), "a configured private RPC credential reached a successful tool response");
    assert.ok(/\[REDACTED\]/.test(text) || !/sourceErrors/.test(text), "if the upstream text is carried, it is carried redacted");
    const bytes = Buffer.byteLength(text);
    assert.ok(bytes <= 100_000, `single-asset result is ${bytes} bytes; the image URL must be bounded`);
    assert.strictEqual(answer.structuredContent?.market?.image, null, "an over-long URL is dropped, not relayed");
  } finally {
    await client.close();
  }
  ok("R5-01/10 over stdio: the RPC key never reaches a normal answer, and a venue URL cannot blow the answer past the client's ceiling");
}

// ================================================================ R5-19 / R5-22 / R5-26 (static)
// The bundle installs from the lockfile, the lock's root metadata matches the
// package, and the README's links resolve from inside an installed package.
{
  const bundle = fs.readFileSync(path.join(root, "scripts", "bundle-mcpb.mjs"), "utf8");
  assert.ok(/"package-lock\.json"/.test(bundle) && /\["ci"/.test(bundle), "the bundle stage carries the lock and installs with npm ci");
  assert.ok(!/\["install"/.test(bundle), "no unpinned install remains in the bundle script");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.strictEqual(lock.version, pkg.version, "lock root version matches package.json");
  assert.strictEqual(lock.packages[""].version, pkg.version);
  assert.deepStrictEqual(lock.packages[""].engines, pkg.engines, "lock root engines match package.json");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  // LINKS to other documents must be absolute: docs/, SECURITY.md and
  // CONTRIBUTING.md are not in the published tarball, so a relative link to
  // one 404s for anybody reading the README from an installed package.
  const relativeLinks = readme.match(/\]\((?:docs\/|SECURITY\.md|CONTRIBUTING\.md|LICENSE\))/g) ?? [];
  assert.deepStrictEqual(relativeLinks, [], `README document links must be absolute so they resolve from an installed package: ${relativeLinks.join(", ")}`);
  // IMAGES are the opposite. GitHub renders a README image through a proxy
  // that fetches with no credentials, so an absolute raw.githubusercontent
  // URL is a 404 on a private repository and every picture breaks.
  // A relative path is rewritten by GitHub to a blob served
  // under the viewer's own session and renders whether the repository is
  // private or public, which is where this README is actually read.
  const absoluteImages = readme.match(/<img[^>]*src="https:\/\/raw\.githubusercontent[^"]*"/g) ?? [];
  assert.deepStrictEqual(absoluteImages, [], `README images must be repo-relative or they break while the repository is private: ${absoluteImages.join(", ")}`);
  for (const m of readme.matchAll(/<img[^>]*src="(?!https?:)([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, m[1])), `README image ${m[1]} does not exist at that path`);
  }
  ok("R5-19/22/26 the bundle is lock-pinned, the lock metadata is current, document links are absolute and images are repo-relative and present");
}

// ================================================================ R5-21 / R5-24 / R5-25 / R5-27 (documents)
// Each of these sentences was checked against the source and found false.
{
  const doc = (p) => fs.readFileSync(path.join(root, p), "utf8");
  const readme = doc("README.md");
  assert.ok(!readme.includes("`historyComplete` says whether it reached the mint"), "historyComplete is not mint reach; mintObserved is");
  assert.ok(readme.includes("`mintObserved`"), "the README names the separate signal");
  assert.ok(!doc("docs/QUESTIONS.md").includes("no automatic holder distribution sweep"), "the census tool exists now");
  const deep = doc("docs/DEEP-DIVE.md");
  assert.ok(!deep.includes("new owner as the last instruction account"), "the decoded path uses slot 4");
  assert.ok(deep.includes("account slot 4"));
  for (const p of ["docs/FAQ.md", "docs/DEEP-DIVE.md", "docs/TRUST-AND-LIMITS.md"]) {
    assert.ok(!/keeps nothing(?: of yours)?[.,]/i.test(doc(p)), `${p}: the self-issued key is stored locally, so "keeps nothing" is false`);
  }
  assert.ok(!doc("docs/SOURCES.md").includes("renews it weekly"), "refresh is on demand near expiry");
  const trust = doc("docs/TRUST-AND-LIMITS.md");
  const section = trust.slice(trust.indexOf("### 9."), trust.indexOf("### 10."));
  assert.ok(/COLLECTOR_MCP_NO_AUTO_KEYS/.test(section), "the missing-key example states the auto-issue precondition");
  // The launch checklist is a private, untracked file; CI has no copy.
  if (fs.existsSync(path.join(root, "PRE-LAUNCH-TESTS.md"))) {
    assert.ok(!doc("PRE-LAUNCH-TESTS.md").includes("Every tool should refuse by name."), "local tools answer offline by design");
  }
  ok("R5-21/24/25/27 the documents say what the code does");
}

// ================================================================ R5-28
// The Magic Eden escrow address, pasted into get_asset because it shows as
// the owner of every listed item, came back "could not be completed, try
// again". A known venue account is named, and a wallet is called a wallet.
{
  assert.match(sol.knownVenueAccount("1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix") ?? "", /Magic Eden's escrow/);
  assert.strictEqual(sol.knownVenueAccount(address("nobody")), null);
  const src = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
  assert.ok(/knownVenueAccount\(mint\)/.test(src) && /accountNature\(mint\)/.test(src), "get_asset settles what a non-asset address IS before saying try again");
  ok("R5-28 a venue escrow and a plain wallet are named as such instead of 'try again'");
  // 493 bids and 3 buys came back "holder". Bids are a behaviour of their own.
  const B = address("bidder");
  const bidFeed = [
    ...Array.from({ length: 40 }, (_, i) => ({ signature: signature(`bid-${i}`), type: "bid", source: "magiceden_v2", tokenMint: address(`b-${i}`), collectionSymbol: "c", blockTime: 1_700_000_000 + i, buyer: B, price: 1 })),
    ...Array.from({ length: 3 }, (_, i) => ({ signature: signature(`buy-${i}`), type: "buyNow", source: "magiceden_v2", tokenMint: address(`p-${i}`), collectionSymbol: "c", blockTime: 1_700_001_000 + i, buyer: B, seller: address("s"), price: 0.4 })),
  ].reverse();
  const bidder = summarizeActivity(B, bidFeed, true);
  assert.strictEqual(bidder.behaviour.label, "bidder", `${bidder.behaviour.label}: ${bidder.behaviour.why}`);
  assert.strictEqual(bidder.buys.count, 3, "the completed buys are still counted");
  // A transfer from the venue escrow is a fill or a delisting, and says so.
  const W2 = address("buyer-two");
  const fromEscrow = summarizeOpenSeaEvents(W2, [{ event_type: "transfer", event_timestamp: 1, transaction: "tx-fill", from_address: "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix", to_address: W2, nft: { identifier: address("item-d"), collection: "col" } }], false);
  assert.match(fromEscrow.receivedWithoutSale[0].note ?? "", /Magic Eden escrow/);
  ok("R5-29 a bidder is labelled a bidder, and a transfer from the venue escrow is named a fill or delisting");
}

for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
console.log(`\ncensus: ${passed} blocks passed`);
