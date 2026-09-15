/**
 * Read the manifest out of a built .mcpb and check the things that decide
 * whether it works once a person double-clicks it.
 *
 * The one that bites: Claude Desktop compares the text a prompt returns
 * against the text the manifest declares and refuses the whole attachment on
 * a mismatch, showing the person nothing but "Failed to attach prompt". A
 * single changed character is enough, so this compares them byte for byte
 * against the same module the server registers from.
 *
 * Usage: node scripts/verify-bundle.mjs [path-to.mcpb]   (default: newest)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pick = () => {
  const dir = join(root, ".release");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".mcpb"))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (files.length === 0) throw new Error("no .mcpb in .release - run node scripts/bundle-mcpb.mjs first");
  return files[0].f;
};

const bundle = process.argv[2] ? join(process.cwd(), process.argv[2]) : pick();
const work = mkdtempSync(join(tmpdir(), "mcpb-verify-"));
const asZip = join(work, "bundle.zip");
copyFileSync(bundle, asZip);
// Expand-Archive insists on the .zip extension, which is why the copy exists.
execFileSync("powershell", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", asZip, "-DestinationPath", work, "-Force"], { stdio: "pipe" });

const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { PROMPT_TEXTS, PROMPT_LIST } = await import(`file://${join(root, "dist", "prompts.js")}`);

const problems = [];
const check = (condition, what) => {
  console.log(`${condition ? "  ok  " : "FAIL  "}${what}`);
  if (!condition) problems.push(what);
};

console.log(`${bundle}\n`);
check(manifest.version === pkg.version, `manifest version ${manifest.version} matches package.json ${pkg.version}`);
check(manifest.manifest_version === "0.2", `manifest_version is 0.2, got ${manifest.manifest_version}`);
check(Boolean(manifest.icon) && readdirSync(work).includes(manifest.icon.split("/")[0]), `the icon it names (${manifest.icon}) is inside the bundle`);
check(manifest.prompts?.length === PROMPT_LIST.length, `declares ${PROMPT_LIST.length} prompts, found ${manifest.prompts?.length ?? 0}`);

for (const [name] of PROMPT_LIST) {
  const declared = manifest.prompts?.find((p) => p.name === name);
  if (!declared) {
    check(false, `${name} is declared at all - an undeclared prompt is refused outright`);
    continue;
  }
  check(declared.text === PROMPT_TEXTS[name], `${name}: declared text is byte-identical to what the server returns`);
  check((declared.arguments ?? []).length === 0, `${name}: declares no arguments, so no typed value can change the body`);
}

// A string naming a capability we removed is worse than no string: the model
// either fails the call or invents the contents.
const blob = JSON.stringify(manifest).toLowerCase();
for (const dead of ["collector://", "get_pack_pulls", "cryptoslam"]) {
  check(!blob.includes(dead), `no mention of ${dead}, which no longer exists`);
}

// The entry path is written against ${__dirname}, which is the unpacked
// bundle root, so the file it names has to be inside the bundle.
const entry = manifest.server?.mcp_config?.args?.find((a) => a.endsWith(".js"));
check(Boolean(entry), `names a server entry point (${entry ?? "none"})`);
const entryPath = join(work, (entry ?? "").replace("${__dirname}/", "").replaceAll("/", "\\"));
check(entry ? existsSync(entryPath) : false, "the entry point it names is inside the bundle");
check(existsSync(join(work, "node_modules")), "carries its dependencies, so it runs with no install step");
check(existsSync(join(work, "data", "me-collections.json.gz")), "carries the marketplace directory snapshot that name lookups need");

console.log(problems.length === 0 ? "\nbundle verified" : `\n${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
