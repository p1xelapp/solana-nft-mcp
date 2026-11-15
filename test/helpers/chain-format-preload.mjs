/**
 * Preloaded into a child server (node --import) for the stdio cases in
 * test/chain-format-and-issuers.mjs. Every reply is one saved from the real
 * services on 2026-11-14 (test/fixtures/), or built from one by changing the
 * field a case is about:
 *
 *  - the chain's list of collections under Candy's key is the saved reply
 *    plus two rows in the same shape: a drop with items the registry lacks,
 *    and an empty one;
 *  - an empty collection naming Candy's key, served as an account in the
 *    saved account shape;
 *  - one card's Magic Eden record, saved, with its name and image swapped for
 *    a sibling's (the wrong copy a marketplace has shown), and a control whose
 *    image is the same picture through Magic Eden's image proxy;
 *  - a DC comic whose account, index and Magic Eden records are all served
 *    exactly as saved.
 *
 * Every other upstream is refused. The home folder is redirected, and every
 * JSON-RPC method sent is appended to SOLANA_NFT_MCP_TEST_LOG.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

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
  let zeros = 0;
  for (const b of bytes) { if (b !== 0) break; zeros++; }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("").replace(/^1+/, "");
}
const keyBytes = (label) => createHash("sha256").update(`chain-format-${label}`).digest();
export const addressOf = (label) => base58(keyBytes(label));
export const EMPTY_NAMING_CANDY = addressOf("empty-naming-candy");
export const NEW_DROP = addressOf("new-drop");
export const NEW_EMPTY = addressOf("new-empty");
export const RENAMED_MINT = addressOf("renamed-mint");
export const SAME_MINT = addressOf("same-mint");
export const ASSET_NAMING_CANDY = addressOf("asset-naming-candy");
/** A real DC comic whose account name and metadata name differ; every reply for it is the saved one. */
export const DC_COMIC = "AUjRXCikevZrK7JPEvgPE3HquYyYc2WF51pmS2ZuiQF9";

const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const CANDY_AUTHORITY = "7wixESeixiY4f2A6JaDKNewNoiip9Tk9s5u1dze7nRwL";
const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";

