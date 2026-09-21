/**
 * Runs npm, and the mcpb CLI, without a shell on any platform.
 *
 * `shell: true` on win32 made every child call emit DEP0190 ("passing args
 * to a child process with shell option true can lead to security
 * vulnerabilities"), and it means the arguments are parsed by cmd.exe rather
 * than passed through. Both tools are JavaScript, so the fix is to run their
 * own entry point with this process's node binary, which needs no shell
 * anywhere. `npm.cmd` is the last resort: a .cmd file cannot be spawned
 * without a shell at all on current Node, so if it is all we have the caller
 * is told so rather than handed a shell.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Where npm's JavaScript entry lives, or the .cmd shim when nothing better exists. */
export function resolveNpm() {
  try {
    return { file: process.execPath, lead: [createRequire(import.meta.url).resolve("npm/bin/npm-cli.js")] };
  } catch {
    // npm is not a resolvable dependency of this project - normal.
  }
  // The npm that ships with this very node binary, next to it on disk.
  for (const guess of [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (existsSync(guess)) return { file: process.execPath, lead: [guess] };
  }
  if (process.platform !== "win32") return { file: "npm", lead: [] };
  const found = execFileSync("where", ["npm"], { encoding: "utf8", shell: false })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const cmd = found.find((p) => p.toLowerCase().endsWith(".cmd")) ?? found[0];
  if (!cmd) throw new Error("npm could not be located: neither npm-cli.js nor npm.cmd was found");
  return { file: cmd, lead: [] };
}

const NPM = resolveNpm();

/** Every npm call goes through here: one place, no shell, ever. */
export const npmSync = (args, opts = {}) => execFileSync(NPM.file, [...NPM.lead, ...args], { ...opts, shell: false });

/** True when npm can be run without a shell on this machine. */
export const npmIsShellFree = () => NPM.file === process.execPath || process.platform !== "win32";

/**
 * The mcpb CLI's JavaScript entry, found through npm's global root so it runs
 * with this node binary and no shell. Installed once with
 * `npm install -g @anthropic-ai/mcpb`.
 */
export function resolveMcpb() {
  const globalRoot = npmSync(["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const pkgDir = path.join(globalRoot, "@anthropic-ai", "mcpb");
  if (!existsSync(path.join(pkgDir, "package.json"))) {
    throw new Error("the mcpb CLI is not installed: run `npm install -g @anthropic-ai/mcpb` once");
  }
  const bin = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1]).bin))", path.join(pkgDir, "package.json")], { encoding: "utf8" }));
  const rel = typeof bin === "string" ? bin : (bin?.mcpb ?? Object.values(bin ?? {})[0]);
  if (!rel) throw new Error("the mcpb package names no binary in its package.json");
  return { file: process.execPath, lead: [path.join(pkgDir, rel)] };
}

/** Run the mcpb CLI with the given arguments, no shell. */
export const mcpbSync = (args, opts = {}) => {
  const m = resolveMcpb();
  return execFileSync(m.file, [...m.lead, ...args], { ...opts, shell: false });
};
