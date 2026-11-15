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
 * The first version said all three from the match alone; each is now left to the evidence that can carry it.
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
  /** Every registered collection this key was the authority of when the table was derived. */
  collectionAddresses?: string[];
  /** A hand-written, dated note: how the name was established, or what else the key still controls. */
  note?: string;
  /** No longer the authority of any registered collection; kept so an old key is not mistaken for a stranger. */
  former?: boolean;
  /** The last table date on which it was the authority. */
  lastSeenAsAuthority?: string | null;
  /** The first table date on which it no longer was. */
  formerAsOf?: string;
}

const table: { derivedAt: string; issuers: IssuerRow[]; unreadable?: string[] } = (() => {
  try {
    return createRequire(import.meta.url)("../data/issuers.json") as { derivedAt: string; issuers: IssuerRow[]; unreadable?: string[] };
  } catch {
    return { derivedAt: "", issuers: [] };
  }
})();

/** The issuer a key is known for, from the dated table, or null. */
export function knownIssuer(address: string): (IssuerRow & { derivedAt: string }) | null {
  const row = table.issuers.find((i) => i.address === address);
  return row ? { ...row, derivedAt: table.derivedAt } : null;
}

/**
 * Where the dated table and the registry disagree, one line per collection.
 *
 * The table answers "whose key is this" and the registry answers "which
 * collections are Candy's". When one is regenerated without the other, a
 * collection can be signed by a key the table calls former, or by no key the
 * table knows, and identify then names the wrong key with high confidence.
 * Run by the release checks against the bundled files; an empty list is
 * agreement. `tableOverride` lets the check be proved on a broken copy.
 */
export function issuerTableDisagreements(
  registryAddresses: string[],
  tableOverride?: { issuers: IssuerRow[]; unreadable?: string[] },
): string[] {
  const t: { issuers: IssuerRow[]; unreadable?: string[] } = tableOverride ?? table;
  const problems: string[] = [];
  const registry = new Set(registryAddresses);
  const owner = new Map<string, string>();
  for (const row of t.issuers) {
    const list = Array.isArray(row.collectionAddresses) ? row.collectionAddresses : null;
    if (!list) { problems.push(`${row.address}: no collection list, so its ${row.collections} collection(s) cannot be checked`); continue; }
    if (row.former && list.length > 0) problems.push(`${row.address}: marked former but still listed as the authority of ${list.length} collection(s)`);
    if (list.length !== row.collections) problems.push(`${row.address}: says ${row.collections} collection(s) but lists ${list.length}`);
    for (const a of list) {
      if (owner.has(a)) problems.push(`${a}: listed under both ${owner.get(a)} and ${row.address}`);
      owner.set(a, row.address);
      if (!registry.has(a)) problems.push(`${a}: in the issuer table under ${row.address} but not in the registry`);
    }
  }
  const unreadable = new Set(Array.isArray(t.unreadable) ? t.unreadable : []);
  for (const a of registry) {
    if (!owner.has(a) && !unreadable.has(a)) problems.push(`${a}: in the registry but the issuer table names no authority for it`);
  }
  return problems;
}

/** The keys the table names as current authorities: the ones whose collections the chain can list. */
export function currentIssuerKeys(): { address: string; issuer: string }[] {
  return table.issuers.filter((r) => !r.former && r.collections > 0).map((r) => ({ address: r.address, issuer: r.issuer }));
}

/**
 * What a collection's update authority says about who issued it.
 *
 * issued: the key is in the table, the collection is one the table lists for
 *   it, and items have been minted into it.
 * no-items: the key is in the table and the collection has no items yet.
 * not-in-registry: the key is in the table and the collection has items, but
 *   the table does not list it.
 * unknown-key: the key is not in the table.
 */
export type IssuerVerdict = "issued" | "no-items" | "not-in-registry" | "unknown-key";

export interface CollectionIssuer {
  verdict: IssuerVerdict;
  /** The issuer's name, set ONLY when the verdict is issued. */
  issuer: string | null;
  /** The table's name for the key, whatever the verdict: who the key belongs to, not who made this collection. */
  keyKnownAs: string | null;
  updateAuthority: string;
  numMinted: number | null;
  /** Present with no-items: the collection exists and nothing has been minted into it. */
  label?: "no items yet";
  note: string;
}

/**
 * The issuer verdict for one collection, the one place every tool gets it.
 *
 * A collection's update authority is a field the creator fills in. Naming a
 * key needs no signature from that key, and creating a collection costs a
 * fraction of a cent, so anybody can make one that names Candy Digital's key,
 * and the table lookup alone called it Candy's. Two facts narrow it:
 *
 *  - Minting an item into a collection needs the signature of the authority
 *    it had at that moment, so an empty collection proves nothing at all.
 *  - An authority can be handed to a new key without that key signing
 *    (UpdateCollectionV1 takes the new authority as a plain account, read in
 *    mpl-core's instruction.rs on 2026-11-14). A collection minted into under
 *    somebody else's key can be passed to Candy's key afterwards, so items
 *    alone do not prove it either.
 *
 * So a collection is called an issuer's only when it has items AND is one of
 * the collections the table lists for that key. Anything else names the key
 * and says why that is not a verdict.
 */