// Side effects only inside the server child the test starts.
if (process.env.SOLANA_NFT_MCP_TEST_HOME) {
  const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
  os.homedir = () => home;
  syncBuiltinESMExports();
  const log = process.env.SOLANA_NFT_MCP_TEST_LOG;
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  const TX = JSON.parse(fs.readFileSync(path.join(fixtures, "transaction-versions-2026-11-14.json"), "utf8"));
  const GPA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(fixtures, "collections-by-authority-2026-11-14.json.gz"))).toString("utf8"));
  const CARD = JSON.parse(fs.readFileSync(path.join(fixtures, "asset-record-2026-11-14.json"), "utf8"));

  // A CollectionV1 account in the saved account's shape: key 5, authority, name, uri, counters.
  const un58 = (s) => {
    let n = 0n;
    for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
    const out = [];
    while (n) { out.unshift(Number(n % 256n)); n /= 256n; }
    for (const c of s) { if (c !== "1") break; out.unshift(0); }
    while (out.length < 32) out.unshift(0);
    return Buffer.from(out);
  };
  const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const collectionBytes = (name, minted) => {
    const counters = Buffer.alloc(8);
    counters.writeUInt32LE(minted);
    counters.writeUInt32LE(minted, 4);
    return Buffer.concat([Buffer.from([5]), un58(CANDY_AUTHORITY), str(name), str("https://arweave.net/" + "A".repeat(43)), counters]);
  };
  const realAccount = TX.getAccountInfo["pUqAP37Cvdh8YEr8YssSC84hngnBWcPEaBNdqsvh4mA"];
  const accountEnvelope = (bytes) => ({ ...realAccount, result: { ...realAccount.result, value: { ...realAccount.result.value, data: [bytes.toString("base64"), "base64"], space: bytes.length } } });
  const synthetic = new Map([
    [EMPTY_NAMING_CANDY, collectionBytes("Absolute Batman (2024) #98", 0)],
    [NEW_DROP, collectionBytes("Superman Unlimited (2025-) #6", 12)],
    [NEW_EMPTY, collectionBytes("Absolute Batman (2024) #99", 0)],
  ]);
  // The saved card's own account with its authority changed from "the
  // collection" (tag 2) to an address (tag 1) that is Candy's key: an item
  // anybody can mint, since the authority does not sign at creation.
  const card = Buffer.from(CARD.getAccountInfo.result.value.data[0], "base64");
  const standalone = Buffer.from(card);
  standalone[33] = 1;
  un58(CANDY_AUTHORITY).copy(standalone, 34);
  synthetic.set(ASSET_NAMING_CANDY, standalone);
  const realRow = GPA.reply.result[0];
  const listRow = (address, bytes) => ({ ...realRow, pubkey: address, account: { ...realRow.account, data: [bytes.subarray(0, 320).toString("base64"), "base64"], space: bytes.length } });
  const list = { ...GPA.reply, result: [...GPA.reply.result, listRow(NEW_DROP, synthetic.get(NEW_DROP)), listRow(NEW_EMPTY, synthetic.get(NEW_EMPTY))] };

  // The card under two synthetic mints: one with Magic Eden's copy swapped
  // for a sibling parallel's name and art, one with the same picture through
  // Magic Eden's image proxy.
  const meBody = (mint) => {
    const body = { ...CARD.magicEdenToken.body, mintAddress: mint };
    if (mint === RENAMED_MINT) return { ...body, name: "Gold Series - Auction #1 (20/36)", image: "https://arweave.net/YsOTkYe3Kr7na1GituNfDh1p7sv7EccCh7y52dgjTSg" };
    return { ...body, image: `https://img-cdn.magiceden.dev/rs:fill:400:0:0/plain/${encodeURIComponent(CARD.magicEdenToken.body.image)}` };
  };
  const CARD_MINTS = new Set([RENAMED_MINT, SAME_MINT]);
  const cardOwner = "jiY25VMssADHZJep2K2TqiePDNiwKdx7jbnP9YZPhua";
  const wallet = TX.getMultipleAccounts.reply.result.value[2];

  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const reply = (id, env) => json({ ...env, id });

  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api-mainnet.magiceden.dev") {
      const m = /^\/v2\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(u.pathname);
      if (log) fs.appendFileSync(log, `magiceden ${u.pathname}\n`);
      if (m && CARD_MINTS.has(m[1])) return json(meBody(m[1]));
      if (m && m[1] === DC_COMIC) return json(CARD.secondItem.magicEdenToken.body);
      return new Response(JSON.stringify({ errors: [{ msg: "not found" }] }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (u.hostname !== "chain-format.invalid" && u.hostname !== "chain-format-index.invalid") throw new Error(`network denied by the chain-format fixture: ${u.hostname}`);
    const body = JSON.parse(String(init.body ?? "{}"));
    if (log) fs.appendFileSync(log, `${body.method}\n`);
    const p = body.params;
    switch (body.method) {
      case "getProgramAccounts":
        return reply(body.id, list);
      case "getAccountInfo": {
        const a = p[0];
        if (synthetic.has(a)) return reply(body.id, accountEnvelope(synthetic.get(a)));
        if (TX.getAccountInfo[a]) return reply(body.id, TX.getAccountInfo[a]);
        if (CARD_MINTS.has(a)) return reply(body.id, CARD.getAccountInfo);
        if (a === cardOwner || a === "h4FoDwkztwipWbqdNV4jEa7FJkL32fz5hjE9w5q67zv") return reply(body.id, { jsonrpc: "2.0", result: { context: realAccount.result.context, value: wallet } });
        return reply(body.id, { jsonrpc: "2.0", result: { context: realAccount.result.context, value: null } });
      }
      case "getSignaturesForAddress":
        return reply(body.id, { jsonrpc: "2.0", result: [] });
      case "getAsset": {
        if (p?.id === CANARY) return reply(body.id, { jsonrpc: "2.0", result: { id: CANARY, interface: "MplCoreCollection" } });
        if (p?.id === DC_COMIC) return reply(body.id, CARD.secondItem.getAsset);
        if (CARD_MINTS.has(p?.id)) {
          const r = CARD.getAsset.result;
          return reply(body.id, { ...CARD.getAsset, result: { ...r, id: p.id } });
        }
        return reply(body.id, { jsonrpc: "2.0", error: { code: -32000, message: "Database Error: RecordNotFound Error: Asset not found" } });
      }
      case "getAssetsByGroup":
        return reply(body.id, { jsonrpc: "2.0", result: { total: 0, limit: 1000, page: 1, items: [] } });
      case "getMultipleAccounts":
        return reply(body.id, { jsonrpc: "2.0", result: { context: realAccount.result.context, value: p[0].map(() => wallet) } });
      default:
        return reply(body.id, { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } });
    }
  };
}
