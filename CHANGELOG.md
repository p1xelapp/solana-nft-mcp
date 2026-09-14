# Changelog

## 1.0.0 - 2026-08-24

Initial public release.

- 8 tools: search_collections, get_collection_stats, get_floor_prices,
  get_recent_sales, get_asset, get_asset_provenance, get_wallet_holdings,
  get_pack_pulls
- `collector://registry` resource + `collection_report` prompt
- Metaplex Core account + TransferV1 provenance decoding (no DAS API needed)
- Zero API keys: Magic Eden v2, CryptoSlam, and plain Solana RPC only
- Per-source rate gates, retries, and stale-on-error caching
- Live smoke suite (`npm test`) exercising every tool over real stdio

## 1.1.0 - 2026-09-01

- Optional OpenSea cross-marketplace source: set `OPENSEA_API_KEY` and pass
  (or registry-resolve) an `openseaSlug` to add OpenSea floor/volume/owners to
  `get_collection_stats` and OpenSea sales to `get_recent_sales`. Without the
  key nothing changes - the server stays zero-config by default.
- Registry entries can now carry `openseaSlug`.

## 1.1.1 - 2026-09-01

- Upstream errors now carry the reason, not just a status code. Every source
  previously surfaced a bare `HTTP 400`, discarding the body that explained
  what actually went wrong; an agent relaying that dead end sends the user
  hunting for a bug that isn't there. Error bodies are redacted (any
  configured key is stripped) and truncated before they reach output.
- `get_wallet_holdings` now explains the marketplace-escrow case. Magic Eden
  blocks its own escrow accounts from the wallet endpoint, and an address
  taken from `get_asset_provenance` is often exactly that - a listed item's
  on-chain owner is the escrow, not the seller. The tool now says so and
  points at the transfer that names the seller.

## 1.2.0 - 2026-09-01

- **The OpenSea path is now verified against the live API**, not just compiled.
  Verifying it found that it never worked end to end: a stdio MCP server is
  launched with a small allowlisted environment and does not inherit shell
  variables, so `OPENSEA_API_KEY` never reached the server and the
  cross-marketplace view silently stayed off. Documented the `env` block that
  MCP clients actually require, and the smoke suite now forwards the key the
  same way a real client does.
- Registry gained four verified OpenSea slugs: `mad-lads`, `claynosaurz`,
  `candy-mlb` (a new `candy-mlb-opensea` entry - OpenSea files every Candy MLB
  series under one collection, so it is deliberately not attached to the
  per-series Core entries, which would compare different populations), and a
  new `collector-crypt` entry priced in USDC rather than SOL.
- Smoke suite gained a SKIP status and an OpenSea case that skips cleanly with
  no key, so the zero-key path stays the tested default.

## 1.3.0 - 2026-09-01

- **Cross-source reconciliation.** `get_collection_stats` now returns a
  `reconciliation` block whenever two venues quote the same collection: which
  is actually cheapest, the spread between them, and, most important, whether the
  two numbers can be compared at all. Collector Crypt is the case that forced
  it: Magic Eden quotes 0.053 SOL, OpenSea quotes 9 USDC. Printed side by side
  those read as a 170x gap; converted they roughly agree. The block refuses to
  rank across currencies and says why, rather than letting an agent pick one
  and be confidently wrong. No USD conversion on purpose - a stale price feed
  produces wrong answers with the same confidence as a good one.
- **`collector://glossary` resource.** Domain vocabulary where each entry names
  the specific wrong answer it prevents: a floor is an ask not a valuation, a
  listed item's on-chain owner is the marketplace escrow, an opened Candy pack
  is returned to treasury rather than burned, a PSA 10 and PSA 9 are different
  assets. Ships with presentation rules so agents render comparisons as tables
  and provenance as a dated timeline.
- Collector Crypt registry entry corrected: it trades on BOTH venues - SOL on
  Magic Eden under `collector_crypt` (underscore), and predominantly USDC on
  OpenSea. The previous note claimed USDC only.

## 1.4.0 - 2026-09-01

