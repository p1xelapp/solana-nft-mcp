import fs from "node:fs";
import { gunzipSync } from "node:zlib";

const folder = new URL("../fixtures/item-reads-2026-11-19/", import.meta.url);
const sources = JSON.parse(fs.readFileSync(new URL("sources.json", folder)));
export const address = (name) => sources[name].params[0];
export function reply(name) {
  const bytes = fs.readFileSync(new URL(sources[name].file, folder));
  return sources[name].file.endsWith(".gz") ? gunzipSync(bytes).toString() : bytes.toString();
}

let withholdOwner = true;
let walletRead = false;
export const group = address("group");
export function allowOwner() { withholdOwner = false; }
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const respond = (name) => new Response(reply(name), { headers: { "content-type": "application/json" } });
  if (!init.body) {
    if (url.hostname === "api-mainnet.magiceden.dev" && (url.pathname.endsWith(address("asset")) || url.pathname.endsWith(address("usd")))) return respond("market");
    throw new Error("Marketplace read unavailable");
  }
  const { method, params } = JSON.parse(init.body);
  if (method === "getAsset" && params.id === group) return respond("groupDas");
  if (method === "getAsset" && params.id === address("zeroMint")) return respond("zeroDas");
  if (method === "getAsset" && params.id === address("liveMint")) return respond("liveDas");
  if (method === "getMultipleAccounts") {
    for (const name of ["walletSlices", "walletPrograms"]) {
      if (JSON.stringify(params[0]) !== JSON.stringify(sources[name].params[0])) continue;
      if (name === "walletSlices") {
        if (walletRead) throw new Error("Owner read unavailable");
        walletRead = true;
      }
      return respond(name);
    }
  }
  if (method === "getAsset" && params.id === sources.canary.params.id) return respond("canary");
  if (method === "getAsset" && params.id === sources.burnDas.params.id) return respond("burnDas");
  if (method === "getAccountInfo") {
    if (params[0] === group) return respond("group");
    for (const name of ["asset", "burn", "leaf", "tokenAccount", "usd", "legacy", "owner", "zeroMint", "liveMint"]) {
      if (params[0] !== address(name)) continue;
      if (name === "owner" && withholdOwner) throw new Error("Owner program read unavailable");
      return respond(name === "legacy" && params[1]?.dataSlice ? "legacyOwner" : name);
    }
  }
  if (method === "getAssetsByOwner" && params.ownerAddress === sources.wallet.params.ownerAddress) return respond("wallet");
  throw new Error("Requested source unavailable");
};
