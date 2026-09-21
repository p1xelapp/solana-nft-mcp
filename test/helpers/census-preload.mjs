/**
 * Preloaded into a child server (node --import) for the collection census
 * tests. The asset index is a synthetic DAS at DAS_RPC_URL, keyed by the
 * collection address asked for; every other upstream is refused. The home
 * folder is redirected so nothing here can touch a real key file, and every
 * JSON-RPC method the server sends is appended to SOLANA_NFT_MCP_TEST_LOG, so a
 * test can prove a request was NOT made.
 */
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real key file");
os.homedir = () => home;
syncBuiltinESMExports();
const log = process.env.SOLANA_NFT_MCP_TEST_LOG;

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
  return digits.reverse().map((d) => ALPHABET[d]).join("");
}
export const address = (label) => base58(createHash("sha256").update(label).digest());
const col = (label) => address(`census-collection-${label}`);
const ownerA = address("census-owner-a");
const ownerB = address("census-owner-b");
const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";

const asset = (label, collection, owner = ownerA, extra = {}) => ({
  id: address(`census-asset-${label}`),
  interface: "MplCoreAsset",
  grouping: [{ group_key: "collection", group_value: collection, verified: true }],
  ownership: { owner },
  content: { metadata: { name: `Pack ${label}`, attributes: [{ trait_type: "Item Type", value: "Pack" }] } },
  ...extra,
});
const meta = (name, attributes) => ({ content: { metadata: { name, attributes } } });

/** Pages per collection, in the order the index serves them. */
const cases = new Map();
cases.set(col("cap-short"), [[asset("cap-1", col("cap-short")), asset("cap-2", col("cap-short")), asset("cap-3", col("cap-short"))]]);
cases.set(col("cap-filter"), [[asset("filter-card", col("cap-filter"), ownerA, meta("Card", [{ trait_type: "Item Type", value: "Card" }])), asset("filter-pack", col("cap-filter"), ownerB)]]);
const first = Array.from({ length: 1000 }, (_, i) => asset(`dup-${i}`, col("duplicate")));
cases.set(col("duplicate"), [first, [asset("dup-0", col("duplicate")), asset("dup-1000", col("duplicate"), ownerB)]]);
cases.set(col("conflict"), [
  Array.from({ length: 1000 }, (_, i) => asset(`con-${i}`, col("conflict"))),
  [asset("con-0", col("conflict"), ownerB)],
]);
cases.set(col("wrong-group"), [[asset("foreign", col("some-other-collection"))]]);
cases.set(col("unverified"), [[asset("unverified", col("unverified"), ownerA, { grouping: [{ group_key: "collection", group_value: col("unverified"), verified: false }] })]]);
cases.set(col("non-core"), [[asset("legacy", col("non-core"), ownerA, { interface: "V1_NFT" })]]);
cases.set(col("duplicate-trait"), [[
  asset("dt", col("duplicate-trait"), ownerA, meta("Pack dt", [{ trait_type: "Item Type", value: "Card" }, { trait_type: "Item Type", value: "Pack" }])),
]]);
cases.set(col("trait-tail"), [[
  asset("tail", col("trait-tail"), ownerA, meta("Pack tail", [...Array.from({ length: 64 }, () => ({ trait_type: "", value: "" })), { trait_type: "Item Type", value: "Pack" }])),
]]);
cases.set(col("clipped"), [[asset("clip", col("clipped"), ownerA, meta("Pack clip", [{ trait_type: "Edition", value: "P".repeat(128) + "X" }]))]]);
cases.set(col("burnt"), [[asset("burnt", col("burnt"), ownerA, { burnt: true })]]);
cases.set(col("bad-id"), [[{ id: "bad-id", interface: "MplCoreAsset", grouping: [{ group_key: "collection", group_value: col("bad-id"), verified: true }], ownership: { owner: ownerA } }, asset("good", col("bad-id"))]]);
cases.set(col("big"), [
  Array.from({ length: 1000 }, (_, i) => asset(`big-${i}`, col("big"), address(`big-owner-${i}`))),
  Array.from({ length: 1000 }, (_, i) => asset(`big-${1000 + i}`, col("big"), address(`big-owner-${1000 + i}`))),
]);
cases.set(col("half"), [[asset("half", col("half"))]]);

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.includes("registry.npmjs.org")) return json({ "dist-tags": { latest: "0.0.0" } });
  if (!target.startsWith(process.env.DAS_RPC_URL)) throw new Error(`network denied by the census fixture: ${target.slice(0, 80)}`);
  const body = JSON.parse(String(init.body ?? "{}"));
  if (log) fs.appendFileSync(log, `${body.method}\n`);
  if (body.method === "getAsset") {
    if (body.params?.id === CANARY) return json({ jsonrpc: "2.0", id: body.id, result: { id: CANARY, interface: "MplCoreCollection" } });
    return json({ jsonrpc: "2.0", id: body.id, result: null });
  }
  if (body.method === "getAssetsByGroup") {
    const pages = cases.get(body.params?.groupValue) ?? [[]];
    const items = pages[(body.params?.page ?? 1) - 1] ?? [];
    return json({ jsonrpc: "2.0", id: body.id, result: { items } });
  }
  return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method unsupported in the fixture" } });
};
