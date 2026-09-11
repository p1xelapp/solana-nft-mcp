/**
 * How collectibles are actually handled - escrow, freezing, delegates,
 * royalties, lock and unlock - per standard and per venue.
 *
 * The rest of this server answers "what is true about this item?". This file
 * answers the question a collector asks immediately afterwards and that every
 * marketplace page ducks: what does that MEAN for me? A card whose collection
 * carries a permanent transfer delegate is still shown as "Owned by you". A
 * card sitting in a pool account is shown as sold when it is merely listed. A
 * 10% royalty is presented identically whether a program enforces it or a
 * marketplace politely suggests it.
 *
 * Two rules hold this file honest.
 *
 * First, every entry carries the URL it was read from. Program behaviour was
 * taken from program SOURCE where the source is public (mpl-core, MMM), from
 * the standard's own documentation otherwise, and from a live account read
 * where the fact is about a specific collection. A marketing page is a claim,
 * not a fact, and is labelled `documented:` so a contradicting `observed:`
 * can sit beside it instead of being quietly averaged with it.
 *
 * Second, `verified: false` is a legitimate answer. Several venues publish no
 * technical description of their listing custody at all, and one help centre
 * is behind a bot wall. Saying so is more useful than a confident sentence
 * nobody can reproduce, and it is the difference between a knowledge base and
 * a rumour with a footnote.
 *
 * Entries are written for a collector, not a developer: short, plain, and
 * naming exact program addresses only where the address is the fact.
 */

/** Where an entry sits: a standard, one decodable plugin, a venue, or a question people actually ask. */
export type MechanicsCategory = "standard" | "plugin" | "external-plugin" | "venue" | "question";

export interface MechanicsEntry {
  /** Stable slug. Safe to reference from other tools' output. */
  id: string;
  category: MechanicsCategory;
  title: string;
  /**
   * The decoded plugin type this entry explains, spelled exactly as
   * src/lib/coreplugins.ts names it, so a decoded asset maps straight onto it.
   */
  pluginType?: string;
  /** Venue key this entry describes, lowercase and unspaced. */
  venue?: string;
  /** What the holder of the authority can do, in one line. */
  power?: string;
  /** Who normally holds that authority: owner, update authority, or a program. */
  heldBy?: string;
  /** What it means for the person holding the item. Plain words, under 80 words. */
  plain: string;
  /** The wrong conclusion this entry exists to prevent. */
  pitfall: string;
  /** What the standard or the venue says in its own documentation. */
  documented?: string;
  /** What reading the chain or the program source actually shows. */
  observed?: string;
  /** False when the claim could not be confirmed from a primary source this session. */
  verified: boolean;
  /** Required whenever verified is false: why the check could not be completed. */
  unverifiedReason?: string;
  /** The URL this entry was read from. */
  source: string;
  /** When that URL was read, ISO date. */
  sourceRead: string;
  /** Extra words a person might search with. The title and body are searched too. */
  keywords: string[];
}

const READ = "2026-09-11";

// Documentation roots, so a moved docs site is one edit rather than fifty.
const CORE = "https://metaplex.com/docs/core/plugins";
const CORE_SC = "https://www.metaplex.com/docs/smart-contracts/core";
const CORE_SRC = "https://raw.githubusercontent.com/metaplex-foundation/mpl-core/main/programs/mpl-core/src";
const MMM_SRC = "https://raw.githubusercontent.com/me-foundation/mmm/main/programs/mmm/src/instructions/mpl_core_asset";

