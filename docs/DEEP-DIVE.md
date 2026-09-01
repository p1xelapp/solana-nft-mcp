# collector-mcp - The Deep Dive

Everything about what this is, how it works, why it exists, and who it's for.

---

## 1. What it is, in one paragraph

collector-mcp is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that gives any AI agent (Claude Desktop, Claude Code, Cursor, or anything MCP-compatible) live, structured access to Solana digital-collectibles data: floor prices, sales, wallet holdings, live pack rips, and full on-chain ownership history. It runs locally over stdio, requires **zero API keys, zero wallets, and zero configuration**, and is read-only by design. It is built for **licensed digital collectibles** - Candy Digital (official MLB license), Panini America (NBA/NFL/Soccer), and any Metaplex Core or Magic Eden collection.

## 2. The problem it solves

Three gaps, one server:

**Gap 1 - AI agents are blind to collectibles.** MCP directories index 22,000+ servers. The Solana ones are wallet/DeFi agent kits: they want your *private key* so an agent can trade, and an RPC provider API key before anything works. If you just want your AI to *answer questions* about collectibles - "what's my collection worth?", "who owned this card?" - there was nothing. You'd be pasting screenshots into chat.

**Gap 2 - Metaplex Core assets have invisible history.** Candy Digital (and a fast-growing share of Solana collectibles - 1.5M+ Core mints in Jun-Jul 2026 alone) mint **Metaplex Core** assets, not SPL tokens. Core stores ownership inside the asset account itself, not in token accounts. Consequence: enhanced-transaction APIs - including major indexers - parse Core transfers as `type: "UNKNOWN"` with **empty `tokenTransfers`**. Tools built on those APIs report *zero provenance* for these assets. The history exists on-chain; almost nothing reads it.

**Gap 3 - keys are friction and risk.** Every key requirement kills a percentage of installs, adds a credential to leak, and couples your agent to a provider's billing. For read-only collectible data, none of that is necessary - if you're disciplined about which endpoints you use and polite about how you use them.

## 3. How it works - layer by layer

```
Claude / MCP client
   │ stdio (JSON-RPC 2.0)
   ▼
┌─────────────────────────────────────────────────┐
│ MCP layer (official TypeScript SDK)             │
│  8 tools · 1 resource · 1 prompt                │
│  zod validation on every input                  │
├─────────────────────────────────────────────────┤
│ Domain layer                                    │
│  curated registry: human names -> identifiers   │
│  ("candy gold" -> Core address, ME symbol...)   │
├─────────────────────────────────────────────────┤
│ Source layer (one module per upstream)          │
│  magiceden.ts   cryptoslam.ts   solana.ts       │
├─────────────────────────────────────────────────┤
│ Plumbing layer                                  │
│  per-source rate gates · retry w/ backoff       │
│  stale-on-error cache · timeout on every call   │
└─────────────────────────────────────────────────┘
```

### The MCP layer
Standard `@modelcontextprotocol/sdk` server over stdio. Every tool input is validated with zod schemas (base58 shape checks on addresses, length caps, enum-like regexes on symbols) *before* any network call. Errors return as clean `isError` results with actionable messages ("try search_collections, or pass a Core collection address") - an agent can recover mid-conversation instead of dead-ending.

### The domain layer (the differentiator)
Generic NFT tools make the user hunt for marketplace symbols. The curated registry maps human vocabulary ("candy gold series", "panini") to the *right identifier for each source*: a Magic Eden symbol for market data, a Metaplex Core collection address for on-chain supply, a CryptoSlam contract for the pulls feed. Everything not in the registry still works by passing identifiers directly - the registry is a convenience layer, not a wall.

### The provenance engine (the hard part)
For a Core asset, the server:
1. Fetches the raw account (`getAccountInfo`, base64) and **hand-decodes the AssetV1 layout**: discriminator byte, owner pubkey (bytes 1-33), update-authority enum, name. This yields the authoritative current owner - no indexer opinion involved.
2. Pulls the signature list for the asset and walks each transaction's instructions (top-level + inner), keeping the ones from the Core program.
3. For each `Transfer`, extracts the **new owner as the last instruction account that is not the asset, the collection, the Core program, or the System Program**. A fixed account index breaks on Core's optional-account variants (7 vs 8 accounts); this filter heuristic survives them. It was verified against a live Candy Digital auction: all 36 auctioned packs traced to their winners, zero untraced.
4. Labels events by marketplace (Magic Eden / Tensor program IDs in the transaction) so a sale reads as a sale.

The output is a story: `minted → listed (Magic Eden) → transferred → current owner`, each event with a timestamp and a verifiable tx signature.

### The plumbing layer (the production part)
- **Rate gates**: serialized limiters per source (Magic Eden ~1.6 req/s, Solana RPC 1 per 350ms). Being a polite client is the entire viability model of a keyless server.
- **Retries**: network errors, 5xx, and 429s retry with escalating backoff (slower for 429).
- **Never-blank caching**: every remote read is cached with a per-kind TTL. If a refresh fails and a previous good value exists, the server returns it **labeled `stale: true`** instead of erroring. An agent mid-conversation is better served by 90-second-old floor prices marked stale than by an exception.
- **Bounded memory**: the cache is capped (oldest-evicted) so a long-lived session can't grow unbounded.
- **Honest degradation**: results that are partial say so (`skippedTransactions`, `activitiesScanned`, quiet-market notes). Silent truncation is treated as a bug class.

## 4. The tools, in depth