- **`identify` - works on collections that did not exist yesterday.** A curated
  registry is permanently incomplete: collections launch daily and providers
  disappear (SimpleHash closed March 2025, Reservoir sunset October 2025,
  Magic Eden wound down EVM and Bitcoin by March 2026). `identify` takes any
  address, symbol, slug or plain name, probes live sources, and reports what
  each one said - including the probes that found nothing, what was NOT checked
  and why, and a confidence rating. Verified against `okay_bears`, which has no
  registry entry and was still resolved from live data. An empty result now
  means "the places I can see do not list it", never "it does not exist".
- **`get_integration_recipe` - the reason to use this over a search engine.**
  Looking a number up is solved. Building something that keeps looking it up
  correctly for months is not. Five recipes (sales bot, floor dashboard,
  provenance page, wallet tracker, pack watcher) carrying verified endpoints,
  real rate limits, a runnable skeleton, steady-state cost, a pre-launch
  checklist, and the ways each integration fails SILENTLY - drawn from
  production incidents rather than documentation.
- Startup banner counts its tools instead of asserting a hand-written number,
  which had already gone stale.

## 1.5.0 - 2026-09-01

Security, verification, and protocol-currency release.

- **Untrusted metadata is now neutralised before it reaches a model.** Every
  "name" a collectibles API returns is text somebody chose when they minted,
  and minting is permissionless. An attacker can mint an asset whose name is a
  fake message boundary followed by instructions, list it, and wait for an
  agent to read it - an indirect prompt injection with a permanent, publicly
  addressable payload (OWASP: MCP Tool Poisoning). All name fields from chain,
  Magic Eden, OpenSea and CryptoSlam now pass through a neutraliser that strips
  invisible and bidirectional-override characters, collapses line breaks,
  defangs delimiter markup, caps length, and flags what it found. Real names
  are untouched.
- **`verify_claim` - "don't trust, verify" as a tool.** Checks whether a
  statement is actually true rather than just reporting data: supply,
  never-traded, ownership, and floor claims. Returns confirmed, contradicted or
  unverifiable, with the observed numbers, where they were read, and
  instructions to reproduce the check independently - so the answer does not
  require trusting this server either. It answers UNVERIFIABLE rather than
  guessing.
- **Tool results now include `structuredContent`** alongside the existing JSON
  text block, so spec-current clients parse typed data instead of scraping a
  string. The text block is retained for older clients, as the spec asks.

## 1.5.1 - 2026-09-01

Panel-review release - positioning and the things three kinds of users asked for.

- `verify_claim` now returns a one-line `receipt` safe to paste into a Discord
  argument: verdict, the numbers the chain showed, and where it came from.
- README leads with three tools and the prompt that reaches each, instead of
  eleven names. Tool names are frozen from here: agents reference them in
  prompts and a rename breaks integrations silently.
- Dropped "the first MCP server for licensed digital collectibles" - an
  unfalsifiable claim that adjacent tools could contest. The pitch is now the
  testable one: zero keys, and the Metaplex Core transfer history mainstream
  indexers return empty.

## 1.6.0 - 2026-09-01

- **`get_asset_trust`** - decodes the Metaplex Core plugin registry straight
  from account bytes and turns it into custody facts: permanent transfer,
  burn and freeze delegates (who can act on the asset without the holder),
  frozen state, whether royalties are enforced by a program rule set or merely
  advisory, mutable vs immutable metadata, on-chain edition numbers. Layout
  verified against the mpl-core program source. Expected on packs (they are
  consumed on open); a red flag on a card meant to be kept.
- Glossary learns pack mechanics: sealed packs as separate assets, burn-on-open
  vs return-to-treasury, gacha, and the pack-context reading of permanent
  delegates. The 2026 Solana card market is gacha-shaped and models get the
  open mechanics wrong constantly.
- Offline suite decodes a captured real Core account (test/fixtures) so the
  byte layout is pinned by a test, not by memory.

## 1.7.0 - 2026-09-04

- **`get_wallet_profile`** - what an address holds, read as a collector would:
  items grouped by collection with share of wallet, which collection dominates,
  listed and compressed counts, the royalty each collection asks for, share of
  total supply where a supply is known (chain for registry collections, OpenSea
  with a key), a floor-times-count CEILING for the largest positions with the
  assumptions spelled out, and wallet age plus transaction count from the chain
  (bounded walk, reported as "at least" when cut).
