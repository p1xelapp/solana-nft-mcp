/**
 * Preloaded into a child server (node --import) for test/stale-facts-and-sales.mjs.
 *
 * Serves one Candy collection that Magic Eden and OpenSea both index, with
 * the same fill in both feeds at two prices; a second collection OpenSea has
 * no record of; and a wallet whose second collection's floor never answers.
 * The home folder is redirected so nothing the child writes lands in a real
 * profile. Nothing here reaches the network: an unexpected request is a 404.
 */
import os from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encode = (b) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
export const sig = (label) => encode(createHash("sha512").update(label).digest());
export const addr = (label) => encode(createHash("sha256").update(label).digest());

// Registry entry candy-portraits-echoes-across-the-lens-of-time: symbol and
// chain address are both on the hand-written entry.
export const PORTRAITS = { symbol: "portraits_echoes_across_the_lens_of_time", core: "Fr42ujZwVq2PH5Pb6cDRcmmTkRrk18XyM2AHCH8aqEyY", slug: "portraits-echoes-across-the-lens-of-time" };
// Registry entry candy-2026-mlb-all-star-game-icons: OpenSea has no record
// carrying its address, and the one slug its name spells names another.
export const ALLSTAR = { symbol: "2026_mlb_allstar_game_icons_candy_digital", core: "YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX" };
export const BUYER = addr("buyer");
export const SELLER = addr("seller");
export const ITEM_A = addr("item-a");
export const ITEM_B = addr("item-b");
export const WALLET = addr("profile-wallet");

const now = Math.floor(Date.now() / 1000);
// The same fill in both feeds: Magic Eden's price is the seller's, OpenSea's
// is what the buyer paid with the royalty and fee on top.
const meSales = [
  { signature: sig("fill-1"), type: "buyNow", tokenMint: ITEM_A, buyer: BUYER, seller: SELLER, price: 0.01, blockTime: now - 7200, source: "magiceden_v2" },
  { signature: sig("fill-2"), type: "buyNow", tokenMint: ITEM_B, buyer: BUYER, seller: SELLER, price: 0.02, blockTime: now - 9000, source: "magiceden_v2" },
];
const osEvent = (transaction, mint, quantity, at) => ({ event_type: "sale", event_timestamp: at, transaction, buyer: BUYER, seller: SELLER, payment: { quantity, decimals: 9, symbol: "SOL" }, nft: { identifier: mint, name: "Portrait (1/10)" } });
const osSales = [
  osEvent(sig("fill-1"), ITEM_A, "11200000", now - 7200),
  // Same signature as a Magic Eden fill but a different item: not the same sale.
  osEvent(sig("fill-2"), addr("item-c"), "30000000", now - 9000),
  // A sale only OpenSea indexed.
  osEvent(sig("fill-3"), ITEM_A, "1130000000", now - 3600),
];

const hang = (signal) =>
  new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const u = new URL(target);
  if (u.hostname === "registry.npmjs.org") return json({ version: "0.0.1" });
  if (u.hostname === "stale-rpc.invalid") {
    let body = {};
    try { body = JSON.parse(String(init.body ?? "{}")); } catch { /* answered as an error below */ }
    if (body.method === "getSignaturesForAddress") return json({ jsonrpc: "2.0", id: body.id, result: [] });
    if (body.method === "getAccountInfo") return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: null } });
    return json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32601, message: `stale-facts preload does not serve ${body.method}` } });
  }
  if (u.hostname === "api.opensea.io") {
    const p = u.pathname;
    if (p.endsWith("/auth/keys")) return json({ message: "key issuance is not served here" }, 403);
    if (p === "/api/v2/collections") return json({ collections: [{ collection: PORTRAITS.slug, name: "Portraits", contracts: [{ chain: "solana", address: PORTRAITS.core }] }] });
    if (p === `/api/v2/events/collection/${PORTRAITS.slug}`) return json({ asset_events: osSales });
    if (p === `/api/v2/collections/${PORTRAITS.slug}`) return json({ collection: PORTRAITS.slug, name: "Portraits", contracts: [{ chain: "solana", address: PORTRAITS.core }] });
    // The name-spelled slug for the All-Star entry exists but is someone else's.
    if (p === "/api/v2/collections/2026-mlb-all-star-game-icons") return json({ collection: "2026-mlb-all-star-game-icons", name: "Lookalike", contracts: [{ chain: "solana", address: addr("lookalike") }] });
    return json({ message: "not found" }, 404);
  }
  if (u.hostname === "api-mainnet.magiceden.dev") {
    const p = u.pathname;
    if (p.endsWith("/stats")) {
      const symbol = p.split("/")[3];
      // This collection's floor never answers; the profile must not wait on it.
      if (symbol === "slow_floor") return hang(init.signal);
      return json({ symbol, floorPrice: 1_000_000_000, listedCount: 10, volumeAll: 5_000_000_000 });
    }
    if (p.endsWith("/activities")) {
      const symbol = p.split("/")[3];
      const off = Number(u.searchParams.get("offset") ?? 0);
      if (symbol === PORTRAITS.symbol && u.searchParams.get("limit") === "100" && off === 0) return json(meSales);
      return json([]);
    }
    if (p.includes("/wallets/") && p.endsWith("/tokens")) {
      if (Number(u.searchParams.get("offset") ?? 0) > 0) return json([]);
      const t = (i, collection) => ({ mintAddress: addr(`held-${i}`), owner: WALLET, name: `Held ${i}`, collection, collectionName: collection, listStatus: "unlisted" });
      return json([t(1, "fast_floor"), t(2, "fast_floor"), t(3, "slow_floor")]);
    }
    if (p.startsWith("/v2/collections/")) return json({ symbol: p.split("/")[3], name: "Fixture" });
    return json([]);
  }
  return json({ message: `refused by the stale-facts preload: ${target.slice(0, 80)}` }, 404);
};
