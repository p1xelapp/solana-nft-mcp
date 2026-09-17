/**
 * Draws assets/architecture.svg from what the server actually exposes.
 *
 * The last diagram was drawn by hand. It claimed 8 tools, a resource and a
 * source that had been cut, and it said all three for months, because a picture
 * has nothing that fails when it stops being true. This one asks the built
 * server for its tool, prompt and resource lists over the protocol, and reads
 * the source rows out of the catalog that the server itself answers from.
 *
 *   node scripts/build-architecture.mjs          rewrite the SVG
 *   node scripts/build-architecture.mjs --check  exit 1 if it is out of date
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "assets", "architecture.svg");
const check = process.argv.includes("--check");

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing: run `npm run build` first");
  process.exit(1);
}

// ---------------------------------------------------------------- the facts
//
// The server is asked the same three questions a client asks, so the diagram
// can only ever show the surface a real client sees.
const env = {};
for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "COMSPEC"]) {
  if (process.env[k]) env[k] = process.env[k];
}
env.COLLECTOR_MCP_OFFLINE = "1";
env.COLLECTOR_MCP_NO_UPDATE_CHECK = "1";

const client = new Client({ name: "architecture-builder", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));

const tools = (await client.listTools()).tools;
const prompts = (await client.listPrompts()).prompts;
let resources = [];
try {
  resources = (await client.listResources()).resources;
} catch {
  // A server that publishes none may refuse the call outright. Both mean zero.
}
const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
await client.close();

const { SOURCES, WIRED_SOURCES } = await import(new URL("../dist/sources/catalog.js", import.meta.url).href);
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Tier 4 is the explorer links printed in an answer for a person to click. It
// is not a thing this server reads, so it is drawn as a footnote, not a row.
const byTier = new Map();
for (const s of WIRED_SOURCES) {
  if (s.tier >= 4) continue;
  if (!byTier.has(s.tier)) byTier.set(s.tier, []);
  byTier.get(s.tier).push(s);
}
const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]);
// The explorers are never called by this server. They are printed in an
// answer for a person to open, so they belong in the footnote, not a tier.
const linkOut = SOURCES.filter((s) => s.tier >= 4);

const TIER_LABEL = { 1: "chain truth", 2: "venue and index", 3: "optional" };
const TIER_COLOR = { 1: "#a78bfa", 2: "#22d3ee", 3: "#14f195" };

// ---------------------------------------------------------------- the drawing
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ROW_H = 26;
const TIER_PAD = 30;
const tierHeights = tiers.map(([, rows]) => TIER_PAD + rows.length * ROW_H + 10);
const rightH = tierHeights.reduce((a, b) => a + b + 12, 0);
const H = Math.max(430, rightH + 120);
const W = 1180;

let y = 78;
const tierBlocks = tiers
  .map(([tier, rows], i) => {
    const h = tierHeights[i];
    const top = y;
    y += h + 12;
    const color = TIER_COLOR[tier] ?? "#96a0bb";
    const items = rows
      .map((s, j) => {
        const ry = top + TIER_PAD + j * ROW_H + 4;
        const key = s.keyRequired
          ? `<text x="${W - 42}" y="${ry + 12}" text-anchor="end" font-size="10.5" fill="#f5c04a" font-family="'IBM Plex Mono',ui-monospace,monospace">key</text>`
          : `<text x="${W - 42}" y="${ry + 12}" text-anchor="end" font-size="10.5" fill="#5f6883" font-family="'IBM Plex Mono',ui-monospace,monospace">no key</text>`;
        return (
          `<circle cx="712" cy="${ry + 8}" r="3" fill="${color}"/>` +
          `<text x="726" y="${ry + 12}" font-size="12.5" fill="#dfe4f2">${esc(s.name)}</text>` +
          key
        );
      })
      .join("");
    return (
      `<rect x="694" y="${top}" width="${W - 694 - 24}" height="${h}" rx="12" fill="#0a0d16" stroke="${color}" stroke-opacity=".38"/>` +
      `<text x="712" y="${top + 20}" font-size="10.5" letter-spacing="1.4" fill="${color}" font-family="'IBM Plex Mono',ui-monospace,monospace">TIER ${tier} · ${esc(TIER_LABEL[tier] ?? "").toUpperCase()}</text>` +
      items
    );
  })
  .join("");

const midY = 150;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter,'Segoe UI',system-ui,sans-serif">
  <!-- Generated by scripts/build-architecture.mjs. Do not edit by hand: run the script. -->
  <defs>
    <linearGradient id="mcp" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#5f6883"/>
    </marker>
  </defs>

  <rect width="${W}" height="${H}" fill="#04050a"/>
  <text x="24" y="34" font-size="15" font-weight="700" fill="#f2f4fb">collector-mcp ${esc(version)}</text>
  <text x="24" y="52" font-size="11.5" fill="#5f6883">what runs where, and what it is allowed to do</text>

  <!-- the client -->
  <rect x="24" y="${midY - 44}" width="228" height="128" rx="14" fill="#0a0d16" stroke="#2c3550"/>
  <text x="44" y="${midY - 20}" font-size="10.5" letter-spacing="1.4" fill="#96a0bb" font-family="'IBM Plex Mono',ui-monospace,monospace">YOUR AI APP</text>
  <text x="44" y="${midY + 4}" font-size="13" fill="#dfe4f2">Claude Desktop, Claude Code,</text>
  <text x="44" y="${midY + 24}" font-size="13" fill="#dfe4f2">Codex CLI, Cursor, any</text>
  <text x="44" y="${midY + 44}" font-size="13" fill="#dfe4f2">MCP client</text>
  <text x="44" y="${midY + 68}" font-size="11" fill="#5f6883">Runs on your machine. Starts the server itself.</text>

  <line x1="252" y1="${midY + 20}" x2="316" y2="${midY + 20}" stroke="#5f6883" stroke-width="1.4" marker-end="url(#a)"/>
  <text x="284" y="${midY + 10}" text-anchor="middle" font-size="10" fill="#5f6883" font-family="'IBM Plex Mono',ui-monospace,monospace">stdio</text>
  <text x="284" y="${midY + 38}" text-anchor="middle" font-size="10" fill="#5f6883" font-family="'IBM Plex Mono',ui-monospace,monospace">JSON-RPC</text>

  <!-- the server -->
  <rect x="320" y="${midY - 64}" width="340" height="188" rx="14" fill="#070b16" stroke="url(#mcp)" stroke-width="1.6"/>
  <text x="344" y="${midY - 40}" font-size="10.5" letter-spacing="1.4" fill="#a78bfa" font-family="'IBM Plex Mono',ui-monospace,monospace">COLLECTOR-MCP</text>
  <text x="344" y="${midY - 16}" font-size="14.5" font-weight="600" fill="#f2f4fb">Runs on your machine</text>
  <text x="344" y="${midY + 8}" font-size="12.5" fill="#dfe4f2" font-family="'IBM Plex Mono',ui-monospace,monospace">${tools.length} tools · ${prompts.length} prompts · ${resources.length} resources</text>
  <text x="344" y="${midY + 30}" font-size="12" fill="#14f195">${readOnly} of ${tools.length} declare readOnlyHint</text>
  <text x="344" y="${midY + 54}" font-size="11.5" fill="#96a0bb">No signing code exists in it, so it cannot</text>
  <text x="344" y="${midY + 72}" font-size="11.5" fill="#96a0bb">buy, sell, list, transfer or touch a wallet.</text>
  <text x="344" y="${midY + 98}" font-size="11" fill="#5f6883">Answers carry the venue, the currency and the read time.</text>

  <line x1="660" y1="${midY + 20}" x2="690" y2="${midY + 20}" stroke="#5f6883" stroke-width="1.4" marker-end="url(#a)"/>

  <!-- the sources -->
  ${tierBlocks}

  <text x="24" y="${H - 44}" font-size="11" fill="#5f6883">A source marked <tspan fill="#f5c04a">key</tspan> needs one. The server asks OpenSea for a free key of its own on first need and keeps it on your machine.</text>
  <text x="24" y="${H - 26}" font-size="11" fill="#5f6883">Every item answer also links ${linkOut.map((s) => esc(s.name)).join(", ")} so you can check it without trusting this server.</text>
  <text x="${W - 24}" y="${H - 26}" text-anchor="end" font-size="10" fill="#2c3550" font-family="'IBM Plex Mono',ui-monospace,monospace">generated from the code</text>
</svg>
`;

if (check) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== svg) {
    console.error("assets/architecture.svg is out of date: run `node scripts/build-architecture.mjs`");
    process.exit(1);
  }
  console.log(`architecture.svg matches the server (${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources, ${WIRED_SOURCES.length} wired sources)`);
} else {
  writeFileSync(out, svg);
  console.log(`wrote assets/architecture.svg: ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources, ${tiers.length} tiers, ${WIRED_SOURCES.length} wired sources`);
}
