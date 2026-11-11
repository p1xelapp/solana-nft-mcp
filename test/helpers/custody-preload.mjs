/**
 * Preloaded into a child server (node --import) for test/custody.mjs.
 *
 * One synthetic Metaplex Core collection whose Magic Eden book looks like
 * Candy's after its wallet migration: the cheapest listings name sellers who
 * no longer hold the item. The chain side answers getAccountInfo,
 * getMultipleAccounts (with dataSlice), the asset index methods and one
 * listing transaction; Magic Eden and OpenSea answer from tables below.
 * CUSTODY_PROFILE=rpc-down refuses getMultipleAccounts, so every custody read
 * comes back unread. The home folder is redirected and nothing reaches the
 * network.
 */
import os from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real profile");
os.homedir = () => home;
syncBuiltinESMExports();
const profile = process.env.CUSTODY_PROFILE || "normal";

const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function encode(b) { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n) { s = chars[Number(n % 58n)] + s; n /= 58n; } let z = 0; while (b[z] === 0) z++; return "1".repeat(z) + s; }
function decode(s) { let n = 0n; for (const c of s) n = n * 58n + BigInt(chars.indexOf(c)); return Buffer.from(n.toString(16).padStart(64, "0"), "hex"); }
const key = (label) => encode(createHash("sha256").update(`custody-${label}`).digest());

export const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export const SYSTEM = "11111111111111111111111111111111";
export const OPENSEA = "7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V";
export const ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix";
// Any program that is not Core stands in for a legacy token standard here.
const TOKEN_PROGRAM = key("token-program");
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const COL = key("collection");
export const S = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [i, key(`seller-${i}`)]));
export const MOVED_TO = key("new-wallet");
export const LISTING_ACCOUNT = key("opensea-listing-account");
// Another marketplace's program, by its real id: an item in an account of a
// program the server cannot name gets no verdict, so the fixture needs one it can.
export const OTHER_PROGRAM = "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN";
export const OTHER_PROGRAM_ACCOUNT = key("other-program-account");
export const M = Object.fromEntries(["A", "B", "C", "D", "E", "F", "G", "H", "N"].map((k) => [k, key(`mint-${k}`)]));
const LISTING_SIG = encode(createHash("sha512").update("custody-listing-tx").digest());

