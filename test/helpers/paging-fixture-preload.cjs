/**
 * Preloaded into a child server (node --require) for the cancellation test.
 *
 * A synthetic Magic Eden that serves as many activity pages as it is asked
 * for, 100 ms apart, and logs every request with a timestamp to the file
 * named by SOLANA_NFT_MCP_TEST_FIXTURE_LOG. The test cancels the client's call
 * after the first page and reads the log to see whether the server kept
 * paging with nobody waiting. Real sockets are refused, so a request that
 * slipped past the stub fails loudly rather than reaching the venue.
 */
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");

const logFile = process.env.SOLANA_NFT_MCP_TEST_FIXTURE_LOG;
if (!logFile) throw new Error("SOLANA_NFT_MCP_TEST_FIXTURE_LOG is required");

net.Socket.prototype.connect = () => {
  throw new Error("network refused by the test fixture");
};
tls.connect = () => {
  throw new Error("network refused by the test fixture");
};

const log = (data) => fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...data })}\n`);
const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const MINT = "11111111111111111111111111111111";

globalThis.fetch = async (raw, options = {}) => {
  const url = new URL(String(raw));
  log({ event: "provider_call", path: url.pathname, offset: url.searchParams.get("offset") });
  if (url.pathname.endsWith("/stats")) return reply({ symbol: "mad_lads", floorPrice: 1e9, listedCount: 100, volumeAll: 10e9 });
  if (url.pathname.endsWith("/activities")) {
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = Math.floor(Date.now() / 1000) - 10;
    return reply(
      Array.from({ length: limit }, (_, i) => ({
        type: "buyNow",
        signature: `fixture-${offset + i}`,
        tokenMint: MINT,
        price: 1,
        blockTime: now,
        source: "fixture",
      })),
    );
  }
  if (url.pathname.includes("/collections/")) return reply({ symbol: "mad_lads", name: "Mad Lads" });
  if (url.hostname === "registry.npmjs.org") return reply({ version: "0.0.1" });
  let body = {};
  try {
    body = JSON.parse(options.body || "{}");
  } catch {
    /* answered generically below */
  }
  if (Array.isArray(body)) return reply([{ id: 1, result: "ok" }, { id: 2, result: 123 }]);
  return reply({ jsonrpc: "2.0", id: body.id || 1, result: [] });
};
