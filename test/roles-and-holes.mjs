/**
 * Fourteen regressions from 2026-09-18: a fact read from the chain being
 * turned into a story it does not tell (issuer roles, custody across holes,
 * short credentials, unknown plugins).
 * Every block asserts the correct behaviour and every one failed before its
 * fix. Nothing here touches the network.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registerUrlCredentials, redactSecrets, resetSecrets } from "../dist/lib/secrets.js";
import { roleOf } from "../dist/issuers.js";
import { deriveTrust, decodeCoreAccountPlugins } from "../dist/lib/coreplugins.js";
import { searchRegistry } from "../dist/registry.js";
import { getAssetsByGroup } from "../dist/sources/das.js";
import * as sol from "../dist/sources/solana.js";
import { verifyClaim } from "../dist/verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
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
const un58 = (s) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Buffer.from(out);
};
const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
/** A CollectionV1 account with the given update authority, base64. */
const collectionB64 = (authority) => { const n = Buffer.alloc(8); n.writeUInt32LE(10); n.writeUInt32LE(10, 4); return Buffer.concat([Buffer.from([5]), un58(authority), str("Roles fixture"), str("https://example.invalid/c"), n]).toString("base64"); };
/** An AssetV1 account owned by `owner`, in `col` when given, base64. */
const assetB64 = (owner, col) => Buffer.concat([Buffer.from([1]), un58(owner), Buffer.from([col ? 2 : 0]), ...(col ? [un58(col)] : []), str("Roles fixture item"), str("https://example.invalid/a"), Buffer.from([0])]).toString("base64");

const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SYSTEM = "11111111111111111111111111111111";
const MINT = address("r7-mint");
const COL = address("r7-col");
const PAYER = address("r7-payer");
const AUTH = address("r7-authority");
const FIRST = address("r7-first");
const LAST = address("r7-last");
const b58data = (bytes) => base58(bytes);
const createIx = () => ({ programId: CORE, accounts: [MINT, COL, AUTH, PAYER, FIRST, CORE, SYSTEM, CORE], data: b58data(Buffer.concat([Buffer.from([20, 0]), str("Roles fixture item"), str("https://example.invalid/a"), Buffer.from([0, 0])])) });
const transferIx = (to) => ({ programId: CORE, accounts: [MINT, COL, PAYER, FIRST, to, SYSTEM, CORE], data: b58data(Buffer.from([14, 0])) });
const tx = (ixs, inner = []) => ({ blockTime: 1_700_000_000, meta: { err: null, logMessages: ["Program log: Instruction: TransferV1"], innerInstructions: inner }, transaction: { message: { accountKeys: [], instructions: ixs } } });
/** One signature, one transaction, the asset in COL whose authority is `authority` (or the read fails). */
function rpcFor(host, t, { authority = LAST, failCollection = false } = {}) {
  process.env.SOLANA_RPC_URL = `https://${host}.invalid`;
  const sig = signature(host);
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(process.env.SOLANA_RPC_URL)) throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init.body));
    let result;
    if (body.method === "getAccountInfo" && body.params[0] === MINT) result = { context: { slot: 1000 }, value: { owner: CORE, data: [assetB64(LAST, COL), "base64"] } };
    else if (body.method === "getAccountInfo" && body.params[0] === COL) {
      if (failCollection) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "synthetic collection unavailable" } });
      result = { context: { slot: 1000 }, value: { owner: CORE, data: [collectionB64(authority), "base64"] } };
    } else if (body.method === "getSignaturesForAddress") result = [{ signature: sig, blockTime: 1_700_000_000, err: null }];
    else if (body.method === "getTransaction") result = t;
    else throw new Error(`unexpected method ${body.method}`);
    return json({ jsonrpc: "2.0", id: body.id, result });
  };
}
const kinds = (r) => r.events.map((e) => e.event);

