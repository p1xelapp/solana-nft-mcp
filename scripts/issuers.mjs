/**
 * Derive data/issuers.json from the chain: the update authority of every
 * collection in data/candy-collections.json, grouped by key.
 *
 *   npm run build && node scripts/issuers.mjs
 *
 * A Metaplex Core collection's update authority is the key that signs its
 * metadata and, in practice, its mints. A wallet that holds that key is the
 * collection authority. Ownership alone does not explain how an item arrived. The table is
 * a snapshot with a date; the tools also read the authority live for the
 * collection in front of them, so a new drop under the same key is recognised
 * without this file being regenerated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sol from "../dist/sources/solana.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(path.join(root, "data", "candy-collections.json"), "utf8"));
const list = Array.isArray(registry) ? registry : registry.collections;
// Names come only from the previous table. An authority it does not name
// stays unattributed: a change of key is not evidence of who holds the new one.
let prior = null;
try {
  prior = JSON.parse(readFileSync(path.join(root, "data", "issuers.json"), "utf8"));
} catch {
  /* no previous table: every authority is unattributed */
}
const priorRows = Array.isArray(prior?.issuers) ? prior.issuers : [];
const knownNames = new Map(priorRows.map((row) => [row.address, row.issuer]));
const byAuthority = new Map();
let read = 0;
// A public endpoint refuses some reads in any long run. The unread ones get
// two more passes after a pause, so a busy minute is not reported as
// collections the table could not see. A pass that reads nothing at all is
// an outage, not throttling, and ends the attempt.
let pending = list;
for (let pass = 0; pass < 3 && pending.length > 0; pass++) {
  if (pass > 0) await new Promise((r) => setTimeout(r, 20_000));
  const retry = [];
  let readThisPass = 0;
  for (const c of pending) {
    try {
      const raw = await sol.getCoreAccountRaw(c.address);
      const d = raw ? sol.decodeCoreAccount(raw) : null;
      if (!d || d.kind !== "collection") { retry.push(c); continue; }
      read++;
      readThisPass++;
      const entry = byAuthority.get(d.updateAuthority) ?? { address: d.updateAuthority, collections: 0, sample: [], addresses: [] };
      entry.collections++;
      entry.addresses.push(c.address);
      if (entry.sample.length < 3) entry.sample.push({ address: c.address, name: d.name });
      byAuthority.set(d.updateAuthority, entry);
    } catch {
      retry.push(c);
    }
  }
  pending = retry;
  if (readThisPass === 0) break;
}
const failed = pending.length;
// An outage must not replace the last good table with an empty one that
// carries a fresh date. Nothing is written unless nearly every collection
// was read; a partial table would drop keys that are still real.
const total = list.length;
if (read === 0) throw new Error(`issuers.json NOT written: none of the ${total} collections could be read (${failed} failed); the last good table stays in place`);
if (read < Math.ceil(total * 0.9)) throw new Error(`issuers.json NOT written: only ${read} of ${total} collections were read; retry when the endpoint is healthy, the last good table stays in place`);
const issuers = [...byAuthority.values()]
  .sort((a, b) => b.collections - a.collections)
  .map((e) => ({
    address: e.address,
    // The name is the one fact here the chain does not carry; it comes from
    // the prior identity table. A new authority needs separate operator evidence.
    issuer: knownNames.get(e.address) ?? "Unattributed issuer",
    role: "update authority of the collections listed in data/candy-collections.json; signs the mints",
    collections: e.collections,
    sample: e.sample,
    // Every collection this key signs, so a release check can hold the table
    // against the registry one collection at a time and the weekly live check
    // can compare any of them with the chain.
    collectionAddresses: e.addresses.sort(),
    // A hand-written, dated note (how the name was established, what else the
    // key controls) survives regeneration; the chain cannot rewrite it.
    ...(priorRows.find((p) => p.address === e.address)?.note ? { note: priorRows.find((p) => p.address === e.address).note } : {}),
  }));
// A key that signed for these collections and no longer does is kept, marked
// former, with the last date it was seen as their authority. Dropping it made
// identify call the old key "most likely a wallet" while it still controls
// other accounts and appears in every older transaction.
const derivedAt = new Date().toISOString();
for (const p of priorRows) {
  if (byAuthority.has(p.address)) continue;
  issuers.push({
    ...p,
    role: "former update authority of the collections listed in data/candy-collections.json",
    collections: 0,
    collectionAddresses: [],
    former: true,
    lastSeenAsAuthority: p.former ? p.lastSeenAsAuthority : String(prior.derivedAt ?? "").slice(0, 10) || null,
    formerAsOf: p.former ? p.formerAsOf : derivedAt.slice(0, 10),
  });
}
const out = { derivedAt, collectionsRead: read, collectionsUnreadable: failed, unreadable: pending.map((c) => c.address).sort(), issuers };
writeFileSync(path.join(root, "data", "issuers.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`issuers.json: ${issuers.length} key(s) over ${read} collections (${failed} unreadable)`);
for (const i of issuers) console.log(`  ${i.address} ${i.collections}`);
