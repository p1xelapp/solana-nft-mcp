/**
 * Preloaded into a child server (node --import) for the answer-size test.
 *
 * Magic Eden answers the token read with an image URL of about 130,000
 * characters, the chain says the account does not exist, and the asset index
 * declines the method. A private SOLANA_RPC_URL is set whose key is echoed
 * back inside a JSON-RPC error, so the same server proves the credential
 * never reaches the answer. The home folder is redirected so nothing here
 * can touch a real key file.
 */
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.SOLANA_NFT_MCP_TEST_HOME;
if (!home) throw new Error("SOLANA_NFT_MCP_TEST_HOME is required so the test cannot touch the real key file");
os.homedir = () => home;
syncBuiltinESMExports();

const canary = process.env.SOLANA_NFT_MCP_TEST_CANARY;
if (!canary) throw new Error("SOLANA_NFT_MCP_TEST_CANARY is required");
const mint = "11111111111111111111111111111111";
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "registry.npmjs.org") return json({ "dist-tags": { latest: "0.0.0" } });
  if (u.hostname === "api-mainnet.magiceden.dev" && u.pathname === `/v2/tokens/${mint}`) {
    return json({ mintAddress: mint, name: "Synthetic asset", owner: mint, collection: "synthetic", image: "https://image.invalid/" + "z".repeat(130_000), attributes: [], price: 1 });
  }
  if (init.method === "POST") {
    const req = JSON.parse(String(init.body));
    if (Array.isArray(req)) return json(req.map((r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "getHealth" ? "ok" : 1000 })));
    if (u.hostname === "private-rpc.invalid") return json({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `authentication rejected credential ${canary}` } });
    if (req.method === "getAsset") return json({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method unsupported" } });
    if (req.method === "getAccountInfo") return json({ jsonrpc: "2.0", id: req.id, result: { context: { slot: 1000 }, value: null } });
  }
  throw new Error(`network denied by the fixture: ${u.hostname}${u.pathname}`);
};