// ================================================================ R7-01
// A configured endpoint's path credential is registered whatever its alphabet or length.
{
  for (const [seg, why] of [["FAKEONLYLETTERSCANARY", "letters only"], ["123456789012345678901234", "digits only"], ["FAKEKEY9", "eight characters"]]) {
    resetSecrets();
    registerUrlCredentials(`https://r7-private.invalid/v2/${seg}`);
    assert.ok(!redactSecrets(`upstream said ${seg} was refused`).includes(seg), `${why}: the path segment is a credential`);
  }
  resetSecrets();
  registerUrlCredentials("https://r7-private.invalid/solana-mainnet-beta/v2/");
  assert.strictEqual(redactSecrets("solana-mainnet-beta v2 mainnet"), "solana-mainnet-beta v2 mainnet", "route words and version tags are not credentials");
  resetSecrets();
  assert.strictEqual(registerUrlCredentials("https://rpc.invalid/v2/ab12cd34ef56/"), 1);
  resetSecrets();
  ok("R7-01 a path credential is registered whatever it looks like; route words are left alone");
}

// ================================================================ R7-02 / R7-04 / R7-05
// The issuer role is the observed relationship and nothing more; the table
// never overrides a live read; an unread authority leaves roles unresolved.
{
  const CANDY = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2";
  const issuer = roleOf(AUTH, AUTH);
  assert.strictEqual(issuer.role, "issuer");
  assert.ok(!/permanent transfer delegate|did not buy|not a collector/i.test(issuer.note), `the match proves the relationship only: ${issuer.note}`);
  assert.strictEqual(roleOf(CANDY, AUTH).role, "wallet", "a key known from other collections is an ordinary holder of this one");
  assert.match(roleOf(CANDY, AUTH).note, /Candy Digital.*not this collection's update authority/);
  assert.strictEqual(roleOf(address("someone"), null, "unavailable").role, "unknown", "no authority read, no clearance");
  assert.strictEqual(roleOf(address("someone"), AUTH, "ok").role, "wallet");
  assert.strictEqual(roleOf("1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix", null, "unavailable").role, "venue-escrow", "a known escrow is known whatever the authority read did");
  ok("R7-02/04/05 the issuer role is a relationship, the table is a hint, an unread authority is unknown");
}

// ================================================================ R7-03 / R7-05 / R7-07
// A transfer to the authority carries no intent; the authority read travels
// with its outcome and its age.
{
  rpcFor("r7-to-authority", tx([transferIx(LAST)]), { authority: LAST });
  const r = await sol.getProvenance(MINT, 15, { fresh: true });
  const t = r.events.find((e) => e.event === "transferred");
  assert.strictEqual(t.toIssuer, true);
  assert.ok(!/not a sale|pack being opened|took it back/i.test(t.label), `the address says who, not why: ${t.label}`);
  assert.strictEqual(r.issuerRead.status, "ok");
  assert.strictEqual(r.issuerRead.updateAuthority, LAST);
  assert.ok(typeof r.issuerRead.cachedAt === "string" && r.issuerRead.stale === false, "the read carries its age");
  rpcFor("r7-authority-failed", tx([transferIx(LAST)]), { failCollection: true });
  const f = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(f.issuerRead.status, "unavailable");
  assert.match(f.issuerRead.reason, /synthetic collection unavailable/);
  assert.ok(!f.events.some((e) => e.toIssuer), "nothing is labelled against an authority that was not read");
  globalThis.fetch = denied;
  ok("R7-03/05/07 a transfer to the authority is a fact about the recipient, and the authority read is part of the receipt");
}

// ================================================================ R7-08
// Every unreadable instruction leaves a hole in its place; final custody is
// never certified across one; an orphan group with no outer list is not complete.
{
  const noData = transferIx(LAST);
  delete noData.data;
  rpcFor("r7-inferred", tx([noData]));
  const inferred = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(kinds(inferred), ["transferred", "unread_gap"], `a log-inferred transfer keeps its hole: ${JSON.stringify(kinds(inferred))}`);
  assert.strictEqual(inferred.historyComplete, false);
  const tail = transferIx(FIRST);
  delete tail.data;
  rpcFor("r7-unreadable-tail", tx([transferIx(FIRST), transferIx(LAST), tail]));
  const two = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.ok(!two.events.some((e) => /final custody/.test(e.note ?? "")), "a hole after the second transfer withdraws the final-custody claim");
  const orphan = tx([]);
  orphan.meta.innerInstructions = [{ index: 99, instructions: [transferIx(LAST)] }];
  rpcFor("r7-orphan-only", orphan);
  const o = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.strictEqual(o.historyComplete, false, "an inner group with no parent at all is not an established order");
  globalThis.fetch = denied;
  ok("R7-08 holes stay in place, final custody needs a fully read transaction, an orphan group is never complete");
}

// ================================================================ R7-09
// An instruction this version does not know cannot confirm never-traded.
{
  rpcFor("r7-unknown-opcode", tx([createIx(), { programId: CORE, accounts: [MINT, COL, AUTH], data: b58data(Buffer.from([250, 0])) }]));
  const r = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.ok(r.events.some((e) => e.event === "unread_gap" && /discriminator 250/.test(e.label)), "the unknown instruction is a named hole");
  assert.strictEqual(r.historyComplete, false);
  const v = await verifyClaim({ claim: "never-traded", subject: MINT });
  assert.notStrictEqual(v.verdict, "confirmed", `never-traded across an unknown instruction is unverifiable: ${v.verdict}`);
  rpcFor("r7-known-opcode", tx([createIx(), { programId: CORE, accounts: [MINT, COL, AUTH], data: b58data(Buffer.from([2, 0])) }]));
  const k = await sol.getProvenance(MINT, 15, { fresh: true });
  assert.deepStrictEqual(kinds(k), ["minted"], "a known non-custody instruction (AddPluginV1) is not a hole");
  globalThis.fetch = denied;
  ok("R7-09 an unknown Core instruction is a hole; a known non-custody one is not");
}

// ================================================================ R7-10
// Duplicate copies: order-independent, name-aware, raw-value-aware.
{
  // One collection per case: the page cache is keyed by collection and would
  // otherwise serve the first case's rows to the rest.
  let col = address("r7-census-0");
  const raw = (over = {}) => ({ id: address("r7-dup"), interface: "MplCoreAsset", grouping: [{ group_key: "collection", group_value: col, verified: true }], ownership: { owner: FIRST }, content: { metadata: { name: "Card", attributes: [{ trait_type: "Edition", value: "X".repeat(128) }] } }, ...over });
  let n = 0;
  const serve = (rows) => {
    col = address(`r7-census-${++n}`);
    for (const r of rows) for (const g of r.grouping) if (g.group_value !== address("elsewhere")) g.group_value = col;
    process.env.DAS_RPC_URL = "https://r7-das.invalid";
    globalThis.fetch = async (url, init = {}) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "getAsset") return json({ jsonrpc: "2.0", id: body.id, result: { id: body.params.id } });
      if (body.method === "getAssetsByGroup") return json({ jsonrpc: "2.0", id: body.id, result: { items: body.params.page === 1 ? rows : [] } });
      throw new Error(`unexpected ${body.method}`);
    };
  };
  serve([raw({ grouping: [{ group_key: "collection", group_value: address("elsewhere"), verified: true }] }), raw()]);
  const reversed = await getAssetsByGroup(col, 10);
  assert.strictEqual(reversed.items.length, 0, "a foreign copy first, then a claiming copy, is a contradiction, not a member");
  assert.strictEqual(reversed.conflictingRows, 1);
  serve([raw(), raw({ content: { metadata: { name: "Card", attributes: [{ trait_type: "Edition", value: "X".repeat(128) + "Y" }] } } })]);
  const clipped = await getAssetsByGroup(col, 10);
  assert.strictEqual(clipped.conflictingRows, 1, "two values that print the same after the cut are still two values");
  serve([raw({ content: { metadata: { name: "Old name", attributes: [] } } }), raw({ content: { metadata: { name: "Migrated name", attributes: [] } } })]);
  const renamed = await getAssetsByGroup(col, 10);
  assert.strictEqual(renamed.conflictingRows, 1, "a name a filter runs on is part of the comparison");
  serve([raw(), raw()]);
  const exact = await getAssetsByGroup(col, 10);
  assert.strictEqual(exact.items.length, 1);
  assert.strictEqual(exact.duplicateRows, 1);
  assert.strictEqual(exact.conflictingRows, 0);
  delete process.env.DAS_RPC_URL;
  globalThis.fetch = denied;
  ok("R7-10 duplicate copies are compared on every field a decision uses, in either order");
}

