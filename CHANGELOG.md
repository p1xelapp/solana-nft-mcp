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

## 1.11.0 - 2026-09-15

The prompt menu, fixed properly, and four files removed from it.

- Prompts take no arguments and return FIXED text. The client compares what a
  prompt returns against what the manifest declares and rejects a mismatch as a
  possible injection, logging "content validation failed" while the person sees
  only "Failed to attach prompt". An interpolated body can never match a
  declaration, so `collection_report` and `wallet_report` now ask which
  collection or wallet in the conversation instead of opening an input box.
- The words live in one module, `src/prompts.ts`, which the server registers
  from and the bundle script declares from. They cannot drift apart, and a test
  fails if either side stops reading it.
- The four `collector://` resources are gone. A client shows resources to the
  PERSON, as files to attach beside a message, and nobody attaches a glossary to
  ask what a card is worth. Everything they carried is reachable by a tool the
  model calls on its own: `explain_mechanics` for how a standard or venue
  behaves and for the vocabulary (ask for "glossary" to get all of it with the
  presentation rules), `get_source_status` for the source catalog,
  `search_collections` for the registry. The capability is no longer advertised,
  so nothing appears in the attach menu at all.

## 1.11.1 - 2026-09-15

Installed the package the way a stranger would, and found two things pointing at
features that no longer exist.

- `get_integration_recipe` told the reader to "Read collector://glossary",
  months after the last resource was deleted. Text naming a dead capability is
  worse than no text: the model either fails the call or invents the contents.
  It now names the call that actually answers, `explain_mechanics` with topic
  "glossary".
- A glossary answer opened with `count: 0` and an empty `entries` list, because
  `count` counts mechanics entries and a pure vocabulary question legitimately
  matches none. A reader that stopped at the zero would report that nothing was
  found, with the whole glossary sitting underneath it. Every answer now leads
  with a line saying what matched and where to look.
- `scripts/verify-bundle.mjs` opens a built `.mcpb` and checks the things that
  decide whether it works once a person double-clicks it: the declared prompt
  text byte-for-byte against the module the server registers from, no arguments
  on any prompt, no mention of a removed capability, and that the entry point,
  the dependencies and the marketplace directory snapshot are all really inside.
  `npm run bundle` now runs it, so an unverified bundle cannot be produced.
- The test suite grew the check that would have caught this class: everything a
  client can receive without a network read - every recipe, the glossary, the
  tool list, every prompt and the server instructions - is scanned for the names
  of features that were cut.
- Docs that still claimed a resources surface, and a publish description that
  still advertised pack pulls, say what the server actually does.

## 1.11.2 - 2026-09-15

A prompt should not ask for something it was just told.

- Attaching the collection or wallet report right after naming a collection or
  pasting an address answered with "which one do you mean?", which is worse
  than typing the question outright. Both now use what the conversation already
  carries and ask only when it carries nothing. A report prompt earns its place
  by fixing the SHAPE of the answer - the floor ceiling called a ceiling, the
  airdrop spam split from real holdings, the section saying what the feeds
  could not see - not by collecting input.
- `collection_report` no longer invites a list of guesses. Asked cold it would
  offer collections from earlier in the chat, which is the model's memory
  talking rather than anything read from the chain.
- The bodies are written in lines rather than one paragraph. A client attaches
  a prompt as a text file, and a single long line reads as "1 line" in the chip,
  which looks like an empty attachment.

## 1.11.3 - 2026-09-15

A client refused every call that left a default out.

- Nineteen parameters carried a schema default, which put a `default` key in
  the published JSON Schema. Draft-07 says a field with a default and no place
  in `required` is optional, and one shipping client disagreed: every call that
  omitted one came back "expected nonoptional, received undefined". Being right
  did not help the person whose question failed. No default is published now;
  each one lives in its handler and is named in the parameter description, so
  behaviour is identical and no client has anything to trip on.
- A tenth robustness group holds the line: nothing in any published schema may
  declare a default, and all 20 tools have to answer a call carrying only their
  required arguments.
- A presentation rule against shortened addresses. Abbreviating two of them in
  one answer produced a mint whose head belonged to the asset and whose tail
  belonged to its collection: a string that reads as an identifier, pastes into
  an explorer, and finds nothing.

## 1.12.0 - 2026-09-15

The directory was never the catalogue, and the answers were too big to arrive.

