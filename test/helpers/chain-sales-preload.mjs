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

function rpc(b) {
  const p = b.params ?? [];
  const reply = (r) => ({ ...r, id: b.id });
  switch (b.method) {
    case "getTransaction": {
      if (profile === "busy") return { jsonrpc: "2.0", id: b.id, error: { code: -32603, message: "Internal error" } };
      const r = bySignature.get(p[0]);
      // A signature nobody saved: the node answers null, as it does for one it does not hold.
      if (!r) return { jsonrpc: "2.0", id: b.id, result: null };
      const asked = p[1]?.maxSupportedTransactionVersion;
      if (r.result?.version === 1 && !(typeof asked === "number" && asked >= 1)) return reply(refusal.reply);
      return reply(r);
    }
    case "getSignaturesForAddress": {
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