// ================================================================ R7-11 / R7-12
// An unknown plugin type keeps the picture incomplete; a frozen asset with a
// permanent transfer delegate names the exception.
{
  const base = Buffer.from(assetB64(address("owner")), "base64");
  const header = Buffer.alloc(9);
  header[0] = 3;
  header.writeBigUInt64LE(BigInt(base.length + 10), 1);
  const offset = Buffer.alloc(8);
  offset.writeBigUInt64LE(BigInt(base.length + 9));
  const registry = Buffer.concat([Buffer.from([4]), Buffer.from([1, 0, 0, 0]), Buffer.from([250, 2]), offset, Buffer.alloc(4)]);
  const decoded = decodeCoreAccountPlugins(Buffer.concat([base, header, Buffer.from([250]), registry]).toString("base64"));
  assert.ok(decoded.plugins.some((p) => p.unsupported), "the unknown type is listed as unsupported");
  const trust = deriveTrust(decoded);
  assert.strictEqual(trust.incomplete, true, "an unknown plugin type cannot leave the custody picture complete");
  assert.ok(trust.warnings.some((w) => /unknown plugin type 250/.test(w)));
  const frozen = deriveTrust({ kind: "asset", collection: null, plugins: [{ type: "PermanentFreezeDelegate", authority: address("freezer"), data: { frozen: true } }, { type: "PermanentTransferDelegate", authority: address("mover") }], updateAuthorityIsNone: false, externalPlugins: 0 });
  assert.strictEqual(frozen.frozen, true);
  assert.ok(!frozen.warnings.some((w) => /cannot be transferred.*until.*thaws/i.test(w)), "no absolute cannot-transfer beside a permanent transfer delegate");
  assert.ok(frozen.warnings.some((w) => /force-approved/.test(w) && /frozen/.test(w)), "the delegate's exception is named");
  ok("R7-11/12 an unknown plugin is an unknown, and a freeze does not bind the permanent transfer delegate");
}