export const MECHANICS: MechanicsEntry[] = [
  // ---------------------------------------------------------------- standards
  {
    id: "standard-core",
    category: "standard",
    title: "Metaplex Core - one account per item",
    plain:
      "Core keeps an entire collectible in a single Solana account holding the owner, the name, the image link and a list of plugins. Plugins are the rules: royalties, freezes, delegates. Rules set on the collection apply to every item in it, so an item that looks plain can still be governed by its collection.",
    pitfall:
      "Reading only the item's own account and concluding 'no rules apply'. The collection account has to be read too, or a permanent delegate set there is invisible.",
    documented:
      "Core uses one account per asset instead of mint plus metadata plus token account; plugins hook into create, transfer and burn to enforce rules. Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d.",
    verified: true,
    source: CORE_SC,
    sourceRead: READ,
    keywords: ["core", "mpl-core", "metaplex", "standard", "asset", "plugin", "collection"],
  },
  {
    id: "standard-core-plugin-classes",
    category: "standard",
    title: "Core plugins: owner-managed, authority-managed, permanent",
    plain:
      "Three families. Owner-managed plugins need your signature to add and fall away when the item is sold. Authority-managed plugins belong to the issuer and can be changed while you hold the item. Permanent plugins can only be attached when the item is first created - and then they never go away, for any owner, ever.",
    pitfall:
      "Treating 'delegate' as one thing. An owner-approved transfer delegate is you lending a key; a permanent transfer delegate is the issuer keeping one.",
    documented:
      "Permanent plugins are plugins that may only be added to a Core Asset at the time of creation. Owner-managed authority is automatically revoked upon transfer.",
    verified: true,
    source: CORE,
    sourceRead: READ,
    keywords: ["owner managed", "authority managed", "permanent", "families", "revoked", "creation"],
  },
  {
    id: "standard-token-metadata",
    category: "standard",
    title: "Token Metadata - the legacy Solana NFT",
    plain:
      "The older standard, still holding most pre-2024 Solana collectibles. One item is spread over several accounts: a mint, a token account that records who holds it, and a metadata account with the name and creators. Program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s. Tools written for it return nothing for Core items, and the reverse is also true.",
    pitfall:
      "An empty answer from a legacy-only tool is not evidence the item never traded. It usually means the tool cannot see that standard at all.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/token-metadata/token-standard",
    sourceRead: READ,
    keywords: ["token metadata", "legacy", "spl", "mint", "token account", "metadata account", "tokenstandard"],
  },
  {
    id: "standard-pnft",
    category: "standard",
    title: "Programmable NFT (pNFT) - permanently frozen on purpose",
    plain:
      "A pNFT's token account is kept frozen at all times, so nothing can move, lock or burn it except the Token Metadata program, which checks the creator's rules first. That is how royalties became compulsory on this standard. Frozen here is the normal resting state of a healthy item, not a problem.",
    pitfall:
      "Reporting a pNFT as 'frozen, cannot be sold'. Every pNFT reads frozen; it still trades normally through marketplaces that support the standard.",
    documented:
      "The underlying token account is kept frozen at all times to ensure nobody can transfer, lock or burn Programmable NFTs without going through the Token Metadata program.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/token-metadata/token-standard",
    sourceRead: READ,
    keywords: ["pnft", "programmable", "mip-1", "mip1", "frozen", "royalty enforcement"],
  },
  {
    id: "standard-token-auth-rules",
    category: "standard",
    title: "Token Auth Rules - the rule book behind pNFTs",
    plain:
      "A separate program, auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg, stores rule sets that say which programs may transfer, delegate or burn a pNFT. If a marketplace is not allowed by the rule set, the transaction fails outright. That is the machinery collectors experience as 'this collection forces royalties'.",
    pitfall:
      "Assuming a listing failure means the item is broken or stolen. A rule set refusing an unapproved marketplace looks identical to an error and is working as designed.",
    documented:
      "An advanced metaprogramming tool meant to evaluate permissions of an instruction occurring on an SPL Token; a RuleSet stores rules per operation such as transfer, delegate or burn.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/token-auth-rules",
    sourceRead: READ,
    keywords: ["auth rules", "ruleset", "rule set", "mip-1", "enforcement", "allowlist", "auth9"],
  },
  {
    id: "standard-tm-delegates",
    category: "standard",
    title: "Token Metadata delegates: sale, transfer, utility, staking, locked transfer",
    plain:
      "On pNFTs you can hand out narrow keys. Sale lets someone transfer it and stops you moving it meanwhile - that is a marketplace listing. Locked Transfer and Utility and Staking all lock it in place while active. Plain Transfer does not lock; you keep using the item. On older NFTs there is one blunt Standard delegate that can transfer, burn and freeze.",
    pitfall:
      "Seeing a delegate and assuming theft. Most are listings or staking. The question is which role it is and whether it is still there after you delist.",
    documented:
      "Sale, Locked Transfer, Utility and Staking delegates can lock the asset and prevent owner transfers while active; Transfer cannot lock; Standard applies to all except pNFTs.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/token-metadata/delegates",
    sourceRead: READ,
    keywords: ["delegate", "sale delegate", "utility", "staking", "locked transfer", "standard delegate", "approve"],
  },
  {
    id: "standard-tm-frozen",
    category: "standard",
    title: "\"Frozen\" token accounts on the legacy standard",
    plain:
      "On legacy NFTs a freeze authority can freeze the token account that holds your item. Frozen means it cannot move until the same authority thaws it. Staking programs and some listings do this deliberately so the item never leaves your wallet. Every pNFT is frozen permanently by design, which is a different thing entirely.",
    pitfall:
      "Counting frozen items as tradable supply. They still show in holdings and in floor-ceiling maths while being unable to sell.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/token-metadata/token-standard",
    sourceRead: READ,
    keywords: ["frozen", "freeze authority", "thaw", "locked", "staked", "soulbound"],
  },
  {
    id: "standard-tm-collection-verified",
    category: "standard",
    title: "Collection verification - the checkmark that is actually on chain",
    plain:
      "Any item can claim to belong to a famous collection. Only the collection's own authority can flip that claim to verified. Wallets, explorers and marketplaces are told they must check the verified flag before showing an item as part of a collection. An unverified claim is just text the minter typed.",
    pitfall:
      "Trusting the collection name printed on an item. Without the verified flag it proves nothing, and fake items copy names exactly.",
    documented:
      "Explorers, Wallets and Marketplaces MUST CHECK that Verified is true. Verified can only be set true if the Authority on the Collection NFT has run one of the Token Metadata Verify instructions.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/token-metadata/collections",
    sourceRead: READ,
    keywords: ["collection", "verified", "checkmark", "fake", "counterfeit", "verify"],
  },
  {
    id: "standard-bubblegum",
    category: "standard",
    title: "Compressed NFTs (Bubblegum) - real, but not stored like the others",
    plain:
      "A compressed item is a leaf in a Merkle tree rather than its own account, which is why huge mints cost almost nothing. The full data lives in the transaction that created or changed it. Program BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY. You can transfer, burn and delegate one exactly as you would any other item.",
    pitfall:
      "Cheap to mint is not the same as worthless, and 'my wallet shows nothing' usually means the wallet is not using an indexer.",
    documented:
      "Compressed NFTs exist within Merkle Trees; the entire NFT data is stored in the transaction that created the compressed NFT, and updates are saved as a changelog.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/bubblegum",
    sourceRead: READ,
    keywords: ["cnft", "compressed", "bubblegum", "merkle", "tree", "leaf", "proof"],
  },
  {
    id: "standard-das-required",
    category: "standard",
    title: "Why compressed items need an indexer (DAS)",
    plain:
      "Because the data is in past transactions rather than in an account, an ordinary node cannot list your compressed items. An indexer - the Digital Asset Standard API - watches the chain and keeps a readable copy. If your tool does not use one, compressed holdings simply do not appear.",
    pitfall:
      "Reading 'not found' as 'does not exist'. For compressed items it almost always means 'not indexed by the source you asked'.",
    documented:
      "The Metaplex DAS API indexes compressed NFT information in real time so users can fetch cNFT data without crawling through millions of transactions.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/bubblegum",
    sourceRead: READ,
    keywords: ["das", "indexer", "not found", "missing", "helius", "api", "read"],
  },
  {
    id: "standard-decompression",
    category: "standard",
    title: "Decompression - turning a compressed item into an ordinary one",
    plain:
      "A version 1 compressed item can be decompressed, which creates real mint, metadata and master edition accounts for it. It is one way: once fully decompressed there is no going back. Version 2 compressed items cannot be decompressed at all, so the option depends entirely on which tree the project used.",
    pitfall:
      "Promising a holder they can always decompress. On a Bubblegum V2 tree that option does not exist, and the difference is invisible in a wallet.",
    documented:
      "Decompression is only available for Bubblegum V1 assets. Bubblegum V2 does not support decompression. Once fully decompressed the Cancel Redeem instruction can no longer be used.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/bubblegum-v2/faq",
    sourceRead: READ,
    keywords: ["decompress", "redeem", "cancel redeem", "v1", "v2", "one way", "irreversible"],
  },
  {
    id: "standard-bubblegum-v2",
    category: "standard",
    title: "Bubblegum V2 - compressed items that can be frozen and can enforce royalties",
    plain:
      "Version 2 compressed items live inside Metaplex Core collections, so the collection's plugins apply to them. Projects can freeze and thaw them, make them permanently non-transferable, and enforce royalties - none of which version 1 could do. V1 and V2 trees are not interchangeable.",
    pitfall:
      "Carrying V1 assumptions over. 'Compressed items cannot be frozen or enforce royalties' was true once and is now wrong for V2 collections.",
    documented:
      "Project creators can now freeze and thaw cNFTs; cNFTs can now be made soulbound; since Bubblegum V2 uses MPL-Core Collections it is possible to enforce royalties on cNFTs.",
    verified: true,
    source: "https://www.metaplex.com/docs/smart-contracts/bubblegum-v2/faq",
    sourceRead: READ,
    keywords: ["bubblegum v2", "cnft", "freeze", "soulbound", "royalty", "core collection"],
  },
  {
    id: "standard-token-2022",
    category: "standard",
    title: "Token-2022 extensions that matter to a collector",
    plain:
      "Token-2022 is the newer token program, and four of its optional extensions change what owning something means: Non-Transferable makes it soul-bound; Permanent Delegate gives one account unlimited power to transfer or burn any holding; Default Account State can start every new holding frozen; Transfer Hook runs the issuer's code on every transfer.",
    pitfall:
      "These are mint-level settings, not plugins, so a Core or Token Metadata plugin reader will not see them at all. Absence of warnings is not absence of powers.",
    documented:
      "Permanent Delegate has unlimited delegate privileges over any account for that mint, meaning that it can burn or transfer any amount of tokens. Default Account State can force all new token accounts to be frozen.",
    observed:
      "This server decodes Metaplex Core and Token Metadata; it does not read Token-2022 mint extensions, so it cannot confirm which collectibles use them.",
    verified: true,
    source: "https://www.solana-program.com/docs/token-2022/extensions",
    sourceRead: READ,
    keywords: ["token-2022", "token22", "extension", "non-transferable", "permanent delegate", "transfer hook", "default account state"],
  },

  // ------------------------------------------------------------------ plugins
  {
    id: "plugin-royalties",
    category: "plugin",
    title: "Royalties plugin",
    pluginType: "Royalties",
    power: "Sets the creator fee percentage, who it splits to, and which programs may move the item at all.",
    heldBy: "The issuer's update authority.",
    plain:
      "Says what cut the creators take on resale and, through its rule set, whether that cut can be dodged. With no rule set it is a polite request any marketplace can ignore. With a program allow-list the Core program refuses transfers by anyone not on the list, so the fee is genuinely unavoidable on those venues.",
    pitfall:
      "Quoting the percentage as if it were collected. Without a rule set it is advisory, and the money is handled by marketplaces rather than by the Core program either way.",
    documented:
      "None: any program can transfer the asset, royalties are advisory only. ProgramAllowList: only programs on the list can transfer. Royalty collection and distribution is handled by marketplaces, not the Core program.",
    verified: true,
    source: `${CORE}/royalties`,
    sourceRead: READ,
    keywords: ["royalty", "royalties", "creator fee", "percentage", "allowlist", "denylist", "rule set", "enforced"],
  },
  {
    id: "plugin-royalties-rule-sets",
    category: "plugin",
    title: "Royalty rule sets: allow-list versus deny-list",
    power: "Restricts which on-chain programs may transfer the item.",
    heldBy: "The issuer's update authority.",
    plain:
      "An allow-list names the only programs allowed to move the item; everything else, including a marketplace the issuer dislikes, is refused on chain. A deny-list is the opposite and blocks named programs only. An allow-list that omits the System Program would also stop you sending the item to a friend.",
    pitfall:
      "Treating an allow-list as an anti-theft feature. It restricts venues, not thieves, and it can quietly strand an item if the listed marketplace shuts down.",
    documented:
      "ProgramAllowList: only programs on the list can transfer, enabling strict enforcement. ProgramDenyList: all programs can transfer except those on the list.",
    verified: true,
    source: `${CORE}/royalties`,
    sourceRead: READ,
    keywords: ["allowlist", "allow list", "denylist", "deny list", "rule set", "programs", "blocked", "cannot transfer"],
  },
  {
    id: "plugin-freeze-delegate",
    category: "plugin",
    title: "Freeze delegate",
    pluginType: "FreezeDelegate",
    power: "Locks the item so it cannot be transferred or burned while it stays in the owner's wallet.",
    heldBy: "The owner by default; commonly delegated to a staking or marketplace program.",
    plain:
      "You add this one yourself, usually without realising, when you stake an item or list it on a venue that does not take custody. The item stays in your wallet but cannot move until whoever holds the freeze thaws it. Selling the item ends the arrangement.",
    pitfall:
      "A frozen item still shows in your holdings and in any portfolio total. It is not liquid until it is thawed, and only the freeze holder can thaw it.",
    documented:
      "Freezes Core Assets, blocking transfers and burns while the asset remains in the owner's wallet; described as the best choice for marketplace listings and escrowless staking.",
    verified: true,
    source: `${CORE}/freeze-delegate`,
    sourceRead: READ,
    keywords: ["freeze", "frozen", "locked", "staking", "thaw", "unstake", "cannot transfer"],
  },
  {
    id: "plugin-transfer-delegate",
    category: "plugin",
    title: "Transfer delegate",
    pluginType: "TransferDelegate",
    power: "Lets one named party move the item once, without asking again.",
    heldBy: "Approved by the owner, normally to a marketplace program.",
    plain:
      "The ordinary way to list something without handing it over: you approve a marketplace to move it if a buyer pays. The permission burns itself out - it is revoked automatically the moment the item transfers - and you can revoke it yourself at any time before that.",
    pitfall:
      "A transfer delegate still sitting there after you delisted means someone can still move the item once. Revoke it rather than assuming delisting did.",
    documented:
      "Allows a delegate to transfer an Asset without requiring owner approval for each transaction; authority is automatically revoked after transfer; owners can revoke it using revokePluginAuthority.",
    verified: true,
    source: `${CORE}/transfer-delegate`,
    sourceRead: READ,
    keywords: ["transfer delegate", "approve", "listing", "revoke", "one time", "marketplace"],
  },
  {
    id: "plugin-burn-delegate",
    category: "plugin",
    title: "Burn delegate",
    pluginType: "BurnDelegate",
    power: "Lets one named party destroy the item at any time.",
    heldBy: "Approved by the owner, usually to a game or pack-opening program.",
    plain:
      "You granted someone permission to destroy this item - normally a crafting or pack-opening flow that consumes it. They can use it whenever they like until you revoke it, and it disappears by itself when the item changes hands.",
    pitfall:
      "Expected on something designed to be consumed, alarming on a finished card. If you are not mid-way through a game flow, revoke it.",
    documented:
      "Allows a delegate to burn an Asset; once added the delegate can burn the Asset at any time without owner approval; authority is automatically revoked when the Asset transfers.",
    verified: true,
    source: `${CORE}/burn-delegate`,
    sourceRead: READ,
    keywords: ["burn delegate", "destroy", "consume", "craft", "pack open", "revoke"],
  },
  {
    id: "plugin-update-delegate",
    category: "plugin",
    title: "Update delegate",
    pluginType: "UpdateDelegate",
    power: "Lets extra addresses edit the item's data and add or remove plugins.",
    heldBy: "The issuer's update authority, granted to helpers or partner programs.",
    plain:
      "Someone besides the original issuer can change this item: its name, its image link, its collection membership, and which plugins are attached. On a collection, such a delegate can also eject items from the collection. It cannot change who the root update authority is.",
    pitfall:
      "The traits and artwork you bought are not fixed. Anything an update delegate can edit can change after the sale without your involvement.",
    documented:
      "Delegates can modify most Asset data including collection membership, can add, remove and update plugins, and a Collection delegate can remove any Asset from the Collection.",
    verified: true,
    source: `${CORE}/update-delegate`,
    sourceRead: READ,
    keywords: ["update delegate", "metadata", "edit", "change traits", "collection membership", "mutable"],
  },
  {
    id: "plugin-permanent-freeze-delegate",
    category: "plugin",
    title: "Permanent freeze delegate",
    pluginType: "PermanentFreezeDelegate",
    power: "Locks or unlocks the item at will, forever, through every future owner.",
    heldBy: "The issuer, set when the item was created.",
    plain:
      "The issuer kept a switch that can stop this item moving at any moment, and keeps it after you sell. It is how soul-bound badges, memberships and compliance locks are built. Nobody can remove it later, because permanent plugins can only be added when the item is created.",
    pitfall:
      "Currently unfrozen does not mean safe. The power to freeze is the fact; the current state is just today's setting.",
    documented:
      "Provides irrevocable freeze authority that persists across transfers; authority is never revoked, even after transfers; can only be added at Asset or Collection creation.",
    verified: true,
    source: `${CORE}/permanent-freeze-delegate`,
    sourceRead: READ,
    keywords: ["permanent freeze", "soulbound", "non-transferable", "locked forever", "compliance", "membership"],
  },
  {
    id: "plugin-permanent-transfer-delegate",
    category: "plugin",
    title: "Permanent transfer delegate",
    pluginType: "PermanentTransferDelegate",
    power: "Moves the item out of any wallet, any number of times, without the holder signing.",
    heldBy: "The issuer or its program, set when the item was created.",
    plain:
      "Whoever holds this can take the item from your wallet without you. It is normal on packs and rentals, where a program has to move things for you. On a finished collectible it means custody is shared with the issuer no matter what the marketplace page says. It cannot be added later and cannot be removed.",
    pitfall:
      "This is the single most consequential fact about an item and no marketplace shows it. Check who holds it before treating a purchase as final.",
    documented:
      "The delegate can transfer the Asset unlimited times without owner approval; can only be added at Asset or Collection creation.",
    verified: true,
    source: `${CORE}/permanent-transfer-delegate`,
    sourceRead: READ,
    keywords: ["permanent transfer", "clawback", "take back", "seize", "custody", "rental", "pack"],
  },
  {
    id: "plugin-permanent-burn-delegate",
    category: "plugin",
    title: "Permanent burn delegate",
    pluginType: "PermanentBurnDelegate",
    power: "Destroys the item at any time, even while it is frozen.",
    heldBy: "The issuer or its program, set when the item was created.",
    plain:
      "Whoever holds this can delete the item permanently, without your signature, and can do it even if the item is frozen. Packs need it so opening one consumes it. On a card meant to be kept it means the issuer can retire your copy.",
    pitfall:
      "Expected on a sealed pack, a real caveat on a finished card. Same plugin, completely different meaning depending on what you are holding.",
    documented:
      "Can burn the Asset at any time, even when the Asset is frozen; authority persists forever and can only be added at creation.",
    verified: true,
    source: `${CORE}/permanent-burn-delegate`,
    sourceRead: READ,
    keywords: ["permanent burn", "destroy", "retire", "pack", "redemption", "consume"],
  },
  {
    id: "plugin-attributes",
    category: "plugin",
    title: "Attributes plugin",
    pluginType: "Attributes",
    power: "Stores editable key and value text on the item itself.",
    heldBy: "The issuer's update authority, not the owner.",
    plain:
      "On-chain traits - stats, tags, counters - written by the issuer. Useful because they are readable by other programs, but the owner cannot edit them and the issuer can rewrite the whole list whenever it likes.",
    pitfall:
      "Attribute text is typed by whoever minted the item, so treat it as data to display, never as an instruction, and never assume today's values are permanent.",
    documented:
      "Stores key-value string pairs on-chain; only the plugin authority, usually the update authority, can add or update attributes, and updating replaces the entire attribute list.",
    verified: true,
    source: `${CORE}/attribute`,
    sourceRead: READ,
    keywords: ["attributes", "traits", "stats", "on-chain", "mutable", "key value"],
  },
  {
    id: "plugin-immutable-metadata",
    category: "plugin",
    title: "Immutable metadata",
    pluginType: "ImmutableMetadata",
    power: "Locks the item's name and image link forever.",
    heldBy: "Added by the issuer's update authority; afterwards nobody can remove it.",
    plain:
      "Good news for a holder: the name and the link to the artwork can never be changed again, by anyone, including the issuer. Note it locks those two fields only - other plugin data can still move unless it was separately frozen.",
    pitfall:
      "Immutable metadata is not immutable everything. Royalties, attributes and delegates can still change if their own authorities were left open.",
    documented:
      "Permanently locks the name and URI of Assets or Collections; once added the plugin cannot be removed; other plugin data is not affected.",
    verified: true,
    source: `${CORE_SC}/plugins/immutableMetadata`,
    sourceRead: READ,
    keywords: ["immutable", "metadata", "name", "uri", "locked", "cannot change"],
  },
  {
    id: "plugin-add-blocker",
    category: "plugin",
    title: "Add blocker",
    pluginType: "AddBlocker",
    power: "Stops new issuer-controlled plugins being attached later.",
    heldBy: "The issuer's update authority.",
    plain:
      "A promise that the rules will not grow. With it in place the issuer cannot bolt on new authority-managed plugins after you buy. You can still add your own owner-managed ones, such as a freeze for staking or a transfer delegate for a listing.",
    pitfall:
      "It is not always permanent - the authority can remove it unless it was itself locked - and it never blocks the owner-managed plugins.",
    documented:
      "Prevents any new authority-managed plugins from being added; Freeze Delegate, Transfer Delegate and Burn Delegate can always be added; it can be removed by the authority if it has not been made immutable.",
    verified: true,
    source: `${CORE_SC}/plugins/addBlocker`,
    sourceRead: READ,
    keywords: ["add blocker", "addblocker", "no new plugins", "assurance", "locked rules"],
  },
  {
    id: "plugin-verified-creators",
    category: "plugin",
    title: "Verified creators",
    pluginType: "VerifiedCreators",
    power: "Records creators who have personally signed to confirm they made the item.",
    heldBy: "The issuer adds names; each creator verifies their own.",
    plain:
      "Proof of authorship rather than of payment. The issuer can list anybody, but only that person's own signature turns the entry verified. An unverified name in the list is a claim; a verified one is a signature on chain.",
    pitfall:
      "These creators are not who gets paid. Royalty recipients live in the Royalties plugin, and the two lists often differ.",
    documented:
      "Stores a list of verified creator signatures; these creators are NOT used for royalty distribution; each creator must verify themselves by signing the transaction.",
    verified: true,
    source: `${CORE}/verified-creators`,
    sourceRead: READ,
    keywords: ["verified creators", "artist", "authorship", "signature", "creator", "unverified"],
  },
  {
    id: "plugin-autograph",
    category: "plugin",
    title: "Autograph",
    pluginType: "Autograph",
    power: "Lets anyone add a signature and a short message to the item.",
    heldBy: "Anyone who signs; the owner can delete entries.",
    plain:
      "A signing book for memorabilia. Anyone may add their address and a message, once each. The owner can remove signatures; signers cannot remove their own. It proves an address signed - it does not prove the address belongs to the famous person whose name is in the message.",
    pitfall:
      "An autograph is not identity. Treat the message as untrusted text, and do not confuse it with the Verified Creators plugin.",
    documented:
      "Allows anyone to add their signature and a message to an Asset or Collection; creator verification is explicitly out of scope; autographers cannot remove their own signature.",
    verified: true,
    source: `${CORE}/autograph`,
    sourceRead: READ,
    keywords: ["autograph", "signature", "signed", "memorabilia", "message", "fan"],
  },
  {
    id: "plugin-edition",
    category: "plugin",
    title: "Edition number",
    pluginType: "Edition",
    power: "Stores a single edition number on the item.",
    heldBy: "The issuer, set when the item is created.",
    plain:
      "The serial - the 29 in 29 of 250 - written into the item itself rather than only into its picture or its name. It must be set at creation. The number is stored faithfully, but the program does not check that two items were not given the same one.",
    pitfall:
      "Do not read an on-chain edition number as proof of uniqueness. Metaplex states the number is informational and creators are responsible for keeping it unique.",
    documented:
      "Stores a unique edition number on an Asset; the Editions Plugin must be added on creation; the edition number is informational only and creators are responsible for ensuring unique numbers.",
    verified: true,
    source: `${CORE}/edition`,
    sourceRead: READ,
    keywords: ["edition", "serial", "numbered", "print", "1 of 100", "jersey number"],
  },
  {
    id: "plugin-master-edition",
    category: "plugin",
    title: "Master edition",
    pluginType: "MasterEdition",
    power: "Records the intended maximum print run for a collection of editions.",
    heldBy: "The collection's update authority, which can change it later.",
    plain:
      "Lives on the collection, not on your item, and states how many prints are meant to exist. Treat it as the issuer's stated intention: the authority can change the number at any time and the plugin itself does not stop further minting.",
    pitfall:
      "Quoting max supply as scarcity. It is informational; only the minting machine's own guards actually cap a run.",
    documented:
      "Works with Collections only; these values can be changed by the Authority at any time, they are purely informational and not enforced; use Candy Machine with appropriate guards to actually enforce supply limits.",
    verified: true,
    source: `${CORE}/master-edition`,
    sourceRead: READ,
    keywords: ["master edition", "max supply", "print run", "scarcity", "supply", "collection"],
  },
  {
    id: "plugin-bubblegum-v2",
    category: "plugin",
    title: "Bubblegum V2 marker on a collection",
    pluginType: "BubblegumV2",
    power: "Allows compressed items to be members of this Core collection.",
    heldBy: "The Bubblegum program itself, and only it.",
    plain:
      "A flag on the collection saying its members may be compressed items living in a Merkle tree. Some of the collection therefore cannot be read from a plain node at all. It also limits which other plugins the collection is allowed to carry.",
    pitfall:
      "Counting holders or supply for such a collection from plain RPC gives a number that is quietly short of the compressed members.",
    documented:
      "The Bubblegum V2 plugin allows a Core collection to contain Compressed NFTs from the Bubblegum program; the authority for this plugin can only be the Bubblegum program.",
    verified: true,
    source: `${CORE_SRC}/plugins/internal/permanent/bubblegum_v2.rs`,
    sourceRead: READ,
    keywords: ["bubblegum", "bubblegumv2", "compressed", "cnft", "collection", "merkle"],
  },
  {
    id: "plugin-freeze-execute",
    category: "plugin",
    title: "Freeze execute",
    pluginType: "FreezeExecute",
    power: "Blocks the item from acting as a signer and spending what it holds.",
    heldBy: "The owner by default.",
    plain:
      "A Core item can own tokens of its own and sign for them. This plugin freezes that ability, so the item can still be transferred and sold but cannot spend or move whatever it is carrying. While it is frozen, the freeze itself cannot be revoked or removed.",
    pitfall:
      "Do not read this as the item being locked. Ordinary transfers still work; it is the item's wallet-like behaviour that is switched off.",
    documented:
      "Allows any authority to lock the asset so its Execute lifecycle event can be conditionally blocked; the default authority is the asset owner; if frozen, revocation and removal are rejected.",
    verified: true,
    source: `${CORE_SRC}/plugins/internal/owner_managed/freeze_execute.rs`,
    sourceRead: READ,
    keywords: ["freeze execute", "execute", "asset signer", "spend", "wallet", "contents"],
  },
  {
    id: "plugin-permanent-freeze-execute",
    category: "plugin",
    title: "Permanent freeze execute",
    pluginType: "PermanentFreezeExecute",
    power: "Blocks the item from spending what it holds, permanently and through every owner.",
    heldBy: "The issuer's update authority.",
    plain:
      "The issuer's version of the same switch, and it survives sales. If an item is advertised as carrying tokens or prizes, this decides whether a future owner can ever release them. It can only be attached at creation.",
    pitfall:
      "An item that contains value is only as good as its ability to release it. Check who controls this before paying for the contents.",
    documented:
      "Allows any authority to lock the asset so its Execute lifecycle event can be conditionally blocked; the default authority for this plugin is the update authority.",
    verified: true,
    source: `${CORE_SRC}/plugins/internal/permanent/permanent_freeze_execute.rs`,
    sourceRead: READ,
    keywords: ["permanent freeze execute", "execute", "contents", "locked", "issuer", "prize"],
  },
  {
    id: "plugin-groups",
    category: "plugin",
    title: "Groups",
    pluginType: "Groups",
    power: "Records the parent groups a collection belongs to.",
    heldBy: "The collection's authority, through dedicated group instructions.",
    plain:
      "A collection-level plugin that files a collection under one or more parent groups, so a set can sit inside a larger family. While a collection still belongs to a group, the program refuses to burn it.",
    pitfall:
      "This appears on collections, not on your item. Seeing it on a decoded account means you are looking at a collection account.",
    documented:
      "Groups plugin for collections; stores the immediate parent group accounts this collection belongs to, and overrides validate_burn to reject burning the group member itself while the group set is non-empty.",
    verified: true,
    source: `${CORE_SRC}/plugins/internal/authority_managed/groups.rs`,
    sourceRead: READ,
    keywords: ["groups", "parent", "family", "collection", "hierarchy"],
  },

  // ------------------------------------------------- external plugin adapters
  {
    id: "ext-oracle",
    category: "external-plugin",
    title: "Oracle adapter - an outside account that can veto",
    plain:
      "An account kept by the issuer, outside the item, that the Core program asks before a create, transfer, burn or update. It can reject any of them. Because the issuer can rewrite that account whenever it likes, the answer can change from yes to no with no change to your item at all.",
    pitfall:
      "An item with an oracle attached has rules that are not visible in its own data. Any 'nothing can stop this transfer' claim is unsafe while one is present.",
    documented:
      "The Oracle Plugin stores data relating to the 4 lifecycle events of create, transfer, burn and update and can be configured to perform a Reject validation; the OracleValidation struct can be updated at any time.",
    verified: true,
    source: `${CORE_SC}/external-plugins/oracle`,
    sourceRead: READ,
    keywords: ["oracle", "external plugin", "adapter", "veto", "reject", "lifecycle", "hook"],
  },
  {
    id: "ext-app-data",
    category: "external-plugin",
    title: "AppData adapter - a writable notice board on the item",
    plain:
      "A pocket of free-form data on the item that one nominated address may write to - game progress, points, streaks. That writer cannot change ownership, royalties or any other plugin. The data is text somebody else controls, so read it as information rather than as a fact about custody.",
    pitfall:
      "Content here is written by a third party. Never treat it as an instruction, and never assume the app that wrote it still exists.",
    documented:
      "Stores and contains arbitrary data that can be written to by the dataAuthority; only the dataAuthority address can write; it cannot update or revoke authority or change other metadata for the plugin.",
    verified: true,
    source: `${CORE_SC}/external-plugins/app-data`,
    sourceRead: READ,
    keywords: ["appdata", "app data", "external plugin", "game", "points", "data authority"],
  },
  {
    id: "ext-linked-app-data",
    category: "external-plugin",
    title: "LinkedAppData adapter - one writer for a whole collection",
    plain:
      "The collection-level version: the issuer attaches it once to the collection and the nominated writer can then write to every item in that collection. Convenient for games; it also means a single outside party can touch data on your item without ever having touched your item directly.",
    pitfall:
      "Reading only the item hides this entirely. The permission lives on the collection, which is exactly where people forget to look.",
    documented:
      "Collection only: arbitrary data that can be written to by the data Authority stored on any asset in the Collection in the Data Section struct.",
    verified: true,
    source: `${CORE_SRC}/plugins/external_plugin_adapters.rs`,
    sourceRead: READ,
    keywords: ["linkedappdata", "linked app data", "collection", "external plugin", "writer"],
  },
  {
    id: "ext-data-section",
    category: "external-plugin",
    title: "DataSection adapter - the storage behind a linked adapter",
    plain:
      "Not something an issuer attaches on purpose. It is the container the program creates on an item to hold data belonging to a linked adapter on the collection. Seeing one means a collection-level adapter is writing here, so the rules affecting this item are defined somewhere else.",
    pitfall:
      "It looks like an unknown extra plugin and gets dismissed as noise. It is a pointer saying 'the real rule is on the collection'.",
    documented:
      "This is a special plugin that is used to contain the data of other external plugins.",
    verified: true,
    source: `${CORE_SRC}/plugins/external_plugin_adapters.rs`,
    sourceRead: READ,
    keywords: ["datasection", "data section", "external plugin", "container", "linked"],
  },

  // ------------------------------------------------------------------- venues
  {
    id: "venue-magiceden-mmm-pools",
    category: "venue",
    title: "Magic Eden pools (MMM) take real custody of Core items",
    venue: "mmm",
    plain:
      "Magic Eden's automated pools are a separate program from its order book. When you put a Core item into a pool to sell, the program transfers it to the pool account - the pool becomes the on-chain owner until it sells or you withdraw it. Activity from these pools is labelled 'mmm' rather than 'magiceden_v2'.",
    pitfall:
      "The pool address will look like a stranger holding your card. It is a program account you can withdraw from, not a transfer away.",
    documented:
      "The deposit_sell instruction builds a Core TransferV1 with new_owner set to the pool key, then increments the pool's sell-side asset count.",
    observed:
      "Read from the MMM program source this session; MMM's mainnet program is mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc.",
    verified: true,
    source: `${MMM_SRC}/mpl_core_deposit_sell.rs`,
    sourceRead: READ,
    keywords: ["mmm", "magic eden", "pool", "amm", "escrow", "custody", "deposit", "moved"],
  },
  {
    id: "venue-magiceden-core-plugin-refusal",
    category: "venue",
    title: "Magic Eden pools refuse some Core items - but only check the item",
    venue: "mmm",
    plain:
      "The pool program rejects any item carrying a burn delegate, a permanent transfer delegate, a permanent burn delegate, or a freeze delegate held by someone other than the owner. That is a sensible guard against depositing something the issuer can snatch back. It reads the item's own plugins only.",
    pitfall:
      "Issuers commonly set permanent delegates on the COLLECTION instead, where this check does not look. Passing the guard is not evidence that no permanent delegate applies.",
    documented:
      "CORE_DENY_LIST covers FreezeDelegate, BurnDelegate, PermanentTransferDelegate and PermanentBurnDelegate; FreezeDelegate is allowed only when its authority is the owner.",
    observed:
      "assert_valid_core_plugins is called with the asset account only, so collection-inherited plugins are not examined.",
    verified: true,
    source: `${MMM_SRC}/mpl_core_wrap.rs`,
    sourceRead: READ,
    keywords: ["magic eden", "mmm", "deny list", "unsupported", "permanent delegate", "collection", "rejected"],
  },
  {
    id: "venue-magiceden-royalties",
    category: "venue",
    title: "Magic Eden and royalties on Solana",
    venue: "magiceden",
    plain:
      "On Magic Eden's pool program the creator's cut is a number supplied with the purchase rather than a fixed rate, so unless the collection's own rules force the issue, how much reaches creators depends on the transaction. Where a collection uses a Core program allow-list, enforcement comes from the chain instead of from the venue.",
    pitfall:
      "A collection advertising 10% does not mean 10% was paid. Read the rule set, not the marketing.",
    documented:
      "MMM's fulfil instructions take buyside_creator_royalty_bp as an argument, constrained only to 10000 basis points or less.",
    observed:
      "Magic Eden's own help-centre pages on optional royalties could not be read this session - see the separate entry.",
    verified: true,
    source: `${MMM_SRC}/sol_mpl_core_fulfill_sell.rs`,
    sourceRead: READ,
    keywords: ["magic eden", "royalty", "optional", "creator fee", "basis points", "mmm"],
  },
  {
    id: "venue-magiceden-help-centre",
    category: "venue",
    title: "Magic Eden's published royalty policy could not be checked",
    venue: "magiceden",
    plain:
      "Magic Eden is widely reported to let buyers choose none, half or all of a collection's optional royalty. That is not stated here as fact because the page saying so could not be opened. The program-level facts in the neighbouring entries were read from Magic Eden's own source code and do stand.",
    pitfall:
      "Repeating a percentage policy from memory. Venue policies change quietly and this one is unread.",
    documented: "Not established this session.",
    observed:
      "help.magiceden.io and docs.magiceden.io both answered HTTP 403 to a plain fetch and to a real headless browser; only a search-engine snippet was available.",
    verified: false,
    unverifiedReason:
      "Both Magic Eden documentation hosts are behind a bot wall that refused every request made this session, so no primary text was read.",
    source: "https://help.magiceden.io/en/articles/6645652-understanding-optional-royalties-on-solana",
    sourceRead: READ,
    keywords: ["magic eden", "optional royalties", "help centre", "policy", "blocked", "unverified"],
  },
  {
    id: "venue-magiceden-order-book",
    category: "venue",
    title: "Magic Eden's order book (M2) and where a listed Core item sits",
    venue: "magiceden_v2",
    plain:
      "Magic Eden's main marketplace program is M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K. Its published entry points cover legacy NFTs, programmable NFTs and OCP items, and the escrow account named in its documentation holds the BUYER's funds. What it does with a Core item on listing is not described anywhere public.",
    pitfall:
      "Do not assume 'escrow' means your item. On this program the documented escrow is the bid wallet; the item's own custody on listing is undocumented.",
    documented:
      "M2's README lists sell, cancel_sell and execute_sale entry points plus mip1 and ocp variants, and defines escrow_payment_account as a buyer PDA.",
    observed:
      "This project's provenance decoder sees Core items transferred to a Magic Eden-controlled account when they are listed, which matches custody rather than delegation.",
    verified: false,
    unverifiedReason:
      "M2's public README documents no Metaplex Core entry points, so the listing path for Core items is inferred from observed transfers rather than read from a primary description.",
    source: "https://raw.githubusercontent.com/me-foundation/m2/main/README.md",
    sourceRead: READ,
    keywords: ["magic eden", "m2", "order book", "listing", "escrow", "core", "custody"],
  },
  {
    id: "venue-tensor",
    category: "venue",
    title: "Tensor",
    venue: "tensor",
    plain:
      "Tensor charges a 2% fee to the buyer and nothing to the seller. Where a collection enforces royalties, the buyer always pays them in full; where royalties are optional, the buyer picks none, half or all. Its shared escrow holds SOL for your bids, not items.",
    pitfall:
      "Shared escrow is a funding pool, not a vault for cards. Do not read it as Tensor holding collectibles.",
    documented:
      "2% taker fee, 0% maker fee; enforced royalties are always paid by the taker and never by the maker; optional royalties can be set to none, half or all. Marketplace program TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp.",
    verified: true,
    source: "https://docs.tensor.trade/trade/fees-and-royalties.md",
    sourceRead: READ,
    keywords: ["tensor", "taker fee", "maker", "royalty", "shared escrow", "tcmp", "bid"],
  },
  {
    id: "venue-tensor-custody",
    category: "venue",
    title: "What Tensor does with a listed item is not published",
    venue: "tensor",
    plain:
      "Tensor's own documentation describes prices, fees and order types but never says whether listing moves an item into a program account or leaves it in your wallet under a delegate. Anyone telling you which it is, without a transaction to point at, is guessing.",
    pitfall:
      "Assuming Tensor works the way Magic Eden's pools do. The mechanics differ per program and per standard, and this one is undocumented.",
    documented:
      "Tensor publishes five program addresses - Marketplace, AMM, Escrow, Whitelist and Fees - with no description of listing custody.",
    verified: false,
    unverifiedReason:
      "Neither the fees page, the sell-or-list page nor the protocols page states whether a listing escrows the item or delegates it, and Tensor's programs are not published as readable source.",
    source: "https://docs.tensor.foundation/protocols",
    sourceRead: READ,
    keywords: ["tensor", "listing", "custody", "escrow", "delegate", "unknown", "undocumented"],
  },
  {
    id: "venue-opensea-solana",
    category: "venue",
    title: "OpenSea on Solana",
    venue: "opensea",
    plain:
      "OpenSea now supports buying and selling Solana collectibles, but only for a selected group of collections - not the whole chain. Its marketplace fee is 1% of the sale, included in the price shown to buyers, and creator earnings are enforced on some collections and optional on others.",
    pitfall:
      "An empty OpenSea result for a Solana collection usually means 'not one of the supported collections', not 'no listings'.",
    documented:
      "Using OpenSea, you can swap tokens on Solana and buy and sell Solana NFTs from a selected group of collections; 1% fee for selling NFTs, included in the price displayed to buyers.",
    verified: true,
    source: "https://support.opensea.io/en/articles/8867082-which-blockchains-are-compatible-with-opensea",
    sourceRead: READ,
    keywords: ["opensea", "solana", "os2", "fee", "creator earnings", "supported collections"],
  },
  {
    id: "venue-opensea-solana-details",
    category: "venue",
    title: "OpenSea on Solana: currencies and listing custody are not documented",
    venue: "opensea",
    plain:
      "OpenSea explains which contract types make creator earnings enforced, but every rule it publishes is about Ethereum-style contracts. Nothing states how earnings are enforced on Solana, which currencies a Solana listing may be priced in, or whether listing moves the item.",
    pitfall:
      "Carrying OpenSea's Ethereum royalty rules across to Solana. They are written about contract standards that do not exist on Solana.",
    documented:
      "Enforced or optional creator earnings are decided by contract type, listed only as OpenSea Studio contracts and ERC721-C or ERC1155-C compatible contracts.",
    verified: false,
    unverifiedReason:
      "OpenSea's help centre gives no Solana-specific rule for royalty enforcement, accepted currencies or listing custody, and no primary page stating them was found this session.",
    source: "https://support.opensea.io/en/articles/8867026-how-do-i-set-creator-earnings-on-opensea",
    sourceRead: READ,
    keywords: ["opensea", "usdc", "sol", "currency", "royalty", "enforced", "solana", "unverified"],
  },
  {
    id: "venue-candy-custody",
    category: "venue",
    title: "Candy Digital: what the wallet says versus what the collection says",
    venue: "candy",
    plain:
      "Candy gives each fan a self-custody Solana wallet and says trading is open on third-party marketplaces. Its MLB collections also carry permanent transfer, burn and freeze delegates held by Candy's own update authority. Both are true: you hold the card, and Candy retains the power to move, destroy or lock it without your signature.",
    pitfall:
      "'Self-custody' describes the wallet, not the card. Read the collection's plugins before calling a Candy card unconditionally yours.",
    documented:
      "Candy will create a self-custody Solana wallet for you; secondary trading will be available through supported third-party Solana marketplaces including Magic Eden.",
    observed:
      "Reading collections 8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K and JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n from a public Solana node this session showed PermanentTransferDelegate, PermanentBurnDelegate and PermanentFreezeDelegate, all held by the update authority, on the collection - so inherited by every card in it.",
    verified: true,
    source: "https://www.candy.io/faq",
    sourceRead: READ,
    keywords: ["candy", "candy digital", "mlb", "self custody", "permanent delegate", "clawback", "wallet"],
  },
  {
    id: "venue-candy-royalty-allowlist",
    category: "venue",
    title: "Candy Digital royalties are enforced by an allow-list",
    venue: "candy",
    plain:
      "Candy's MLB collections set a 10% royalty split three ways and back it with a program allow-list, so only the named programs can move a card at all. That makes the fee genuinely unavoidable, and it also means a venue not on the list simply cannot trade these cards.",
    pitfall:
      "If a marketplace shows a Candy card but cannot complete a sale, the allow-list is the likely reason. It is a collection rule, not a bug at the venue.",
    documented:
      "Metaplex Core embeds royalty enforcement directly into the code. That protects creators, licensors, and rights holders every time a collectible changes hands.",
    observed:
      "Decoding the Royalties plugin on both collections this session showed 10% with rule set ProgramAllowList naming the System Program, Magic Eden's M2 program, Tensor's marketplace program and one further program not identified here.",
    verified: true,
    source: "https://blog.candy.io/candy-collectibles-migration-to-solana-what-fans-need-to-know/",
    sourceRead: READ,
    keywords: ["candy", "royalty", "10%", "allowlist", "enforced", "mlb", "program list"],
  },
  {
    id: "venue-collector-crypt",
    category: "venue",
    title: "Collector Crypt - a vaulted physical card behind the token",
    venue: "collectorcrypt",
    plain:
      "You send in a graded card, Collector Crypt stores it and issues you a token for it. Trading the token changes who owns the card without the card moving. When you want the physical card you burn the token and they ship it, which is why burning here is a delivery instruction rather than a loss.",
    pitfall:
      "A burn in this collection is a redemption, not destruction of value. Counting it as a burn in supply maths overstates what vanished.",
    documented:
      "Your cards must be graded; ship them to us, we inspect them and store them in the vault; once a card is vaulted you receive an NFT for it. You burn the NFT for the card you're withdrawing and pay for shipping.",
    verified: true,
    source: "https://docs.collectorcrypt.com/vault/withdraw",
    sourceRead: READ,
    keywords: ["collector crypt", "vault", "redeem", "withdraw", "burn", "physical", "graded", "slab"],
  },
  {
    id: "venue-panini",
    category: "venue",
    title: "Panini is not on Solana",
    venue: "panini",
    plain:
      "Panini's digital cards live on its own platform, with a bridge to the Ethereum main network rather than to Solana, and OpenSea named as the exclusive marketplace for the bridged cards. When a card is bridged out, Panini locks the original in escrow so only one version can trade. Unopened packs cannot be bridged at all.",
    pitfall:
      "Looking for Panini cards among Solana collections. Nothing in this server's Solana sources will ever show them.",
    documented:
      "Panini Blockchain will open its Ethereum bridge to its customers; when a card is minted on Ethereum, the original Panini digital card is locked in escrow with Panini so that only one version of the asset can be transacted at a time.",
    verified: true,
    source: "https://blog.paniniamerica.net/panini-blockchain-bridge-to-open-for-business/",
    sourceRead: READ,
    keywords: ["panini", "ethereum", "bridge", "opensea", "escrow", "not solana", "packs"],
  },

  // ---------------------------------------------------------------- questions
  {
    id: "q-moved-to-unknown-wallet",
    category: "question",
    title: "Why did my item move to a wallet I do not recognise?",
    plain:
      "Listing for sale is the usual answer. Some marketplace programs take the item into an account they control until it sells or you withdraw it, so the chain shows a transfer to an address you never chose. Magic Eden's pool program does exactly this with Core items. Delisting returns it.",
    pitfall:
      "That address is the on-chain owner while the listing stands, so any tool asking 'who owns this' will name the marketplace, not you. It is not a theft and not a sale.",
    documented:
      "MMM's Core deposit instruction transfers the asset with new_owner set to the pool account.",
    verified: true,
    source: `${MMM_SRC}/mpl_core_deposit_sell.rs`,
    sourceRead: READ,
    keywords: ["escrow", "moved", "unknown wallet", "stolen", "missing", "listed", "disappeared", "who owns"],
  },
  {
    id: "q-can-the-project-take-it-back",
    category: "question",
    title: "Can the project take my item back?",
    plain:
      "Only if it kept a permanent delegate, and you can check. A permanent transfer delegate lets the holder move the item out of any wallet; a permanent burn delegate lets them destroy it; a permanent freeze delegate lets them lock it. All three can only be set when the item is created and can never be removed afterwards.",
    pitfall:
      "They can be set on the collection rather than on the item, where most tools never look. Absence on the item alone proves nothing.",
    documented:
      "Permanent plugins may only be added at creation; the delegate can transfer the Asset unlimited times without owner approval, and authority is never revoked even after transfers.",
    verified: true,
    source: `${CORE}/permanent-transfer-delegate`,
    sourceRead: READ,
    keywords: ["take back", "clawback", "seize", "confiscate", "rug", "permanent delegate", "safe", "really own"],
  },
  {
    id: "q-can-i-list-this",
    category: "question",
    title: "Can I list this, or is it locked?",
    plain:
      "A frozen item cannot be sold until it is thawed, and only the party holding the freeze can thaw it. Staking, an active listing, or an issuer's permanent freeze are the usual reasons. Separately, a royalty allow-list can block a specific marketplace even when nothing is frozen at all.",
    pitfall:
      "Frozen items still appear in holdings and in portfolio totals, so a 'value' figure can be mostly items that cannot currently be sold.",
    documented:
      "Freezes Core Assets, blocking transfers and burns while the asset remains in the owner's wallet.",
    verified: true,
    source: `${CORE}/freeze-delegate`,
    sourceRead: READ,
    keywords: ["locked", "frozen", "cannot list", "cannot sell", "stuck", "staked", "thaw", "liquid"],
  },
  {
    id: "q-who-gets-paid",
    category: "question",
    title: "Who gets paid when this sells?",
    plain:
      "The seller, the venue, and sometimes the creators. Venue fees are fixed and small - Tensor charges buyers 2%, OpenSea 1% of the sale. The creator's cut is the variable one: enforced when the collection's rules make the chain refuse non-compliant transfers, and otherwise a courtesy the buyer or the venue can reduce.",
    pitfall:
      "A listed royalty percentage is a rate, not a receipt. Whether it is actually paid depends on the collection's rule set and the venue.",
    documented:
      "Enforced royalties are always paid by the taker and never by the maker; optional royalties can be set to none, half or all. OpenSea charges a 1% fee for selling NFTs.",
    verified: true,
    source: "https://docs.tensor.trade/trade/fees-and-royalties.md",
    sourceRead: READ,
    keywords: ["royalty", "who gets paid", "fees", "creator", "cut", "commission", "seller proceeds"],
  },
  {
    id: "q-floor-differs",
    category: "question",
    title: "Why is the floor different on two sites?",
    plain:
      "Because a floor is the cheapest ask on one venue at one moment, in one currency. Different venues carry different sellers, some quote in a stablecoin rather than SOL, some cover only a selected group of collections, and cached figures go stale. Two different numbers are normally two correct answers to two different questions.",
    pitfall:
      "Ranking floors across venues without checking the currency and the timestamp invents a spread that is not there.",
    documented:
      "OpenSea supports Solana NFTs from a selected group of collections, so its book is not the whole chain.",
    verified: true,
    source: "https://support.opensea.io/en/articles/8867082-which-blockchains-are-compatible-with-opensea",
    sourceRead: READ,
    keywords: ["floor", "different", "price", "venue", "currency", "stale", "arbitrage", "compare"],
  },
  {
    id: "q-wash-trading",
    category: "question",
    title: "What is a wash trade and how would I spot one?",
    plain:
      "A wash trade is a sale where the same person is on both sides, done to make an item look busier or dearer than it is. The tell is funding: the buying wallet was paid by the seller, or by whoever funded the seller, shortly before the purchase. Repeated round trips between the same few addresses are the pattern.",
    pitfall:
      "Volume is the easiest number to fake and the one most often quoted. Distinct owner counts and sales between independently funded wallets are much harder to manufacture.",
    documented:
      "Executing a transaction in which the seller is on both sides of the trade in order to paint a misleading picture of an asset's value and liquidity; detection tracked sales to addresses self-financed by the original seller.",
    verified: true,
    source: "https://www.chainalysis.com/blog/2022-crypto-crime-report-preview-nft-wash-trading-money-laundering/",
    sourceRead: READ,
    keywords: ["wash trading", "fake volume", "manipulation", "self-financed", "round trip", "suspicious", "inflated"],
  },
  {
    id: "q-standard-migration",
    category: "question",
    title: "What changes when a project migrates standards?",
    plain:
      "The item is reissued under new rules, so history, custody and tooling all shift at once. Trading history from the old chain or standard does not follow it. Powers that did not exist before - permanent delegates, enforced royalty allow-lists - can appear at creation, because that is the only moment they can be added.",
    pitfall:
      "A migration is the one moment an issuer can add powers it could never add later. Re-read the plugins after a migration even if you read them before.",
    documented:
      "Candy migrated its collectibles to Solana on Metaplex Core, stating that royalty enforcement is embedded directly into the code.",
    observed:
      "The migrated Candy MLB collections read this session carry permanent transfer, burn and freeze delegates that a pre-migration holder never agreed to.",
    verified: true,
    source: "https://blog.candy.io/candy-collectibles-migration-to-solana-what-fans-need-to-know/",
    sourceRead: READ,
    keywords: ["migration", "migrate", "standard", "moved chain", "reissued", "history lost", "new rules"],
  },
];

