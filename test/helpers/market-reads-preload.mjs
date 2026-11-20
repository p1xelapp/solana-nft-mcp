import { readFileSync } from "node:fs";

export const reads = JSON.parse(readFileSync(new URL("../fixtures/market-reads-2026-11-19.json", import.meta.url)));
const accounts = reads.filter(r => r.method === "getMultipleAccounts");
const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
export let statsCalls = 0;
export function replay(url, init = {}) {
  const u = new URL(String(url));
  if (u.hostname === "api-mainnet.magiceden.dev") {
    if (u.pathname.endsWith("/stats")) {
      statsCalls++;
      return json((reads.find(r => r.url === u.href) ?? reads.find(r => r.url.endsWith("/stats"))).reply);
    }
    const record = reads.find(r => r.url === u.href);
    if (record) return json(record.reply);
  } else if (init.body) {
    const { method, params, id } = JSON.parse(init.body);
    if (method === "getMultipleAccounts") {
      const parts = params[0].map(address => {
        const r = accounts.find(r => r.params[0].includes(address) && r.params[1].dataSlice.length >= params[1].dataSlice.length);
        if (!r) throw Error("No captured account for this read");
        const value = r.reply.result.value[r.params[0].indexOf(address)];
        if (!value) return value;
        const bytes = Buffer.from(value.data[0], "base64").subarray(0, params[1].dataSlice.length);
        return { ...value, data: [bytes.toString("base64"), "base64"] };
      });
      return json({ ...accounts[0].reply, id, result: { ...accounts[0].reply.result, value: parts } });
    }
  }
  throw Error("No captured reply for this read");
}
globalThis.fetch = replay;