- **`get_wallet_activity`** - how an address trades: buys and sells with SOL
  totals, net flow, venue split (order book vs AMM pools), top collections,
  every flip with hold time and P&L before fees, a behaviour label (flipper,
  holder, mixed, seller, lister, quiet) with its reason, and the first purchase
  in the window. With an OpenSea key, plain transfers are included so "airdropped
  or bought?" gets an evidence-based answer that still refuses to say "airdrop"
  when the chain only shows a transfer.
- Solana on OpenSea (live since 2026-08-31): `search_collections` also searches
  the few hundred Solana collections OpenSea indexes, returning slug and on-chain
  collection address; `get_collection_stats` adds OpenSea total supply, creator
  royalty and on-chain address next to the floor. Key required for these, as
  before; the zero-key path is unchanged.
- `get_asset` surfaces whether the item is compressed and the royalty it asks
  for, with the note that asking is not enforcing.
- New `wallet_report` prompt. Glossary learns floor ceilings, venue split,
  flips, transfer-ins and wallet age - the vocabulary the two new tools need to
  be read correctly.
- Offline suite runs the wallet logic against three captured real feeds
  (Magic Eden activity, Magic Eden holdings, OpenSea account events) so the
  behaviour label, flip pairing and ceiling arithmetic are pinned by tests.
