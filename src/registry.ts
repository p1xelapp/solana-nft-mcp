/**
 * Curated collection registry - the domain knowledge layer.
 *
 * Generic NFT tools make the user hunt for marketplace symbols and on-chain
 * addresses. This registry maps human names ("candy gold series", "panini")
 * to the identifiers each data source needs. Entries are hand-verified;
 * anything NOT listed here still works by passing a Magic Eden symbol or a
 * Metaplex Core collection address directly to the tools.
 */

export interface RegistryEntry {
  id: string;
  name: string;
  platform: string;
  /** Magic Eden collection symbol, when the collection trades there. */
  meSymbol?: string;
  /** Metaplex Core collection address for direct on-chain stats/provenance. */
  coreCollection?: string;
  /** CryptoSlam contract name for the mints/pulls feed. */
  cryptoslamContract?: string;
  /** OpenSea collection slug - used only when OPENSEA_API_KEY is set (optional cross-marketplace view). */
  openseaSlug?: string;
  keywords: string[];
  notes?: string;
}

export const REGISTRY: RegistryEntry[] = [
  {
    id: "candy-mlb-icon-2026",
    name: "Candy Digital - 2026 MLB ICON Series",
    platform: "Candy Digital (official MLB license)",
    coreCollection: "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n",
    keywords: ["candy", "candy digital", "mlb", "icon", "baseball", "packs", "2026"],
    notes:
      "Metaplex Core collection. Pack pulls are Core assets - use get_asset_provenance on any card mint for its full ownership trail.",
  },
  {
    id: "candy-mlb-gold-auction-1",
    name: "Candy Digital - MLB Gold Series Auction #1",
    platform: "Candy Digital (official MLB license)",
    coreCollection: "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K",
    keywords: ["candy", "candy digital", "gold", "gold series", "mlb", "auction", "ohtani", "soto"],
    notes: "36 auctioned packs / 226 cards incl. 1-of-1s. Fully traceable on-chain.",
  },
  {
    id: "panini-america",
    name: "Panini America (NBA / NFL / Soccer / Baseball / NASCAR)",
    platform: "Panini (official league licenses)",
    cryptoslamContract: "panini-america",
    keywords: ["panini", "nba", "nfl", "soccer", "nascar", "sports cards", "blockchain cards"],
    notes:
      "NOT on Solana: Panini's blockchain cards live on Panini's own chain with an Ethereum bridge (OpenSea is the bridged venue). " +
      "Included because pack pulls are a collector question; the feed comes from CryptoSlam, and none of the Solana tools (floors, provenance, trust) apply to it.",
  },
  {
    id: "mad_lads",
    name: "Mad Lads",
    platform: "Backpack / Solana",
    meSymbol: "mad_lads",
    openseaSlug: "mad-lads",
    keywords: ["mad lads", "madlads", "backpack", "solana pfp"],
    notes: 'OpenSea slug is "mad-lads" with the hyphen. "madlads" is a different, near-empty collection that still answers HTTP 200 - a wrong slug here returns junk, not an error.',
  },
  {
    id: "claynosaurz",
    name: "Claynosaurz",
    platform: "Solana",
    meSymbol: "claynosaurz",
    openseaSlug: "claynosaurz",
    keywords: ["clay", "claynosaurz", "dino", "solana collectibles"],
  },
  {
    // OpenSea files every Candy MLB card under ONE collection spanning all
    // series, so it is deliberately NOT attached to the per-series Core
    // entries above: pairing it with one series would compare a single
    // series' on-chain supply against every series' floor and read as if
    // they described the same population.
    id: "candy-mlb-opensea",
    name: "Candy Digital - MLB (all series, OpenSea view)",
    platform: "Candy Digital (official MLB license)",
    openseaSlug: "candy-mlb",
    keywords: ["candy", "candy digital", "mlb", "opensea", "baseball", "cross-marketplace"],
    notes:
      "Needs OPENSEA_API_KEY. Covers every Candy MLB series at once - use the per-series Core entries for a single series.",
  },
  {
    id: "collector-crypt",
    name: "Collector Crypt",
    platform: "Solana (graded physical cards, vaulted)",
    meSymbol: "collector_crypt",
    openseaSlug: "collector-crypt",
    keywords: ["collector crypt", "collectorcrypt", "graded", "psa", "pokemon", "physical", "vault", "slab"],
    notes:
      "Trades in DIFFERENT currencies per venue: SOL on Magic Eden, and both USDC and SOL on OpenSea where " +
      "USDC dominates (100% of the last 50 sales sampled 2026-09-01). The two floors are therefore not " +
      "directly comparable as printed - read floorCurrency per source. Magic Eden's symbol uses an " +
      "underscore (collector_crypt); the hyphenated and unspaced variants both answer HTTP 200 with an " +
      "empty collection.",
  },
];

/** Simple scored search over names/keywords/ids. */
export function searchRegistry(query: string): RegistryEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return REGISTRY;
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  return REGISTRY.map((e) => {
    const hay = [e.id, e.name.toLowerCase(), ...e.keywords].join(" ");
    const score = terms.filter((t) => hay.includes(t)).length + (hay.includes(q) ? 2 : 0);
    return { e, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}
