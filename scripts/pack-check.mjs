/**
 * Tarball smoke test: does the package we are about to publish actually
 * contain the things it promises?
 *
 * The failure this exists to catch: `.npmrc` sets `ignore-scripts=true` for
 * supply-chain safety, and npm applies that to OUR OWN lifecycle scripts too.
 * In a fresh clone `dist/` does not exist, `prepare` never runs, and the
 * published package can ship with no `dist/index.js` at all - `npx
 * collector-mcp` then dies with MODULE_NOT_FOUND for everyone who installs it.
 *
 * So this asks npm exactly what would go into the tarball and fails unless the
 * two files the package cannot work without are in it: the entry point the
 * `bin` points at, and the bundled collection snapshot that makes name search
 * instant offline.
 *
 * Run before publishing:
 *   npm run build && node scripts/pack-check.mjs && npm publish --ignore-scripts=false
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// Every file the published package is useless without. The bin target first:
// that is the one an `ignore-scripts` publish silently drops.
const REQUIRED = [
  pkg.bin?.["collector-mcp"] ?? "dist/index.js",
  "data/me-collections.json.gz",
  "package.json",
  "README.md",
  "LICENSE",
];

console.log(`pack-check: ${pkg.name}@${pkg.version}`);

let out;
try {
  // --json gives the file list npm would actually publish, without publishing.
  out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
} catch (e) {
  console.error(`❌ npm pack --dry-run failed: ${e.stderr || e.message}`);
  process.exit(1);
}

let manifest;
try {
  // npm prints warnings before the JSON on some versions; take the array.
  const start = out.indexOf("[");
  manifest = JSON.parse(out.slice(start));
} catch {
  console.error("❌ could not parse `npm pack --dry-run --json` output:");
  console.error(out.slice(0, 1000));
  process.exit(1);
}

const entry = Array.isArray(manifest) ? manifest[0] : manifest;
const files = (entry?.files ?? []).map((f) => String(f.path).replace(/\\/g, "/"));
if (files.length === 0) {
  console.error("❌ the tarball would contain no files at all.");
  process.exit(1);
}

const missing = REQUIRED.filter((want) => !files.includes(want.replace(/\\/g, "/")));

console.log(`   ${files.length} files, ${entry.size ?? "?"} bytes packed, ${entry.unpackedSize ?? "?"} unpacked`);
for (const want of REQUIRED) {
  console.log(`   ${missing.includes(want) ? "MISSING" : "ok     "}  ${want}`);
}

if (missing.length > 0) {
  console.error(
    `\n❌ pack-check FAILED: ${missing.join(", ")} would not be published.\n` +
      `   Run \`npm run build\` first. Publishing with ignore-scripts=true does NOT build for you:\n` +
      `   npm run build && node scripts/pack-check.mjs && npm publish --ignore-scripts=false`,
  );
  process.exit(1);
}

console.log(`\n✅ pack-check passed: every required file is in the tarball.`);
process.exit(0);