- **"DeGods" returned eight imitations and not DeGods.** Magic Eden refuses to
  page past offset 30,000 and its catalogue is larger than that, so the bundled
  directory is a PREFIX of the venue. The collections past the ceiling are not
  obscure: DeGods, Okay Bears, Cets on Creck and Degenerate Ape Academy were all
  missing while degodscasino, anti_okay_bears and ai_okay_bears_ were present
  and scored. `identify` and `search_collections` now ask the venue about the
  name directly, which has no ceiling, and accept the answer only when the
  venue's own record confirms it.
- **Two confident wrong answers, both about price.** "solana monkey business"
  resolved to Rare Solana Monkey Business, 0.055 SOL over 3 listings, against
  the real collection's 12.28 SOL over 242. "yoots" resolved to Pixel Yoots
  instead of y00ts. A single fuzzy match whose NAME is not what was asked for
  is now offered as a candidate with the mismatch stated, never asserted.
- A collection can be rebranded without its symbol changing - the venue calls
  `solana_monkey_business` "SMB Gen2" - so an exact slugification of the name
  is accepted on its own, and the different display name is said out loud.
- **An answer four times too big to arrive.** `find_listings` at limit 100
  returned 247,385 characters, past every client's ceiling; the client cuts the
  overflow off silently and the model reads the surviving prefix as the whole
  list. 140 KB of it was a trait array repeated on every row, with the same
  trait floors already aggregated once above. Row detail is now dropped before
  rows are, and every reduction is named in the answer with how to undo it.
  find_listings 247 KB to 42, search_collections 50 to 25, wallet holdings 72
  to 51.
- **OpenSea for every collection, not four.** Slugs were hand-curated and had
  reached 4 of 402 registry entries - 1 of the 399 Candy collections - two weeks
  after Candy became a launch partner for OpenSea's Solana support. A slug is
  now found from the on-chain address against OpenSea's own Solana index, and
  failing that by name, accepted only when OpenSea's record carries the same
  chain address. Absolute Batman went from "no OpenSea slug is known" to a real
  two-venue reconciliation: 0.22 SOL on Magic Eden against 0.4876 on OpenSea.
- OpenSea answered with a lifetime volume of 7.6e-17 against zero sales, and a
  total supply of 0 for a collection the chain says has 2,457. Both are its own
  indexing state rather than facts, and both are now labelled as such.
- `test/compat.mjs`: ten groups of published CLIENT constraints rather than spec
  rules - Claude Code's 25,000-token result ceiling, Cursor's silent 40-tool
  cap, the OpenAI strict-mode schema subset, the Anthropic name regex and
  review criteria. It is what "works on Codex, Cursor and local models" is
  checked against instead of assumed.
- `test/battery2.mjs`: 80 checks the first battery does not cover - 35 of them
  messy input, because nobody types "Absolute Batman (2024-) #1". Measured on
  the 30 real spellings a person might use: 15 resolve, 15 leave a usable next
  step, none dead-end, and none resolve to the wrong collection.
- Docs called `get_source_status` by a name it has never had.

## 1.12.1 - 2026-09-15

An outside review found three defects and one test that could lie. All four are fixed.

- **One malformed record destroyed a whole valid report.** `blockTime: 1e20` is
  a finite number that JavaScript's Date cannot hold, so `toISOString` threw
  RangeError out of `summarizeSales`. Three good sales plus one unrelated
  listing row carrying it returned nothing at all. Timestamps are now checked
  for representability before any date is built, unreadable ones are counted in
  `coverage.unusableTimestamps` rather than silently swallowed, and a merely odd
  time is kept and rendered rather than deleted.
- **The answer-size budget did not enforce itself.** It measured UTF-16 code
  units while calling them bytes, so thirty CJK characters passed a 60-byte
  budget at 103 actual bytes; any non-Latin name defeated the guarantee. And it
  kept one row even when that row alone was over the limit, returning 1,013
  bytes against a budget of 100 while reporting nothing omitted. Measurement is
  now UTF-8 bytes, and a row that cannot fit is omitted and said so, because
  preserving a row by breaking the promise hands back an answer the client cuts
  without telling anyone.
- **A declared timeout did not bound the queue wait.** The clock was only read
  after the rate gate returned, so a 10 ms budget against a 100 ms gate took
  103 ms to reject. The attempt's own deadline now goes into the gate: measured
  at 26 ms, with no request sent. The gate's message no longer blames "the
  caller's deadline" for a deadline the caller never set.
