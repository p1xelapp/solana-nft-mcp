/**
 * Who issued a collection, read from the chain rather than remembered.
 *
 * A Metaplex Core collection's update authority is the key that signs its
 * metadata and, on the collections read for the table, its mints. A wallet
 * holding that key is the issuer's. Asked who held the 36 packs of a drop,
 * the server listed the issuer's own wallet as the top holder with no role
 * on it, and a reader called it a whale that had bought eleven packs.
 *
 * The role is a RELATIONSHIP read from the chain, and only that. Matching
 * the authority does not say the key holds a permanent delegate (that is a
 * separate plugin), does not say how an item came to sit there (unsold,
 * returned, bought back and refunded all look the same), and does not say
 * the key is a person or a company (a program-derived address can hold it).
 * The first version said all three from the match alone (2026-09-18); each is now left to the evidence that can carry it.
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

export type HolderRole = "issuer" | "venue-escrow" | "wallet" | "unknown";

/**
 * What an address IS in the context of one collection.
 *
 * `updateAuthority` is that collection's, decoded live. `authorityRead` says
 * whether that read happened: when the collection account could not be read,
 * nobody can be cleared of the issuer role, so an ordinary address is
 * `unknown`, not `wallet`. The dated table never decides a role: a key that
 * is the authority of other collections is an ordinary holder of THIS one,
 * and the table's name for it travels as a hint in the note.
 */
export function roleOf(
  address: string,
  updateAuthority: string | null,
  authorityRead: "ok" | "unavailable" = updateAuthority ? "ok" : "unavailable",
): { role: HolderRole; note: string | null } {
  const known = knownIssuer(address);
  if (updateAuthority && address === updateAuthority) {
    return {
      role: "issuer",
      note: `the collection's update authority, read from the collection account (the key that signs its metadata)${known ? `, known as ${known.issuer}'s key` : ""}. A relationship, not a purchase history: how each item came to sit here (unsold, held back, returned) is shown by get_asset_provenance on the item`,
    };
  }
  const venue = knownVenueAccount(address);
  if (venue) return { role: "venue-escrow", note: venue };
  const hint = known
    ? `known as ${known.issuer}'s key (the update authority of ${known.collections} collection(s) in the bundled registry as of ${known.derivedAt.slice(0, 10)})`
    : null;
  if (authorityRead === "unavailable") {
    return {
      role: "unknown",
      note: `this collection's update authority could not be read, so whether this address is its issuer is unresolved${hint ? `; ${hint}` : ""}`,
    };
  }
  return { role: "wallet", note: hint ? `${hint}, but not this collection's update authority: an ordinary holder here` : null };
}
