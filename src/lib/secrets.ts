/**
 * Every credential this process has ever sent, so none of them can come back.
 *
 * The redaction used to read `process.env.OPENSEA_API_KEY` and nothing else.
 * The key this server issues ITSELF lives in memory and on disk, never in the
 * environment, so an upstream error that reflected the request header carried
 * it straight into a `get_source_status` answer - a normal result, not even an
 * error. Reproduced 2026-09-15 with a mocked OpenSea 400 over real stdio.
 *
 * The rule is now: whatever is attached to a request is registered here first,
 * and every string that leaves this process for a model, a log or a client
 * passes through `redactSecrets`. Registration is one-way; a key that was ever
 * sent stays redacted for the life of the process, because a rotated key can
 * still be reflected by a slow upstream.
 *
 * Three spellings of every secret are looked for, not one. A second review
 * (2026-09-16) registered a key containing a double quote and watched it walk
 * through the result boundary: the boundary serialised first and searched
 * second, and JSON escaping had turned `"` into `\"` so the raw string was no
 * longer there. The same key percent-encoded in a URL would have passed too.
 * So the raw form, the JSON-escaped form and the URL-encoded form are all
 * registered, and the boundary redacts string LEAVES before it serialises
 * anything, with the serialised search kept as the last check.
 */

const secrets = new Map<string, string[]>();

/**
 * Too short to be a credential, and long enough that redacting it would eat
 * ordinary words. A caller that issues itself a shorter key than this has a
 * key nothing here will protect, and `registerSecret` returns false to say so.
 */
const MIN_SECRET_LENGTH = 8;

/** The spellings one secret can take inside text that leaves this process. */
function spellings(v: string): string[] {
  const out = new Set<string>([v]);
  // Inside a JSON string: quotes, backslashes and control characters escaped.
  out.add(JSON.stringify(v).slice(1, -1));
  // Inside a URL or a form body.
  try {
    out.add(encodeURIComponent(v));
  } catch {
    /* a lone surrogate cannot be encoded; the raw form still covers it */
  }
  return [...out];
}

/** Remember a credential that is about to be sent somewhere. Idempotent. False when it is too short to protect. */
export function registerSecret(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH) return false;
  if (!secrets.has(v)) secrets.set(v, spellings(v));
  return true;
}

/**
 * Register whatever a private endpoint URL carries as its credential.
 *
 * A private RPC puts its key in one of three places: the query string
 * (`?api-key=...`), a path segment (`/v2/<key>`, `/<token>/`), or the
 * userinfo (`https://user:pass@host`). The host itself is a label and is
 * never treated as a secret. Only the URL's credential parts are registered,
 * so an ordinary path like `/v2` or `/rpc` is not redacted from every answer.
 *
 * The round-four review (2026-09-16) mocked an RPC that reflected the
 * `api-key` query value inside a JSON-RPC error message; the message became
 * `sourceErrors["solana-rpc"]` on a SUCCESSFUL `get_asset` answer. The host-
 * only endpoint label had never been the leak; the upstream's own text was.
 * Returns how many parts were registered, for tests.
 */
export function registerUrlCredentials(url: string | null | undefined): number {
  if (typeof url !== "string" || !url.trim()) return 0;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 0;
  }
  let n = 0;
  const reg = (v: string) => {
    if (registerSecret(v)) n++;
    let decoded = v;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      /* not percent-encoded; the raw form is registered above */
    }
    if (decoded !== v && registerSecret(decoded)) n++;
  };
  if (u.username) reg(u.username);
  if (u.password) reg(u.password);
  for (const [, v] of u.searchParams) reg(v);
  // Path segments: a key is long and opaque, a version prefix is not. Sixteen
  // characters is under every provider token seen (UUIDs are 36, QuickNode
  // and Alchemy tokens 32+) and over any route word.
  for (const seg of u.pathname.split("/")) if (seg.length >= 16) reg(seg);
  return n;
}

/** Replace every registered credential, in any of its spellings, with a marker. Cheap when nothing is registered. */
export function redactSecrets(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  for (const forms of secrets.values()) {
    for (const s of forms) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** True when any registered credential, in any spelling, appears in `text`. */
export function containsSecret(text: string): boolean {
  if (secrets.size === 0 || !text) return false;
  for (const forms of secrets.values()) for (const s of forms) if (text.includes(s)) return true;
  return false;
}

/**
 * A copy of `value` with every string leaf redacted, before it is serialised.
 *
 * Serialising first and searching second is what let the quoted key through.
 * Walking the leaves finds the raw string where it actually lives. Arrays,
 * plain objects and strings are handled; anything else is returned as is.
 */
export function redactDeep<T>(value: T): T {
  if (secrets.size === 0) return value;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactSecrets(v);
    if (depth > 64 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[redactSecrets(k)] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

/** Test seam. Forget everything, so one suite's canary cannot mask another's. */
export function resetSecrets(): void {
  secrets.clear();
}
