/**
 * Marketplace rows checked against the chain.
 *
 * A marketplace's index is a record of what somebody once listed, not of who
 * holds the item now. In October 2026 Candy Digital moved every holder's items
 * to new wallets; Magic Eden kept the old listings and the old owners, and
 * OpenSea mirrored some of them. Relayed as they were, those rows became the
 * floor, the cheapest listings, an item's "listed at" price and a confirmed
 * receipt, while 144 of the cheapest 148 listings on two collections could not
 * be bought by anyone.
 *
 * A Metaplex Core asset names its owner in its own account bytes, so a listing
 * can be checked for the price of one batched read per hundred rows: the item
 * is either still with the seller (or in the venue's escrow), or it is not.
 * Everything else here is wording. An item that is not Core is never guessed
 * at, and a read that failed is reported as unread, never as either verdict.
 */
import * as sol from "../sources/solana.js";
import * as me from "../sources/magiceden.js";
import { clean } from "./untrusted.js";

export type Custody =
  | { state: "backed"; heldBy: "seller" | "magic-eden-escrow" | "opensea-listing-account"; chainOwner: string; why: string }
  | {
      state: "not-backed";
      reason: "moved" | "opensea-listing" | "other-program" | "burned";
      chainOwner: string | null;
      /** The program that owns `chainOwner`, when it was read. */
      ownerProgram?: string;
      why: string;
    }
  | { state: "not-checked"; why: string }
  | { state: "unread"; why: string };

export interface ListingRef {
  mint: string | null | undefined;
  seller: string | null | undefined;
}

const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;

/**
 * Custody of each listing, in the order given.
 *
 * `venue` decides what counts as holding: a Magic Eden listing is backed by
 * the seller or Magic Eden's escrow; an OpenSea order is also backed by an
 * account of OpenSea's own program, which is where OpenSea keeps a listed
 * item, and by Magic Eden's escrow, because OpenSea relays Magic Eden's book.
 *
 * `explainOwners` caps how many distinct foreign owners get a second read for
 * their owning program. That read is part of the verdict, not only its
 * wording: an owner that is a venue's own account is custody, an owner that is
 * a wallet is a move. An owner past the cap, or one the read failed for, is
 * reported as unread. Two requests per hundred listings in the worst case.
 */
