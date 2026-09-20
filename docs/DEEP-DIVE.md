# collector-mcp - Under the hood

Start with the layer diagram below to see where a tool call goes.

---

## 1. What it is

collector-mcp is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI agent (Claude Desktop, Claude Code, Cursor, or anything MCP-compatible) live, structured access to Solana digital-collectibles data: floor prices, sales, wallet holdings, listings and full on-chain ownership history. It runs locally over stdio, asks you for **no account, no wallet and no configuration**, and is read-only by design. The default sources need no key at all; OpenSea is reached with a free key the server issues itself and keeps on your machine. It is built for **licensed digital collectibles** - Candy Digital (official MLB and DC licenses) - and works with any Metaplex Core or Magic Eden collection on Solana.

## 2. The problem it solves

**Gap 1 - AI agents are blind to collectibles.** MCP directories list thousands of servers. The Solana ones are wallet/DeFi agent kits: they want your *private key* so an agent can trade, and an RPC provider API key before anything works. If you just want your AI to *answer questions* about collectibles - "what's my collection worth?", "who owned this card?" - there was nothing. You would be pasting screenshots into chat.

**Gap 2 - Metaplex Core assets have invisible history.** Candy Digital (and a fast-growing share of Solana collectibles) mint **Metaplex Core** assets, not SPL tokens. Core stores ownership inside the asset account itself, not in token accounts. Consequence: enhanced-transaction APIs - including major indexers - parse Core transfers as `type: "UNKNOWN"` with **empty `tokenTransfers`**. Tools built on those APIs report *zero provenance* for these assets. The history exists on-chain; almost nothing reads it.

**Gap 3 - keys are friction and risk.** Every key requirement kills a percentage of installs, adds a credential to leak, and couples your agent to a provider's billing. For read-only collectible data, none of that is necessary - if you are disciplined about which endpoints you use and polite about how you use them.

## 3. How it works - layer by layer

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

## 4. The tools, in depth

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

## 5. Security model

- **Read-only**: no signing, no transactions, no wallet material anywhere in the codebase.
- **No secrets**: nothing to configure means nothing to leak; `.gitignore` still guards the usual suspects.
- **Input validation** at the tool boundary (zod), **output shape-checking** at the source boundary.
- **Prompt-injection stance**: a name or description comes from whoever minted the item. Turn markers, role tags and invisible characters are stripped before that text is returned, and the field is labelled as untrusted so the client can treat it as data.
- **No telemetry**: four data sources, nothing else, auditable in an afternoon.

## 6. Where it came from

The keyless half of a live pipeline behind [CandyScan](https://candyscan.p1xel.app), which has followed Candy Digital's move to Solana since mid-2026. The lessons it carries over: never-blank caching, escrow attribution, Core decoding, polite pacing.
