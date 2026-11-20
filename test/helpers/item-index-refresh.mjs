import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAsset } from "../../dist/sources/das.js";

const missing = "B5G7uZfyxKk7JCQXvCVExsbdqEXyUJQK9LKFofwS4B87";
const leaf = "GDEC7TRDAdU1BUhSSAK2WLc5DqLSCCcq6W2b7rVpfHcS";
const canary = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";
function capture(file) {
  const raw = readFileSync(new URL("../fixtures/" + file + ".json", import.meta.url), "utf8");
  return new Response(raw, { headers: { "content-type": "application/json" } });
}
let refreshing = false;
globalThis.fetch = async (_url, init) => {
  const { method, params } = JSON.parse(init.body);
  if (method === "getAsset" && params.id === canary) return capture("item-reads-2026-11-19/canary");
  if (method === "getAccountInfo" && params[0] === missing) return capture("item-index-refresh/account");
  if (method === "getAccountInfo" && params[0] === leaf) return capture("reads-2026-11-19/compressed-account");
  if (method === "getAsset") {
    if (refreshing && process.env.ITEM_REFRESH_UNAVAILABLE) throw new Error("Index read unavailable");
    if (params.id === missing) return capture("item-index-refresh/index");
    if (params.id === leaf) return capture("reads-2026-11-19/compressed-index");
  }
  throw new Error("No captured response for this read");
};
assert.equal((await getAsset(missing)).asset, null);
assert.ok((await getAsset(leaf)).asset);
const clock = Date.now;
Date.now = () => clock() + 61_000;
refreshing = true;