export async function custodyOfListings(
  rows: ListingRef[],
  opts: { venue?: "magiceden" | "opensea"; explainOwners?: number; fresh?: boolean } = {},
): Promise<Custody[]> {
  const venue = opts.venue ?? "magiceden";
  const mints = rows.map((r) => (typeof r.mint === "string" && sol.isBase58Address(r.mint) ? r.mint : null));
  const owners = await sol.readAssetOwners(mints.filter((m): m is string => m !== null), { fresh: opts.fresh });
  // Owners that are neither the seller nor a known holding account, cheapest
  // rows first, up to the cap.
  const foreign: string[] = [];
  rows.forEach((r, i) => {
    const m = mints[i];
    const o = m ? owners.get(m) : undefined;
    if (o?.kind === "core-asset" && o.owner !== r.seller && o.owner !== sol.MAGIC_EDEN_ESCROW && !foreign.includes(o.owner)) foreign.push(o.owner);
  });
  const cap = Math.max(0, opts.explainOwners ?? 100);
  const programs = cap > 0 && foreign.length > 0 ? await sol.readOwnerPrograms(foreign.slice(0, cap)) : new Map<string, sol.OwnerProgramRead>();

  return rows.map((r, i): Custody => {
    const m = mints[i];
    if (!m) return { state: "not-checked", why: "the listing carries no usable item address, so it was not checked against the chain" };
    const o = owners.get(m);
    if (!o || o.kind === "unread") return { state: "unread", why: `the chain could not be read for this item just now (${o?.kind === "unread" ? o.reason : "no answer"}), so whether the seller still holds it is unknown` };
    if (o.kind === "not-core") return { state: "not-checked", why: "not a Metaplex Core item, so whether the seller still holds it was not checked here" };
    if (o.kind === "no-account") return { state: "not-checked", why: "there is no account at this address (a compressed item has none, and neither does a closed one), so custody was not checked" };
    if (o.kind === "core-other") return { state: "not-checked", why: "the address is a Metaplex Core account that is not an item, so there is no owner to check" };
    if (o.kind === "burned") return { state: "not-backed", reason: "burned", chainOwner: null, why: "the item was burned and no longer exists, so this listing cannot be bought" };
    const owner = o.owner;
    if (typeof r.seller === "string" && owner === r.seller) return { state: "backed", heldBy: "seller", chainOwner: owner, why: "the seller still holds the item" };
    if (owner === sol.MAGIC_EDEN_ESCROW) return { state: "backed", heldBy: "magic-eden-escrow", chainOwner: owner, why: "the item sits in Magic Eden's escrow, where a live Magic Eden listing keeps it" };
    const p = programs.get(owner);
    const knownOpenSea = sol.isOpenSeaListingAccount(owner);
    // The owner is somebody other than the seller. What KIND of account it is
    // decides everything from here, and a verdict is only given on a kind that
    // was actually read: when that second read failed or was not made, a real
    // listing held in a venue's own account looked exactly like a stale one.
    if (!knownOpenSea && (!p || p.kind === "unread")) {
      return {
        state: "unread",
        why: `the item's owner on chain is ${short(owner)}, not the seller, and what kind of account that is could not be read just now, so whether this listing can be bought is unknown`,
      };
    }
    const inOpenSea = knownOpenSea || (p?.kind === "program" && p.program === sol.OPENSEA_SOLANA_PROGRAM);
    if (inOpenSea && venue === "opensea") {
      return { state: "backed", heldBy: "opensea-listing-account", chainOwner: owner, why: "the item sits in an OpenSea listing account, where a live OpenSea listing keeps it" };
    }
    if (inOpenSea) {
      return {
        state: "not-backed",
        reason: "opensea-listing",
        chainOwner: owner,
        ownerProgram: sol.OPENSEA_SOLANA_PROGRAM,
        why: `the item now sits in an OpenSea listing account (${short(owner)}): it is listed on OpenSea, so this Magic Eden listing cannot be bought`,
      };
    }
    if (p?.kind === "program" && !sol.isWalletProgram(p.program)) {
      // Magic Eden's own programs hold items too: a pool takes custody of what
      // it sells. Such an account can be a live listing or a leftover one, and
      // the bytes read here do not say which, so it gets no verdict.
      if (sol.isMagicEdenProgram(p.program)) {
        return { state: "not-checked", why: `the item is held by an account of ${sol.knownProgram(p.program) ?? "a Magic Eden program"}, where a live listing can keep it; whether this one is live was not checked` };
      }
      const named = sol.knownProgram(p.program);
      if (!named) {
        return { state: "not-checked", why: `the item is held by an account of a program this server does not know (${p.program}), so whether this listing can be bought was not checked` };
      }
      return {
        state: "not-backed",
        reason: "other-program",
        chainOwner: owner,
        ownerProgram: p.program,
        why: `the item is held by an account of another marketplace's program (${named}), not by the seller or this venue's escrow, so this listing cannot be bought`,
      };
    }
    // An ordinary wallet holds it. With no seller on the listing there is
    // nothing to compare that wallet with.
    if (typeof r.seller !== "string" || r.seller.length === 0) {
      return { state: "not-checked", why: "the listing names no seller, so the chain owner could not be compared with one" };
    }
    return {
      state: "not-backed",
      reason: "moved",
      chainOwner: owner,
      ...(p?.kind === "program" ? { ownerProgram: p.program } : {}),
      why: `the item was moved to another wallet (${short(owner)}); the seller no longer holds it, so this listing cannot be bought`,
    };
  });
}

/** A listing price that is money: finite and above zero. */
export const usableAsk = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export interface CheckedFloor {
  /**
   * backed: a listing whose item is still held was found. none-backed: every
   * listing read is stale. unread: the chain or the listing book could not be
   * read. not-core: the cheapest listing that is not known stale is not a Core
   * item, so nothing could be checked. not-requested: the caller asked for too
   * much at once and this one was left out.
   */
  status: "backed" | "none-backed" | "unread" | "not-core" | "not-requested";
  /** The floor to publish: the backed ask, Magic Eden's own figure when nothing could be checked, or null when every listing read is stale. */
  floorSol: number | null;
  /** Magic Eden's own reported floor, unchanged. */
  venueReportedFloorSol: number | null;
  /** True only when the figure in floorSol was checked against the chain. */
  checked: boolean;
  /** The listing behind a backed floor. */
  floorListing: { mint: string; seller: string | null; priceSol: number } | null;
  /** Listings cheaper than the published floor whose item the seller no longer holds. */
  staleBelowFloor: number;
  /** How many of the cheapest listings were checked. */
  listingsChecked: number;
  /** Every listing read, with its verdict, so another venue's mirror of one of them can be recognised. */
  listingsRead: { mint: string; seller: string | null; priceSol: number | null; custody: Custody["state"] }[];
  /** A few of the stale listings, cheapest first. */
  staleExamples: { mint: string; priceSol: number | null; seller: string | null; why: string }[];
  sentence: string;
}

