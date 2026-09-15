/**
 * Curated collection registry - the domain knowledge layer.
 *
 * Generic NFT tools make the user hunt for marketplace symbols and on-chain
 * addresses. This registry maps human names ("candy gold series", "batman")
 * to the identifiers each data source needs. Entries are hand-verified;
 * anything NOT listed here still works by passing a Magic Eden symbol or a
 * Metaplex Core collection address directly to the tools.
 */

import { createRequire } from "node:module";

export interface RegistryEntry {
  id: string;
  name: string;
  platform: string;
  /** Magic Eden collection symbol, when the collection trades there. */
  meSymbol?: string;
  /** Metaplex Core collection address for direct on-chain stats/provenance. */
  coreCollection?: string;
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

// ----------------------------------------------------- Candy Digital, all of it
// The hand-written entries above are the ones with cross-venue ids filled in
// by hand. Every Candy Digital collection on Solana is appended from
// data/candy-collections.json: name, category and the Metaplex Core collection
// address, exported from the CandyScan tracker's reconciled list. The address
// is what lets get_collection_stats, provenance and custody answer by name
// without a Magic Eden symbol; the symbol resolves through the directory.
interface CandyRow {
  address: string;
  name: string;
  category: string;
}

function loadCandyCollections(): RegistryEntry[] {
  let rows: CandyRow[] = [];
  try {
    const file = createRequire(import.meta.url)("../data/candy-collections.json") as { collections?: CandyRow[] };
    rows = Array.isArray(file.collections) ? file.collections : [];
  } catch {
    return [];
  }
  const known = new Set(REGISTRY.map((e) => e.coreCollection).filter(Boolean));
  const ids = new Set(REGISTRY.map((e) => e.id));
  const out: RegistryEntry[] = [];
  for (const r of rows) {
    if (typeof r.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.address)) continue;
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    if (known.has(r.address)) continue;
    const name = r.name.trim();
    const category = typeof r.category === "string" ? r.category.trim() : "Other";
    let id = "candy-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    for (let n = 2; ids.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    ids.add(id);
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    out.push({
      id,
      name: `Candy Digital - ${name}`,
      platform: `Candy Digital (${category === "MLB" ? "official MLB license" : category === "DC" ? "official DC license" : category})`,
      coreCollection: r.address,
      keywords: [...new Set(["candy", "candy digital", category.toLowerCase(), ...tokens])],
      notes: "From the CandyScan collection list. The Magic Eden symbol resolves by name through the directory; pass a symbol directly for listings and sales.",
    });
  }
  return out;
}

REGISTRY.push(...loadCandyCollections());

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