/**
 * Words a collector uses mapped to words the entries use. Without this, the
 * most common question in this domain - "is my NFT stolen" - matches nothing,
 * because the answer lives under "escrow".
 *
 * Loaded into a Map below: a plain object lookup keyed on caller text answers
 * `constructor` and `toString` with inherited functions, which is a crash (or
 * worse) handed to anyone who types a common word.
 */
const SYNONYM_SOURCE: Record<string, string[]> = {
  stolen: ["escrow", "moved", "listed"],
  gone: ["escrow", "moved", "burn"],
  missing: ["escrow", "das", "indexer"],
  disappeared: ["escrow", "moved", "burn"],
  vault: ["escrow", "collector crypt", "redeem"],
  custody: ["escrow", "permanent delegate", "owner"],
  clawback: ["permanent transfer", "take back"],
  seize: ["permanent transfer", "take back"],
  rug: ["permanent transfer", "take back", "mutable"],
  locked: ["frozen", "freeze"],
  lock: ["frozen", "freeze"],
  unlock: ["frozen", "thaw"],
  soulbound: ["permanent freeze", "non-transferable"],
  staked: ["frozen", "freeze delegate"],
  fee: ["royalty", "creator fee"],
  fees: ["royalty", "creator fee"],
  commission: ["royalty"],
  cut: ["royalty"],
  cnft: ["compressed", "bubblegum"],
  compressed: ["bubblegum", "das"],
  pnft: ["programmable", "auth rules"],
  wash: ["wash trading", "fake volume"],
  fake: ["wash trading", "verified"],
  price: ["floor"],
  worth: ["floor"],
  delegate: ["permanent transfer", "transfer delegate", "freeze delegate"],
  me: ["magic eden"],
  os: ["opensea"],
};