const str = (t) => { const b = Buffer.from(t); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const assetBytes = (owner, name) => Buffer.concat([Buffer.from([1]), decode(owner), Buffer.from([2]), decode(COL), str(name), str("https://example.invalid/item.json"), Buffer.from([0])]);
const counters = Buffer.alloc(8); counters.writeUInt32LE(9, 0); counters.writeUInt32LE(9, 4);
const collectionBytes = Buffer.concat([Buffer.from([5]), decode(S[7]), str("Custody fixture"), str("https://example.invalid/c"), counters]);

// Serial k is in the name, so the lowest-serial hunt sorts A first.
const items = {
  A: { owner: MOVED_TO, serial: 1, price: 0.1, seller: S[1], trait: "Gold" },
  B: { owner: LISTING_ACCOUNT, serial: 2, price: 0.12, seller: S[2], trait: "Gold" },
  C: { burned: true, serial: 3, price: 0.15, seller: S[3], trait: "Red" },
  D: { owner: ESCROW, serial: 4, price: 0.2, seller: S[4], trait: "Gold" },
  E: { owner: S[5], serial: 5, price: 0.25, seller: S[5], trait: "Red" },
  F: { notCore: true, serial: 6, price: 0.3, seller: S[6], trait: "Red" },
  G: { owner: OTHER_PROGRAM_ACCOUNT, serial: 7, price: 0.35, seller: S[7], trait: "Gold" },
  H: { owner: S[1], serial: 8, trait: "Gold" },
  N: { owner: S[5], serial: 9, trait: "Blue" },
};
const nameOf = (k) => `Card (${items[k].serial}/100)`;

function account(address) {
  for (const [k, it] of Object.entries(items)) {
    if (M[k] !== address) continue;
    if (it.burned) return { owner: CORE, data: Buffer.from([0]) };
    if (it.notCore) return { owner: TOKEN_PROGRAM, data: Buffer.alloc(82) };
    return { owner: CORE, data: assetBytes(it.owner, nameOf(k)) };
  }
  if (address === COL) return { owner: CORE, data: collectionBytes };
  if (address === LISTING_ACCOUNT) return { owner: OPENSEA, data: Buffer.alloc(317) };
  if (address === OTHER_PROGRAM_ACCOUNT) return { owner: OTHER_PROGRAM, data: Buffer.alloc(64) };
  if (address === OPENSEA) return { owner: LOADER, data: Buffer.alloc(36), executable: true };
  if (address === ESCROW) return { owner: "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", data: Buffer.alloc(8) };
  if ([...Object.values(S), MOVED_TO].includes(address)) return { owner: SYSTEM, data: Buffer.alloc(0) };
  return null;
}
const wire = (a, slice) => {
  if (!a) return null;
  const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
  return { owner: a.owner, data: [data.toString("base64"), "base64"], lamports: 1_000_000, executable: Boolean(a.executable), rentEpoch: 0 };
};

const dasOwner = { A: S[1], B: S[2], C: S[3], D: S[4], E: S[5], H: S[1], N: S[5] };
const dasAsset = (k) => ({
  id: M[k],
  interface: "MplCoreAsset",
  burnt: Boolean(items[k].burned),
  grouping: [{ group_key: "collection", group_value: COL, verified: true }],
  ownership: { owner: dasOwner[k] ?? null, frozen: false, delegated: false },
  content: { metadata: { name: nameOf(k), attributes: [{ trait_type: "Background", value: items[k].trait }] }, links: { image: `https://example.com/${k}.png` } },
  compression: { compressed: false },
});

function rpc(b) {
  const p = b.params;
  const ok = (result) => ({ jsonrpc: "2.0", id: b.id, result });
  switch (b.method) {
    case "getAccountInfo": return ok({ context: { slot: 1000 }, value: wire(account(p[0]), p[1]?.dataSlice) });
    case "getMultipleAccounts":
      if (profile === "rpc-down") return { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "custody fixture refuses getMultipleAccounts" } };
      return ok({ context: { slot: 1000 }, value: p[0].map((a) => wire(account(a), p[1]?.dataSlice)) });
    case "getSignaturesForAddress":
      return ok(p[0] === M.B && !p[1]?.before ? [{ signature: LISTING_SIG, slot: 990, blockTime: 1794256044, err: null }] : []);
    case "getTransaction":
      return ok(p[0] === LISTING_SIG
        ? { slot: 990, blockTime: 1794256044, meta: { err: null, logMessages: ["Program log: Instruction: TransferV1"], innerInstructions: [] },
            transaction: { message: { accountKeys: [], instructions: [
              { programId: OPENSEA, accounts: [S[2], LISTING_ACCOUNT, M.B], data: "3" },
              { programId: CORE, accounts: [M.B, COL, S[2], S[2], LISTING_ACCOUNT, SYSTEM, CORE], data: encode(Buffer.from([14, 0])) },
            ] } } }
        : null);
    case "getAsset": {
      const k = Object.keys(M).find((x) => M[x] === p.id);
      // The index's own capability probe asks for one fixed collection; every
      // other unknown id is not in the index.
      if (p.id === "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K") return ok({ id: p.id, interface: "MplCoreCollection", content: { metadata: { name: "probe" } } });
      return ok(k ? dasAsset(k) : null);
    }
    case "getAssetsByOwner":
      return ok({ total: 2, limit: p.limit ?? 1000, page: p.page ?? 1, items: (p.page ?? 1) === 1 && p.ownerAddress === S[1] ? [dasAsset("A"), dasAsset("H")] : [] });
    case "getAssetsByGroup": {
      const rows = ["A", "B", "D", "E"].map((k) => ({ ...dasAsset(k), ownership: { owner: items[k].owner, frozen: false, delegated: false } }));
      return ok({ total: rows.length, limit: p.limit ?? 1000, page: p.page ?? 1, items: (p.page ?? 1) === 1 ? rows : [] });
    }
    default: return { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: `custody fixture does not serve ${b.method}` } };
  }
}

