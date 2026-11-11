/**
 * Settings as a host hands them over, made into the shape the rest of the
 * server reads.
 *
 * A desktop bundle fills these from a settings dialog, and a dialog does not
 * speak the way a shell does. A switch arrives as the word "true" where the
 * documented value is "1". A text box left empty arrives as an empty string,
 * or, in a host that substitutes nothing for a missing value, as the literal
 * placeholder "${user_config.opensea_api_key}". Read as written, an empty key
 * is a key that fails on every call, and a placeholder is a URL that parses.
 *
 * Imported for its effect, before anything reads the environment.
 */
const SWITCHES = ["SOLANA_NFT_MCP_NO_AUTO_KEYS", "SOLANA_NFT_MCP_NO_UPDATE_CHECK", "SOLANA_NFT_MCP_LOG", "SOLANA_NFT_MCP_OFFLINE"] as const;
const TEXT = ["OPENSEA_API_KEY", "SOLANA_RPC_URL", "DAS_RPC_URL"] as const;

export function normaliseEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of [...SWITCHES, ...TEXT]) {
    const v = env[name];
    if (v === undefined) continue;
    const t = v.trim();
    if (t === "" || t.includes("${")) delete env[name];
  }
  for (const name of SWITCHES) {
    const v = env[name]?.trim().toLowerCase();
    if (v === undefined) continue;
    if (v === "true" || v === "yes" || v === "on") env[name] = "1";
    else if (v === "false" || v === "no" || v === "off" || v === "0") delete env[name];
  }
}

normaliseEnv();