const SYNONYMS = new Map<string, string[]>(Object.entries(SYNONYM_SOURCE));

/**
 * Words that appear in almost every entry's prose. Left in, a question like
 * "what can they do to my card" scores one point against the entire knowledge
 * base and returns it in arbitrary order, which reads as an answer.
 */
const STOPWORDS = new Set([
  "the", "and", "all", "any", "are", "was", "were", "for", "with", "this", "that", "there", "then",
  "what", "why", "how", "who", "when", "does", "did", "can", "could", "will", "would", "should",
  "have", "has", "had", "not", "but", "you", "your", "my", "mine", "our", "its", "his", "her",
  "they", "them", "their", "from", "into", "out", "off", "one", "two", "get", "got", "put", "say",
  "some", "just", "also", "only", "still", "even", "now", "new", "old", "own", "very", "more",
  "about", "after", "before", "than", "because", "been", "being", "over", "under", "such", "like",
  "nft", "nfts", "item", "items", "card", "cards", "thing", "things", "tell", "know", "want",
  // "plugin" appears in the title of every plugin entry; as a search term it
  // selects the whole knowledge base and adds nothing to the words beside it.
  "plugin", "plugins",
]);

/** Longest query this will consider. A question is a question, not a payload. */
const MAX_TOPIC = 200;

