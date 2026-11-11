/**
 * Preloaded into a child server (node --import) for test/wrong-input.mjs, and
 * imported by that test for the addresses it serves.
 *
 * Every upstream is answered here, keyed by address or symbol: a Core item
 * and its collection, a wallet, a token mint, a legacy NFT that sold and one
 * that did not, a compressed NFT with no account, an address nobody knows, a
 * public node that answers "internal error", an index record too big to read,
 * a marketplace that times out, and two readers that fail with long reasons.
 * Every URL asked for is appended to a log in the throwaway home folder so the
 * test can prove a link was never opened. Nothing here reaches the network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function encode(b) {
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  let z = 0;
  while (b[z] === 0) z++;
  return "1".repeat(z) + s;
}
function decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}
const id = (label) => encode(createHash("sha256").update(`wrong-input-${label}`).digest());

export const COL = id("collection");
export const ASSET = id("asset");
export const ESCROWED = id("escrowed");
export const WALLET = id("wallet");
export const OTHER = id("other");
export const TOKEN = id("token");
export const LEGACY = id("legacy");
export const LEGACY_QUIET = id("legacy-quiet");
export const CNFT = id("cnft");
export const MISSING = id("missing");
export const BUSY = id("busy");
export const OVERSIZE = id("oversize");
export const NOISY = id("noisy");
export const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export const ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix";
export const SALE_SIG = encode(createHash("sha512").update("wrong-input-sale").digest());
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (home) {
  os.homedir = () => home;
  syncBuiltinESMExports();
  const log = path.join(home, "fetches.txt");
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const str = (t) => { const b = Buffer.from(t); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const coreAsset = (owner, name) => Buffer.concat([Buffer.from([1]), decode(owner), Buffer.from([2]), decode(COL), str(name), str("https://example.invalid/item.json"), Buffer.from([0])]).toString("base64");
  const counts = Buffer.alloc(8); counts.writeUInt32LE(3, 0); counts.writeUInt32LE(3, 4);
  const coreCollection = Buffer.concat([Buffer.from([5]), decode(OTHER), str("Wrong Input Fixture"), str("https://example.invalid/c.json"), counts]).toString("base64");
  const mint = (decimals, supply) => { const b = Buffer.alloc(82); b.writeUInt32LE(1, 0); decode(OTHER).copy(b, 4); b.writeBigUInt64LE(BigInt(supply), 36); b[44] = decimals; b[45] = 1; return b.toString("base64"); };
  const accounts = {
    [ASSET]: { owner: CORE, data: coreAsset(WALLET, "Absolute Batman #1 (12/250)") },
    [ESCROWED]: { owner: CORE, data: coreAsset(ESCROW, "Absolute Batman #1 (13/250)") },
    [COL]: { owner: CORE, data: coreCollection },
    [WALLET]: { owner: SYSTEM, data: "" },
    [TOKEN]: { owner: TOKEN_PROGRAM, data: mint(6, 1_000_000_000) },
    [LEGACY]: { owner: TOKEN_PROGRAM, data: mint(0, 1) },
    [LEGACY_QUIET]: { owner: TOKEN_PROGRAM, data: mint(0, 1) },
    [CORE]: { owner: LOADER, data: "", executable: true },
  };
  const dasRecord = (assetId, iface, name, extra = {}) => ({
    id: assetId, interface: iface, content: { metadata: { name } }, ownership: { owner: WALLET }, compression: { compressed: false }, grouping: [], ...extra,
  });
  const dasAssets = {
    [CANARY]: { id: CANARY, interface: "MplCoreCollection", content: { metadata: { name: "canary" } } },
    [ASSET]: dasRecord(ASSET, "MplCoreAsset", "Absolute Batman #1 (12/250)", { grouping: [{ group_key: "collection", group_value: COL, verified: true }] }),
    [TOKEN]: dasRecord(TOKEN, "Custom", "Fixture Coin"),
    [LEGACY]: dasRecord(LEGACY, "V1_NFT", "Legacy Lad #1"),
    [LEGACY_QUIET]: dasRecord(LEGACY_QUIET, "V1_NFT", "Legacy Lad #2"),
    [CNFT]: dasRecord(CNFT, "V1_NFT", "Fixture cNFT", { compression: { compressed: true, tree: OTHER, leaf_id: 1 } }),
  };
  const groupRow = (i) => ({ ...dasRecord(id(`member-${i}`), "MplCoreAsset", `Member ${i}`), grouping: [{ group_key: "collection", group_value: COL, verified: true }] });
  function rpc(b) {
    const p = b.params;
    switch (b.method) {
      case "getHealth": return { jsonrpc: "2.0", id: b.id, result: "ok" };
      case "getSlot": return { jsonrpc: "2.0", id: b.id, result: 1000 };
      case "getAccountInfo": {
        if (p[0] === BUSY) return { jsonrpc: "2.0", id: b.id, error: { code: -32603, message: "Internal error" } };
        const a = accounts[p[0]];
        return { jsonrpc: "2.0", id: b.id, result: { context: { slot: 1000 }, value: a ? { owner: a.owner, data: [a.data, "base64"], lamports: 1_000_000, executable: a.executable === true } : null } };
      }
      case "getAsset": {
        if (p.id === NOISY) return { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: `index fixture refusal ${"q".repeat(260)} end of the index reason` } };
        // An unknown id gets the error the public index really sends; an empty
        // result would be an outage, not an answer.
        if (!dasAssets[p.id]) return { jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "Database Error: RecordNotFound Error: Asset not found" } };
        return { jsonrpc: "2.0", id: b.id, result: dasAssets[p.id] };
      }
      case "getAssetsByGroup": return { jsonrpc: "2.0", id: b.id, result: { total: p.groupValue === COL ? 3 : 0, items: p.groupValue === COL ? [0, 1, 2].map(groupRow) : [] } };
      case "getSignaturesForAddress": return { jsonrpc: "2.0", id: b.id, result: [] };
      default: return { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: `wrong-input preload does not serve ${b.method}` } };
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const listing = (serial, price) => ({ tokenMint: id(`listing-${serial}`), price, seller: OTHER, listingSource: "M2", token: { name: `Absolute Batman #1 (${serial}/810)`, attributes: [{ trait_type: "Name", value: "Absolute Batman" }] } });
  function me(u) {
    const p = u.pathname;
    const token = /^\/v2\/tokens\/([^/]+)(\/activities)?$/.exec(p);
    if (token) {
      const [, t, acts] = token;
      if (acts) {
        // A full first page of relists and the sale on the second page, the
        // way a listed item's feed reads on the venue.
        const offset = Number(u.searchParams.get("offset") ?? 0);
        if (t === LEGACY && offset === 0) return json(Array.from({ length: 100 }, (_, i) => ({ type: "list", signature: SALE_SIG.slice(0, 87), tokenMint: LEGACY, price: 7, blockTime: now - 60 - i })));
        if (t === LEGACY && offset === 100) return json([{ type: "buyNow", signature: SALE_SIG, tokenMint: LEGACY, price: 6.5, blockTime: now - 3600, buyer: WALLET, seller: OTHER, source: "magiceden_v2" }]);
        if (t === LEGACY_QUIET) return json([{ type: "list", signature: SALE_SIG.slice(0, 87), tokenMint: LEGACY_QUIET, price: 7, blockTime: now - 60 }]);
        return json([]);
      }
      if (t === ASSET) return json({ mintAddress: ASSET, owner: WALLET, name: "Absolute Batman #1 (12/250)", collection: "fixture_batman", listStatus: "unlisted" });
      if (t === LEGACY) return json({ mintAddress: LEGACY, owner: WALLET, name: "Legacy Lad #1", collection: "legacy_lads", listStatus: "unlisted" });
      if (t === NOISY) return json({ message: `marketplace fixture refusal ${"m".repeat(280)} end of the marketplace reason` }, 400);
      return json({});
    }
    const col = /^\/v2\/collections\/([^/]+)(?:\/([a-z_]+))?$/.exec(p);
    if (col) {
      const [, symbol, what] = col;
      if (symbol === "slowfixture") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const known = symbol === "fixture_batman" || symbol === "mad_lads";
      if (what === "stats") return json(known ? { symbol, floorPrice: 1_000_000_000, listedCount: 3, volumeAll: 10 } : { symbol, listedCount: 0 });
      if (what === "activities") return json([]);
      if (what === "listings") return json(symbol === "fixture_batman" && (u.searchParams.get("offset") ?? "0") === "0" ? [listing(5, 1), listing(13, 6), listing(213, 2)] : []);
      if (what === "attributes") return json({ results: { availableAttributes: [] } });
      if (!what) return known ? json({ symbol, name: symbol === "mad_lads" ? "Mad Lads" : "Fixture Batman" }) : json({ message: "not found" }, 404);
    }
    return json([]);
  }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    fs.appendFileSync(log, target + "\n");
    const u = new URL(target);
    if (u.hostname === "registry.npmjs.org") return json({ version: "0.0.1" });
    if (u.hostname.includes("magiceden")) return me(u);
    if (u.hostname.includes("opensea")) return json({ message: "not served" }, 404);
    if (init.method === "POST" && typeof init.body === "string") {
      const b = JSON.parse(init.body);
      if (!Array.isArray(b) && b.method === "getAsset" && b.params?.id === OVERSIZE) {
        // More than the 4 MB body limit, so the reader refuses it.
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { id: OVERSIZE, padding: "p".repeat(4_300_000) } }), { headers: { "content-type": "application/json" } });
      }
      return json(Array.isArray(b) ? b.map(rpc) : rpc(b));
    }
    return json({ message: `refused by the wrong-input preload: ${target.slice(0, 80)}` }, 404);
  };
}
