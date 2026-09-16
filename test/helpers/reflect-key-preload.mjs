/**
 * Preloaded into a child server (node --import) for the credential test.
 *
 * Every upstream is stubbed. OpenSea's key endpoint hands out a canary, and
 * every other OpenSea route answers 400 with the request's own key reflected
 * in the body, which is what a real upstream does when it echoes a bad
 * header. The server's home folder is redirected to a throwaway directory so
 * the canary is never written over the real key file of whoever runs the
 * suite. Nothing here reaches the network.
 */
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.COLLECTOR_TEST_HOME;
if (!home) throw new Error("COLLECTOR_TEST_HOME is required so the test cannot touch the real key file");
os.homedir = () => home;
syncBuiltinESMExports();

const canary = process.env.COLLECTOR_TEST_CANARY;
if (!canary) throw new Error("COLLECTOR_TEST_CANARY is required");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.endsWith("/auth/keys")) {
    return json({ api_key: canary, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  }
  if (target.includes("api.opensea.io")) {
    return json({ message: `bad request; header x-api-key was ${canary}` }, 400);
  }
  if (target.includes("magiceden.dev")) {
    return json({ symbol: "mad_lads", floorPrice: 1_000_000_000, listedCount: 1, volumeAll: 1 });
  }
  if (target.includes("registry.npmjs.org")) {
    return json({ version: "0.0.1" });
  }
  let request = {};
  try {
    request = JSON.parse(String(init.body ?? "{}"));
  } catch {
    /* not JSON: answered generically below */
  }
  if (Array.isArray(request)) {
    return json([{ id: 1, result: "ok" }, { id: 2, result: 123 }]);
  }
  return json({ jsonrpc: "2.0", id: request?.id ?? 1, result: { id: request?.params?.id ?? "unknown" } });
};