/**
 * Below this, a hit is a coincidence: a single shared common word somewhere in
 * a paragraph. Returning nothing beats returning the wrong explanation.
 */
const MIN_SCORE = 2;

/**
 * Reduce a caller-supplied topic to plain search terms.
 *
 * The topic can arrive from a model that was reading marketplace text, so it
 * is treated as hostile: capped, lowercased, stripped to letters, digits and
 * separators, and never compiled into a regular expression. Matching is done
 * with substring tests against our own strings, so nothing a caller sends can
 * change how the search behaves - only what it finds.
 */
function terms(topic: unknown): { phrase: string; words: string[] } {
  if (typeof topic !== "string") return { phrase: "", words: [] };
  const phrase = topic.slice(0, MAX_TOPIC).toLowerCase().replace(/[^a-z0-9 +/-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!phrase) return { phrase: "", words: [] };
  const words: string[] = [];
  for (const w of phrase.split(" ")) {
    if (w.length < 2 || words.includes(w)) continue;
    const expansions = SYNONYMS.get(w) ?? [];
    if (STOPWORDS.has(w) && expansions.length === 0) continue;
    words.push(w);
    for (const s of expansions) if (!words.includes(s)) words.push(s);
    if (words.length >= 40) break;
  }
  return { phrase, words };
}

/** camelCase is a word boundary: FreezeDelegate is also "freeze" and "delegate". */
const splitCamel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

/** The distinct words in a string, camelCase split, for boundary matching. */
function tokensOf(s: string): Set<string> {
  return new Set(
    splitCamel(s)
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter(Boolean),
  );
}

/**
 * Does a search term appear as a WORD here?
 *
 * Substring matching is what made "plugin" score against every plugin entry
 * and "delegate" against half the knowledge base. A multi-word synonym (for
 * example "permanent transfer") has no single token to match, so it falls back
 * to a phrase test on the joined text.
 */
const hasTerm = (tokens: Set<string>, joined: string, w: string): boolean =>
  w.includes(" ") ? joined.includes(w) : tokens.has(w);

/**
 * Find the entries that answer a topic, best match first.
 *
 * An exact plugin type or entry id wins outright: someone typing
 * "FreezeDelegate" wants that plugin, not every entry whose prose contains the
 * word "delegate". Fuzzy scoring runs behind it for the plain-question case.
 *
 * Returns an empty array rather than a guess when nothing matches: a wrong
 * mechanics entry is worse than none, because it is read as an explanation of
 * the asset in front of the reader.
 */
export function explainMechanics(topic: string): MechanicsEntry[] {
  const { phrase, words } = terms(topic);
  if (!phrase) return [];

  // --- exact identity first ------------------------------------------------
  const asked = new Set<string>([phrase, phrase.replace(/\s+/g, ""), phrase.replace(/\s+/g, "-"), ...phrase.split(" ")]);
  const exact: MechanicsEntry[] = [];
  const exactIds = new Set<string>();
  for (const entry of MECHANICS) {
    const pluginType = entry.pluginType?.toLowerCase();
    if ((pluginType && asked.has(pluginType)) || asked.has(entry.id.toLowerCase())) {
      exact.push(entry);
      exactIds.add(entry.id);
    }
  }

  const scored: { entry: MechanicsEntry; score: number }[] = [];
  for (const entry of MECHANICS) {
    if (exactIds.has(entry.id)) continue;
    const id = entry.id.replace(/-/g, " ");
    const title = entry.title.toLowerCase();
    const keys = entry.keywords.join(" ").toLowerCase();
    const body = `${entry.plain} ${entry.pitfall} ${entry.power ?? ""} ${entry.venue ?? ""} ${entry.pluginType ?? ""}`.toLowerCase();
    const keyTokens = tokensOf(keys);
    const titleTokens = tokensOf(`${title} ${id}`);
    const bodyTokens = tokensOf(body);
    let score = 0;
    // An exact phrase in a keyword or title is the strongest signal we have.
    if (keys.includes(phrase) || title.includes(phrase) || id.includes(phrase)) score += 8;
    for (const w of words) {
      if (hasTerm(keyTokens, keys, w)) score += 3;
      else if (hasTerm(titleTokens, `${title} ${id}`, w)) score += 2;
      else if (hasTerm(bodyTokens, body, w)) score += 1;
    }
    if (score >= MIN_SCORE) scored.push({ entry, score });
  }
  return [
    ...exact.sort((a, b) => a.id.localeCompare(b.id)),
    ...scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).map((s) => s.entry),
  ];
}

