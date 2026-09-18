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
  // Inside a URL or a form body: upper-case escapes, lower-case escapes (a
  // provider that lower-cases %2F is still echoing the same key), and the
  // form spelling where a space is a plus.
  try {
    const enc = encodeURIComponent(v);
    out.add(enc);
    out.add(enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    out.add(enc.replace(/%20/g, "+"));
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
  // The RAW component is registered as written, as well as its decoded
  // value: `searchParams` decodes, and re-encoding it produced upper-case
  // escapes only, so a key the URL spelt with %2f or with + for a space was
  // never protected (2026-09-18).
  const reg = (raw: string) => {
    if (registerSecret(raw)) n++;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw.replace(/\+/g, "%20"));
    } catch {
      /* not percent-encoded; the raw form is registered above */
    }
    if (decoded !== raw && registerSecret(decoded)) n++;
  };
  if (u.username) reg(u.username);
  if (u.password) reg(u.password);
  // Query values: only fields whose NAME says credential. Registering every
  // long value turned `commitment=confirmed` into a secret and redacted the
  // word "confirmed" out of every answer.
  const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    if (value && CREDENTIAL_FIELD.test(decodeURIComponent(key.replace(/\+/g, " ")))) reg(value);
  }
  // Path segments: on a configured endpoint, every segment that is not a
  // route word is a credential. The earlier rule kept only a segment that
  // LOOKED like a token (twelve or more characters mixing letters and
  // digits), and a provider key made of letters only, of digits only, or of
  // eight characters was never registered: an upstream error that echoed the
  // URL then put it in a successful result (2026-09-18).
  // A route word is a known path component or a version tag; the rest is
  // registered in its raw and decoded spellings.
  for (const seg of u.pathname.split("/")) if (isPathCredential(seg)) reg(seg);
  return n;
}

/** Query field names that carry a credential, across the RPC providers seen. */
const CREDENTIAL_FIELD = /key|token|secret|auth|pass|access|credential|sig/i;

/** Path components RPC providers use as routes, never as credentials. Compared lower-case. */
const ROUTE_WORDS = new Set([
  "rpc", "api", "solana", "mainnet", "mainnet-beta", "solana-mainnet", "solana-mainnet-beta", "devnet", "testnet", "beta",
  "json", "jsonrpc", "json-rpc", "http", "https", "ws", "wss", "das", "node", "nodes", "public", "private", "endpoint",
  "endpoints", "sol", "health", "proxy", "rpc-proxy", "main", "net", "chain", "blockchain", "index", "query",
]);

/**
 * A path segment that carries a credential: anything on a configured
 * endpoint that is not a route word or a version tag and is at least eight
 * characters once separators are dropped. The length floor is what keeps a
 * short route word such as `main` from being redacted out of `mainnet` in
 * every answer; a shorter key on a path is the one shape still not covered,
 * and the README says so.
 */
function isPathCredential(seg: string): boolean {
  if (!seg) return false;
  const lower = seg.toLowerCase();
  if (ROUTE_WORDS.has(lower) || /^v\d{1,3}$/.test(lower)) return false;
  return seg.replace(/[-_.~%]/g, "").length >= 8;
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
