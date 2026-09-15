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
  produces wrong answers with no warning.
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
- **`get_integration_recipe`** - endpoints, pacing and failure modes for a build, as data.
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
- A caller that gave up while queued for a rate gate no longer spends its turn,
  so a live reader behind abandoned callers waits one interval, not six.
- Escrow detection is limited to the documented refusal (HTTP 400) and the
  explanation says what Magic Eden did rather than asserting what the address is.
- When both wallet readers fail with a venue classification (429, 5xx, a full
  queue, a deadline), that classification is the answer.
- A capped wallet profile calls its shares shares of the items read, not lower bounds.

## 1.8.3 - 2026-09-14

- The server checks the npm registry once at startup and prints one stderr line when
  a newer version is published; `get_source_status` carries the same fact as `update`.
  Nothing is printed when the registry is unreachable, and COLLECTOR_MCP_NO_UPDATE_CHECK=1
  turns the request off.
- The weekly live check opens or updates one GitHub issue when a source fails or degrades,
  and pings an optional LIVE_CHECK_WEBHOOK secret, so a break is a ticket, not a buried email.

## 1.8.4 - 2026-09-14

- Three OpenSea reads added in 2026 are wired, with the same self-issued key: the
  cheapest listing per trait value (joined onto every deal in `find_listings` as
  `openSeaFloor` next to Magic Eden's `traitFloorSol`), a 7-day floor series and the
  largest holders with their share of supply (both in `get_collection_stats`). Each
  names itself as OpenSea; nothing from two venues is ever summed.
- `find_listings` takes an optional `openseaSlug`; registry entries that carry one are used automatically.

## 1.8.5 - 2026-09-15

- Every Candy Digital collection on Solana is in the registry: 398 entries generated from
  `data/candy-collections.json` (name, category, Core collection address, exported from the
  CandyScan tracker's reconciled list). A plain name like "2022 Leadoff ICONs" now resolves
  straight to chain reads. Hand-written entries keep their cross-venue ids.
- `COLLECTOR_MCP_LOG=1` writes one JSON line per tool call to stderr: tool, milliseconds,
  outcome and argument names. Never values, never stdout.
- `get_trending` carries OpenSea's own Solana trending order beside Magic Eden's list, as
  rank only, because OpenSea publishes no volume on those rows.
- `npm run bundle` builds the one-click Claude Desktop install (`.release/collector-mcp-<version>.mcpb`).

## 1.9.0 - 2026-09-15

- `get_pack_pulls`, the Panini registry entry and the CryptoSlam source are gone. The feed
  worked, but Panini's cards settle on Panini's own chain with a bridge to Ethereum, so it was
  the one tool in a Solana server that could never answer a Solana question, and the flakiest
  source in the set. 19 tools now. Nothing else read CryptoSlam.
- The pack-watcher recipe stays and now describes how to build the same thing on Solana: page a
  Metaplex Core collection from the public asset index and treat ids you have not stored as the
  new pulls. The public index cannot sort a collection by mint time, and the recipe says so.
- Prompts: every argument is optional and a request that carries no arguments at all is treated
  as an empty one, so a prompt attaches even in a client that loses the value you typed. New
  `getting_started` prompt reads live source status and hands over five questions to try.
- Each `collector://` resource opens with a line saying what to ask once it is attached, and the
  registry hoists the sentence that repeated on 400 Candy rows.
- The install bundle carries the white logo, which was invisible against a dark panel.

## 1.10.0 - 2026-09-15

Four fixes, each one a question the server got wrong by hand first.

- Collections the registry knows only by name and chain address now reach their
  Magic Eden symbol through the bundled directory, matched on the collection's own
  name. Asked for the market side of a Candy collection, a model had to invent a
  symbol; the guess for Absolute Batman #1 was `absolute_batman_2024_1_candy_digital`
  against a real symbol of `absolute_batman_2024_1`, and the empty answer read as
  "never traded". 361 of the 398 Candy collections resolve this way. Every answer
  that uses one says the symbol was matched by name rather than hand-verified.
- Entries that share a chain address keep both spellings: the 2026 MLB ICON Series
  is "2026 MLB Base Series ICONs" in the issuer's own export, and only that spelling
  is in the venue directory. Either name now resolves to the same collection.
- New `find_in_group`: hunt one edition number across a whole family of collections.
  DC on Candy is 272 separate collections, one per issue, so "is any #1 or #100
  listed, and how close to floor" could not be asked at all. It reads a batch,
  measures every match against that collection's own floor, and hands back a cursor
  for the rest. Twenty collections take about twelve seconds.
- `get_wallet_holdings` labels airdrop spam and says why: a web address in the name,
  a reward to claim, a token amount, or Latin letters mixed with lookalikes from
  another alphabet. Nothing is removed from the list. One real wallet held 1,171
  items of which 1,166 were unsolicited drops, and the five real holdings were
  invisible underneath them.
- The largest holders of a collection are each checked against the chain for what
  kind of account they are. A wallet is owned by the System Program; an escrow is
  owned by the marketplace's own program, and is named when the program is one this
  server knows. An unreadable account stays unknown rather than defaulting to a
  person.

## 1.10.1 - 2026-09-15

- The install bundle declares its prompts. Claude Desktop refuses to attach a
  prompt the manifest does not list, logging "attempted undeclared prompt" while
  the person sees only "Failed to attach prompt" - so all three prompts were
  dead for anyone who installed the bundle, whatever the server registered. A
  test now fails if a registered prompt is missing from the manifest.
- The bundle description reads as what it is rather than as a feature list.
- The server now sends instructions on connect, because every collection name
  here is shared with a physical object. Asked what Absolute Batman #1 is worth,
  an assistant answered about the printed comic from the open web and never
  called a tool. The instructions say what the server covers, that a name means
  the Solana collection rather than the paper one, and that an empty result is
  never proof a thing does not exist.
- `find_in_group` returns the chain address of any collection it could not match
  to a marketplace symbol, so those stay answerable for supply and provenance
  rather than reading as skipped.

## 1.10.2 - 2026-09-15

Found by working through a twelve-case test pass by hand.

- A search for something that does not exist comes back empty. Matching any ONE
  word was fine with seven registry entries and wrong with four hundred:
  "zzzz brand new collection name" matched 27 Candy collections on the word
  "collection", so a search for nothing looked like a result. Half the words have
  to land now, and only the best-scoring entries survive.
- Giveaway language alone no longer marks a holding as airdrop spam. Candy ships
  a real collectible called an Overdrive Reward Pack, and the word "reward" was
  enough to label it. A web address, a claim, a token amount or a disguised
  letter still decides on its own; "reward" and "prize" now need company.
- A collection with no OpenSea slug says so. Saying nothing about a second venue
  reads as there being only one.
- An empty wallet answer says when the chain has no account at that address at
  all, which is what a mistyped address looks like. Both readers returning
  nothing used to read identically for a real empty wallet and a typo.

## 1.10.3 - 2026-09-15

A live behavioural battery, `node test/battery.mjs`: 157 checks across 26 areas that
ask what a person asks and then test how the answer behaves. Its first three runs
found six real bugs, all fixed here.

- `identify` matched a collection name by substring, so "Absolute Batman (2024) #1"
  matched issues #1, #10, #11 and #12 alike, looked ambiguous, and fell through to a
  directory guess that landed on an Ashcan special edition. Names are compared on a
  shared key now, punctuation and issuer stripped, and containment stops at a word
  boundary.
- `get_asset_trust` on a programmable NFT answered "Try again, or try a narrower
  request", which is advice to retry something that can never work. The raw account
  reader threw an untyped error, so the standards mismatch lost its class before the
  wording layer saw it.
- A wallet with listings and no completed trades was labelled "unknown" with an empty
  reason. It now says there were no buys or sells to judge, and what to read instead.
- A search query echoed a direction-override character straight back into the answer.
  The echo goes through the same neutraliser as anything an upstream wrote.
- A collection with no OpenSea slug said nothing about OpenSea at all.
- An empty wallet answer now says when the chain has no account at that address,
  which is what a mistyped address looks like.

## 1.10.4 - 2026-09-15

A robustness suite, `test/robustness.mjs`, now part of `npm test`: every reader fed
eleven broken upstream shapes, a corrupt install, and a drift check between the
server and the README. Two bugs of the same class fell out.

- A Solana or asset-index endpoint answering the literal `null`, or a bare string,
  crashed inside our own reader with a type error, and the caller saw a generic
  failure carrying our stack. Both readers now treat a body that is not a JSON-RPC
  response as an endpoint failure and move to the next one.
- The suite also pins things that were already right and could quietly stop being:
  a corrupt collection list degrades to the hand-written registry, a truncated
  directory snapshot leaves the registry layer answering, no answer carries a key,
  a file path or a stack frame, and the README's tool count is the server's.

## 1.10.6 - 2026-09-15

Found by sweeping 37 real collections rather than the same few fixtures.

- A marketplace symbol matched by NAME is now checked against the chain before
  its numbers may stand beside a collection's supply. The registry entry "2023
  Tickets" resolved to a venue symbol whose items belong to a different
  collection, and the answer printed 2 minted next to 10 listed and a 0.1 SOL
  floor as though that were one market. One listed item is read, the asset index
  says which collection it belongs to, and a mismatch is reported as a rejected
  symbol with the other collection's address, never as this collection's market.
  Measured on a sample of 52 name-matched collections: 49 confirmed, 1 wrong, 2
  unverifiable. The check is cached for six hours.
- A name that belongs to more than one collection is ambiguous rather than a
  pick. The issuer's own export ships two different "2023 Tickets" and two
  "2022 ICON Chasers", each with its own chain address, and taking the first
  match answered confidently about one of them. Both are now listed with their
  ids and addresses.
- An ambiguous identifier carries its own wording. It used to reach the generic
  "Try again, or try a narrower request", which is advice to repeat a question
  that will always have the same two answers.
- An empty ownership history is never called complete. An account that exists was
  minted, so it has at least one transaction; zero is an endpoint that cannot see
  the history. Measured live: the same asset answered with seven events and then
  with none a minute later, and the empty answer would have read as "this card has
  never moved". The walk is retried against another endpoint, and an empty result
  that survives says plainly that the endpoint could not see it.
- One unresolvable name no longer kills a whole group scan. A name shared by two
  collections threw, and in a batch of twenty that is a row to report rather than
  a reason to abandon the other nineteen.
