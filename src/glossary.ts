/**
 * Domain vocabulary and the nuances that trip up general-purpose models.
 *
 * Served as the `collector://glossary` resource. This exists because the
 * expensive mistakes in this space are not arithmetic - they are an agent
 * using a word confidently and wrongly. "Owner" means something different
 * when an item is listed. "Burned" is wrong for a Candy pack that was opened.
 * A floor is not a valuation. Each entry below is a correction to a specific
 * plausible-but-wrong answer, not a dictionary definition for its own sake.
 */

export interface GlossaryEntry {
  term: string;
  meaning: string;
  /** The wrong answer this entry exists to prevent. */
  pitfall?: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: "floor price",
    meaning: "The lowest current ASK on one venue - the cheapest listing, not a completed trade.",
    pitfall:
      "It is not a valuation and not what the item last sold for. On a thin book a single optimistic or panic listing sets it, and each venue has its own floor.",
  },
  {
    term: "last sale",
    meaning: "The price of the most recent completed trade.",
    pitfall:
      "Can sit far above or below the floor. A single sale is an anecdote; use a run of recent sales before calling it a price.",
  },
  {
    term: "escrow (listed item)",
    meaning:
      "On Solana marketplaces, listing an item usually transfers it to a marketplace-controlled account until it sells or is delisted.",
    pitfall:
      "The on-chain owner of a listed item is the MARKETPLACE, not the seller. Reporting an escrow address as 'the owner' is wrong; the seller is whoever transferred it in. Magic Eden also refuses to list holdings for its own escrow addresses.",
  },
  {
    term: "serial number / edition",
    meaning: "The item's position in a numbered run, written like 29/250 - the 29th of 250 printed.",
    pitfall:
      "Low serials and 'jersey numbers' can carry large premiums, so an average price across a whole series hides most of what collectors care about.",
  },
  {
    term: "1-of-1",
    meaning: "A single unique item with no other copies in the set.",
    pitfall: "Has no meaningful floor - there is nothing to compare it against. Value comes from its last sale or an auction.",
  },
  {
    term: "provenance",
    meaning: "The full chain of custody: every owner an item has had, from mint to now.",
    pitfall:
      "Mainstream NFT and enhanced-transaction APIs return EMPTY transfer history for Metaplex Core assets. Empty means unsupported by that API, never 'never traded'.",
  },
  {
    term: "Metaplex Core",
    meaning:
      "The current single-account Solana NFT standard, used by Candy Digital and most 2026 Solana collectibles.",
    pitfall:
      "Not the same as legacy SPL NFTs or compressed NFTs (cNFTs). Tools written for legacy SPL silently return nothing for Core assets rather than erroring.",
  },
  {
    term: "compressed NFT (cNFT)",
    meaning: "An NFT stored in a Merkle tree rather than its own account, making large mints cheap.",
    pitfall: "Requires an indexer (DAS) to read. Plain RPC cannot enumerate them, so 'not found' may mean 'not indexed here'.",
  },
  {
    term: "burn vs return-to-treasury",
    meaning: "Burning destroys an asset permanently. Returning it to a treasury wallet does not.",
    pitfall:
      "Opening a Candy Digital pack RETURNS the pack to the treasury; it is not burned. Treating 'held by treasury' as 'destroyed' - or as 'still sealed' - both produce wrong pack counts.",
  },
  {
    term: "pack (sealed)",
    meaning:
      "An NFT that represents unopened contents. On Solana it is usually its own Metaplex Core asset in a packs collection, distinct from the cards it will produce.",
    pitfall:
      "A pack and its cards are different assets with different histories. Provenance on a card starts at the pack OPEN, not at the pack purchase; provenance on the pack ends when it is opened.",
  },
  {
    term: "pack open: burn vs return",
    meaning:
      "Opening a pack consumes it and mints or transfers the contents to the opener. Many projects BURN the pack (its account is closed, ~0.0009 SOL stub remains); Candy Digital RETURNS the pack to a treasury wallet instead.",
    pitfall:
      "'The pack is gone from the wallet' has two different meanings. Burned = destroyed; returned = held by treasury and still counts as an existing asset. Counting treasury-held packs as sealed, or returned packs as burned, both produce wrong supply numbers.",
  },
  {
    term: "gacha",
    meaning:
      "Pay-to-pull randomised packs, often backed by vaulted physical cards (Collector Crypt, Jupiter Gacha, PokeHub). The dominant tokenized-card mechanic on Solana in 2026.",
    pitfall:
      "Pull odds and card values are set by the operator, not the chain. The chain can prove what you received; it cannot prove the odds were fair. Say which.",
  },
  {
    term: "permanent delegate (pack context)",
    meaning: "Packs commonly carry a permanent burn or transfer delegate so the opening program can consume them without a second signature.",
    pitfall:
      "Expected on a pack. On a finished card it means the issuer retains the power to move or destroy your asset - get_asset_trust surfaces which case you are looking at.",
  },
  {
    term: "pack rip / pull",
    meaning: "Opening a sealed pack and revealing the cards inside.",
    pitfall: "A pull feed is an event stream. Miss a stretch of events and the totals are quietly short - reconcile against the issuer's counts.",
  },
  {
    term: "graded / slab",
    meaning:
      "A physical card authenticated and scored (usually 1-10) by a grader such as PSA, then sealed in a tamper-evident case.",
    pitfall: "Grade dominates price. A PSA 10 and a PSA 9 of the same card are effectively different assets and should never be averaged together.",
  },
  {
    term: "vaulted / redeemable",
    meaning:
      "A token backed by a physical item held in a vault, redeemable for the real card. Collector Crypt works this way.",
    pitfall: "Price tracks the physical card, not crypto-native scarcity, and redemption permanently removes it from circulation.",
  },
  {
    term: "permanent delegate",
    meaning: "A plugin letting the issuer move or burn an asset from any wallet without the holder's signature.",
    pitfall:
      "A real custody caveat that most tools never surface. An asset with a permanent delegate is not unconditionally yours, however the marketplace presents it.",
  },
  {
    term: "frozen / soulbound",
    meaning: "An asset that cannot currently be transferred, often while staked, listed, or pending a redemption.",
    pitfall: "Frozen items still appear in holdings. Counting them as liquid supply overstates what can actually trade.",
  },
  {
    term: "wash trading",
    meaning: "Trades between wallets under one controller, inflating apparent volume.",
    pitfall: "Volume is the easiest metric to fake. Owner counts and sale counts across independent wallets are harder to manipulate.",
  },
  {
    term: "mint count vs current supply",
    meaning: "How many were ever created, versus how many still exist after burns and closures.",
    pitfall: "They diverge over time. Quoting mint count as 'supply' overstates scarcity for any set that has burned items.",
  },
  {
    term: "holders vs owners",
    meaning: "The number of distinct wallets holding at least one item.",
    pitfall:
      "One person can hold many wallets and marketplace escrows count as wallets, so holder counts are an upper bound on the number of real collectors.",
  },
];

/** How agents should present this data. Served alongside the glossary. */
export const PRESENTATION_RULES: string[] = [
  "Compare venues in a small table (venue, floor, currency, listings) rather than prose - the reader is comparing numbers, and a table is how numbers get compared.",
  "Never present floors in different currencies as a ranked list or call one 'cheaper'. If `reconciliation.comparable` is false, repeat its `verdict` instead of computing your own comparison.",
  "Render a provenance trail as a dated timeline, oldest first, one line per event, naming the marketplace where one is known. It reads as a story and that is the point.",
  "Always surface `stale: true` and `cachedAt` when present. A number without its age invites the reader to trust it more than they should.",
  "Quote serial numbers exactly as issued (29/250). Never round, average, or drop them - the serial is often most of the value.",
  "State what was NOT checked. These tools cover specific chains and standards; silence about a gap reads as coverage.",
  "Prefer counts and dates over adjectives. 'Seven transfers since July 15' beats 'frequently traded'.",
];
