/**
 * Preloaded into a child server (node --import) for the round-eight
 * regression cases that need a whole tool handler, not a pure function.
 *
 * Magic Eden's listings book for one synthetic symbol carries two players and
 * one malformed ask; its stats route answers a floor; every other route is
 * refused. The home folder is redirected so nothing the child writes lands in
 * a real profile. Nothing here reaches the network.
 */
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.COLLECTOR_TEST_HOME;
if (!home) throw new Error("COLLECTOR_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MINT_A = "7chErGXMoYARjjmj9ZWrv7H415Bx1F3WrQt1nVFihuEa";
const MINT_B = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2";
const MINT_C = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n";
const SELLER = "BA56URSgTmXFdh83i125szydnvVTuN8U1VSQSckqcnP2";

const listings = [
  { tokenMint: MINT_A, price: 0.5, seller: SELLER, listingSource: "M2", token: { name: "Aaron Judge #1", attributes: [] } },
  { tokenMint: MINT_B, price: 0.4, seller: SELLER, listingSource: "M2", token: { name: "Shohei Ohtani #7", attributes: [] } },
  { tokenMint: MINT_C, price: -2, seller: SELLER, listingSource: "M2", token: { name: "Shohei Ohtani #3", attributes: [] } },
];

// A CollectionV1 account whose counters say numMinted 10, currentSize 11: an
// asset was moved in, nothing was burned. Authority is the all-zero key.
const str = (t) => { const b = Buffer.from(t); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const counters = Buffer.alloc(8); counters.writeUInt32LE(10, 0); counters.writeUInt32LE(11, 4);
const COLLECTION_B64 = Buffer.concat([Buffer.from([5]), Buffer.alloc(32), str("Round eight"), str("https://example.invalid/c"), counters]).toString("base64");
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.includes("registry.npmjs.org")) return json({ version: "0.0.1" });
  if (target.includes("r8-rpc.invalid")) {
    let body = {};
    try { body = JSON.parse(String(init.body ?? "{}")); } catch { /* answered as an error below */ }
    if (body.method === "getAccountInfo") return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1000 }, value: { owner: CORE, data: [COLLECTION_B64, "base64"] } } });
    return json({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32601, message: `round-eight preload does not serve ${body.method}` } });
  }
  if (target.includes("magiceden.dev")) {
    // A quiet wallet: no activity, no tokens.
    if (target.includes("/wallets/")) return json([]);
    if (target.includes("/collections/r8-fixture/listings")) {
      // One short page: the venue reports the end of the book.
      return json(target.includes("offset=0") || !target.includes("offset=") ? listings : []);
    }
    if (target.includes("/collections/r8-fixture/stats")) return json({ symbol: "r8-fixture", floorPrice: 100_000_000, listedCount: 3, volumeAll: 1 });
    if (target.includes("/collections/r8-fixture/attributes")) return json({ results: { availableAttributes: [] } });
    if (target.includes("/collections/r8-fixture")) return json({ symbol: "r8-fixture", name: "Round eight fixture" });
  }
  return json({ message: `refused by the round-eight preload: ${target.slice(0, 80)}` }, 404);
};
