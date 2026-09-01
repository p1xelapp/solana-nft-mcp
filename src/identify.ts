/**
 * Universal identification - the future-proofing layer.
 *
 * A curated registry is useful and permanently incomplete. Collections launch
 * daily, marketplaces appear and shut down (SimpleHash closed March 2025,
 * Reservoir sunset its NFT API October 2025, Magic Eden wound down its EVM and
 * Bitcoin marketplaces by March 2026), and a tool that only answers for a
 * hand-maintained list is stale the week after it ships.
 *
 * So this module takes ANY identifier a person might paste - a mint address, a
 * collection address, a marketplace symbol or slug, a bare name - probes the
 * sources that could plausibly know it, and reports what each one actually
 * said. It never guesses a type from string shape alone; shape only decides
 * which probes are worth spending a request on.
 *
 * The output is deliberately evidence-shaped rather than answer-shaped: what
 * was checked, what answered, what did NOT answer, and how confident that
 * makes the conclusion. An agent that receives "not found" with no record of
 * what was searched will tell the user the thing does not exist, which is a
 * different and much more damaging claim than "the four places I can see do
 * not list it".
 */

import * as me from "./sources/magiceden.js";
import * as os from "./sources/opensea.js";
import * as sol from "./sources/solana.js";
import { REGISTRY, searchRegistry, type RegistryEntry } from "./registry.js";

export interface Probe {
  source: string;
  /** What this probe was testing for, in plain words. */
  looked_for: string;
  result: "found" | "not_found" | "skipped" | "error";
  detail?: string;
}

export interface Identification {
  query: string;
  /** What the thing turned out to be, or null when nothing recognised it. */
  kind:
    | "core-asset"
    | "core-collection"
    | "marketplace-collection"
    | "wallet-or-unknown-account"
    | "registry-entry"
    | "unknown";
  summary: string;
  /** Identifiers other tools accept, so the agent can chain without guessing. */
  identifiers: Record<string, string>;
  standard?: string;
  chain?: string;
  /** Venues confirmed to list it, by name. */
  tradesOn: string[];
  /** Every probe run, including the ones that found nothing. */
  checked: Probe[];
  /** What was NOT checked and why - silence about a gap reads as coverage. */
  notChecked: string[];
  confidence: "high" | "medium" | "low";
  suggestedNextTools: string[];
}

const looksLikeAddress = (q: string) => sol.isBase58Address(q);
const looksLikeSlug = (q: string) => /^[a-z0-9_\-.]{2,80}$/i.test(q);

/**
 * Identify anything. Probes run cheapest-first and every outcome is recorded,
 * including failures, so "we could not find it" is always accompanied by
 * "here is where we looked".
 */