- **The size compatibility check could pass having measured nothing.** If every
  call threw, the oversized list stayed empty and the green line still claimed
  every widest-case answer was inside the limit. An error result was worse: a
  short failure message counted as a small answer, as did a valid "unknown
  identifier" body. Successes are now counted, refusals of both kinds are
  excluded, and too few real measurements fails the check. Proven by running it
  against calls engineered to fail: it now reports "only 0 of 3 widest reads
  produced a real answer" where it used to print a pass.
- The README privacy statement said the only thing leaving the machine was the
  address being asked about. It also makes a version check to the npm registry
  and can ask OpenSea for a free key, and it writes one local file. All three
  are now named, with the switch that turns each off.
- `docs/TRUST-AND-LIMITS.md` said "name the upstream, never blame the tool".
  That reads as a rule to point elsewhere whatever happened, and it would have
  had us blame Magic Eden for a timestamp our own code could not parse.
  Attribution is now evidence-based.

## 1.13.0 - 2026-09-15

The queue serves the person first.

- **A question queued behind the whole directory refresh.** The rate gate was a
  strictly FIFO promise chain, and the background walk that refreshes the
  Magic Eden directory puts 61 pages into it at once. Anyone asking a question
  during that wait went to the back. Measured at a 200 ms interval, a
  foreground caller waited 4,138 ms behind twenty background turns; at the real
  600 ms pace and 61 pages that is around 36 seconds of somebody watching a
  spinner right after installing.
- The gate is now a priority queue: the directory walk declares itself
  background and yields to anything a person is waiting on. The same foreground
  caller now waits 211 ms, which is one interval and therefore the floor.
- **The pace did not change, and that is the point.** At most one turn is still
  released per interval, proven at the real 600 ms setting with foreground and
  background mixed: smallest gap between releases 601 ms, average 608 ms. The
  order changed; the rate a venue sees did not, because that rate is what keeps
  a keyless server welcome.
- Background work is not starved. It yields, but after 20 seconds of waiting it
  stops yielding, and in practice it fills the gaps between questions: a
  background turn still came through during constant foreground pressure.
- Cold-start latency, same questions as before this change: "candy" 4.9s to
  2.9s, a name nothing carries 9.5s to 4.7s, "DeGods" 2.6s to 1.4s, "Okay
  Bears" 2.3s to 1.0s.
- Found while building it: the new scheduler's timer was unref'd, so Node could
  exit before granting a turn somebody was awaiting and the promise simply never
  settled. A timer is only ever scheduled while the queue has someone in it, so
  it cannot hold the process open idle, and it is no longer unref'd. The
  regression covers this along with priority, pace and starvation.

## 1.14.0 - 2026-09-15

An outside audit of 1.13.0 found thirteen defects with synthetic upstreams and a
real stdio client. All thirteen are fixed here, each with a regression that
asserts the correct behaviour on the fixture that reproduced it
(`test/credentials-and-cancellation.mjs`, fourteen groups, in `npm test`).

Credentials and bodies:

- **A self-issued OpenSea key could reach an answer.** Redaction read only
  `OPENSEA_API_KEY` from the environment; the key this server issues itself
  lives in memory and on disk. A mocked OpenSea 400 that echoed the request
  header carried that key into a normal `get_source_status` result over real
  stdio. Every credential the process sends is now registered the moment it is
  obtained (`src/lib/secrets.ts`), upstream error bodies are scrubbed against
  the registry, and the tool boundary scrubs the whole serialised result as a
  last gate. Proven at the source and over stdio with a canary.
- **Two response paths read bodies unbounded.** `rpcHealth` parsed a 4.2 MB
  health batch with its own `res.json()`, past the shared 4 MB reader; the npm
  update check did the same. Both use the bounded reader now, and an oversized
  health answer reports the endpoint as unhealthy with the reason.
- **A refused key issue was asked again on every call.** Only concurrent
  attempts were coalesced; two sequential calls against a 429 posted to the key
  endpoint twice. A refusal is remembered: an hour after a 429, five minutes
  after anything else, a `Retry-After` honoured inside a 24-hour ceiling, and
  the status note says when the next attempt may go out. A 429 or 5xx that
  outlives every retry is now thrown as an `HttpError` carrying the status and
  the venue's `Retry-After`, where callers used to get a private class and a
  message to grep.

Cancellation:

- **A cancelled request kept working.** The SDK's per-request signal reached
  the handler and stopped there: a client that cancelled a sales read after
  the first page watched the server fetch offsets 500 and 1000 with nobody
  waiting, and an RPC read aborted 10 ms in settled at 356 ms because the gate
  wait ignored the signal. The signal now travels as ambient context
  (`src/lib/context.ts`) that every gate wait, retry sleep, fetch and page
  loop reads, in every source, without a parameter threaded through fifty
  call sites. A read shared by several callers runs under its own signal and
  is abandoned only when the last waiter leaves, so one caller giving up
  cannot cancel an answer another still needs. Measured: the 356 ms settle is
  22 ms, and the cancelled paged read requests no further page.

Evidence and identity:

- **A name resolved to a collection the venue calls something else.** The
  direct venue probe accepted an exact slugification of the query even when
  the venue's own name for that symbol conflicted, on the theory that
  collections get rebranded. "Audit Crown" therefore resolved to a collection
  named "Entirely Different" with `found: true`, and `identify` attached its
  floor and sales to the name asked for. A conflict is now reported as one:
  both names, the symbol to pass if that is the one you meant, and no choice
  made for you. A symbol with nothing listed under it, whose name cannot be
  read, is accepted as provisional and labelled so.
- **"Never traded" could be confirmed on evidence nobody read.** A Core
  instruction touching the asset with no instruction data and `logMessages:
  []` fell through to "other", because an empty log array counted as logs
  being present. A Core instruction that neither its data nor a log line can
  classify now counts as unreadable, which makes the verdict unverifiable. A
  confirmed "never" also needs the mint itself to have been decoded
  (`mintObserved`): a complete walk from a pruned endpoint ends where that
  node's memory does, not where the history starts. `CreateV2` is decoded
  alongside `CreateV1`. Verified against a real Core asset on the public RPC:
  mint observed, history complete, three transfers, correctly contradicted.
- **Two sparse fills in one transaction collapsed into one.** The event
  identity encoded a missing mint or type as an empty string, so two rows
  sharing a signature and a type but lacking a mint were "the same fill": one
  vanished as a duplicate and the other lost its price as contested. All
  three parts are required now; a row without them has no identity, is kept
  whole, and is counted as unidentifiable.
- **Overlapping wallet pages inflated a "complete" count.** Two shifting
  pages produced 150 rows for 149 mints and the answer called it a complete
  read. Rows are deduplicated on a validated mint, the overlap is counted in
  the answer, and the basis line says the count is close rather than exact,
  because the same shift that repeats an item can skip one.
- **One bad block time destroyed `get_recent_sales`.** The older sales path
  called `toISOString` unguarded; `blockTime: 1e20` threw and took every other
  sale with it, while `get_collection_sales` had a guard. One guard now lives
  in `src/lib/time.ts` and every source uses it; a row with an unrepresentable
  time keeps its price with `time: null` and the answer counts such rows.
- **OpenSea amounts were divided without being checked.** `"-100"` became a
  price of -1, decimals `0.5` became 31.62 from 100 units, and `"1e309"`
  became Infinity that serialised to null with no reason. Raw units must be a
  non-negative integer string and the scale a whole number up to 36; the
  division is exact on the whole part; the raw values travel with the price;
  and a malformed row says which field failed and why.
- **Instruction-shaped text passed through OpenSea's typed fields.** Only the
  item name went through the untrusted-text pass; `currency`, `buyer`,
  `seller` and `transaction` were relayed raw. Each is now validated against
  the shape it claims (a ticker, a base58 address, a 64-byte signature) and
  set to null with a reason when it fails. The venue's text is never repeated.

Disclosure and tests:

- The read-only hint stays. It describes what the tools do to the chain, the
  venues and your wallet, which is nothing. What it does not describe - the
  first OpenSea question may create a free key and store it in your home
  folder, and startup asks npm for the latest version - is now said in the
  server's own instructions, which every client's model reads, and in
  SECURITY.md, which used to claim the server holds no keys. Both are opt-out.
- `test/robustness.mjs` r10 launched its child server without the offline
  environment every other block uses, and its loop swallowed every error that
  was not a schema refusal, so "every tool answers" was true of a test that
  had measured nothing. It runs offline now and classifies four outcomes
  apart: 12 tools answer from local data, 8 name the source as unreachable, 0
  refuse their required arguments, 0 fail for any other reason.
- `test/hardening.mjs` b16 stubbed fetch with a bare object carrying only
  `json()`. The registry body now goes through the bounded reader, so the
  stand-in is a real `Response`.