// ================================================================ R7-13
// The issuer table is never replaced by an empty one after an outage.
{
  const code = fs.readFileSync(path.join(root, "scripts", "issuers.mjs"), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.join(root, "scripts", "issuers.mjs")).href));
  let wrote;
  const context = {
    path,
    fileURLToPath,
    readFileSync: () => JSON.stringify([{ address: address("c1") }, { address: address("c2") }]),
    writeFileSync: (_p, text) => { wrote = JSON.parse(text); },
    sol: { getCoreAccountRaw: async () => { throw new Error("synthetic outage"); }, decodeCoreAccount: () => null },
    console: { log: () => {} },
  };
  await assert.rejects(vm.runInNewContext(`(async()=>{${code}})()`, context), /NOT written/);
  assert.strictEqual(wrote, undefined, "nothing is written when nothing was read");
  ok("R7-13 a failed refresh leaves the last good issuer table in place");
}

// ================================================================ R7-14
// A generation number survives the search.
{
  const r = searchRegistry("SMB Gen 2");
  assert.strictEqual(r[0]?.id, "smb-gen2", `the one-character generation token is kept: ${r.map((e) => e.id).join(", ")}`);
  assert.strictEqual(searchRegistry("SMB Gen2")[0]?.id, "smb-gen2");
  assert.strictEqual(searchRegistry("Solana Monkey Business")[0]?.id, "smb-gen2");
  ok("R7-14 'SMB Gen 2' finds Gen2");
}

console.log(`\nroles-and-holes: ${passed} blocks passed`);