export async function identify(query: string): Promise<Identification> {
  const q = query.trim();
  const checked: Probe[] = [];
  const notChecked: string[] = [];
  const identifiers: Record<string, string> = {};
  const tradesOn: string[] = [];

  // ---- 1. curated registry (free, no network) --------------------------
  const exact = REGISTRY.find((e) => e.id === q);
  const fuzzy = exact ? [exact] : searchRegistry(q);
  const entry: RegistryEntry | undefined = exact ?? fuzzy[0];
  checked.push({
    source: "registry",
    looked_for: "a hand-verified entry matching this id or name",
    result: entry ? "found" : "not_found",
    detail: entry ? `${entry.id} - ${entry.name}` : "no curated entry; falling through to live probes",
  });

  // A registry hit supplies identifiers but is not the final answer - the live
  // probes below still run, because the registry records what we knew when it
  // was written, not what is true now.
  if (entry) {
    if (entry.meSymbol) identifiers.meSymbol = entry.meSymbol;
    if (entry.openseaSlug) identifiers.openseaSlug = entry.openseaSlug;
    if (entry.coreCollection) identifiers.coreCollection = entry.coreCollection;
    if (entry.cryptoslamContract) identifiers.cryptoslamContract = entry.cryptoslamContract;
  }

  // ---- 2. on-chain, when the string could be an address ----------------
  let coreKind: "asset" | "collection" | null = null;
  let coreName: string | undefined;
  const addressToProbe = looksLikeAddress(q) ? q : entry?.coreCollection;

  if (addressToProbe) {
    try {
      const acct = await sol.getCoreAccount(addressToProbe);
      if (acct) {
        coreKind = acct.kind;
        coreName = acct.name;
        identifiers[acct.kind === "asset" ? "mint" : "coreCollection"] = addressToProbe;
        checked.push({
          source: "solana-rpc",
          looked_for: "a Metaplex Core account at this address, decoded from raw bytes",
          result: "found",
          detail: `Core ${acct.kind}: "${acct.name}"`,
        });
      } else {
        checked.push({
          source: "solana-rpc",
          looked_for: "a Metaplex Core account at this address",
          result: "not_found",
          detail:
            "the account exists or is empty but does not decode as Core - it may be a wallet, a legacy SPL mint, a compressed NFT, or another program's account",
        });
      }
    } catch (e) {
      checked.push({
        source: "solana-rpc",
        looked_for: "a Metaplex Core account at this address",
        result: "error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    checked.push({
      source: "solana-rpc",
      looked_for: "an on-chain account",
      result: "skipped",
      detail: "the query is not a base58 address, so there is nothing to look up on chain",
    });
  }

  // ---- 3. Magic Eden ---------------------------------------------------
  const meSymbol = entry?.meSymbol ?? (looksLikeSlug(q) ? q : undefined);
  if (meSymbol) {
    try {
      const stats = await me.collectionStats(meSymbol);
      identifiers.meSymbol = meSymbol;
      tradesOn.push("Magic Eden");
      checked.push({
        source: "magiceden",
        looked_for: `a collection with symbol "${meSymbol}"`,
        result: "found",
        detail: `floor ${stats.floorPriceSol ?? "n/a"} SOL, ${stats.listedCount ?? "?"} listed`,
      });
    } catch (e) {
      checked.push({
        source: "magiceden",
        looked_for: `a collection with symbol "${meSymbol}"`,
        result: "not_found",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    checked.push({
      source: "magiceden",
      looked_for: "a collection symbol",
      result: "skipped",
      detail: "query is not usable as a marketplace symbol",
    });
  }

  // ---- 4. OpenSea (optional, key-gated) --------------------------------
  const osSlug = entry?.openseaSlug ?? (looksLikeSlug(q) ? q : undefined);
  if (!os.openSeaEnabled()) {
    checked.push({
      source: "opensea",
      looked_for: "a collection slug",
      result: "skipped",
      detail: "OPENSEA_API_KEY is not set - this is optional and the server stays zero-config without it",
    });
    notChecked.push(
      "OpenSea. Set OPENSEA_API_KEY to include it. Free keys are issued instantly with no signup via POST https://api.opensea.io/api/v2/auth/keys, but they are capped at 2 per day and expire after 7 days; the OpenSea developer portal issues permanent ones.",
    );
  } else if (osSlug) {
    try {
      const stats = await os.collectionStats(osSlug);
      // OpenSea answers 200 for slugs that do not really exist, returning an
      // empty shell. Judge the payload, never the status code.
      if ((stats.floor ?? 0) > 0 || (stats.owners ?? 0) > 1) {
        identifiers.openseaSlug = osSlug;
        tradesOn.push("OpenSea");
        checked.push({
          source: "opensea",
          looked_for: `a collection with slug "${osSlug}"`,
          result: "found",
          detail: `floor ${stats.floor} ${stats.floorCurrency}, ${stats.owners} owners`,
        });
      } else {
        checked.push({
          source: "opensea",
          looked_for: `a collection with slug "${osSlug}"`,
          result: "not_found",
          detail:
            "OpenSea returned HTTP 200 but with an empty shell collection (no floor, no owners) - a placeholder slug, not a real listing",
        });
      }
    } catch (e) {
      checked.push({
        source: "opensea",
        looked_for: `a collection with slug "${osSlug}"`,
        result: "not_found",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---- 5. conclude ------------------------------------------------------
  notChecked.push(
    "Legacy SPL NFTs and compressed NFTs (cNFTs). Enumerating those needs a DAS indexer, which needs a key - outside the zero-key default.",
    "Non-Solana chains. This server is Solana-only by design; an Ethereum or Base collection will not be found here even if it exists.",
  );

  let kind: Identification["kind"] = "unknown";
  let summary: string;
  let confidence: Identification["confidence"] = "low";
  const next: string[] = [];

  if (coreKind === "asset") {
    kind = "core-asset";
    summary = `"${coreName}" is a single Metaplex Core asset on Solana. Its full ownership history can be decoded from chain.`;
    confidence = "high";
    next.push("get_asset_provenance", "get_asset");
  } else if (coreKind === "collection") {
    kind = "core-collection";
    summary = `"${coreName}" is a Metaplex Core collection on Solana. Supply figures come straight from the on-chain account.`;
    confidence = "high";
    next.push("get_collection_stats", "get_asset_provenance");
  } else if (tradesOn.length > 0) {
    kind = "marketplace-collection";
    summary = `"${q}" is a collection listed on ${tradesOn.join(" and ")}. No Core collection account was resolved, so on-chain supply is unavailable but market data is.`;
    confidence = tradesOn.length > 1 ? "high" : "medium";
    next.push("get_collection_stats", "get_recent_sales", "get_floor_prices");
  } else if (entry) {
    kind = "registry-entry";
    summary = `"${entry.name}" is a curated registry entry, but no live source confirmed it just now. Treat the identifiers as a starting point, not as confirmation it is currently trading.`;
    confidence = "low";
    next.push("get_collection_stats");
  } else if (looksLikeAddress(q)) {
    kind = "wallet-or-unknown-account";
    summary = `${q} is a valid Solana address but is not a Metaplex Core asset or collection. It is most likely a wallet, a legacy SPL mint, or another program's account.`;
    confidence = "medium";
    next.push("get_wallet_holdings");
  } else {
    summary = `Nothing matched "${q}" in the sources this server can see. That is not proof it does not exist - see notChecked for the gaps, and search_collections for close names.`;
    next.push("search_collections");
  }

  if (coreKind && tradesOn.length > 0) {
    // Chain truth plus an independent marketplace agreeing is the strongest
    // signal available without an indexer.
    confidence = "high";
  }

  return {
    query: q,
    kind,
    summary,
    identifiers,
    standard: coreKind ? "Metaplex Core" : undefined,
    chain: coreKind || tradesOn.length > 0 ? "Solana" : undefined,
    tradesOn,
    checked,
    notChecked,
    confidence,
    suggestedNextTools: [...new Set(next)],
  };
}
