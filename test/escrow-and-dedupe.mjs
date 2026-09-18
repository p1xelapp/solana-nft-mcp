/**
 * Regressions for the round-six outside review (2026-09-18), 12 findings.
 * Every block asserts the correct behaviour and every one failed before its
 * fix. Nothing here touches the network.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { registerUrlCredentials, redactSecrets, resetSecrets } from "../dist/lib/secrets.js";
import { summarizeActivity, summarizeOpenSeaEvents } from "../dist/wallet.js";
import { accountEventFingerprint } from "../dist/sources/opensea.js";
import * as sol from "../dist/sources/solana.js";
import { normaliseTraits } from "../dist/sources/das.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`  ok  ${what}`);
};
delete process.env.SOLANA_RPC_URL;
const denied = async (url) => {
  throw new Error(`network denied by the test: ${String(url).slice(0, 80)}`);
};
globalThis.fetch = denied;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

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

const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SYSTEM = "11111111111111111111111111111111";
const ME_PROGRAM = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
const MINT = "BA56URSgTmXFdh83i125szydnvVTuN8U1VSQSckqcnP2";
const COLLECTION = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n";
const coreFixture = fs.readFileSync(path.join(here, "fixtures", "core-asset.b64"), "utf8").trim();
const coreIx = (data, newOwner) => ({ programId: CORE, accounts: [MINT, COLLECTION, address("payer"), address("authority"), newOwner, SYSTEM, CORE], data });
const meIx = (...accounts) => ({ programId: ME_PROGRAM, accounts: [MINT, ...accounts], data: "1" });
const tx = (instructions, logs, inner = []) => ({ blockTime: 1_700_000_000, meta: { err: null, logMessages: logs, innerInstructions: inner }, transaction: { message: { accountKeys: [], instructions } } });
const T = ["Program log: Instruction: Transfer"];
const C = ["Program log: Instruction: Create"];
function rpcFor(host, txs) {
  process.env.SOLANA_RPC_URL = `https://${host}.invalid`;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(process.env.SOLANA_RPC_URL)) throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init.body));
    let result;
    if (body.method === "getAccountInfo") result = { context: { slot: 123 }, value: { owner: CORE, data: [coreFixture, "base64"] } };
    else if (body.method === "getSignaturesForAddress") result = txs.map((t) => ({ signature: t.signature, blockTime: 1_700_000_000, err: null }));
    else if (body.method === "getTransaction") result = txs.find((t) => t.signature === body.params[0])?.tx ?? null;
    else throw new Error(`unexpected method ${body.method}`);
    return json({ jsonrpc: "2.0", id: body.id, result });
  };
}
const kinds = (r) => r.events.map((e) => e.event);
const mintTx = (tag) => ({ signature: signature(`mint-${tag}`), tx: tx([coreIx("11", address("minter"))], C) });

// ================================================================ R6-01 / R6-11
// Credential spellings the registration missed, and ordinary values it ate.
{
  resetSecrets();
  registerUrlCredentials("https://rpc.invalid/?api-key=AB%2fCD%2fEF-CANARY-12");
  assert.ok(!/AB%2fCD%2fEF-CANARY-12/.test(redactSecrets("echo AB%2fCD%2fEF-CANARY-12")), "lower-case percent escapes are the same key");
  assert.ok(!/CANARY-12/.test(redactSecrets("echo AB/CD/EF-CANARY-12")), "the decoded form too");
  resetSecrets();
  registerUrlCredentials("https://rpc.invalid/?token=SPACE+CANARY+VALUE+1234");
  assert.ok(!/CANARY/.test(redactSecrets("echo SPACE+CANARY+VALUE+1234 and SPACE CANARY VALUE 1234")), "plus-for-space and the decoded form");
  resetSecrets();
  assert.strictEqual(registerUrlCredentials("https://rpc.invalid/v2/ab12cd34ef56/"), 1, "a twelve-character mixed token in the path is a credential");
  resetSecrets();
  registerUrlCredentials("https://rpc.invalid/solana-mainnet-beta/?commitment=confirmed&encoding=jsonParsed");
  const kept = redactSecrets("confirmed using jsonParsed on solana-mainnet-beta");
  assert.strictEqual(kept, "confirmed using jsonParsed on solana-mainnet-beta", `ordinary values are not secrets: ${kept}`);
  resetSecrets();
  ok("R6-01/11 every spelling of a URL credential is caught, and route words and options are left alone");
}

// ================================================================ R6-02 / R6-05
// A readable transfer beside an undecodable sibling is kept, the sibling is a
// hole in place; a mint and a transfer in one transaction are both rows.
{
  const owner = address("owner-a");
  rpcFor("sibling-with-log", [{ signature: signature("s1"), tx: tx([coreIx("F", owner), { programId: CORE, accounts: coreIx("F", owner).accounts }], T) }, mintTx("a")]);
  const withLog = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(kinds(withLog), ["minted", "transferred", "unread_gap"], JSON.stringify(kinds(withLog)));
  assert.strictEqual(withLog.unreadableTransactions, 1);
  assert.strictEqual(withLog.historyComplete, false);
  rpcFor("sibling-no-log", [{ signature: signature("s2"), tx: tx([coreIx("F", owner), { programId: CORE, accounts: coreIx("F", owner).accounts }], []) }, mintTx("b")]);
  const noLog = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(kinds(noLog), ["minted", "transferred", "unread_gap"], `the decoded transfer survives an empty log: ${JSON.stringify(kinds(noLog))}`);
  rpcFor("create-then-transfer", [{ signature: signature("ct"), tx: tx([coreIx("11", address("minter")), coreIx("F", owner)], [...C, ...T]) }]);
  const both = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(kinds(both), ["minted", "transferred"], JSON.stringify(kinds(both)));
  assert.strictEqual(both.mintObserved, true);
  assert.strictEqual(both.historyComplete, true);
  globalThis.fetch = denied;
  ok("R6-02/05 every Core instruction on the asset is its own row, in order, holes included");
}

// ================================================================ R6-03
// An inner group whose parent is not in the outer list is not an execution order.
{
  const owner = address("owner-b");
  const mid = address("mid");
  rpcFor("orphan-parent", [{ signature: signature("op"), tx: tx([coreIx("F", mid)], T, [{ index: 99, instructions: [coreIx("F", owner)] }]) }, mintTx("c")]);
  const r = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(r.historyComplete, false, "an order the endpoint could not establish is not complete");
  assert.ok(r.unreadableTransactions >= 1);
  assert.ok(r.events.some((e) => e.event === "unread_gap" && /parent/.test(e.label)), "the hole says why");
  assert.ok(r.events.filter((e) => e.event === "transferred").every((e) => /order/.test(e.note ?? "")), "every transfer row carries the order caveat");
  globalThis.fetch = denied;
  ok("R6-03 an orphaned inner group keeps its rows but takes away the order and the completeness");
}

// ================================================================ R6-04
// The depth gap goes after the LAST row of the anchor transaction.
{
  const a = address("owner-c");
  const b = address("owner-d");
  const anchor = { signature: signature("anchor"), tx: tx([coreIx("F", a), coreIx("F", b)], [...T, ...T]) };
  rpcFor("depth-one", [{ signature: signature("newer"), tx: tx([coreIx("3", address("x"))], ["Program log: Instruction: AddPlugin"]) }, anchor]);
  const r = await sol.getProvenance(MINT, 1, { fresh: true });
  assert.deepStrictEqual(kinds(r), ["transferred", "transferred", "unread_gap"], JSON.stringify(kinds(r)));
  assert.deepStrictEqual(r.events.slice(0, 2).map((e) => e.newOwner), [a, b]);
  globalThis.fetch = denied;
  ok("R6-04 a depth gap never splits the anchor transaction's own rows");
}

// ================================================================ R6-07
// Entries past the raw trait bound were never inspected: that is an omission.
{
  const t = normaliseTraits([...Array.from({ length: 4096 }, () => ({ trait_type: "", value: "" })), { trait_type: "Type", value: "Pack" }]);
  assert.strictEqual(t.rows.length, 0);
  assert.strictEqual(t.omitted, 1, "one entry beyond the bound counts as omitted, so a filter cannot call no-match a decision");
  ok("R6-07 an uninspected trait tail is reported, not forgotten");
}

// ================================================================ R6-08 / R6-09 / R6-10
// Payment currency and scale are claims; outgoing settlement uncertainty
// mirrors incoming; a self-fill is not the first buy.
{
  const W = address("w6");
  const base = { event_type: "sale", event_timestamp: 1, transaction: "tx1", buyer: W, seller: address("s"), nft: { identifier: address("i"), collection: "c" } };
  const usdc = { ...base, payment: { quantity: "1000000", decimals: 6, symbol: "USDC" } };
  const solp = { ...base, payment: { quantity: "1000000", decimals: 9, symbol: "SOL" } };
  assert.notStrictEqual(accountEventFingerprint(usdc), accountEventFingerprint(solp), "different currency, different claim");
  assert.strictEqual(summarizeOpenSeaEvents(W, [usdc, solp], false).bought, 2, "two differing claims stay two");
  const seller = address("w7");
  const out = summarizeOpenSeaEvents(seller, [
    { event_type: "sale", event_timestamp: 1, transaction: "tx2", buyer: address("b"), seller },
    { event_type: "transfer", event_timestamp: 1, transaction: "tx2", from_address: seller, to_address: address("b"), nft: { identifier: address("j"), collection: "c" } },
  ], false);
  assert.strictEqual(out.sentWithoutSale.length, 0, "a transfer beside an itemless sale is not a gift");
  assert.strictEqual(out.settlementUncertain, 1);
  const B = address("w8");
  const self = summarizeActivity(B, [{ signature: signature("sf"), type: "buyNow", source: "magiceden_v2", tokenMint: address("m"), collectionSymbol: "c", blockTime: 1_700_000_000, buyer: B, seller: B, price: 2 }], false);
  assert.strictEqual(self.firstBuyInWindow ?? null, null, `a self-fill is not the first purchase: ${JSON.stringify(self.firstBuyInWindow)}`);
  ok("R6-08/09/10 a duplicate is exact in every claim, outgoing settlement is uncertain too, a self-fill is no first buy");
}

console.log(`\nround6: ${passed} blocks passed`);
