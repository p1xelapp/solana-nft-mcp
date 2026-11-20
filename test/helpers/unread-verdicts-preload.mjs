// Preloaded into a child server (node --import) for test/unread-is-not-a-verdict.mjs.
//
// Every reply is a captured real fixture from test/fixtures, a captured real
// account re-wrapped in a JSON-RPC envelope, or a derived copy with the
// changed fields named where it is built. Anything not routed fails like an
// outage. UNREAD_SCENARIO picks what fails, and when.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";

const R = new URL("../fixtures/", import.meta.url);
const folder = new URL("item-reads-2026-11-19/", R);
const sources = JSON.parse(fs.readFileSync(new URL("sources.json", folder), "utf8"));
const address = (name) => sources[name].params[0] ?? sources[name].params.id;
const fixture = (name) => {
  const bytes = fs.readFileSync(new URL(sources[name].file, folder));
  return sources[name].file.endsWith(".gz") ? gunzipSync(bytes).toString() : bytes.toString();
};
// Real oracle account bytes captured 2026-11-08, re-wrapped as a getAccountInfo reply.
const oracle = JSON.parse(fs.readFileSync(new URL("candy-oracle-2026-11-08.json", R), "utf8")).oracle;
const oracleReply = () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: oracle.slot }, value: { data: [oracle.data, "base64"], executable: false, lamports: 1461600, owner: oracle.owner, rentEpoch: 0, space: Buffer.from(oracle.data, "base64").length } } });

const scenario = process.env.UNREAD_SCENARIO ?? "";
// Some scenarios move the clock past a cache's lifetime after the first good
// read, then withhold the refresh.
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
let collectionReads = 0;
// Real 100-row getAssetsByGroup page for Absolute Batman #1, captured 2026-11-19.
const batman = JSON.parse(fs.readFileSync(new URL("reads-2026-11-19/batman-index.json", R), "utf8"));
const json = (body) => new Response(body, { headers: { "content-type": "application/json" } });
const down = (what) => {
  throw new Error(`fixture: ${what} unavailable`);
};

// Provenance replies captured 2026-11-14/15 (fresh, pinned walk) for a Candy card.
const PV = JSON.parse(fs.readFileSync(new URL("provenance-sales-2026-11-14.json", R), "utf8"));
const pvSaved = new Map(PV.calls.map((c) => [`${c.method}:${JSON.stringify(c.params[0])}`, c.reply]));
export const PROV_ITEM = "6F1bweAPCrVw89ViZWDWgh5Ppoxfcm5imLqfDWg2grLZ";
let provFirstWalkDone = false;
let rateLimitedOnce = false;

/** Magic Eden's real token record for another item, carried over to the burned one. */
function burnedItemMarketRow(listed) {
  const row = JSON.parse(fixture("market"));
  const t = row.result ?? row;
  // Derived: mintAddress set to the burned item; when listed, owner set to the
  // asset index's last holder, listStatus "listed" and price 12.5. Magic Eden
  // was seen keeping rows like this for burned items.
  t.mintAddress = address("burn");
  if (listed) {
    t.owner = "D3GQWXCTyGVDJzEMCBx4QrFT3ANrSELCa2mhJXcfBqdH";
    t.listStatus = "listed";
    t.price = 12.5;
  }
  return JSON.stringify(row);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!init.body) {
    const m = /\/v2\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
    if (url.hostname === "api-mainnet.magiceden.dev" && m) {
      if (m[1] === address("asset")) return json(fixture("market"));
      if (m[1] === address("burn") && scenario.startsWith("burn-")) return json(burnedItemMarketRow(true));
    }
    return down(`GET ${url.hostname}${url.pathname}`);
  }
  const body = JSON.parse(init.body);
  const { method, params } = body;
  if (scenario === "prov-stale") {
    const k = `${method}:${JSON.stringify(Array.isArray(params) ? params[0] : params)}`;
    if (provFirstWalkDone && (method === "getAccountInfo" || method === "getSignaturesForAddress") && params[0] === PROV_ITEM) return down(`${method} after the clock moved`);
    // The walk's last read is the owner-program batch: once it settles, the
    // clock moves past both lifetimes (account 60 s, list 120 s).
    if (method === "getMultipleAccounts" && !provFirstWalkDone) {
      setTimeout(() => {
        if (!provFirstWalkDone) {
          provFirstWalkDone = true;
          offset += 121_000;
        }
      }, 1500);
    }
    const r = pvSaved.get(k);
    if (r) return json(JSON.stringify(r));
    return down(k.slice(0, 80));
  }
  if (method === "getAsset") {
    if (params.id === sources.canary.params.id) return json(fixture("canary"));
    if (params.id === address("burn")) return json(fixture("burnDas"));
    if (params.id === address("group")) return json(fixture("groupDas"));
    // Real row 0 of the Batman page re-wrapped as a getAsset reply.
    if (params.id === batman.result.items[0].id && scenario === "index-only") return json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: batman.result.items[0] }));
    return down("getAsset " + params.id);
  }
  if (method === "getAccountInfo") {
    const a = params[0];
    // A public node's burst limit: one 429 with no pause named, then answers.
    if (a === address("asset") && scenario === "rate-limited-once" && !rateLimitedOnce) {
      rateLimitedOnce = true;
      return new Response("rate limited", { status: 429 });
    }
    // A slow node: the item's account answers after nine seconds.
    if (a === address("asset") && scenario === "slow-asset") await new Promise((r) => setTimeout(r, 9_000));
    if (a === address("asset")) return json(fixture("asset"));
    if (a === address("collection")) {
      if (scenario === "trust-collection-down") return down("collection account");
      if (scenario === "holders-stale-authority" && collectionReads++ > 0) return down("collection account refresh");
      if (scenario === "holders-stale-authority") setTimeout(() => (offset += 61_000), 300);
      return json(fixture("collection"));
    }
    if (a === oracle.address) return scenario === "trust-oracle-down" ? down("oracle account") : json(oracleReply());
    if (a === address("group")) return json(fixture("group"));
    if (a === address("burn")) return scenario === "burn-core-down" ? down("burned item's account") : json(fixture("burn"));
    return down("getAccountInfo " + a);
  }
  if (method === "getAssetsByGroup" && params.groupValue === address("collection")) {
    if (scenario === "holders-group-row") {
      // Derived: row 0's interface changed from MplCoreAsset to MplCoreGroup.
      const copy = structuredClone(batman);
      copy.result.items[0].interface = "MplCoreGroup";
      return json(JSON.stringify(copy));
    }
    if (scenario === "holders-stale-authority") {
      // Derived: rows 0 to 2 held by the collection's update authority (the
      // key the captured collection account names), as unsold stock is.
      const copy = structuredClone(batman);
      for (const row of copy.result.items.slice(0, 3)) row.ownership.owner = "7wixESeixiY4f2A6JaDKNewNoiip9Tk9s5u1dze7nRwL";
      return json(JSON.stringify(copy));
    }
    return json(JSON.stringify(batman));
  }
  return down(method);
};
