/**
 * The source catalog: one honest record per place this server reads from.
 *
 * Why a catalog and not a paragraph in the README: when a venue is down, the
 * only useful answer is "which venue, what it would have told you, and what we
 * did instead". That answer needs machine-readable facts - what a source is
 * for, what it structurally cannot see, who replaces it when it stops
 * answering. Kept next to the code that calls them so a source cannot be wired
 * up without being described, and so `get_source_status` and docs/SOURCES.md
 * are rendered from the same row rather than written twice.
 *
 * `lastVerified` is the day a human actually fetched the endpoint and the doc
 * link and watched them answer - not the day the file was edited.
 */

export type SourceKind =
  /** A plain Solana JSON-RPC node: chain truth, no opinions. */
  | "chain-rpc"
  /** A venue with its own order book and its own view of "the" price. */
  | "marketplace"
  /** An indexer that re-publishes other people's data. */
  | "aggregator"
  /** Not called by this server - we only build URLs a person can click. */
  | "explorer-links"
  /** A specification we decode by hand; the docs are the source. */
  | "standard-docs";

/**
 * 1 = chain truth read directly from an account (settles disputes), 2 = a
 * primary venue or an index OF the chain (what somebody else's database says,
 * which can lag the chain), 3 = secondary or optional colour, 4 = reference
 * link only. A lower tier never loses an argument to a higher one.
 *
 * An indexer never earns tier 1, however good it is: tier 1 means we read the
 * bytes ourselves.
 */
export type SourceTier = 1 | 2 | 3 | 4;

export interface SourceEntry {
  id: string;
  name: string;
  kind: SourceKind;
  tier: SourceTier;
  /** True when the source cannot be read at all without a credential. */
  keyRequired: boolean;
  /** Environment variable that carries the key or the override, when there is one. */
  keyEnvVar: string | null;
  /** False = described here but not called by this server today. */
  wired: boolean;
  /** Questions this source is used to answer, in the words a user would use. */
  answers: string[];
  /** What this source structurally cannot tell us, however healthy it is. */
  cannotSee: string[];
  officialDocs: string;
  statusPage: string | null;
  /** ISO date the endpoint and the doc link were both fetched and seen to answer. */
  lastVerified: string;
  /** Next source to ask the same question, or null when nothing else can answer it. */
  fallback: string | null;
  /** How far back this source keeps data. "unknown" when the vendor does not document it. */
  retention: string;
  /** URL a person can open to check a claim by hand; {address} is substituted. */
  linkTemplate?: string;
  /** Anything a reader needs before trusting a number from here. */
  note?: string;
}

/** The day every URL and endpoint below was fetched and observed to answer. */
const VERIFIED = "2026-09-11";

