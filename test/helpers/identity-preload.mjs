/**
 * Preloaded into a child server (node --import) for the identity and
 * validation regressions that need a whole tool handler.
 *
 * Serves: a Core collection account for the registry's MLB ICON entry; an
 * OpenSea slug whose record names a DIFFERENT on-chain collection and one
 * whose record names the right one; a listings book that returns a Grade 9
 * row under a Grade 10 filter, the way the marketplace does; and a key
 * endpoint that counts how many times it was asked. The home folder is
 * redirected so nothing the child writes lands in a real profile. Nothing
 * here reaches the network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ICON = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"; // registry: candy-mlb-icon-2026
const OTHER = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K"; // a different collection
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SELLER = "BA56URSgTmXFdh83i125szydnvVTuN8U1VSQSckqcnP2";
const MINT_A = "7chErGXMoYARjjmj9ZWrv7H415Bx1F3WrQt1nVFihuEa";
const MINT_B = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2";
const MINT_C = "2GGzww6NPSUkcfJM5LmwCcjAhYWsfJyLWvsSzBM4TgaR";

const str = (t) => { const b = Buffer.from(t); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const counters = Buffer.alloc(8); counters.writeUInt32LE(10, 0); counters.writeUInt32LE(10, 4);
const COLLECTION_B64 = Buffer.concat([Buffer.from([5]), Buffer.alloc(32), str("Identity fixture"), str("https://example.invalid/c"), counters]).toString("base64");

// The book the marketplace returns for a Grade=10 filter: two real Grade 10
// cards and one Grade 9 card it let through, all carrying serials.
const listings = [
  { tokenMint: MINT_A, price: 0.3, seller: SELLER, listingSource: "M2", token: { name: "Charizard V CGC 10 #12/100", attributes: [{ trait_type: "Grade", value: "10" }, { trait_type: "Card Name", value: "Charizard V" }] } },
  { tokenMint: MINT_B, price: 0.2, seller: SELLER, listingSource: "M2", token: { name: "Charizard ex CGC 9 #3/100", attributes: [{ trait_type: "Grade", value: 9 }, { trait_type: "Card Name", value: "Charizard ex" }] } },
  { tokenMint: MINT_C, price: 0.4, seller: SELLER, listingSource: "M2", token: { name: "Charizard VMAX CGC 10 #77/100", attributes: [{ trait_type: "grade", value: "10.0" }, { trait_type: "Card Name", value: "Charizard VMAX" }] } },
];

const issuedFile = path.join(home, "issued.txt");
const countIssue = () => {
  let n = 0;
  try { n = Number(fs.readFileSync(issuedFile, "utf8")) || 0; } catch { /* first time */ }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(issuedFile, String(n + 1));
};

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.includes("registry.npmjs.org")) return json({ version: "0.0.1" });
  if (target.includes("identity-rpc.invalid")) {
    let body = {};
    try { body = JSON.parse(String(init.body ?? "{}")); } catch { /* answered as an error below */ }
    if (body.method === "getAccountInfo") return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1000 }, value: { owner: CORE, data: [COLLECTION_B64, "base64"] } } });
    return json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32601, message: `identity preload does not serve ${body.method}` } });
  }
  if (target.endsWith("/auth/keys")) {
    countIssue();
    return json({ api_key: "fixturekeyfixturekey", expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  }
  if (target.includes("api.opensea.io")) {
    if (target.includes("/collections/wrong-collection/stats") || target.includes("/collections/right-collection/stats")) {
      return json({ total: { floor_price: 1, floor_price_symbol: "SOL", volume: 10, sales: 5, num_owners: 3 } });
    }
    if (target.endsWith("/collections/wrong-collection")) return json({ collection: "wrong-collection", name: "Another collection", total_supply: 500, contracts: [{ chain: "solana", address: OTHER }] });
    if (target.endsWith("/collections/right-collection")) return json({ collection: "right-collection", name: "The ICON series", total_supply: 500, contracts: [{ chain: "solana", address: ICON }] });
    return json({ message: "not served by the identity preload" }, 404);
  }
  if (target.includes("magiceden.dev")) {
    if (target.includes("/collections/trait-fixture/listings")) return json(target.includes("offset=0") || !target.includes("offset=") ? listings : []);
    if (target.includes("/collections/trait-fixture/stats")) return json({ symbol: "trait-fixture", floorPrice: 200_000_000, listedCount: 3, volumeAll: 1 });
    if (target.includes("/collections/trait-fixture/attributes")) return json({ results: { availableAttributes: [] } });
    if (target.includes("/collections/trait-fixture")) return json({ symbol: "trait-fixture", name: "Trait fixture" });
  }
  return json({ message: `refused by the identity preload: ${target.slice(0, 80)}` }, 404);
};