export interface TrustMechanics {
  /** What the decoded plugins mean for the holder, plainest first. */
  consequences: string[];
  /** The entries those sentences came from, so a caller can show the pitfalls too. */
  entries: MechanicsEntry[];
  /** Plugin types that were decoded but have no entry here, named rather than dropped. */
  unexplained: string[];
  /** Every source URL behind the sentences above. */
  sources: string[];
}

/**
 * Venue names as they arrive from our sources, mapped to the venue keys used
 * above. One name can pull in several keys: "magic eden" covers both the order
 * book (magiceden_v2 in activity feeds) and the pools (mmm), which behave
 * differently enough that a holder needs both. A Map, not an object, for the
 * same reason as the synonyms: `venue` is caller text.
 */
const VENUE_ALIAS_SOURCE: Record<string, string[]> = {
  magiceden: ["magiceden", "magiceden_v2", "mmm"],
  magiceden_v2: ["magiceden", "magiceden_v2"],
  "magic eden": ["magiceden", "magiceden_v2", "mmm"],
  me: ["magiceden", "magiceden_v2", "mmm"],
  mmm: ["mmm", "magiceden"],
  tensor: ["tensor"],
  tensorswap: ["tensor"],
  opensea: ["opensea"],
  os: ["opensea"],
  candy: ["candy"],
  "candy digital": ["candy"],
  collectorcrypt: ["collectorcrypt"],
  "collector crypt": ["collectorcrypt"],
  panini: ["panini"],
};

