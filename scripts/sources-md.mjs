/**
 * Render docs/SOURCES.md from the source catalog.
 *
 * The table is generated so the docs cannot drift from the code that calls the
 * sources - one fact, one place. The prose below the table lives here rather
 * than in the .md for the same reason: regenerating must never silently drop
 * it.
 *
 * Run: npm run build && node scripts/sources-md.mjs
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SOURCES } from "../dist/sources/catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "SOURCES.md");

const cell = (s) => String(s).replace(/\|/g, "\\|");
const list = (a) => cell(a.join("; "));
const link = (url, text) => (url ? `[${text}](${url})` : "-");

const keyCell = (s) => {
  if (s.keyRequired) return `yes - \`${s.keyEnvVar}\``;
  if (s.keyEnvVar) return `no (optional \`${s.keyEnvVar}\`)`;
  return "no";
};

const wiredCell = (s) => (s.wired ? "" : " *(not wired)*");

// Catalog order is already tier-ascending and, inside tier 1, the order the
// RPC endpoints are actually tried. Re-sorting would print a fallback chain
// out of the order it runs in.
const rows = SOURCES.map(
  (s) =>
    `| ${[
      s.tier,
      `**${cell(s.name)}**${wiredCell(s)}<br>\`${s.id}\` · ${s.kind}`,
      list(s.answers),
      keyCell(s),
      s.fallback ? `\`${s.fallback}\`` : "none",
      cell(s.retention),
      link(s.officialDocs, "docs"),
      link(s.statusPage, "status"),
    ].join(" | ")} |`,
);

const cannotSee = SOURCES.filter((s) => s.wired).map(
  (s) => `- **${s.name}** cannot see: ${s.cannotSee.join("; ")}.${s.note ? ` ${s.note}` : ""}`,
);

const verified = [...new Set(SOURCES.map((s) => s.lastVerified))].sort().join(", ");

const md = `# Sources

Generated from \`src/sources/catalog.ts\` by \`scripts/sources-md.mjs\` - edit the catalog, not this file.

Every row below was fetched and seen to answer on ${verified}. Tier 1 is an account read
straight from the chain and settles ownership. Tier 2 is somebody else's database - a
marketplace's view of the market, or an index's view of the chain, either of which can lag
it. Tier 3 is secondary or optional colour. Tier 4 is a link a person can open; this server
never reads it.

Listed in the order they are tried.

| Tier | Source | Answers | Key | Fallback | How far back | Docs | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## What each wired source cannot see

A healthy source still has a horizon. These are the gaps that stay gaps, and the reason
one venue's number is never presented as the market's.

${cannotSee.join("\n")}

## How a source is retired or added

1. **Catalog entry first.** A source that is not in \`src/sources/catalog.ts\` does not get
   called. The entry has to say what it answers, what it cannot see, who takes over when it
   stops answering, and how far back it keeps data - "unknown" where the vendor does not
   document it, never a guess.
2. **Live check.** Add it to \`test/live.mjs\` if it is keyless, or to \`test/smoke.mjs\` if
   it needs a key. The assertion names the source, because the only useful failure message
   is which venue moved.
3. **Fixture.** Capture one real response under \`test/fixtures/\` so \`test/protocol.mjs\`
   can keep proving the decode offline when the venue is down. Fixtures are public
   marketplace data and are allowlisted in \`.gitleaks.toml\`.
4. **CHANGELOG.** Adding or retiring a source changes what an answer means, so it is a
   user-visible change and gets an entry.

Retiring runs the same list backwards: mark \`wired: false\` and leave the row in place with
what it used to answer. A source that vanishes from the docs turns a known gap into a silent
one, and silence reads as coverage.

## How we notice change

- **Weekly live check.** \`.github/workflows/live-check.yml\` runs \`test/live.mjs\` every
  Monday with no secrets. It makes three real calls - one marketplace, one chain read, one
  routing call - and fails naming the source. Nothing in the repo changes between runs, so a
  red run is the outside world moving.
- **Shape guards.** Every array page from a source passes a guard before it is read. A
  non-array is an outage or an API change and is raised as one; it is never treated as "no
  more results". The same rule covers the JSON-RPC envelope: a reply with neither \`result\`
  nor \`error\` is a malformed answer, not an empty one.
- **RPC rotation is reported, not hidden.** When an endpoint fails, the next one is tried and
  the answer carries \`rpcEndpointUsed\` plus a note saying who was passed over. A degraded
  read never looks like a clean one.
- **The Core layout pin.** Ownership decoding depends on Metaplex Core discriminators
  (AssetV1 = 1, CollectionV1 = 5, TransferV1 = 14) and on \`new_owner\` sitting at index 4 of
  the TransferV1 account list. These are pinned in \`src/sources/solana.ts\`. If Core ships a
  layout change, the weekly check on a known minted asset is what catches it - the asset
  cannot stop existing, so a failure there is the layout, not the data.
- **Live status on demand.** \`get_source_status\` pings every wired source once and returns
  a plain line such as "3 of 4 sources answering; OpenSea off (no key)", so an agent can tell
  a user which venue is missing instead of reporting that the tool is broken.
`;

writeFileSync(out, md, "utf8");
console.log(`wrote ${out} (${SOURCES.length} sources)`);
