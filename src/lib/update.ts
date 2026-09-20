/**
 * Is a newer collector-mcp published?
 *
 * A server that runs on someone else's machine has no way to tell them it has
 * fallen behind unless it checks. So it asks the npm registry once per process
 * for the latest published version, compares, and says so in one line on
 * stderr and in the status report. It never blocks a tool call, never touches
 * stdout, never asks more than once, and stays silent when it cannot reach
 * the registry: an update notice is a courtesy, not a dependency.
 *
 * Off switches: COLLECTOR_MCP_OFFLINE=1 (the offline test suite) and
 * COLLECTOR_MCP_NO_UPDATE_CHECK=1 (someone who does not want the request made).
 */

import { readBoundedJson } from "./http.js";
import { clean } from "./untrusted.js";

export interface UpdateInfo {
  /** The version this process is running. */
  current: string;
  /** Latest version on the registry, when the check ran and answered. */
  latest: string | null;
  /** True only when the registry's latest is newer than this one. */
  behind: boolean;
  /** Whether the registry was asked. */
  checked: boolean;
  /** Why it was not asked, or why the answer was unusable. */
  reason: string | null;
  /** What to run. Only present when behind. */
  howTo: string | null;
  checkedAt: string;
}

const REGISTRY = "https://registry.npmjs.org/collector-mcp/latest";
/** A complete semantic version, bounded: digits, dots, an optional short pre-release tag, nothing else. */
const SEMVER = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,32})?$/;
const HOW_TO = "git pull && npm install && npm run build (or npm i -g collector-mcp@latest if installed from npm), then restart your AI app";

/** Numeric semver compare on the dotted core only: 1 if a > b, -1 if a < b, 0 if equal or unreadable. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi > yi) return 1;
    if (xi < yi) return -1;
  }
  return 0;
}

let once: Promise<UpdateInfo> | null = null;

export function checkForUpdate(current: string, deps: { fetch?: typeof fetch } = {}): Promise<UpdateInfo> {
  if (once) return once;
  once = run(current, deps.fetch ?? fetch);
  return once;
}

/** Test seam: forget the cached answer. */
export function resetUpdateCheck(): void {
  once = null;
}

async function run(current: string, doFetch: typeof fetch): Promise<UpdateInfo> {
  const checkedAt = new Date().toISOString();
  const base: UpdateInfo = { current, latest: null, behind: false, checked: false, reason: null, howTo: null, checkedAt };
  if (process.env.COLLECTOR_MCP_OFFLINE === "1") return { ...base, reason: "offline mode" };
  if (process.env.COLLECTOR_MCP_NO_UPDATE_CHECK === "1") return { ...base, reason: "disabled by COLLECTOR_MCP_NO_UPDATE_CHECK" };
  try {
    const res = await doFetch(REGISTRY, {
      headers: { accept: "application/json", "user-agent": `collector-mcp/${current}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ...base, checked: true, reason: `registry answered HTTP ${res.status}` };
    }
    // Bounded like every other body. The registry is a fixed, trusted host,
    // but a proxy or a captive portal in front of it is not.
    const body = await readBoundedJson<{ version?: unknown }>(res, "the npm registry");
    // Only a complete, bounded semantic version is a version. Anything else
    // from the registry, or from whatever sits in front of it, is text: it
    // used to be printed into the startup line and the status answer as
    // served, and a proxy could put a fake message boundary there.
    const latest = typeof body.version === "string" && SEMVER.test(body.version) ? body.version : null;
    if (!latest) return { ...base, checked: true, reason: "registry answer carried no usable version" };
    const behind = compareVersions(latest, current) > 0;
    return { ...base, checked: true, latest, behind, howTo: behind ? HOW_TO : null };
  } catch (e) {
    // `JSON.parse` quotes part of the body it failed on, so this text is not
    // wholly ours when something sits between here and the registry.
    const why = clean(e instanceof Error ? e.message : String(e)).slice(0, 200);
    return { ...base, checked: true, reason: `registry not reachable (${why})` };
  }
}

/** The one line a person sees at startup, or null when there is nothing to say. */
export function updateNotice(u: UpdateInfo): string | null {
  if (!u.behind || !u.latest) return null;
  return `collector-mcp ${u.current} is behind: ${u.latest} is published. Update: ${u.howTo}`;
}
