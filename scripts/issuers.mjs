/**
 * Derive data/issuers.json from the chain: the update authority of every
 * collection in data/candy-collections.json, grouped by key.
 *
 *   npm run build && node scripts/issuers.mjs
 *
 * A Metaplex Core collection's update authority is the key that signs its
 * metadata and, in practice, its mints. A wallet that holds that key is the
 * issuer, not a collector: items sitting there were never sold. The table is
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
const issuers = [...byAuthority.values()]
  .sort((a, b) => b.collections - a.collections)
  .map((e) => ({
    address: e.address,
    // The name is the one fact here the chain does not carry; it comes from
    // the registry the collections were listed under.
    issuer: "Candy Digital",
    role: "update authority of the collections listed in data/candy-collections.json; signs the mints",
    collections: e.collections,
    sample: e.sample,
  }));
const out = { derivedAt: new Date().toISOString(), collectionsRead: read, collectionsUnreadable: failed, issuers };
writeFileSync(path.join(root, "data", "issuers.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`issuers.json: ${issuers.length} key(s) over ${read} collections (${failed} unreadable)`);
for (const i of issuers) console.log(`  ${i.address} ${i.collections}`);
