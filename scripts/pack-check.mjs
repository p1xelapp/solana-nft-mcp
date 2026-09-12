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
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
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

console.log(`\n   file list ok. Installing the tarball and starting it...`);

/**
 * A file list is not a working package.
 *
 * "dist/index.js is in the tarball" says nothing about whether it RUNS: a
 * missing runtime dependency, a bad import path or an ESM/CJS mismatch all
 * ship a perfectly complete file list and then die with MODULE_NOT_FOUND on
 * the user's machine. So the tarball is installed into a throwaway directory
 * exactly as `npm i collector-mcp` would, and the installed binary is started
 * offline: the server prints its banner to stderr and is then killed. Reaching
 * the banner proves the entry point, its imports and its dependencies all
 * resolve from a clean install.
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), "collector-mcp-pack-"));
let startupOk = false;
let startupDetail = "";
let tarball;
try {
  // Pack for real this time - the dry run above produced no file.
  const packed = execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  tarball = path.join(root, String(JSON.parse(packed.slice(packed.indexOf("[")))[0].filename));
  execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "ignore", shell: process.platform === "win32" });
  // --ignore-scripts: installing a package here must never run its lifecycle
  // scripts. This check is about what the packed FILES do on their own.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: tmp, stdio: "ignore", shell: process.platform === "win32" });
  const installedBin = path.join(tmp, "node_modules", pkg.name, pkg.bin?.["collector-mcp"] ?? "dist/index.js");
  startupDetail = await new Promise((resolve) => {
    const child = spawn(process.execPath, [installedBin], {
      cwd: tmp,
      // Offline: a startup check must never depend on a venue being up, and
      // must never spend anybody's rate limit.
      env: { ...process.env, COLLECTOR_MCP_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let err = "";
    let out = "";
    const done = (detail) => {
      clearTimeout(timer);
      child.kill();
      resolve(detail);
    };
    const timer = setTimeout(() => done(`no banner on stderr within 10 s (stderr so far: ${err.slice(0, 200) || "nothing"})`), 10_000);
    child.stderr.on("data", (b) => {
      err += String(b);
      // The banner names the package and its version; anything less is not a
      // server that started.
      if (/collector-mcp v\d+\.\d+\.\d+ ready/.test(err)) {
        startupOk = true;
        done((err.split("\n").find((l) => l.includes("ready")) ?? "").trim());
      }
    });
    child.stdout.on("data", (b) => {
      out += String(b);
      // stdout IS the protocol channel. Anything printed there before a client
      // has said a word corrupts the stream for every user.
      if (out.trim()) done(`the installed server wrote to stdout at startup, which corrupts the MCP channel: ${out.slice(0, 200)}`);
    });
    child.on("error", (e) => done(`could not start the installed binary: ${e.message}`));
    child.on("exit", (code) => done(`the installed binary exited (code ${code}) before printing a banner. stderr: ${err.slice(0, 300) || "nothing"}`));
  });
} catch (e) {
  startupDetail = `install failed: ${String(e.stderr || e.message || e).slice(0, 300)}`;
} finally {
  // Best-effort, and never fatal. On Windows the just-killed child can still
  // hold a handle on its own directory for a moment; failing the release check
  // over a temp directory would be the check lying about the package.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    console.log(`   (note: ${tmp} could not be removed yet; it is a temp directory and the OS will clear it)`);
  }
  if (tarball) {
    try {
      rmSync(tarball, { force: true });
    } catch {
      /* leaving a tarball behind is not a failure of the package */
    }
  }
}

if (!startupOk) {
  console.error(`\n❌ pack-check FAILED: the packed tarball does not start from a clean install.\n   ${startupDetail}`);
  process.exit(1);
}
console.log(`   started from a clean install: ${startupDetail}`);

console.log(`\n✅ pack-check passed: every required file is in the tarball, and the installed package starts.`);
process.exit(0);
