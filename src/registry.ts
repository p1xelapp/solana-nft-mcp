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
  /**
   * The family a collection belongs to, when it is one of many that ship
   * together: "DC" is 272 separate Metaplex Core collections, one per comic
   * issue, and nobody asks about them one at a time. find_in_group scans them
   * in batches.
   */
  group?: string;
  /**
   * Other names the same collection is filed under. The hand-written entries
   * predate the generated list and sometimes spell a collection differently
   * from the issuer's own export - the 2026 MLB ICON Series is "2026 MLB Base
   * Series ICONs" there, and the venue directory only knows that spelling. The
   * duplicate address is dropped; its name is kept here so either one resolves.
   */
  aliases?: string[];
  notes?: string;
}

export const REGISTRY: RegistryEntry[] = [
  // ---- Well-known Solana collections, by the names people type.
  //
  // The Magic Eden directory snapshot stops at the venue's 30,000-row
  // ceiling, and "Solana Monkey Business" came back as "Rare Solana Monkey
  // Business" at 0.055 SOL while the real collection sat at 12 SOL under a
  // symbol the snapshot never reached (2026-09-18). A curated row with the
  // aliases people use puts the real one first. Every symbol here was
  // checked against the venue on the date in its note.
  {
    id: "smb-gen2",
    name: "Solana Monkey Business (SMB Gen2)",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "solana_monkey_business",
    keywords: ["smb", "monke", "monkes", "gen2", "monkey business"],
    aliases: ["SMB", "SMB Gen2", "Solana Monkey Business", "Monkes"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "smb-gen3",
    name: "SMB Gen3",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "smb_gen3",
    keywords: ["smb", "gen3", "monke"],
    aliases: ["SMB Gen3", "Solana Monkey Business Gen3"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "okay-bears",
    name: "Okay Bears",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "okay_bears",
    keywords: ["okay", "bears", "bear"],
    aliases: ["Okay Bears", "OKB"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "famous-fox-federation",
    name: "Famous Fox Federation",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "famous_fox_federation",
    keywords: ["fox", "foxes", "fff"],
    aliases: ["Famous Fox Federation", "FFF", "Famous Foxes"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "tensorians",
    name: "Tensorians",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "tensorians",
    keywords: ["tensor", "tensorian"],
    aliases: ["Tensorians"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "degods",
    name: "DeGods",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "degods",
    keywords: ["degod", "dust", "y00ts"],
    aliases: ["DeGods", "De Gods"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "y00ts",
    name: "y00ts",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "y00ts",
    keywords: ["yoots", "y00t", "degods"],
    aliases: ["y00ts", "yoots"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "degenerate-ape-academy",
    name: "Degenerate Ape Academy",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "degenerate_ape_academy",
    keywords: ["daa", "ape", "apes", "degen ape"],
    aliases: ["Degenerate Ape Academy", "DAA", "Degen Apes"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "cets-on-creck",
    name: "Cets on Creck",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "cets_on_creck",
    keywords: ["cets", "cet", "creck"],
    aliases: ["Cets on Creck", "Cets"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "froganas",
    name: "Froganas",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "froganas",
    keywords: ["frog", "frogana"],
    aliases: ["Froganas"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "lifinity-flares",
    name: "Lifinity Flares",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "lifinity_flares",
    keywords: ["lifinity", "flare"],
    aliases: ["Lifinity Flares"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "galactic-geckos",
    name: "Galactic Gecko Space Garage",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "galactic_geckos",
    keywords: ["gecko", "geckos", "ggsg"],
    aliases: ["Galactic Geckos", "GGSG", "Galactic Gecko Space Garage"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "aurory",
    name: "Aurory",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "aurory",
    keywords: ["aurorian", "aurorians"],
    aliases: ["Aurory", "Aurorians"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "taiyo-robotics",
    name: "Taiyo Robotics",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "taiyo_robotics",
    keywords: ["taiyo", "robotics", "robot"],
    aliases: ["Taiyo Robotics", "Taiyo"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "sharx",
    name: "Sharx by Sharky",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "sharx",
    keywords: ["sharky", "shark"],
    aliases: ["Sharx", "Sharx by Sharky"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "primates",
    name: "Primates",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "primates",
    keywords: ["primate"],
    aliases: ["Primates"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "backwoods",
    name: "Backwoods",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "backwoods",
    keywords: ["backwood"],
    aliases: ["Backwoods"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "retardio-cousins",
    name: "Retardio Cousins",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "retardio_cousins",
    keywords: ["retardio", "cousins"],
    aliases: ["Retardio Cousins", "Retardios"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },
  {
    id: "bozo-collective",
    name: "Bozo Collective",
    platform: "Solana community collection (Token Metadata)",
    meSymbol: "bozo_collective",
    keywords: ["bozo", "bozos"],
    aliases: ["Bozo Collective", "Bozos"],
    notes: "Well-known Solana collection. Symbol answered Magic Eden's floor endpoint on 2026-09-18. Listed here because the venue's directory snapshot stops short of its catalogue and a name search for it returned a lookalike first.",
  },

  {
    id: "candy-mlb-icon-2026",
    name: "Candy Digital - 2026 MLB ICON Series",
    platform: "Candy Digital (official MLB license)",
    coreCollection: "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n",
    group: "MLB",
    keywords: ["candy", "candy digital", "mlb", "icon", "baseball", "packs", "2026"],
    notes:
      "Metaplex Core collection. Pack pulls are Core assets - use get_asset_provenance on any card mint for its full ownership trail.",
  },
  {
    id: "candy-mlb-gold-auction-1",
    name: "Candy Digital - MLB Gold Series Auction #1",
    platform: "Candy Digital (official MLB license)",
    coreCollection: "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K",
    group: "MLB",
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
  const byAddress = new Map(REGISTRY.filter((e) => e.coreCollection).map((e) => [e.coreCollection!, e]));
  const ids = new Set(REGISTRY.map((e) => e.id));
  const out: RegistryEntry[] = [];
  for (const r of rows) {
    if (typeof r.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.address)) continue;
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    const already = byAddress.get(r.address);
    if (already) {
      // Same collection, different spelling. Keep the hand-written entry and
      // let the issuer's name reach it too.
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (name && name !== already.name) {
        already.aliases = [...new Set([...(already.aliases ?? []), name])];
        already.keywords = [...new Set([...already.keywords, ...name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)])];
      }
      continue;
    }
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
      group: category,
      keywords: [...new Set(["candy", "candy digital", category.toLowerCase(), ...tokens])],
      notes: "From the CandyScan collection list. The Magic Eden symbol resolves by name through the directory; pass a symbol directly for listings and sales.",
    });
  }
  return out;
}

REGISTRY.push(...loadCandyCollections());

/** Simple scored search over names/keywords/ids. */
export function searchRegistry(query: string): RegistryEntry[] {
  // "Gen 2" and "Gen2" are one token, and a one-character token that is a
  // number is kept: dropping it ranked SMB Gen3 first for "SMB Gen 2"
  // (2026-09-18).
  const norm = (s: string) => s.toLowerCase().replace(/\bgen\s+(\d+)\b/g, "gen$1");
  const q = norm(query).trim();
  if (!q) return REGISTRY;
  const terms = q.split(/\s+/).filter((t) => t.length > 1 || /\d/.test(t));
  if (terms.length === 0) return [];
  // Matching ANY one term was too generous once the registry held 400 Candy
  // collections: "zzzz brand new collection name" matched 27 of them on the
  // word "collection" alone, and a search for something that does not exist
  // came back looking like a result. Half the words have to land, and only the
  // best-scoring entries survive, so a query either identifies something or
  // says it found nothing.
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  const scored = REGISTRY.map((e) => {
    const hay = norm([e.id, e.name, ...e.keywords, ...(e.aliases ?? [])].join(" "));
    const matched = terms.filter((t) => hay.includes(t)).length;
    // An exact name or alias beats a name that merely contains the query:
    // "Solana Monkey Business" is SMB Gen2's alias and a substring of Gen3's,
    // and the shorter-name tiebreak was handing the query to Gen3.
    const exact = e.name.toLowerCase() === q || (e.aliases ?? []).some((a) => a.toLowerCase() === q);
    return { e, matched, score: matched + (hay.includes(q) ? 2 : 0) + (exact ? 3 : 0) };
  }).filter((x) => x.matched >= needed);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((x) => x.score));
  return scored
    .filter((x) => x.score === best)
    .sort((a, b) => a.e.name.length - b.e.name.length)
    .map((x) => x.e);
}
