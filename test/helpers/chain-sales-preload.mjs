/**
 * Preloaded into a child server (node --import) for test/chain-sales.mjs.
 *
 * The chain answers from replies captured on 2026-11-14 and saved under
 * test/fixtures/chain-sales/: getTransaction for every saved signature, and
 * getSignaturesForAddress for one Candy collection (Batman: The Long
 * Halloween). Magic Eden answers that collection's stats and sales from its
 * own captured replies. Like the real node, a request for a version-1
 * transaction that asks for less than version 1 gets the -32015 refusal the
 * node gave that day. CHAIN_SALES_PROFILE=busy answers every transaction read
 * with the public node's overload error. The home folder is redirected and
 * nothing reaches the network.
 *
 * Account, history and transaction reads for three cards, a wallet, the USDC
 * mint and an address with no account are served from the replies saved in
 * transaction-versions-, provenance-sales- and address-kinds-2026-11-14.json.
 * CHAIN_SALES_PROFILE=unread-mint answers the first transaction of one card's
 * history with null, as a node that does not hold it does. An account nobody
 * saved is an error, never an invented "no account".
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();
const profile = process.env.CHAIN_SALES_PROFILE || "normal";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "chain-sales");
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const bySignature = new Map();
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const j = load(f);
  // The saved refusal is a reply to the same signature, asked for the wrong
  // version; only replies that carry the transaction are served as it.
  if (j.method === "getTransaction" && j.reply?.result) bySignature.set(j.params[0], j.reply);
}
const sigList = load("sigs-pUqAP3.json");
const refusal = load("version-refusal.json");
const meStats = load("me-tlh-stats.json").reply;
const meSales = load("me-tlh-buynow.json").reply;

const fixtures = path.join(dir, "..");
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(fixtures, f), "utf8"));
const TV = fixture("transaction-versions-2026-11-14.json");
const PV = fixture("provenance-sales-2026-11-14.json");
const AK = fixture("address-kinds-2026-11-14.json");
/** Saved replies by method and first parameter. */
const saved = new Map();
for (const c of [...PV.calls, ...AK.calls]) saved.set(`${c.method}:${JSON.stringify(c.params[0])}`, c.reply);
for (const field of ["getAccountInfo", "getSignaturesForAddress", "getTransaction"]) {
  for (const [first, r] of Object.entries(TV[field])) saved.set(`${field}:${JSON.stringify(first)}`, r);
}
saved.set(`getMultipleAccounts:${JSON.stringify(TV.getMultipleAccounts.params[0])}`, TV.getMultipleAccounts.reply);
for (const c of PV.calls) if (c.method === "getTransaction" && c.reply?.result) bySignature.set(c.params[0], c.reply);
for (const [s, r] of Object.entries(TV.getTransaction)) if (r?.result) bySignature.set(s, r);
/** The first transaction of HEqTvtpw's history, which the unread-mint profile does not hold. */
const UNREAD_MINT = PV.calls.find((c) => c.method === "getTransaction" && c.params[0].startsWith("2DzqXRX7")).params[0];

function rpc(b) {
  const p = b.params ?? [];
  const reply = (r) => ({ ...r, id: b.id });
  switch (b.method) {
    case "getAccountInfo":
    case "getMultipleAccounts": {
      const r = saved.get(`${b.method}:${JSON.stringify(p[0])}`);
      return r ? reply(r) : { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: `chain-sales fixture does not serve ${b.method} for this account` } };
    }
    case "getTransaction": {
      if (profile === "busy") return { jsonrpc: "2.0", id: b.id, error: { code: -32603, message: "Internal error" } };
      if (profile === "unread-mint" && p[0] === UNREAD_MINT) return { jsonrpc: "2.0", id: b.id, result: null };
      const r = bySignature.get(p[0]);
      // A signature nobody saved: the node answers null, as it does for one it does not hold.
      if (!r) return { jsonrpc: "2.0", id: b.id, result: null };
      const asked = p[1]?.maxSupportedTransactionVersion;
      if (r.result?.version === 1 && !(typeof asked === "number" && asked >= 1)) return reply(refusal.reply);
      return reply(r);
    }
    case "getSignaturesForAddress": {
      const other = saved.get(`${b.method}:${JSON.stringify(p[0])}`);
      if (other) return reply(other);
      if (p[0] !== sigList.params[0]) return { jsonrpc: "2.0", id: b.id, result: [] };
      // The node returns the newest `limit` signatures; the saved list is the newest 100.
      const limit = Math.min(Number(p[1]?.limit ?? 1000), sigList.reply.result.length);
      return { jsonrpc: "2.0", id: b.id, result: sigList.reply.result.slice(0, limit) };
    }
    default:
      return { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: `chain-sales fixture does not serve ${b.method}` } };
  }
}

function me(u) {
  const p = u.pathname;
  if (p === "/v2/collections/batman_the_long_halloween/stats") return meStats;
  if (p === "/v2/collections/batman_the_long_halloween/activities") return u.searchParams.get("offset") === "0" ? meSales : [];
  return null;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === "registry.npmjs.org") return json({ version: "0.0.1" });
  if (target.hostname === "chain-sales-rpc.invalid") {
    const body = JSON.parse(String(init.body ?? "{}"));
    return json(Array.isArray(body) ? body.map(rpc) : rpc(body));
  }
  if (target.hostname === "api-mainnet.magiceden.dev") {
    const body = me(target);
    return body === null ? json({ message: "not in the chain-sales fixture" }, 404) : json(body);
  }
  return json({ message: `refused by the chain-sales preload: ${target.hostname}` }, 404);
};