export const SOURCES: readonly SourceEntry[] = [
  // ------------------------------------------------------------- tier 1
  {
    id: "rpc-custom",
    name: "Your own Solana RPC endpoint",
    kind: "chain-rpc",
    tier: 1,
    keyRequired: false,
    keyEnvVar: "SOLANA_RPC_URL",
    wired: true,
    answers: [
      "everything the public endpoints answer, without sharing their rate limit",
      "deeper transaction history, if the endpoint you point at is archival",
    ],
    cannotSee: [
      "marketplace listings, offers or floor prices - those never touch the chain until a trade settles",
    ],
    officialDocs: "https://solana.com/docs/rpc",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: "rpc-mainnet-beta",
    retention: "whatever the endpoint you choose keeps - ask your provider",
    note:
      "Optional. Set SOLANA_RPC_URL and it is tried first, then the public list. " +
      "The URL is never printed back: status and provenance report the host only, so a key in a query string cannot leak into a transcript.",
  },
  {
    id: "rpc-mainnet-beta",
    name: "Solana public mainnet RPC",
    kind: "chain-rpc",
    tier: 1,
    keyRequired: false,
    keyEnvVar: null,
    wired: true,
    answers: [
      "who owns a Metaplex Core asset right now",
      "every transaction that touched an asset, and the new owner in each transfer",
      "how old a wallet is and roughly how busy",
      "how many items a Core collection has minted",
    ],
    cannotSee: [
      "listings, offers, floor prices or sale prices - a marketplace holds those off chain until settlement",
      "which collection a name belongs to; the chain has addresses, not search",
    ],
    officialDocs: "https://solana.com/docs/rpc",
    statusPage: "https://status.solana.com/",
    lastVerified: VERIFIED,
    fallback: "rpc-publicnode",
    retention:
      "unknown (not documented for the public endpoint); a transaction old enough to be pruned returns null and is counted as unreadable, never as 'did not happen'",
    note: "Rate-limited hard on bursts. This is the default first endpoint because it is the canonical one, not the fastest.",
  },
  {
    id: "rpc-publicnode",
    name: "PublicNode Solana RPC",
    kind: "chain-rpc",
    tier: 1,
    keyRequired: false,
    keyEnvVar: null,
    wired: true,
    answers: ["the same chain questions as the Solana public endpoint, when that one is busy"],
    cannotSee: ["the same off-chain market data no RPC node can see"],
    officialDocs: "https://publicnode.com/",
    statusPage: "https://allnodes.statuspage.io/",
    lastVerified: VERIFIED,
    fallback: "rpc-leorpc",
    retention: "unknown (not documented)",
  },
  {
    id: "rpc-leorpc",
    name: "LeoRPC public Solana endpoint",
    kind: "chain-rpc",
    tier: 1,
    keyRequired: false,
    keyEnvVar: null,
    wired: true,
    answers: ["last-resort chain reads when the two endpoints ahead of it in the fallback order are both rate-limiting"],
    cannotSee: ["the same off-chain market data no RPC node can see"],
    officialDocs: "https://leorpc.com/",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: null,
    retention: "unknown (not documented)",
    note:
      "Reached with the vendor's shared public token in the URL - no signup, nothing issued to this user, so the zero-key promise holds. Slowest of the three in our measurements.",
  },
  {
    id: "metaplex-core",
    name: "Metaplex Core program and docs",
    kind: "standard-docs",
    tier: 1,
    keyRequired: false,
    keyEnvVar: null,
    wired: true,
    answers: [
      "the byte layout we decode owner, name and mint counts from",
      "the TransferV1 instruction shape that tells us who received an asset",
      "which plugins can freeze, burn or take royalties on an asset",
    ],
    cannotSee: ["anything about a specific asset - it is a specification, not a data feed"],
    officialDocs: "https://developers.metaplex.com/core",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: null,
    retention: "permanent (a program's account layout only changes with a new program version)",
    linkTemplate: "https://explorer.solana.com/address/CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
    note:
      "We decode the layout by hand rather than pulling the SDK, so a Core upgrade that moves a field is a silent-wrong-answer risk. " +
      "The pin is the discriminator set in src/sources/solana.ts (AssetV1 = 1, CollectionV1 = 5, TransferV1 = 14); the live check re-reads a known asset every week to catch a move.",
  },

  // ------------------------------------------------------------- tier 2
  {
    id: "das-public",
    name: "Asset index (DAS) on the public Solana RPC",
    kind: "aggregator",
    tier: 2,
    keyRequired: false,
    keyEnvVar: "DAS_RPC_URL",
    wired: true,
    answers: [
      "a second opinion on who an index believes owns an asset, and which collection it is grouped under, across every standard (Core, Token Metadata, compressed)",
      "what a wallet holds beyond what a marketplace indexes",
      "what standard an unknown mint uses",
    ],
    cannotSee: [
      "prices, listings, sales - it is an index of assets, not of trades",
      "ownership history; only the state the index last wrote down",
      "assets the index has not picked up yet; coverage is not documented and was seen to differ from Magic Eden's for the same wallet",
      "anything it has not re-indexed since the last transfer - an index lags the chain, and how far is not published",
    ],
    officialDocs: "https://developers.metaplex.com/das-api",
    statusPage: "https://status.solana.com/",
    lastVerified: VERIFIED,
    fallback: "helius-das",
    retention: "current state only",
    note:
      "An INDEX of the chain, not the chain: it runs on the same host as the tier-1 endpoint but answers from a database somebody else maintains, so it never settles ownership - the byte-level Core account read does that, and a disagreement is reported rather than resolved. The Solana Foundation endpoint answers getAsset, getAssetsByOwner and searchAssets without a key, but does not document it and calls the endpoint unfit for production. A -32601 'Method not found' is the canary that the capability was withdrawn, and the tools then say so and carry on without it. Set DAS_RPC_URL to any DAS provider you have to put it first.",
  },
  {
    id: "magiceden-v2",
    name: "Magic Eden v2",
    kind: "marketplace",
    tier: 2,
    keyRequired: false,
    keyEnvVar: null,
    wired: true,
    answers: [
      "floor price and listed count for a Solana collection",
      "recent completed sales, with buyer, seller and signature",
      "what a wallet holds, as Magic Eden indexes it",
      "a wallet's buy and sell activity on this marketplace",
    ],
    cannotSee: [
      "trades that happened on any other marketplace - a Magic Eden floor is one marketplace's ask, not the market's",
      "Metaplex Core ownership history; the API returns it empty, which is why this server reads the chain instead",
      "wallets Magic Eden blocks, including its own escrow accounts",
    ],
    officialDocs: "https://docs.magiceden.io/reference/solana-overview",
    statusPage: "https://status.magiceden.io/",
    lastVerified: VERIFIED,
    fallback: "opensea-v2",
    retention: "unknown (not documented); activity pages back through the collection's own history",
    note:
      "Keyless and generous, so it is the default market source. The docs site refuses automated clients - open the link in a browser.",
  },
  {
    id: "opensea-v2",
    name: "OpenSea v2",
    kind: "marketplace",
    tier: 2,
    keyRequired: true,
    keyEnvVar: "OPENSEA_API_KEY",
    wired: true,
    answers: [
      "a second marketplace's floor, owner count and royalty for the same collection",
      "sales priced in something other than SOL, in the currency OpenSea reports",
      "transfers in and out of a wallet, including ones with no sale attached",
      "the full list of Solana collections OpenSea has indexed, for name search",
      "the cheapest listing per trait value across every marketplace OpenSea aggregates, joined onto each deal in find_listings",
      "a 7-day floor series (start, end, low, high, change) in get_collection_stats",
      "the largest holders and their combined share of supply in get_collection_stats",
    ],
    cannotSee: [
      "anything at all when no key is in hand - if the self-issued key is refused and OPENSEA_API_KEY is unset, every OpenSea-backed field is simply absent",
      "which marketplace actually executed a fill; OpenSea has been observed reporting Magic Eden fills under its own name",
    ],
    officialDocs: "https://docs.opensea.io/reference/api-overview",
    statusPage: "https://status.opensea.io/",
    lastVerified: VERIFIED,
    fallback: "magiceden-v2",
    retention: "unknown (not documented)",
    note: "No configuration needed: the first call that needs OpenSea issues a free agent key (POST /api/v2/auth/keys), stores it under the user's home folder and replaces it on the first call made within a day of its expiry; OPENSEA_API_KEY overrides it and COLLECTOR_MCP_NO_AUTO_KEYS=1 disables it. Key CREATION is rate-limited to about two per day per IP, so on a busy address OpenSea can stay off - every tool still answers, with the OpenSea half named as missing rather than dropped.",
  },

  // ------------------------------------------------------------- tier 3
  {
    id: "rarible",
    name: "Rarible (Solana marketplace, relaunched August 2026)",
    kind: "marketplace",
    tier: 3,
    keyRequired: true,
    keyEnvVar: "RARIBLE_API_KEY",
    wired: false,
    answers: [
      "would add: collection-wide bid depth (the exit price a seller can actually get), Rarible listings and fills",
    ],
    cannotSee: [
      "which marketplace executed a fill: its platform enum has no Magic Eden or Tensor value, so a Magic Eden sale would be relabelled",
      "anything without a key: every data endpoint answers 403 keyless",
    ],
    officialDocs: "https://docs.rarible.org/",
    statusPage: null,
    lastVerified: "2026-09-12",
    fallback: "magiceden-v2",
    retention: "unknown (not documented)",
    note:
      "Not wired. Keys are self-serve but need a wallet, an email and allowed domains, and the free tier is 100 requests per month, which one report would spend. " +
      "The API terms that govern caching and redistribution are referenced but not published. Revisit when a usable tier and marketplace attribution exist.",
  },
  {
    id: "tensor",
    name: "Tensor API",
    kind: "marketplace",
    tier: 3,
    keyRequired: true,
    keyEnvVar: "TENSOR_API_KEY",
    wired: false,
    answers: [
      "planned: a third Solana floor and bid-side depth, which neither wired marketplace exposes",
      "planned: collection-wide bids, the number that actually sets a seller's exit price",
    ],
    cannotSee: ["anything today - not wired; listed here so a missing Tensor number is a known gap, not a silent one"],
    officialDocs: "https://docs.tensor.trade/",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: "magiceden-v2",
    retention: "unknown (not documented)",
    note: "Requires an issued key, so wiring it would break the zero-key promise for anyone without one. Planned as optional, like OpenSea.",
  },
  {
    id: "helius-das",
    name: "Helius DAS API",
    kind: "aggregator",
    tier: 3,
    keyRequired: true,
    keyEnvVar: "HELIUS_API_KEY",
    wired: false,
    answers: [
      "planned: every asset in a collection or wallet in one call, instead of walking transactions",
      "planned: compressed NFTs, which have no account to read and are invisible to plain RPC",
    ],
    cannotSee: ["anything today - not wired"],
    officialDocs: "https://www.helius.dev/docs/api-reference/das",
    statusPage: "https://helius.statuspage.io/",
    lastVerified: VERIFIED,
    fallback: "rpc-mainnet-beta",
    retention: "unknown (not documented); DAS answers current state, not history",
    note: "Metered by credits, so an unattended loop against it has a running cost. That is the reason it stays optional and off by default.",
  },
  {
    id: "triton-das",
    name: "Triton One RPC and DAS",
    kind: "aggregator",
    tier: 3,
    keyRequired: true,
    keyEnvVar: "TRITON_RPC_URL",
    wired: false,
    answers: ["planned: archival transaction history deeper than a public node keeps, and a DAS index alongside it"],
    cannotSee: ["anything today - not wired"],
    officialDocs: "https://docs.triton.one/",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: "rpc-mainnet-beta",
    retention: "archival plans are offered; the exact window depends on the plan",
    note: "A paid endpoint here would arrive as SOLANA_RPC_URL and need no new code - the RPC fallback list already takes a custom endpoint first.",
  },
  {
    id: "shyft-das",
    name: "Shyft DAS API",
    kind: "aggregator",
    tier: 3,
    keyRequired: true,
    keyEnvVar: "SHYFT_API_KEY",
    wired: false,
    answers: ["planned: a second DAS index, so a wallet listing does not depend on one vendor"],
    cannotSee: ["anything today - not wired"],
    officialDocs: "https://docs.shyft.to/",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: "helius-das",
    retention: "unknown (not documented)",
  },

  // ------------------------------------------------------------- tier 4
  {
    id: "solscan",
    name: "Solscan",
    kind: "explorer-links",
    tier: 4,
    keyRequired: false,
    keyEnvVar: null,
    wired: false,
    answers: ["a page a person can open to check an asset or wallet by hand against a second index"],
    cannotSee: ["nothing is read from it - this server only builds the URL"],
    officialDocs: "https://docs.solscan.io/",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: "solanafm",
    retention: "unknown (the explorer's own index)",
    linkTemplate: "https://solscan.io/token/{address}",
    note: "Its API needs a key, so it stays link-only. The link is for a human, not for us.",
  },
  {
    id: "solanafm",
    name: "SolanaFM",
    kind: "explorer-links",
    tier: 4,
    keyRequired: false,
    keyEnvVar: null,
    wired: false,
    answers: ["a second explorer view, useful when Solscan and the chain seem to disagree"],
    cannotSee: ["nothing is read from it - this server only builds the URL"],
    officialDocs: "https://docs.solana.fm/",
    statusPage: null,
    lastVerified: VERIFIED,
    fallback: "solana-explorer",
    retention: "unknown (the explorer's own index)",
    linkTemplate: "https://solana.fm/address/{address}",
    note: "Its API needs a key, so it stays link-only.",
  },
  {
    id: "solana-explorer",
    name: "Solana Explorer",
    kind: "explorer-links",
    tier: 4,
    keyRequired: false,
    keyEnvVar: null,
    wired: false,
    answers: ["the raw account and transaction view, straight from an RPC node - the tiebreaker when indexers disagree"],
    cannotSee: ["nothing is read from it - this server only builds the URL"],
    officialDocs: "https://explorer.solana.com/",
    statusPage: "https://status.solana.com/",
    lastVerified: VERIFIED,
    fallback: null,
    retention: "whatever the node behind it keeps",
    linkTemplate: "https://explorer.solana.com/address/{address}",
  },
  {
    id: "xray",
    name: "XRAY",
    kind: "explorer-links",
    tier: 4,
    keyRequired: false,
    keyEnvVar: null,
    wired: false,
    answers: ["a plain-English rendering of a transaction, handy when explaining an event to a person"],
    cannotSee: ["nothing is read from it - this server only builds the URL"],
    officialDocs: "https://xray.helius.xyz/",
    statusPage: "https://helius.statuspage.io/",
    lastVerified: VERIFIED,
    fallback: "solana-explorer",
    retention: "unknown (the explorer's own index)",
    linkTemplate: "https://xray.helius.xyz/token/{address}",
  },
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export function sourceById(id: string): SourceEntry | undefined {
  return BY_ID.get(id);
}

/** Sources this server actually calls - the only ones a status check can ping. */
export const WIRED_SOURCES: readonly SourceEntry[] = SOURCES.filter((s) => s.wired);

/**
 * Public Solana RPC endpoints, in the order they are tried.
 *
 * Ordered by "least surprise", not by speed: the canonical Solana endpoint
 * stays first so today's behaviour is unchanged, and the others exist only to
 * catch it being busy. A user's own SOLANA_RPC_URL is inserted ahead of all of
 * these by src/sources/solana.ts.
 */
export const PUBLIC_RPC_ENDPOINTS: readonly { id: string; url: string }[] = [
  { id: "rpc-mainnet-beta", url: "https://api.mainnet-beta.solana.com" },
  { id: "rpc-publicnode", url: "https://solana-rpc.publicnode.com" },
  { id: "rpc-leorpc", url: "https://solana.leorpc.com/?api_key=FREE" },
];

/**
 * Explorer URLs for one address, so an answer can always be double-checked by
 * a person. Built locally: no request is made and nothing here can fail.
 */
export function explorerLinks(address: string): { source: string; name: string; url: string }[] {
  const encoded = encodeURIComponent(address);
  return SOURCES.filter((s) => s.kind === "explorer-links" && s.linkTemplate).map((s) => ({
    source: s.id,
    name: s.name,
    url: s.linkTemplate!.replace("{address}", encoded),
  }));
}