const CHECKED_FLOOR_PAGE = 100;

/**
 * The cheapest ask whose item is still held by its seller or Magic Eden's
 * escrow, among the cheapest hundred listings.
 *
 * One listing page and one batched chain read. A stale listing below it is
 * skipped and counted; a listing the chain could not be read for stops the
 * walk, because skipping it could step over the real floor.
 */
export async function checkedFloor(symbol: string, venueFloorSol: number | null): Promise<CheckedFloor> {
  const base = { venueReportedFloorSol: venueFloorSol, floorListing: null, staleBelowFloor: 0, listingsChecked: 0, listingsRead: [], staleExamples: [] };
  let page: me.CollectionListingsRead;
  try {
    page = await me.collectionListings(symbol, { limit: CHECKED_FLOOR_PAGE, sort: "listPrice", direction: "asc" });
  } catch (e) {
    return {
      ...base,
      status: "unread",
      floorSol: venueFloorSol,
      checked: false,
      sentence: `Magic Eden's listing book could not be read (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}), so its floor was not checked against the chain; this is Magic Eden's own figure.`,
    };
  }
  if (page.stale) {
    return { ...base, status: "unread", floorSol: venueFloorSol, checked: false, sentence: "Magic Eden's listing book did not answer just now (a cached page was all there was), so its floor was not checked against the chain; this is Magic Eden's own figure." };
  }
  const rows = [...page.listings].sort((a, b) => (usableAsk(a.price) ?? Infinity) - (usableAsk(b.price) ?? Infinity));
  if (rows.length === 0) {
    return { ...base, status: "unread", floorSol: venueFloorSol, checked: false, sentence: "Magic Eden returned no listings to check, so its floor was not checked against the chain; this is Magic Eden's own figure." };
  }
  const custody = await custodyOfListings(rows.map((l) => ({ mint: l.tokenMint, seller: l.seller })));
  const listingsRead = rows.flatMap((l, i) =>
    typeof l.tokenMint === "string" && sol.isBase58Address(l.tokenMint)
      ? [{ mint: l.tokenMint, seller: sol.venueAddress(l.seller), priceSol: usableAsk(l.price), custody: custody[i]!.state }]
      : [],
  );
  const staleExamples: CheckedFloor["staleExamples"] = [];
  let stale = 0;
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i]!;
    const c = custody[i]!;
    const price = usableAsk(l.price);
    if (price === null) continue;
    if (c.state === "not-backed") {
      stale++;
      if (staleExamples.length < 3 && typeof l.tokenMint === "string") staleExamples.push({ mint: l.tokenMint, priceSol: price, seller: sol.venueAddress(l.seller), why: c.why });
      continue;
    }
    const common = { ...base, listingsChecked: rows.length, listingsRead, staleExamples, staleBelowFloor: stale };
    const skipped =
      stale > 0
        ? ` ${stale} cheaper listing(s) on Magic Eden were skipped because the chain shows the seller no longer holds the item (moved, burned or listed elsewhere).`
        : "";
    if (c.state === "backed") {
      return {
        ...common,
        status: "backed",
        floorSol: price,
        checked: true,
        floorListing: { mint: l.tokenMint as string, seller: sol.venueAddress(l.seller), priceSol: price },
        sentence: `Checked against the chain: ${price} SOL is the cheapest of Magic Eden's ${rows.length} cheapest listings whose item is still held by its seller or Magic Eden's escrow.${skipped}${venueFloorSol !== null && venueFloorSol !== price ? ` Magic Eden's own reported floor is ${venueFloorSol} SOL.` : ""}`,
      };
    }
    if (c.state === "unread") {
      return { ...common, status: "unread", floorSol: venueFloorSol, checked: false, sentence: `${c.why[0]!.toUpperCase()}${c.why.slice(1)}. The floor was not checked; this is Magic Eden's own figure.${skipped}` };
    }
    return {
      ...common,
      status: "not-core",
      floorSol: stale > 0 ? price : venueFloorSol,
      checked: false,
      sentence:
        stale > 0
          ? `The cheapest listing that is not known to be stale could not be checked (${c.why}), so ${price} SOL is shown unchecked.${skipped}`
          : `The cheapest listing could not be checked against the chain (${c.why}), so this is Magic Eden's own figure, not checked.`,
    };
  }
  return {
    ...base,
    status: "none-backed",
    floorSol: null,
    checked: true,
    staleBelowFloor: stale,
    listingsChecked: rows.length,
    listingsRead,
    staleExamples,
    sentence:
      `None of the ${rows.length} cheapest Magic Eden listing(s) read can be bought: in every one the chain shows the seller no longer holds the item. ` +
      `No floor is given${venueFloorSol !== null ? `; Magic Eden still reports ${venueFloorSol} SOL, which is one of those stale listings` : ""}. ` +
      `Only the cheapest ${CHECKED_FLOOR_PAGE} are read, so a collection with more listings than that can still have one that can be bought further up.`,
  };
}