Not changed, on purpose: the `>=20` engine floor. Node 20 is end of life and
this release was tested on 24. Narrowing the floor would refuse installs that
work today, which is a maintainer's decision rather than a patch.

## 1.14.1 - 2026-09-15

Node floor raised from 20 to 22, in `engines`, the bundle manifest and the
README. Node 20 reached end of life in April 2026 and nothing here was ever
tested on it; CI now runs the whole offline suite on 22 and 24 so the floor
promises only what has run. Anyone still on Node 20 is refused at install
with a clear engines message rather than served an untested build.

`test/persona-server.mjs` runs the server-side half of the outside audit's
48-case persona campaign against a real server over stdio (26 cases carry a
server oracle; 22 judge model conduct and are listed with their prompts).
Not part of `npm test`: it reads live venues.

## 1.14.2 - 2026-09-15

Five gaps found by running the persona campaign as the model, with the tools
attached, against live venues:

- `get_collection_sales` daily series now carries every UTC day in the
  window. A day with no sales is an explicit zero, and a day the feed never
  reached (page budget ran out) is marked `covered: false`. Both used to be
  an absent row, which a chart drew identically.
- Relayed image and OpenSea links are https-only; anything else is null. The
  wallet holdings image field was the one path still passing venue text
  through unchecked.
- The sales-bot recipe skeleton keys on signature + mint + type with a
  persisted seen-set instead of a timestamp cursor, holds back rows it cannot
  identify, and names the at-least-once trade-off. Its rate-limit line says
  the venue allowance is per IP, not per process.
- `identify` lists devnet and testnet under what was not checked.
- `get_asset_provenance` says it returns ownership events only and points
  at `get_asset` and `get_asset_trust` for traits, after a real host read
  its empty trait picture as "no traits".

## 1.14.3 - 2026-09-16

A third outside review, scoped to the 1.14.x diff, found nine defects. All
nine are fixed, each with a regression that fails on 1.14.2.

- **A key containing a quote walked through the result boundary.** The
  boundary serialised first and searched second, and JSON escaping had
  changed the spelling. Every registered secret is now looked for raw,
  JSON-escaped and URL-encoded, and string leaves are redacted BEFORE
  anything is serialised (`redactDeep`), with the serialised search kept as
  the last check. A key shorter than eight characters is refused at
  registration rather than silently unprotected. Proven over stdio on a
  normal successful answer, not only an error.
- **Three more routes to a false "never traded".** A decoded CreateV2 beside
  an undecodable Core instruction on the same asset counted as complete; a
  transaction-wide "Instruction: CreateV2" log written by another asset was
  taken as this one's mint; and a CreateV2 that created another asset while
  naming this one in its optional owner slot was read as this asset's
  creation. Now every undecodable Core instruction on the asset is a hole,
  logs may add a transfer but never a mint, and an instruction is about an
  asset only when that asset sits in slot 0. A normal inner CreateV2 CPI
  still confirms; the real Batman asset still decodes as minted plus three
  transfers.
- **A late caller could join an abandoned cache producer** and inherit its
  AbortedError without ever fetching. An entry whose producer is already
  aborted is replaced.
- **The status tool kept probing RPC endpoints after cancellation.** The
  health loop now reads the ambient signal.
- **Signal combiners left listeners on surviving parents** (twenty per
  twenty combinations). Both use `AbortSignal.any`, which holds parents
  weakly; the Node 22 floor allows it.
- **Raw RPC reads bypassed offline mode.** An offline suite still sent chain
  reads; the refusal now happens by name before any gate, the health check
  reports it per endpoint, and the tool boundary gives offline mode its own
  headline instead of "try again".
- **The day a truncated feed was cut in read as a whole day.** It is marked
  `partial: true`; its count is a floor.
- **The direct-symbol negative cache was keyed by name, not by the spellings
  tried.** "Candy Digital - Audit Crown" answered for "Audit Crown" without
  ever asking about `audit_crown`.
- **`rawQuantity` relayed a malformed value verbatim,** which put
  instruction-shaped text back into a normal answer. It is relayed only when
  it has the shape of a bounded integer.

Tests: the cooldown recovery moves a fake clock across the boundary instead
of resetting state; persona cases that only cite another test report
REFERENCE rather than PASS, and the runner refuses to start without
`PERSONA_LIVE=1` and an explicit `PERSONA_CASES` path.
