/**
 * Preloaded into a child server (node --import) for test/feeds-and-groups.mjs.
 *
 * Serves replies Magic Eden, OpenSea and the public RPC gave on 2026-11-14 and
 * 2026-11-15 (test/fixtures), as captured: Collector Crypt's two feeds, where
 * OpenSea names SOL on Magic Eden's USDC fills; the 2022 Leadoff ICONs feeds,
 * with OpenSea's "candy-mlb" slug and the accounts of the items it lists;
 * Gold Series ICONs by its Magic Eden symbol; and a compressed Tensorian whose
 * Magic Eden row and asset index name different owners.
 *
 * A getMultipleAccounts request is answered from the captured per-account
 * values in the order it asks for them; an address that was not captured makes
 * the whole read fail, as an endpoint error would. The clock is moved back to
 * the capture (time still runs), so a window of days covers the same rows
 * whenever the test runs. The home folder is redirected and nothing reaches
 * the network: an unexpected request is a 404 or a JSON-RPC error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();

export const CAPTURED_AT = Date.parse("2026-11-15T04:00:00Z");
const realNow = Date.now;
const shift = realNow() - CAPTURED_AT;
Date.now = () => realNow() - shift;

const fixtures = path.join(import.meta.dirname, "..", "fixtures");
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
const meFeeds = {
  collector_crypt: load("me-collector-crypt-sales-2026-11-15.json"),
  "2022_leadoff_icons": load("me-leadoff-sales-2026-11-14.json"),
  gold_series_auction_1_candy_digital: load("me-gold-sales-2026-11-15.json"),
};
const meStats = {
  "2022_leadoff_icons": load("me-leadoff-stats-2026-11-14.json"),
  gold_series_auction_1_candy_digital: load("me-gold-stats-2026-11-15.json"),
};
const osEvents = {
  "collector-crypt": load("os-collector-crypt-sales-2026-11-15.json"),
  "candy-mlb": load("os-candy-mlb-sales-50-2026-11-15.json"),
};
const osDetail = { "candy-mlb": load("os-candy-mlb-detail-2026-11-14.json") };
const osStats = { "candy-mlb": load("os-candy-mlb-stats-2026-11-15.json") };
export const LEADOFF = "46kCejJ7euGEmLAFqvV1j5yUzEumtwEvS9d65f6PbZ7g";
const leadoffAccount = load("leadoff-collection-account-2026-11-15.json");
const osIndex = [load("os-solana-index-p1-2026-11-15.json"), load("os-solana-index-p2-2026-11-15.json")];
export const TENSORIAN = "GDEC7TRDAdU1BUhSSAK2WLc5DqLSCCcq6W2b7rVpfHcS";
const tensorianToken = load("me-token-compressed-tensorian-2026-11-15.json");
const tensorianIndex = load("das-compressed-tensorian-2026-11-15.json");
const tensorianAccount = load("tensorian-item-account-2026-11-15.json");
const tensorianOwner = load("tensorian-index-owner-account-2026-11-15.json");

// Each captured getMultipleAccounts reply, as one value per address.
const accountValues = new Map();
for (const name of ["candy-mlb-item-accounts-2026-11-15.json", "gold-item-accounts-2026-11-15.json"]) {
  const { request, reply } = load(name);
  request.forEach((address, i) => accountValues.set(address, { value: reply.result.value[i], context: reply.result.context }));
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rpcError = (id, message) => json({ jsonrpc: "2.0", id, error: { code: -32601, message } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "registry.npmjs.org") return json({ version: "0.0.1" });
  if (u.hostname === "api-mainnet.magiceden.dev") {
    const p = u.pathname.split("/");
    const symbol = p[3];
    if (p[2] === "collections" && p[4] === "stats" && Object.hasOwn(meStats, symbol)) return json(meStats[symbol]);
    if (p[2] === "collections" && p[4] === "activities" && Object.hasOwn(meFeeds, symbol)) {
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 100);
      return json(offset === 0 ? meFeeds[symbol].slice(0, limit) : []);
    }
    if (u.pathname === `/v2/tokens/${TENSORIAN}`) return json(tensorianToken);
    return json({ message: "not served by the feeds preload" }, 404);
  }
  if (u.hostname === "api.opensea.io") {
    const p = u.pathname;
    if (p.endsWith("/auth/keys")) return json({ message: "key issuance is not served here" }, 403);
    const events = /^\/api\/v2\/events\/collection\/([^/]+)$/.exec(p);
    if (events && Object.hasOwn(osEvents, events[1]) && u.searchParams.get("next") === null) return json(osEvents[events[1]]);
    const detail = /^\/api\/v2\/collections\/([^/]+)$/.exec(p);
    if (detail && Object.hasOwn(osDetail, detail[1])) return json(osDetail[detail[1]]);
    const stats = /^\/api\/v2\/collections\/([^/]+)\/stats$/.exec(p);
    if (stats && Object.hasOwn(osStats, stats[1])) return json(osStats[stats[1]]);
    if (p === "/api/v2/collections" && u.searchParams.get("chain") === "solana") {
      const next = u.searchParams.get("next");
      if (next === null) return json(osIndex[0]);
      if (next === osIndex[0].next) return json(osIndex[1]);
    }
    return json({ message: "not found" }, 404);
  }
  if (u.hostname === "feeds-rpc.invalid") {
    let body = {};
    try { body = JSON.parse(String(init.body ?? "{}")); } catch { /* answered as an error below */ }
    if (body.method === "getMultipleAccounts") {
      const asked = Array.isArray(body.params?.[0]) ? body.params[0] : [];
      if (!asked.every((a) => accountValues.has(a))) return rpcError(body.id, "the feeds preload holds no capture for one of these accounts");
      return json({ jsonrpc: "2.0", id: body.id, result: { context: accountValues.get(asked[0])?.context ?? { slot: 1 }, value: asked.map((a) => accountValues.get(a).value) } });
    }
    if (body.method === "getAsset" && body.params?.id === TENSORIAN) return json({ ...tensorianIndex, id: body.id });
    if (body.method === "getAccountInfo" && body.params?.[0] === TENSORIAN) return json({ ...tensorianAccount, id: body.id });
    if (body.method === "getAccountInfo" && body.params?.[0] === LEADOFF) return json({ ...leadoffAccount, id: body.id });
    if (body.method === "getAccountInfo" && body.params?.[0] === tensorianOwner.owner) return json({ ...tensorianOwner.reply, id: body.id });
    return rpcError(body.id ?? 1, `the feeds preload does not serve ${body.method}`);
  }
  return json({ message: "refused by the feeds preload" }, 404);
};
