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
const knownNames = new Map((Array.isArray(prior?.issuers) ? prior.issuers : []).map((row) => [row.address, row.issuer]));
const byAuthority = new Map();
let read = 0;
let failed = 0;
for (const c of list) {
  try {
    const raw = await sol.getCoreAccountRaw(c.address);
    const d = raw ? sol.decodeCoreAccount(raw) : null;
    if (!d || d.kind !== "collection") { failed++; continue; }
    read++;
    const entry = byAuthority.get(d.updateAuthority) ?? { address: d.updateAuthority, collections: 0, sample: [] };
    entry.collections++;
    if (entry.sample.length < 3) entry.sample.push({ address: c.address, name: d.name });
    byAuthority.set(d.updateAuthority, entry);
  } catch {
    failed++;
  }
}
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
  }));
const out = { derivedAt: new Date().toISOString(), collectionsRead: read, collectionsUnreadable: failed, issuers };
writeFileSync(path.join(root, "data", "issuers.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`issuers.json: ${issuers.length} key(s) over ${read} collections (${failed} unreadable)`);
for (const i of issuers) console.log(`  ${i.address} ${i.collections}`);
