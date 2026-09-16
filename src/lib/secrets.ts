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
 */

const secrets = new Set<string>();

/** Too short to be a credential, and long enough that redacting it would eat ordinary words. */
const MIN_SECRET_LENGTH = 8;

/** Remember a credential that is about to be sent somewhere. Idempotent. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH) return;
  secrets.add(v);
}

/** Replace every registered credential in `text` with a marker. Cheap when nothing is registered. */
export function redactSecrets(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** True when any registered credential appears in `text`. For the final gate at the tool boundary. */
export function containsSecret(text: string): boolean {
  if (secrets.size === 0 || !text) return false;
  for (const s of secrets) if (text.includes(s)) return true;
  return false;
}

/** Test seam. Forget everything, so one suite's canary cannot mask another's. */
export function resetSecrets(): void {
  secrets.clear();
}