const VENUE_ALIASES = new Map<string, string[]>(Object.entries(VENUE_ALIAS_SOURCE));

/**
 * Turn a decoded asset's plugin list into plain consequences for its holder.
 *
 * Built to hang off get_asset_trust: that tool says WHICH plugins are present
 * and who holds them, and this says what living with them is like. Plugin
 * types are matched exactly as coreplugins.ts names them; anything unknown is
 * reported in `unexplained` rather than silently dropped, because a plugin we
 * cannot explain is exactly the one worth mentioning.
 */
export function mechanicsForTrust(pluginTypes: string[], venue?: string): TrustMechanics {
  const entries: MechanicsEntry[] = [];
  const unexplained: string[] = [];
  const seen = new Set<string>();

  const wanted = Array.isArray(pluginTypes) ? pluginTypes : [];
  for (const raw of wanted) {
    if (typeof raw !== "string") continue;
    const type = raw.trim();
    if (!type) continue;
    const hit = MECHANICS.find((m) => m.pluginType === type);
    if (!hit) {
      if (!unexplained.includes(type)) unexplained.push(type);
      continue;
    }
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    entries.push(hit);
  }

  // A royalty rule set decides whether the percentage is real, so it travels
  // with the Royalties plugin rather than waiting to be asked for.
  if (wanted.includes("Royalties")) {
    const rs = MECHANICS.find((m) => m.id === "plugin-royalties-rule-sets");
    if (rs && !seen.has(rs.id)) { seen.add(rs.id); entries.push(rs); }
  }

  if (typeof venue === "string" && venue.trim()) {
    const keys = VENUE_ALIASES.get(venue.trim().toLowerCase());
    if (keys) {
      for (const m of MECHANICS) {
        if (m.venue && keys.includes(m.venue) && !seen.has(m.id)) { seen.add(m.id); entries.push(m); }
      }
    }
  }

  const consequences = entries.map((e) => `${e.title}: ${e.plain}`);
  if (unexplained.length) {
    consequences.push(
      `Plugin(s) present that this knowledge base does not explain: ${unexplained.join(", ")}. ` +
        `Treat the custody picture as incomplete rather than clean.`,
    );
  }
  return { consequences, entries, unexplained, sources: [...new Set(entries.map((e) => e.source))] };
}

/** Entries whose claim could not be confirmed from a primary source, with the reason. */
export function unverifiedMechanics(): MechanicsEntry[] {
  return MECHANICS.filter((m) => !m.verified);
}
