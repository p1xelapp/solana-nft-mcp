/**
 * Builds the one-click install bundle for Claude Desktop (an .mcpb file).
 *
 * A user who cannot edit a JSON config drags the bundle onto Claude Desktop's
 * Settings > Extensions page instead (double-clicking does not open it). It
 * carries the built server, the collection snapshot, production dependencies
 * and a manifest; Claude Desktop reads the manifest and registers the server.
 *
 *   npm run build && node scripts/bundle-mcpb.mjs
 *   -> .release/solana-nft-mcp-<version>.mcpb
 *
 * Needs the mcpb CLI once: npm install -g @anthropic-ai/mcpb
 */
import { npmSync, mcpbSync } from "./npm-cli.mjs";
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
const out = path.join(root, ".release", `solana-nft-mcp-${pkg.version}.mcpb`);

if (!existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing: run `npm run build` first");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// The lockfile and .npmrc travel with the stage so the install below is the
// TESTED tree: `npm install` without them resolved every production range
// again, and a bundle could carry versions CI never ran.
for (const f of ["dist", "data", "LICENSE", "README.md", "package.json"]) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
cpSync(path.join(root, "package-lock.json"), path.join(stage, "package-lock.json"));
cpSync(path.join(root, ".npmrc"), path.join(stage, ".npmrc"));
cpSync(path.join(root, "assets", "icon-512.png"), path.join(stage, "icon.png"));

// Production dependencies only, from the lockfile, no lifecycle scripts:
// `npm ci` refuses to run when package.json and the lock disagree, which is
// the check that the bundle carries what the suite tested.
// No shell on any platform: npm runs as its own JavaScript entry under this
// node binary (see scripts/npm-cli.mjs), so nothing here is parsed by cmd.exe.
npmSync(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "ignore" });
// Prove it: every production dependency in the staged tree is at the version
// the root lock names. A mismatch here is a build bug, not a warning.
{
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const drift = [];
  for (const [p, entry] of Object.entries(lock.packages ?? {})) {
    if (!p.startsWith("node_modules/") || entry.dev) continue;
    const staged = path.join(stage, p, "package.json");
    if (!existsSync(staged)) {
      drift.push(`${p}: missing from the stage`);
      continue;
    }
    const v = JSON.parse(readFileSync(staged, "utf8")).version;
    if (v !== entry.version) drift.push(`${p}: lock ${entry.version}, staged ${v}`);
  }
  if (drift.length) {
    console.error("staged dependencies differ from package-lock.json:\n  " + drift.join("\n  "));
    process.exit(1);
  }
}
// The lock and .npmrc did their job; they are not part of what ships.
rmSync(path.join(stage, "package-lock.json"), { force: true });
rmSync(path.join(stage, ".npmrc"), { force: true });

const manifest = {
  manifest_version: "0.2",
  name: "solana-nft-mcp",
  display_name: "solana-nft-mcp",
  version: pkg.version,
  description: "Solana collectibles for your AI: ownership history, custody rules, floors, sales and deals. No sign-up, read-only, runs on your machine.",
  long_description:
    "Ask your AI about any Solana collectible and get the answer from the chain: who owned it, who can still freeze or burn it, " +
    "what actually sold, and where the deals are. It decodes Metaplex Core ownership history byte by byte, the history mainstream " +
    "NFT APIs hand back empty, and labels every number with its marketplace, its currency and the moment it was read, so nothing gets " +
    "compared that should not be. Builders get the same reads as typed results with the raw fields intact, ready for an agent " +
    "without writing a parser. 21 tools, no sign-up, no telemetry, and no signing code exists in it, so it cannot touch your wallet. The one file it may write is a free OpenSea key in your home folder, and that can be switched off.",
  author: { name: "p1xel", url: "https://p1xel.app" },
  homepage: "https://p1xel.app/solana-nft-mcp/",
  documentation: "https://github.com/p1xelapp/solana-nft-mcp#readme",
  support: "https://github.com/p1xelapp/solana-nft-mcp/issues",
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
    { name: "get_collection_holders", description: "Every item in a collection and who holds it, listed or not" },
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
mcpbSync(["validate", path.join(stage, "manifest.json")], { stdio: "inherit" });
mcpbSync(["pack", stage, out], { stdio: "inherit" });
console.log(`\nbundle: ${path.relative(root, out)} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