| Tool | Sources | Notes |
|---|---|---|
| `search_collections` | registry | Scored free-text search; returns identifiers + hints when empty |
| `get_collection_stats` | ME + chain | The only tool of its kind that answers for collections *no marketplace indexes* by decoding the Core collection account (name, minted, current size, burned) |
| `get_floor_prices` | ME | Batch of up to 10, sequential through one gate |
| `get_recent_sales` | ME | Walks up to 500 activity events for true sales (`buyNow`); reports how much it scanned so quiet markets are explainable |
| `get_asset` | ME + chain | Marketplace view AND authoritative on-chain owner side by side; flags possible escrow ownership |
| `get_asset_provenance` | chain | The party trick (see above); depth-capped with explicit skip counts |
| `get_wallet_holdings` | ME | Read-only; the server can never move anything |
| `get_pack_pulls` | CryptoSlam | Live licensed-card rip feed: player, set/parallel, serial, population, owner, image; labeled best-effort because the upstream is flaky by nature |

## 5. Who is this for?

- **AI developers / agent builders** - drop-in collectibles data for agents with no key management, no wallet risk surface, and production patterns (caching, rate limits, graceful degradation) already handled.
- **Collectors who use Claude** - "what's my wallet worth", "did that card ever sell on ME", "watch pack pulls" answered conversationally from live data. Install is copy-paste.
- **Licensed-collectible communities** (Candy Digital, Panini) - their assets are exactly the ones mainstream NFT tooling handles worst (Core assets, marketplace-less drops). This server treats them as first-class.
- **Solana teams / hiring managers** - the repo is a worked example of MCP done properly: full protocol surface (tools + resources + prompts), strict TypeScript, live end-to-end tests, honest error surfaces, no slop.
- **Data journalists / analysts** - provenance queries ("who accumulated these 1-of-1s?") without writing RPC decoders.

## 6. Pros and cons, honestly

**Pros**
- Zero keys, zero config - working in under a minute, nothing to leak
- Read-only by construction - no private key ever touches the process
- Provenance data almost nothing else surfaces (Core TransferV1 decoding)
- Domain registry: speaks collector, not just protocol
- Production-grade plumbing: rate-gated, retried, cached, never-blank
- Full MCP surface (tools + resources + prompts), official SDK, strict TS
- Live test suite proving every tool against real endpoints

**Cons / limitations (by design or by v1)**
- Public endpoints are rate-limited: heavy parallel workloads want a personal `SOLANA_RPC_URL` (still keyless from the server's perspective)
- Provenance covers **Metaplex Core** assets; SPL/compressed NFTs get marketplace data but not the decoded history (v1 scope)
- CryptoSlam upstream is flaky; the feed is best-effort (cached, labeled)
- Sales/holdings coverage is as good as Magic Eden's indexing; escrow-held listed items show the escrow as owner (flagged in output)
- No USD conversion (SOL-denominated; deliberate - no extra price-feed dependency)
- The public Solana RPC blocks datacenter IPs - fine for local/desktop use (residential), but a hosted deployment needs its own endpoint

## 7. Why it can stand out

- **A true "first"**: MCP directories have no licensed-digital-collectibles server. Verifiable, specific, defensible.
- **Anti-key positioning**: "your AI should be able to *look at* collectibles without holding your keys" is a message both crypto-native and crypto-cautious audiences agree with.
- **A demo that lands in 45 seconds**: asking Claude "who owned this card?" and watching a full provenance timeline print is visceral in a way "38 DeFi tools" is not.
- **Expertise you can diff**: the Core decoding isn't wrapped from a library - it's in the repo, commented, with the verification story attached.

## 8. Security model

- **Read-only**: no signing, no transactions, no wallet material anywhere in the codebase.
- **No secrets**: nothing to configure means nothing to leak; `.gitignore` still guards the usual suspects.
- **Input validation** at the tool boundary (zod), **output shape-checking** at the source boundary.
- **Prompt-injection stance**: returned metadata (asset names, descriptions) is third-party content. The server returns it as data; agent frameworks must not execute instructions found in it. Called out in the README so integrators think about it.
- **No telemetry**: three data sources, nothing else, auditable in an afternoon.

## 9. FAQ

**Why not just use a Helius/DAS-based server?** Keys, credits, and - for Core assets - empty transfer history. This exists precisely for the data DAS-based paths miss, at a price (free) that can't be beaten.

**Does it work outside Claude?** Any MCP client: Cursor, Windsurf, Cline, custom agents via the SDK.

**Can it trade / list / mint?** No, and it never will in this repo. Read-only is a feature, not a missing feature.

**Why is VeVe not included?** No official public API surface exists; unofficial access is a TOS risk. This repo only ships sources that are public and TOS-clean.

**What if Magic Eden changes their API?** Shape checks fail loudly with the upstream named, cached data serves during the gap, and the source module is 150 lines to fix.

**Hosted version?** Planned (SSE/HTTP variant). Local stdio ships first because it's the zero-trust, zero-cost path.

## 10. The origin story (for the curious)

This server open-sources the keyless half of a live production pipeline: [p1xel.app/candymigration](https://p1xel.app/candymigration), a tracker that has followed Candy Digital's migration to Solana since mid-2026 - including tracing a 36-pack Gold Series auction to every winner, reconciling marketplace escrows, and surviving multiple RPC-provider incidents. The lessons (never-blank caching, escrow attribution, Core decoding, polite pacing) are baked into this codebase.
