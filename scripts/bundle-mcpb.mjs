/**
 * Builds the one-click install bundle for Claude Desktop (an .mcpb file).
 *
 * A user who cannot edit a JSON config double-clicks the bundle instead. It
 * carries the built server, the collection snapshot, production dependencies
 * and a manifest; Claude Desktop reads the manifest and registers the server.
 *
 *   npm run build && node scripts/bundle-mcpb.mjs
 *   -> .release/collector-mcp-<version>.mcpb
 *
 * Needs the mcpb CLI once: npm install -g @anthropic-ai/mcpb
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The prompt bodies come from the same module the server registers them from,
// so the manifest cannot drift from what the server actually returns. It has
// no side effects, unlike the server entry.
import { PROMPT_TEXTS, PROMPT_LIST } from "../dist/prompts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const stage = path.join(root, ".release", "mcpb");
const out = path.join(root, ".release", `collector-mcp-${pkg.version}.mcpb`);

if (!existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing: run `npm run build` first");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["dist", "data", "LICENSE", "README.md", "package.json"]) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
cpSync(path.join(root, "assets", "icon-512.png"), path.join(stage, "icon.png"));

// Production dependencies only, no lifecycle scripts: the bundle must carry
// exactly what `npm install collector-mcp` would give a user, nothing else.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "ignore", shell: process.platform === "win32" });

const manifest = {
  manifest_version: "0.2",
  name: "collector-mcp",
  display_name: "collector-mcp",
  version: pkg.version,
  description: "Solana collectibles for your AI: ownership history, custody rules, floors, sales and deals. No sign-up, read-only, runs on your machine.",
  long_description:
    "Ask your AI about any Solana collectible and get the answer from the chain: who owned it, who can still freeze or burn it, " +
    "what actually sold, and where the deals are. It decodes Metaplex Core ownership history byte by byte, the history mainstream " +
    "NFT APIs hand back empty, and labels every number with its venue, its currency and the moment it was read, so nothing gets " +
    "compared that should not be. Builders get the same reads as typed results with the raw fields intact, ready for an agent " +
    "without writing a parser. 20 tools, no sign-up, nothing collected, and no signing code exists in it, so it cannot touch your wallet.",
  author: { name: "p1xel", url: "https://p1xel.app" },
  homepage: "https://p1xel.app/collector-mcp/",
  documentation: "https://github.com/p1xelapp/collector-mcp#readme",
  support: "https://github.com/p1xelapp/collector-mcp/issues",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: { command: "node", args: ["${__dirname}/dist/index.js"] },
  },
  tools: [
    { name: "identify", description: "What is this address or name" },
    { name: "get_asset_provenance", description: "Who owned it, from the chain, back to the mint" },
    { name: "get_asset_trust", description: "Who can freeze or burn it" },
    { name: "find_listings", description: "Cheapest listings, deals, low serials, trait floors" },
    { name: "find_in_group", description: "Hunt one edition number across a whole family of collections" },
    { name: "get_collection_sales", description: "What sold, for how much, by name" },
    { name: "get_wallet_profile", description: "What a wallet holds and how it trades" },
  ],
  tools_generated: true,
  // A bundled extension may only use prompts the manifest DECLARES, and the
  // client compares the text each one returns against the text declared here.
  // An undeclared prompt logs "attempted undeclared prompt" and a mismatched
  // one logs "content validation failed. Rejecting response to prevent
  // potential prompt injection" - both of which reach the person as nothing
  // more than "Failed to attach prompt". Built from the server's own words.
  prompts: PROMPT_LIST.map(([name, , description]) => ({ name, description, arguments: [], text: PROMPT_TEXTS[name] })),
  keywords: ["solana", "nft", "collectibles", "candy digital", "magic eden", "opensea", "metaplex core"],
  license: "MIT",
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=22.0.0" } },
};
writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

rmSync(out, { force: true });
const mcpb = process.platform === "win32" ? "mcpb.cmd" : "mcpb";
execFileSync(mcpb, ["validate", path.join(stage, "manifest.json")], { stdio: "inherit", shell: process.platform === "win32" });
execFileSync(mcpb, ["pack", stage, out], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`\nbundle: ${path.relative(root, out)} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
