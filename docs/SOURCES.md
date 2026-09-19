# Sources

Generated from `src/sources/catalog.ts` by `scripts/sources-md.mjs` - edit the catalog, not this file.

Every row below was fetched and seen to answer on 2026-09-11, 2026-09-12. Tier 1 is an account read
straight from the chain and settles ownership. Tier 2 is somebody else's database - a
marketplace's view of the market, or an index's view of the chain, either of which can lag
it. Tier 3 is secondary or optional colour. Tier 4 is a link a person can open; this server
never reads it.

Listed in the order they are tried.

| Tier | Source | Answers | Key | Fallback | How far back | Docs | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Your own Solana RPC endpoint**<br>`rpc-custom` · chain-rpc | everything the public endpoints answer, without sharing their rate limit; deeper transaction history, if the endpoint you point at is archival | no (optional `SOLANA_RPC_URL`) | `rpc-mainnet-beta` | whatever the endpoint you choose keeps - ask your provider | [docs](https://solana.com/docs/rpc) | - |
| 1 | **Solana public mainnet RPC**<br>`rpc-mainnet-beta` · chain-rpc | who owns a Metaplex Core asset right now; every transaction that touched an asset, and the new owner in each transfer; how old a wallet is and roughly how busy; how many items a Core collection has minted | no | `rpc-publicnode` | unknown (not documented for the public endpoint); a transaction old enough to be pruned returns null and is counted as unreadable, never as 'did not happen' | [docs](https://solana.com/docs/rpc) | [status](https://status.solana.com/) |
| 1 | **PublicNode Solana RPC**<br>`rpc-publicnode` · chain-rpc | the same chain questions as the Solana public endpoint, when that one is busy | no | `rpc-leorpc` | unknown (not documented) | [docs](https://publicnode.com/) | [status](https://allnodes.statuspage.io/) |
| 1 | **LeoRPC public Solana endpoint**<br>`rpc-leorpc` · chain-rpc | last-resort chain reads when the two endpoints ahead of it in the fallback order are both rate-limiting | no | none | unknown (not documented) | [docs](https://leorpc.com/) | - |
| 1 | **Metaplex Core program and docs**<br>`metaplex-core` · standard-docs | the byte layout we decode owner, name and mint counts from; the TransferV1 instruction shape that tells us who received an asset; which plugins can freeze, burn or take royalties on an asset | no | none | permanent (a program's account layout only changes with a new program version) | [docs](https://developers.metaplex.com/core) | - |
| 2 | **Asset index (DAS) on the public Solana RPC**<br>`das-public` · aggregator | a second opinion on who an index believes owns an asset, and which collection it is grouped under, across every standard (Core, Token Metadata, compressed); what a wallet holds beyond what a marketplace indexes; what standard an unknown mint uses | no (optional `DAS_RPC_URL`) | `helius-das` | current state only | [docs](https://developers.metaplex.com/das-api) | [status](https://status.solana.com/) |
| 2 | **Magic Eden v2**<br>`magiceden-v2` · marketplace | floor price and listed count for a Solana collection; recent completed sales, with buyer, seller and signature; what a wallet holds, as Magic Eden indexes it; a wallet's buy and sell activity on this marketplace | no | `opensea-v2` | unknown (not documented); activity pages back through the collection's own history | [docs](https://docs.magiceden.io/reference/solana-overview) | [status](https://status.magiceden.io/) |
| 2 | **OpenSea v2**<br>`opensea-v2` · marketplace | a second marketplace's floor, owner count and royalty for the same collection; sales priced in something other than SOL, in the currency OpenSea reports; transfers in and out of a wallet, including ones with no sale attached; the full list of Solana collections OpenSea has indexed, for name search; the cheapest listing per trait value across every marketplace OpenSea aggregates, joined onto each deal in find_listings; a 7-day floor series (start, end, low, high, change) in get_collection_stats; the largest holders and their combined share of supply in get_collection_stats | yes - `OPENSEA_API_KEY` | `magiceden-v2` | unknown (not documented) | [docs](https://docs.opensea.io/reference/api-overview) | [status](https://status.opensea.io/) |
| 3 | **Rarible (Solana marketplace, relaunched August 2026)** *(not wired)*<br>`rarible` · marketplace | would add: collection-wide bid depth (the exit price a seller can actually get), Rarible listings and fills | yes - `RARIBLE_API_KEY` | `magiceden-v2` | unknown (not documented) | [docs](https://docs.rarible.org/) | - |
| 3 | **Tensor API** *(not wired)*<br>`tensor` · marketplace | planned: a third Solana floor and bid-side depth, which neither wired marketplace exposes; planned: collection-wide bids, the number that actually sets a seller's exit price | yes - `TENSOR_API_KEY` | `magiceden-v2` | unknown (not documented) | [docs](https://docs.tensor.trade/) | - |
| 3 | **Helius DAS API** *(not wired)*<br>`helius-das` · aggregator | planned: every asset in a collection or wallet in one call, instead of walking transactions; planned: compressed NFTs, which have no account to read and are invisible to plain RPC | yes - `HELIUS_API_KEY` | `rpc-mainnet-beta` | unknown (not documented); DAS answers current state, not history | [docs](https://www.helius.dev/docs/api-reference/das) | [status](https://helius.statuspage.io/) |
| 3 | **Triton One RPC and DAS** *(not wired)*<br>`triton-das` · aggregator | planned: archival transaction history deeper than a public node keeps, and a DAS index alongside it | yes - `TRITON_RPC_URL` | `rpc-mainnet-beta` | archival plans are offered; the exact window depends on the plan | [docs](https://docs.triton.one/) | - |
| 3 | **Shyft DAS API** *(not wired)*<br>`shyft-das` · aggregator | planned: a second DAS index, so a wallet listing does not depend on one vendor | yes - `SHYFT_API_KEY` | `helius-das` | unknown (not documented) | [docs](https://docs.shyft.to/) | - |
| 4 | **Solscan** *(not wired)*<br>`solscan` · explorer-links | a page a person can open to check an asset or wallet by hand against a second index | no | `solanafm` | unknown (the explorer's own index) | [docs](https://docs.solscan.io/) | - |
| 4 | **SolanaFM** *(not wired)*<br>`solanafm` · explorer-links | a second explorer view, useful when Solscan and the chain seem to disagree | no | `solana-explorer` | unknown (the explorer's own index) | [docs](https://docs.solana.fm/) | - |
| 4 | **Solana Explorer** *(not wired)*<br>`solana-explorer` · explorer-links | the raw account and transaction view, straight from an RPC node - the tiebreaker when indexers disagree | no | none | whatever the node behind it keeps | [docs](https://explorer.solana.com/) | [status](https://status.solana.com/) |
| 4 | **XRAY** *(not wired)*<br>`xray` · explorer-links | a plain-English rendering of a transaction, handy when explaining an event to a person | no | `solana-explorer` | unknown (the explorer's own index) | [docs](https://xray.helius.xyz/) | [status](https://helius.statuspage.io/) |

## What each wired source cannot see

A healthy source still has a horizon. These are the gaps that stay gaps, and the reason
one venue's number is never presented as the market's.

- **Your own Solana RPC endpoint** cannot see: marketplace listings, offers or floor prices - those never touch the chain until a trade settles. Optional. Set SOLANA_RPC_URL and it is tried first, then the public list. The URL is never printed back: status and provenance report the host only, so a key in a query string cannot leak into a transcript.
- **Solana public mainnet RPC** cannot see: listings, offers, floor prices or sale prices - a marketplace holds those off chain until settlement; which collection a name belongs to; the chain has addresses, not search. Rate-limited hard on bursts. This is the default first endpoint because it is the canonical one, not the fastest.
- **PublicNode Solana RPC** cannot see: the same off-chain market data no RPC node can see.
- **LeoRPC public Solana endpoint** cannot see: the same off-chain market data no RPC node can see. Reached with the vendor's shared public token in the URL - no signup, nothing issued to this user, so the zero-key promise holds. Slowest of the three in our measurements.
- **Metaplex Core program and docs** cannot see: anything about a specific asset - it is a specification, not a data feed. We decode the layout by hand rather than pulling the SDK, so a Core upgrade that moves a field is a silent-wrong-answer risk. The pin is the discriminator set in src/sources/solana.ts (AssetV1 = 1, CollectionV1 = 5, TransferV1 = 14); the live check re-reads a known asset every week to catch a move.
- **Asset index (DAS) on the public Solana RPC** cannot see: prices, listings, sales - it is an index of assets, not of trades; ownership history; only the state the index last wrote down; assets the index has not picked up yet; coverage is not documented and was seen to differ from Magic Eden's for the same wallet; anything it has not re-indexed since the last transfer - an index lags the chain, and how far is not published. An INDEX of the chain, not the chain: it runs on the same host as the tier-1 endpoint but answers from a database somebody else maintains, so it never settles ownership - the byte-level Core account read does that, and a disagreement is reported rather than resolved. The Solana Foundation endpoint answers getAsset, getAssetsByOwner and searchAssets without a key, but does not document it and calls the endpoint unfit for production. A -32601 'Method not found' is the canary that the capability was withdrawn, and the tools then say so and carry on without it. Set DAS_RPC_URL to any DAS provider you have to put it first.
- **Magic Eden v2** cannot see: trades that happened on any other marketplace - a Magic Eden floor is one marketplace's ask, not the market's; Metaplex Core ownership history; the API returns it empty, which is why this server reads the chain instead; wallets Magic Eden blocks, including its own escrow accounts. Keyless and generous, so it is the default market source. The docs site refuses automated clients - open the link in a browser.
- **OpenSea v2** cannot see: anything at all when no key is in hand - if the self-issued key is refused and OPENSEA_API_KEY is unset, every OpenSea-backed field is simply absent; which marketplace actually executed a fill; OpenSea has been observed reporting Magic Eden fills under its own name. No configuration needed: the first call that needs OpenSea issues a free agent key (POST /api/v2/auth/keys), stores it under the user's home folder and replaces it on the first call made within a day of its expiry; OPENSEA_API_KEY overrides it and COLLECTOR_MCP_NO_AUTO_KEYS=1 disables it. Key CREATION is rate-limited to about two per day per IP, so on a busy address OpenSea can stay off - every tool still answers, with the OpenSea half named as missing rather than dropped.

## How a source is retired or added

1. **Catalog entry first.** A source that is not in `src/sources/catalog.ts` does not get
   called. The entry has to say what it answers, what it cannot see, who takes over when it
   stops answering, and how far back it keeps data - "unknown" where the vendor does not
   document it, never a guess.
2. **Live check.** Add it to `test/live.mjs` if it is keyless, or to `test/smoke.mjs` if
   it needs a key. The assertion names the source, because the only useful failure message
   is which venue moved.
3. **Fixture.** Capture one real response under `test/fixtures/` so `test/protocol.mjs`
   can keep proving the decode offline when the venue is down. Fixtures are public
   marketplace data and are allowlisted in `.gitleaks.toml`.
4. **CHANGELOG.** Adding or retiring a source changes what an answer means, so it is a
   user-visible change and gets an entry.

Retiring runs the same list backwards: mark `wired: false` and leave the row in place with
what it used to answer. A source that vanishes from the docs turns a known gap into a silent
one, and silence reads as coverage.

## How we notice change

- **Weekly live check.** `.github/workflows/live-check.yml` runs `test/live.mjs` every
  Monday with no secrets. It makes three real calls - one marketplace, one chain read, one
  routing call - and fails naming the source. Nothing in the repo changes between runs, so a
  red run is the outside world moving.
- **Shape guards.** Every array page from a source passes a guard before it is read. A
  non-array is an outage or an API change and is raised as one; it is never treated as "no
  more results". The same rule covers the JSON-RPC envelope: a reply with neither `result`
  nor `error` is a malformed answer, not an empty one.
- **RPC rotation is reported, not hidden.** When an endpoint fails, the next one is tried and
  the answer carries `rpcEndpointUsed` plus a note saying who was passed over. A degraded
  read never looks like a clean one.
- **The Core layout pin.** Ownership decoding depends on Metaplex Core discriminators
  (AssetV1 = 1, CollectionV1 = 5, TransferV1 = 14) and on `new_owner` sitting at index 4 of
  the TransferV1 account list. These are pinned in `src/sources/solana.ts`. If Core ships a
  layout change, the weekly check on a known minted asset is what catches it - the asset
  cannot stop existing, so a failure there is the layout, not the data.
- **Live status on demand.** `get_source_status` pings every wired source once and returns
  a plain line such as "3 of 4 sources answering; OpenSea off (no key)", so an agent can tell
  a user which venue is missing instead of reporting that the tool is broken.
