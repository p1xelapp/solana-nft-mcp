# collector-mcp - Under the hood

Where a tool call goes, why each layer is shaped the way it is, and what was
checked before any of it was published. Start with the layer diagram in
section 3.

---

## 1. What it is

collector-mcp is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI agent (Claude Desktop, Claude Code, Cursor, or anything MCP-compatible) live, structured access to Solana digital-collectibles data: floor prices, sales, wallet holdings, listings and full on-chain ownership history. It runs locally over stdio, asks you for **no account, no wallet and no configuration**, and is read-only by design. The default sources need no key at all; OpenSea is reached with a free key the server issues itself and keeps on your machine. It is built for **licensed digital collectibles** - Candy Digital (official MLB and DC licenses) - and works with any Metaplex Core or Magic Eden collection on Solana.

## 2. Why it exists

It started with a 36-pack Candy Digital auction and a simple question: which
wallets won the cards. Every NFT API asked handed back an empty ownership
history. Not an error and not a warning, an empty array, which anything reading
it takes to mean the card has never traded. Those cards had changed hands six
times, and the transfers had been on chain the whole time.

The cause is a format difference nobody surfaces. Candy Digital, and a growing
share of Solana collectibles, mint **Metaplex Core** assets rather than SPL
tokens, and Core stores ownership inside the asset account itself instead of in
token accounts. Enhanced-transaction APIs, including the major indexers, parse
a Core transfer as `type: "UNKNOWN"` with an empty `tokenTransfers` list. The
history is there; almost nothing reads it. What made that worth building
around was not the missing data but the shape of the failure: the wrong answer
arrived with exactly as much confidence as a right one.

The same shape turned up everywhere once it had a name. A SOL floor put beside
a USDC floor and called a multiple. A floor times an item count, presented as a
portfolio value, built on a book three listings deep. A fuzzy name match on a
different collection, answered as though it were the one you asked about. Counts
that disagree because they were taken by place rather than by state: a listed
item has left the wallet on chain and has not been sold, and a tool that counts
where an asset sits produces totals that are confidently wrong and internally
consistent with each other.

Meanwhile the Solana servers in the MCP directories are wallet and DeFi agent
kits. They want a private key so an agent can trade, and an RPC provider key
before anything works at all. If you only want your AI to answer questions
about collectibles, there was nothing, and every key requirement kills a share
of installs, adds a credential to leak and couples the agent to somebody's
billing. For read-only data none of it is necessary, as long as you are
disciplined about which endpoints you use and polite about how you use them.

## 3. The design choices

**Chain first.** Supply comes from the collection account. Current owner comes
from a hand-decoded asset account, not from an indexer's opinion. Ownership
history comes from walking the transfer instructions in each transaction. There
is no indexer in the path and no key required to do it.

**Marketplace labelled, always.** Marketplace data is that marketplace's index,
and it is returned saying so. Each number carries its marketplace, its currency
and its read time. When two marketplaces disagree, both are returned. One
marketplace has been observed reporting another marketplace's fills as its own,
so events are labelled by the program that executed the transaction rather than
by who reported it.

**Evidence-shaped output.** Every result is typed rather than prose a model has
to scrape numbers out of. Partial results report what they skipped: how many
older events were not read, how many activity events were scanned to find the
sales, whether a wallet page hit its cap. Claim checks return three verdicts,
because a tool with only true and false will eventually return false for
something it could not see.

**Refuse to guess.** The stats block will not rank a SOL floor against a USDC
floor. No currency conversion happens, on purpose, because it would mean
depending on a second price feed nobody here can check. A floor-times-count
figure is returned as a ceiling with its assumptions attached. An empty history
is reported as unsupported or unread, never as untraded.

## 4. How it works - layer by layer

```
Claude / MCP client
   │ stdio (JSON-RPC 2.0)
   ▼
┌─────────────────────────────────────────────────┐
│ MCP layer (official TypeScript SDK)             │
│  21 tools · 3 prompts · 0 resources             │
│  zod validation on every input                  │
├─────────────────────────────────────────────────┤
│ Domain layer                                    │
│  curated registry: human names -> identifiers   │
│  ("candy gold" -> Core address, ME symbol...)   │
├─────────────────────────────────────────────────┤
│ Source layer (one module per upstream)          │
│  magiceden.ts   opensea.ts     solana.ts        │
├─────────────────────────────────────────────────┤
│ Plumbing layer                                  │
│  per-source rate gates · retry w/ backoff       │
│  stale-on-error cache · timeout on every call   │
└─────────────────────────────────────────────────┘
```

### The MCP layer
Standard `@modelcontextprotocol/sdk` server over stdio. Every tool input is validated with zod schemas (base58 shape checks on addresses, length caps, enum-like regexes on symbols) *before* any network call. Errors return as clean `isError` results with actionable messages ("try search_collections, or pass a Core collection address") - an agent can recover mid-conversation instead of dead-ending.

