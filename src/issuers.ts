/**
 * Who issued a collection, read from the chain rather than remembered.
 *
 * A Metaplex Core collection's update authority is the key that signs its
 * metadata and, in practice, pays for and signs its mints. A wallet holding
 * that key is the issuer: items sitting in it were never sold, they were
 * kept back or not yet distributed. Asked who held the 36 packs of a drop,
 * the server listed the issuer's own wallet as the top holder with no role
 * on it, and a reader called it a whale that had bought eleven packs.
 *
 * Two readers, in this order:
 *  1. The collection in front of the tool: its update authority is decoded
 *     live, so a brand-new drop under the same key is recognised the day it
 *     mints, with no file to regenerate.
 *  2. `data/issuers.json`: the update authorities of every collection in the
 *     bundled registry, derived by `scripts/issuers.mjs` and dated. This is
 *     what lets `identify` name a bare address as an issuer without knowing
 *     which collection the person has in mind.
 */
import { createRequire } from "node:module";

import { knownVenueAccount } from "./sources/solana.js";

interface IssuerRow {
  address: string;
  issuer: string;
  role: string;
  collections: number;
}

const table: { derivedAt: string; issuers: IssuerRow[] } = (() => {
  try {
    return createRequire(import.meta.url)("../data/issuers.json") as { derivedAt: string; issuers: IssuerRow[] };
  } catch {
    return { derivedAt: "", issuers: [] };
  }
})();

/** The issuer a key is known for, from the dated table, or null. */
export function knownIssuer(address: string): (IssuerRow & { derivedAt: string }) | null {
  const row = table.issuers.find((i) => i.address === address);
  return row ? { ...row, derivedAt: table.derivedAt } : null;
}

export type HolderRole = "issuer" | "venue-escrow" | "wallet";

/**
 * What an address IS in the context of one collection. `updateAuthority` is
 * that collection's, decoded live; the table is the fallback for a key seen
 * on other collections of the same issuer.
 */
export function roleOf(address: string, updateAuthority: string | null): { role: HolderRole; note: string | null } {
  if (updateAuthority && address === updateAuthority) {
    const known = knownIssuer(address);
    return {
      role: "issuer",
      note: `the collection's update authority (the key that signs its metadata and mints)${known ? `, known as ${known.issuer}` : ""}: not a collector. An item here is unsold, held back, or RETURNED after a collector opened or redeemed it (this key holds the permanent transfer delegate); get_asset_provenance on the item shows which, and "bought by" is never the right reading`,
    };
  }
  const known = knownIssuer(address);
  if (known) {
    return {
      role: "issuer",
      note: `${known.issuer}'s key: the update authority of ${known.collections} collection(s) in the bundled registry as of ${known.derivedAt.slice(0, 10)}, and the permanent transfer, burn and freeze delegate on them. Not a collector: an item here is unsold, held back, or returned after being opened or redeemed; get_asset_provenance shows which`,
    };
  }
  const venue = knownVenueAccount(address);
  if (venue) return { role: "venue-escrow", note: venue };
  return { role: "wallet", note: null };
}