- Docs: `docs/FAQ.md` (why this over a plain model or a marketplace's own MCP),
  and `docs/HOW-PEOPLE-USE-IT.md` rewritten around fifteen personas from
  first-week newbie to brand licensing lead.

## 1.7.1 - 2026-09-05

Review wave. An independent hostile review of 1.7.0 (30 findings) drove these;
the important ones changed answers, not just code.

- **`get_asset_trust` reads the collection too.** Core plugins set on a
  collection apply to every asset in it. Reading only the asset told holders
  of Candy's ICON cards there was no transfer delegate and no royalty; the
  collection carries a permanent transfer delegate, a permanent burn delegate
  and 10% program-enforced royalties. Inherited plugins are marked. External
  plugin adapters are counted and reported as a gap. "Sole controller" is now
  derived from each delegate's actual authority; an update authority of None
  counts as immutable metadata.
- **Provenance walks the whole signature list** (paged, capped at 5,000) and
  reports `historyComplete`; the log-wrapper account can no longer be mistaken
  for a new owner.
- **`verify_claim` never confirms from stale or partial data.** never-traded
  requires the full readable history (and says it means "never changed
  hands"); ownership and supply read the chain fresh; a cached floor returns
  unverifiable.
- **Freshness travels.** Reconciliation shows a stale venue but never ranks it;
  the wallet floor ceiling counts stale or failed quotes as unpriced and says
  why; the floor-dashboard recipe no longer overwrites the stale flag.
- **Upstream honesty.** A malformed RPC envelope, a non-array Magic Eden page,
  or a token lookup that fails for any reason other than 404 now throws
  instead of reading as "nothing there"; identify records outages as errors,
  not negative evidence, and returns candidates instead of picking the first
  fuzzy registry match.
- **Untrusted text everywhere.** `get_asset` returns a whitelisted,
  neutralised market view instead of the raw record; collection metadata and
  every CryptoSlam attribute are cleaned; instruction-shaped names carry a
  visible label through every caller.
- **Rate discipline.** Every retry passes the source gate and honours
  Retry-After; identical in-flight requests are coalesced; the cache is
  byte-bounded; wallet profile defaults are lower.
- base58 encodes an all-zero key as 32 ones; the startup banner says "0
  required API keys" and whether OpenSea is on.
- Second pass on the wave: verification walks the chain fresh (no cached
  signature list, no cached floor) and counts unreadable transactions as
  holes, so `historyComplete` means every signature was listed and every
  selected transaction was readable; trust reads name, owner, collection and
  plugins from one snapshot and only calls a standalone asset complete;
  cache commits happen once per coalesced fetch with oversized values
  rejected before eviction; Retry-After accepts HTTP dates; `get_asset`
  keeps chain data when the marketplace is down (and vice versa) and names
  the source that failed; identify answers "ambiguous" with the candidate
  ids; stale floors stay visible but unranked.
- Third pass: provenance selects the TransferV1 instruction by its
  discriminator and reads the fixed new-owner slot (the account-list guess
  remains only as a labelled fallback); a plugin the registry lists but whose
  data cannot be decoded is reported as present-but-unreadable, never as
  absent (an unreadable Royalties or Freeze plugin now warns instead of
  reassuring); on-chain attribute and edition strings are neutralised and
  capped; `fresh` reads coalesce and commit; cache keys include the page
  size; Retry-After over 30 s stops instead of retrying; every verify path
  and identify distinguish a source failure from a negative answer; stats
  and sales return the venue that answered when the other failed; receipts
  name the venue and time for marketplace-only checks; the offline suite no
  longer touches the network.

## 1.8.0 - 2026-09-11

Market questions, plain names, a second reader for the chain, and a source
catalog. 20 tools, 4 resources.

- `get_collection_sales`: sales over a window from Magic Eden's activity feed
  (count, volume, top and bottom sale, median, buyers and sellers, per-day
  series, venue split), with how far back the feed was read. Unknown activity
  types are rejected client-side because the venue silently ignores them and
  returns the unfiltered feed. Duplicate fills in the venue's own feed are
  deduplicated by signature. Prices are kept at lamport resolution; three
  decimals lost a third of a sub-0.01 SOL card sale.
- `find_listings`: cheapest-first listings with trait filters (AND across
  filters), a name filter for serials, each ask compared to its trait floor.
- `get_top_traders`, `get_trending` (with an explicit note when the venue
  publishes an empty list), `explain_mechanics`, `get_source_status`.
- Plain names resolve against the whole Magic Eden directory: a bundled
  snapshot (`data/me-collections.json.gz`, 30,499 collections, `npm run
  snapshot` refreshes it) answers instantly and the live directory is walked
  in the background after the first miss. Results say which layers were
  searched; "no match" is never claimed for a layer that was not read.
- The public Solana RPC's asset index (DAS) is read without a key as a second,
  independent view: `get_asset` reports whether the account bytes and the
  index name the same owner; `get_wallet_holdings` returns both readers and
  names the gap. A capability probe treats a withdrawn method as unavailable
  and the tools carry on without it.
- Chain reads rotate across three public RPC endpoints with a per-endpoint
  cooldown; `SOLANA_RPC_URL` goes first when set.
- `src/sources/catalog.ts` lists every source (wired or planned) with tier,
  what it answers, what it cannot see, retention, fallback, docs and status
  page; served as `collector://sources` and rendered to `docs/SOURCES.md`.
- `src/mechanics.ts`: how each Metaplex Core plugin, Token Metadata delegate
  and rule set, compressed NFTs, and each Solana venue handle custody,
  freezing and royalties, every entry with its source and pitfall, documented
  versus observed where they differ. `get_asset_trust` attaches the plain
  consequences of the plugins it decoded.
- `get_wallet_activity` adds realized totals over every flip (not just the 25
  shown): P&L, wins, losses, best and worst.
- Errors distinguish "that is a collection, not an item" and "not a Core
  asset" from not-found, each with the tool to use instead.
- Weekly live check (`.github/workflows/live-check.yml`, `npm run test:live`)
  against the real endpoints; it only makes noise when a source breaks.
- Panini's registry entry now says its cards are not on Solana.
- Docs: SOURCES, QUESTIONS, BUILD-IDEAS, TRUST-AND-LIMITS, HOW-IT-WAS-BUILT;
  FAQ covers tool names, plain names, privacy, speed, screenshots, outages,
  history depth and wrong numbers.

## 1.8.1 - 2026-09-11

- `get_collection_sales` names every sale in the window through one batched
  read of the chain's asset index (`getAssetBatch`, keyless), adds a per-name
  breakdown (which player, character or issue sold most) and a `nameContains`
  filter. "How many Ohtani cards sold this week" is one call.
- `find_listings` gains `lowestSerials`: reads up to 1,000 listings, parses
  the serial from each name and returns the lowest editions with their asks
  against the floor, saying how much of the book it saw.
- Status probes carry an 8 s per-source deadline; the weekly live check
  reports a CryptoSlam outage as theirs and does not fail on it.

## 1.8.2 - 2026-09-13

- `get_wallet_holdings`: when Magic Eden refuses an address as its own escrow
  and the public asset index times out in the same call, the answer is the
  escrow explanation, not "try again". A typed failure from either reader now
  survives both readers failing.
- Lint covers `scripts/` with the same rules as `test/`.