export function collectionIssuer(collection: string, updateAuthority: string, numMinted: number | null): CollectionIssuer {
  const known = knownIssuer(updateAuthority);
  const minted = typeof numMinted === "number" && Number.isFinite(numMinted) ? numMinted : null;
  const base = { updateAuthority, numMinted: minted, keyKnownAs: known?.issuer ?? null };
  if (!known) {
    return { ...base, verdict: "unknown-key", issuer: null, note: `Its update authority, ${updateAuthority}, is not a key in the bundled issuer table, so no issuer is named.` };
  }
  const whose = `${known.issuer}'s ${known.former ? "former " : ""}key`;
  if (minted === null || minted === 0) {
    return {
      ...base,
      verdict: "no-items",
      issuer: null,
      label: "no items yet",
      note:
        `It names ${whose} as its update authority but has no items yet. Naming a key needs no signature from it, so an empty collection proves nothing about who made it: unverified. ` +
        `If ${known.issuer} did create it, it is a drop that has not started.`,
    };
  }
  const listed = Array.isArray(known.collectionAddresses) && known.collectionAddresses.includes(collection);
  if (!listed) {
    return {
      ...base,
      verdict: "not-in-registry",
      issuer: null,
      note:
        `It names ${whose} as its update authority and has ${minted} item(s), but it is not one of the ${known.collections} collection(s) the bundled table lists for that key (derived ${known.derivedAt.slice(0, 10)}). ` +
        `Its items were added with the signature of whatever authority it had at the time, and an authority can be handed to any key without that key signing, so this does not prove ${known.issuer} issued it: unverified.`,
    };
  }
  return {
    ...base,
    verdict: "issued",
    issuer: known.issuer,
    note: `Issued by ${known.issuer}: its update authority is ${whose}, it is one of the collections the bundled table lists for that key (derived ${known.derivedAt.slice(0, 10)}), and ${minted} item(s) have been minted into it.`,
  };
}

/**
 * Where the chain's own list of a key's collections and the bundled registry
 * disagree.
 *
 * `problems` are what a release must not ship with: a collection with items
 * under the key that the registry lacks (a drop newer than the registry,
 * added by hand once it is confirmed to be the issuer's), and a registry
 * collection the chain no longer lists under the key. `noItemsYet` is not a
 * problem: an empty collection naming the key proves nothing, and is reported
 * so a drop that has not started is visible.
 */
export function discoveryDisagreements(
  authority: string,
  discovered: { address: string; name: string; numMinted: number }[],
  registryAddresses: string[],
): { problems: string[]; noItemsYet: string[] } {
  const problems: string[] = [];
  const noItemsYet: string[] = [];
  const registry = new Set(registryAddresses);
  const live = new Set(discovered.map((d) => d.address));
  for (const d of discovered) {
    if (d.numMinted === 0) noItemsYet.push(`${d.address} (${d.name})${registry.has(d.address) ? "" : ", not in the registry"}`);
    else if (!registry.has(d.address)) problems.push(`${d.address} (${d.name}): ${d.numMinted} item(s) under ${authority} but not in the registry; confirm it is the issuer's and add it by hand`);
  }
  for (const a of registry) {
    if (!live.has(a)) problems.push(`${a}: in the registry, but the chain lists no collection under ${authority} at that address now`);
  }
  return { problems, noItemsYet };
}

/** The collections the dated table lists for one key. */
export function tableCollectionsOf(address: string): string[] {
  const row = table.issuers.find((i) => i.address === address);
  return Array.isArray(row?.collectionAddresses) ? [...row.collectionAddresses] : [];
}

/**
 * One sentence on what a key in the table is, current or former.
 *
 * Candy's collections changed update authority in November 2026 and the
 * table still described the old key as the authority of all 401 while the new
 * one was called "most likely a wallet". A former key is still somebody's key:
 * it signed every older mint and can control other accounts, so it is named
 * as former, with the dates that bound the change, rather than dropped.
 */
export function describeIssuerKey(k: IssuerRow & { derivedAt: string }): string {
  const read = `${k.derivedAt.slice(0, 10)} UTC`;
  const note = k.note ? ` ${k.note}` : "";
  if (k.former) {
    return (
      `${k.issuer}'s FORMER key: it was the update authority of the registered collections on ${k.lastSeenAsAuthority ?? "an earlier table date"} ` +
      `and is the authority of none of them in the table derived from the chain on ${read}.${note}`
    );
  }
  return (
    `${k.issuer}'s key: the current update authority of ${k.collections} collection(s) in the bundled registry ` +
    `(derived from the chain on ${read}), which signs their metadata and their mints.${note}`
  );
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
    ? known.former
      ? `known as ${known.issuer}'s former key (seen as the update authority of the registered collections on ${known.lastSeenAsAuthority ?? "an earlier table date"}, of none as of ${known.derivedAt.slice(0, 10)})`
      : `known as ${known.issuer}'s key (the update authority of ${known.collections} collection(s) in the bundled registry as of ${known.derivedAt.slice(0, 10)})`
    : null;
  if (authorityRead === "unavailable") {
    return {
      role: "unknown",
      note: `this collection's update authority could not be read, so whether this address is its issuer is unresolved${hint ? `; ${hint}` : ""}`,
    };
  }
  return { role: "wallet", note: hint ? `${hint}, but not this collection's update authority: an ordinary holder here` : null };
}
