/**
 * Preloaded into a child server (node --import) for test/money.mjs.
 *
 * Serves the replies Magic Eden and OpenSea gave on 2026-11-14 for the 2022
 * Leadoff ICONs collection, read from test/fixtures as captured. One extra
 * slug serves the same OpenSea page with one sale's time moved by an hour, the
 * only altered reply here, so the cross-feed time check has something to see.
 * The home folder is redirected and nothing reaches the network: an
 * unexpected request is a 404.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();

const fixtures = path.join(import.meta.dirname, "..", "fixtures");
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
const meLeadoff = load("me-leadoff-sales-2026-11-14.json");
const meStats = load("me-leadoff-stats-2026-11-14.json");
const osSales = load("os-candy-mlb-sales-2026-11-14.json");
const osDetail = load("os-candy-mlb-detail-2026-11-14.json");
export const SHIFTED_SIGNATURE = "4f2Arm2WALBhkJkm3oqEJf2wFuxvs1SN6Lts3GbfTVNoZCdA3oWuE7YdKBYw1dPfwN3iaArkdgQw58yZxo4jRc96";
const shifted = { ...osSales, asset_events: osSales.asset_events.map((e) => (e.transaction === SHIFTED_SIGNATURE ? { ...e, event_timestamp: e.event_timestamp + 3600 } : e)) };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === "registry.npmjs.org") return json({ version: "0.0.1" });
  if (u.hostname === "api-mainnet.magiceden.dev") {
    const p = u.pathname;
    if (p === "/v2/collections/2022_leadoff_icons/stats") return json(meStats);
    if (p === "/v2/collections/2022_leadoff_icons/activities") {
      const q = u.searchParams;
      if (q.get("type") === "buyNow" && q.get("limit") === "100" && q.get("offset") === "0") return json(meLeadoff);
      return json([]);
    }
    return json({ message: "not served by the money preload" }, 404);
  }
  if (u.hostname === "api.opensea.io") {
    const p = u.pathname;
    if (p.endsWith("/auth/keys")) return json({ message: "key issuance is not served here" }, 403);
    if (p === "/api/v2/events/collection/candy-mlb" && u.searchParams.get("limit") === "10") return json(osSales);
    if (p === "/api/v2/events/collection/candy-mlb-shifted" && u.searchParams.get("limit") === "10") return json(shifted);
    if (p === "/api/v2/collections/candy-mlb" || p === "/api/v2/collections/candy-mlb-shifted") return json(osDetail);
    return json({ message: "not served by the money preload" }, 404);
  }
  return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "the money preload serves no RPC" } });
};