/**
 * Magic Eden's per-trait floors, with every floor that is a known stale
 * listing taken out.
 *
 * The venue computes a trait floor from its own book, so a trait whose
 * cheapest listing moved months ago still reports that price, and every
 * "under the trait floor" figure was argued from it. A floor is recognised as
 * a listing in the rows read: same trait, same price. When every such listing
 * is stale, the floor becomes the next listing carrying that trait that the
 * chain shows can be bought, but only when the rows read are the cheapest of
 * the whole book (`rowsArePrefix`); otherwise, or when no such listing was
 * read, the floor is withdrawn rather than kept. A floor whose listing is not
 * among the rows read is left as the venue reported it.
 */
export function checkTraitFloorsAgainstRows(
  attributes: me.TraitFloor[],
  rows: { l: me.MeListing; c: Custody }[],
  rowsArePrefix: boolean,
): { attributes: me.TraitFloor[]; replaced: number; withdrawn: number } {
  let replaced = 0;
  let withdrawn = 0;
  const carries = (l: me.MeListing, a: me.TraitFloor) =>
    Array.isArray(l.token?.attributes) &&
    l.token.attributes.some((t) => t && typeof t.trait_type === "string" && clean(t.trait_type) === a.traitType && clean(t.value) === a.value);
  const out = attributes.map((a) => {
    if (a.floorSol === null) return a;
    const withTrait = rows.filter(({ l }) => usableAsk(l.price) !== null && carries(l, a)).sort((x, y) => (x.l.price as number) - (y.l.price as number));
    const atFloor = withTrait.filter(({ l }) => Math.abs((l.price as number) - (a.floorSol as number)) < 1e-9);
    if (atFloor.length === 0 || atFloor.some(({ c }) => c.state !== "not-backed")) return a;
    if (rowsArePrefix) {
      for (const { l, c } of withTrait) {
        if (c.state === "not-backed") continue;
        if (c.state === "backed") {
          replaced++;
          return { ...a, floorSol: usableAsk(l.price) };
        }
        break;
      }
    }
    withdrawn++;
    return { ...a, floorSol: null };
  });
  return { attributes: out, replaced, withdrawn };
}

/** The verdict for a symbol this call left out, with the reason in words. */
export function floorNotRequested(venueFloorSol: number | null, why: string): CheckedFloor {
  return { status: "not-requested", floorSol: venueFloorSol, venueReportedFloorSol: venueFloorSol, checked: false, floorListing: null, staleBelowFloor: 0, listingsChecked: 0, listingsRead: [], staleExamples: [], sentence: why };
}

/**
 * Run tasks one after another inside a wall-clock budget.
 *
 * Measured: ten floors took 64.6 s, which is longer than many clients wait.
 * The budget is the caller's deadline for the whole call: a task still
 * running when it ends is abandoned (its reads are cancelled through the
 * ambient signal), and every task not finished comes back as `timedOut`, so
 * the rows that were read still arrive.
 */
export async function withinBudget<T>(
  budgetMs: number,
  tasks: ((signal: AbortSignal) => Promise<T>)[],
  run: (signal: AbortSignal, fn: () => Promise<T>) => Promise<T>,
  outer?: AbortSignal,
): Promise<({ done: true; value: T } | { done: false; error?: unknown; timedOut: boolean })[]> {
  const timer = AbortSignal.timeout(budgetMs);
  const signal = outer ? AbortSignal.any([timer, outer]) : timer;
  const out: ({ done: true; value: T } | { done: false; error?: unknown; timedOut: boolean })[] = [];
  const ABANDONED = Symbol("abandoned");
  // One listener for the whole run. A task that ignores the signal still
  // loses the race, so the budget holds whatever the task does.
  const abandoned = new Promise<typeof ABANDONED>((resolve) => {
    if (signal.aborted) resolve(ABANDONED);
    else signal.addEventListener("abort", () => resolve(ABANDONED), { once: true });
  });
  for (const task of tasks) {
    if (signal.aborted) {
      out.push({ done: false, timedOut: true });
      continue;
    }
    try {
      const v = await Promise.race([run(signal, () => task(signal)), abandoned]);
      if (v === ABANDONED) out.push({ done: false, timedOut: true });
      else out.push({ done: true, value: v as T });
    } catch (e) {
      out.push({ done: false, error: e, timedOut: signal.aborted });
    }
  }
  return out;
}