const listing = (k) => ({ tokenMint: M[k], seller: items[k].seller, price: items[k].price, listingSource: "M2", token: { name: nameOf(k), attributes: [{ trait_type: "Background", value: items[k].trait }] } });
const meToken = (k, extra = {}) => ({ mintAddress: M[k], owner: items[k].seller ?? dasOwner[k], name: nameOf(k), collection: "custody-fixture", collectionName: "Custody fixture", image: `https://example.com/${k}.png`, attributes: [{ trait_type: "Background", value: items[k].trait }], listStatus: items[k].price ? "listed" : "unlisted", price: items[k].price ?? 0, ...extra });

function me(u) {
  const p = u.pathname;
  const off = Number(u.searchParams.get("offset") || 0);
  const sym = p.split("/")[3] || "";
  if (/^custody[-_]/.test(sym)) {
    if (p.endsWith("/stats")) return { symbol: sym, floorPrice: 100_000_000, listedCount: 7, volumeAll: 1 };
    if (p.endsWith("/listings")) return off === 0 ? ["A", "B", "C", "D", "E", "F", "G"].map(listing) : [];
    if (p.endsWith("/attributes")) return { results: { symbol: sym, availableAttributes: [
      { attribute: { trait_type: "Background", value: "Gold" }, count: 4, floor: 100_000_000 },
      { attribute: { trait_type: "Background", value: "Red" }, count: 3, floor: 150_000_000 },
    ] } };
    if (p.endsWith("/activities")) return [];
    return { symbol: sym, name: "Custody fixture" };
  }
  if (p.startsWith("/v2/tokens/")) {
    const k = Object.keys(M).find((x) => M[x] === p.split("/")[3]);
    if (!k) return {};
    // A new item: Magic Eden has no image and no traits for it yet.
    if (k === "N") return meToken("N", { image: "", attributes: [] });
    return meToken(k);
  }
  if (p.includes("/wallets/") && p.endsWith("/tokens")) return off === 0 && p.includes(S[1]) ? [meToken("A"), meToken("H")] : [];
  if (p.includes("/wallets/")) return [];
  return [];
}

function opensea(u) {
  const p = u.pathname;
  if (p.endsWith("/collections/custody-os/stats")) return { total: { floor_price: 0.112, floor_price_symbol: "SOL", volume: 1, volume_symbol: "SOL", sales: 1, num_owners: 5 } };
  if (p.endsWith("/listings/collection/custody-os/best")) {
    return { listings: [{ chain: "solana", asset: { identifier: M.A }, svm_order: { asset_id: M.A, maker: S[1] }, price: { current: { currency: "SOL", decimals: 9, value: "112000000" } }, status: "ACTIVE" }] };
  }
  if (p.endsWith("/collections/custody-os")) return { collection: "custody-os", name: "Custody fixture", contracts: [], total_supply: 9, fees: [] };
  if (p.includes("/floor_prices")) return { floor_prices: [] };
  if (p.endsWith("/holders")) return { holders: [] };
  return null;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname === "registry.npmjs.org") return json({ version: "0.0.1" });
  if (target.hostname === "custody-rpc.invalid") {
    const body = JSON.parse(String(init.body ?? "{}"));
    return json(Array.isArray(body) ? body.map(rpc) : rpc(body));
  }
  if (target.hostname.includes("magiceden")) return json(me(target));
  if (target.hostname.includes("opensea")) {
    const body = opensea(target);
    return body ? json(body) : json({ errors: ["not in the custody fixture"] }, 404);
  }
  return json({ message: `refused by the custody preload: ${target.hostname}` }, 404);
};