### The domain layer
Generic NFT tools make the user hunt for marketplace symbols. The curated registry maps human vocabulary ("candy gold series", "batman") to the *right identifier for each source*: a Magic Eden symbol for market data, a Metaplex Core collection address for on-chain supply, an OpenSea slug for the second marketplace. Everything not in the registry still works by passing identifiers directly - the registry is a convenience layer, not a wall.

### The provenance engine
For a Core asset, the server:
1. Fetches the raw account (`getAccountInfo`, base64) and **hand-decodes the AssetV1 layout**: discriminator byte, owner pubkey (bytes 1-33), update-authority enum, name. This yields the authoritative current owner - no indexer opinion involved.
2. Pulls the signature list for the asset and walks each transaction's instructions (top-level + inner), keeping the ones from the Core program.
3. For each decoded `TransferV1`, reads the **new owner from account slot 4**. Core fills every omitted optional account with the program id, so the slot never shifts; the value still has to look like a public key and must not be one of the structural accounts. Only an instruction whose data could not be decoded falls back to a heuristic (the last account that is not the asset, the collection, the Core program or the System Program), and that row says the owner was inferred. Every transfer of the asset in a transaction is kept, in execution order. It was verified against a live Candy Digital auction: all 36 auctioned packs traced to their winners, zero untraced.
4. Labels events by marketplace (Magic Eden / Tensor program IDs in the transaction) so a sale reads as a sale.

The output is a story: `minted -> listed (Magic Eden) -> transferred -> current owner`, each event with a timestamp and a verifiable tx signature.

### The plumbing layer
- **Rate gates**: serialized limiters per source (Magic Eden ~1.6 req/s, Solana RPC 1 per 350ms). Public endpoints throttle bursts, so requests are spaced out.
- **Retries**: network errors, 5xx, and 429s retry with escalating backoff (slower for 429).
- **Never-blank caching**: every remote read is cached with a per-kind TTL. If a refresh fails and a previous good value exists, the server returns it **labeled `stale: true`** instead of erroring. An agent mid-conversation is better served by 90-second-old floor prices marked stale than by an exception.
- **Bounded memory**: every cache is capped and drops expired entries, so a long-lived session cannot grow unbounded.
- **Honest degradation**: results that are partial say so (`skippedTransactions`, `activitiesScanned`, quiet-market notes). Silent truncation is treated as a bug class.

## 5. The tools, in depth

| Tool | Sources | Notes |
|---|---|---|
| `search_collections` | registry | Scored free-text search; returns identifiers + hints when empty |
| `get_collection_stats` | ME + chain | Answers for collections *no marketplace indexes*, by decoding the Core collection account (name, minted, current size, burned) |
| `get_floor_prices` | ME | Batch of up to 10, sequential through one gate |
| `get_recent_sales` | ME | Walks up to 500 activity events for true sales (`buyNow`); reports how much it scanned so quiet markets are explainable |
| `get_asset` | ME + chain | Marketplace view AND authoritative on-chain owner side by side; flags possible escrow ownership |
| `get_asset_provenance` | chain | Decoded ownership history; depth-capped, with the transactions it could not read counted |
| `get_wallet_holdings` | ME + chain | Two independent readers, the gap between them named, and airdrop spam labelled with the reason it was labelled |
| `find_in_group` | ME + chain | One edition number hunted across a whole family of collections in batches, each match measured against that collection's own floor |

The full list of 21 is in the README.

## 6. Security model

- **Read-only**: no signing, no transactions, no wallet material anywhere in the codebase.
- **No secrets**: nothing to configure means nothing to leak; `.gitignore` still guards the usual suspects.
- **Input validation** at the tool boundary (zod), **output shape-checking** at the source boundary.
- **Prompt-injection stance**: a name or description comes from whoever minted the item. Turn markers, role tags and invisible characters are stripped before that text is returned, and the field is labelled as untrusted so the client can treat it as data.
- **No telemetry**: four data sources, nothing else, auditable in an afternoon.

The reporting route and the full threat model are in
[SECURITY.md](https://github.com/p1xelapp/collector-mcp/blob/main/SECURITY.md).

## 7. What was tested

Every tool and prompt is exercised offline against captured feeds, including
the wallet logic and the prompt-injection defence, and again live against the
real endpoints with a real provenance trace, a real wallet and hostile inputs.
Each defect this server has had is pinned by a test that failed before its fix.
CI runs the offline suite plus a full-history secrets scan on every push, and a
weekly live check re-reads the real sources.

The hardest piece was extracting the new owner from a Core transfer whose
account layout varies between two shapes. It was verified against a live
36-pack auction: all 36 packs traced to their winners, none left untraced.

None of that makes it always right. Sources lag, marketplaces go down, public
RPC throttles. What it does mean is that those conditions are said out loud
instead of smoothed over: cached values come back labelled stale rather than
erroring mid-conversation, caps are disclosed, disagreements are shown rather
than resolved by a coin flip, and every claim check hands back a line telling
you how to reproduce it without trusting this server at all.

## 8. Where it came from

The keyless half of a live pipeline behind [CandyScan](https://candyscan.p1xel.app), which has followed Candy Digital's move to Solana since mid-2026. The lessons it carries over: never-blank caching, escrow attribution, Core decoding, polite pacing.
