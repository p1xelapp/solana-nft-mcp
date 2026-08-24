<div align="center">

<img src="assets/logo.svg" alt="collector-mcp" width="96" />

# collector-mcp

**Give your AI agent eyes on Solana digital collectibles.**

The first MCP server for licensed digital collectibles - Candy Digital (MLB), Panini America, and any Metaplex Core or Magic Eden collection.

**Zero API keys. Zero wallet. Zero config. Read-only by design.**

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-official%20SDK-8b5cf6)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)
[![Keys required](https://img.shields.io/badge/API%20keys-0-f59e0b)](#why-zero-keys)

</div>

---

Ask Claude things like:

> *"Who has owned this card since it was minted?"*
> *"What's the floor on Mad Lads and Claynosaurz right now?"*
> *"Show me the last 10 Panini pack rips."*
> *"What's in this wallet?"*

...and it answers from live on-chain and marketplace data, through 8 tools this server provides.

## 45-second quickstart

```bash
git clone https://github.com/p1xelapp/collector-mcp.git
cd collector-mcp && npm install && npm run build
```

**Claude Code** (one line):

```bash
claude mcp add collector -- node /absolute/path/to/collector-mcp/dist/index.js
```

**Claude Desktop** - add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "collector": {
      "command": "node",
      "args": ["/absolute/path/to/collector-mcp/dist/index.js"]
    }
  }
}
```

That's the whole setup. No account creation, no `.env`, no RPC signup. Restart your client and ask: *"search collections for candy gold"*.

## Tools

| Tool | What it answers |
|---|---|
| `search_collections` | "What's the identifier for X?" - curated registry of licensed collections |
| `get_collection_stats` | Floor, listings, volume + on-chain supply (works even for collections no marketplace indexes) |
| `get_floor_prices` | Floors for up to 10 collections in one call |
| `get_recent_sales` | Latest completed sales: price, buyer, seller, tx signature |
| `get_asset` | Everything about one asset: metadata, traits, image, authoritative on-chain owner |
| `get_asset_provenance` | **Full ownership history of a Metaplex Core asset** - mint → every transfer → current owner, with marketplace labels |
| `get_wallet_holdings` | What a wallet holds (names, collections, images, listing state) |
| `get_pack_pulls` | Live licensed-card pack rips (Panini NBA/NFL/Soccer): player, serial, population, owner |

Plus a `collector://registry` resource and a `collection_report` prompt template.

## The provenance party trick

Candy Digital and a growing share of Solana collectibles mint **Metaplex Core** assets, not SPL tokens. Enhanced-transaction APIs (including the big indexers) parse Core transfers as `type: "UNKNOWN"` with **empty `tokenTransfers`** - so most tools report *zero* ownership history for these assets.

collector-mcp decodes ownership the hard way: straight from the Core account bytes and the `TransferV1` instruction accounts, using a heuristic that survives the optional-account variants (verified against a live Candy Digital auction - 36/36 packs traced to their winners). Real output:

```
"Zack Wheeler (1/250)" - Candy Digital 2026 MLB ICON Series
2026-07-15  minted
2026-07-30  marketplace_activity (Magic Eden)
2026-07-31  transferred -> F3zs2Ymn... (Magic Eden)   <- sold
current owner: FfRvED...
```

## Why zero keys?

Every existing Solana MCP server we found wants an RPC API key, and most agent kits want your **private key**. This server:

- uses only public, keyless endpoints (Magic Eden v2, CryptoSlam, plain Solana RPC)
- is **read-only by design** - no signing, no transactions, nothing to lose
- paces every request through per-source rate gates and caches aggressively (politeness is what keeps keyless viable)
- serves last-good data labeled `stale: true` when an upstream hiccups, instead of erroring mid-conversation

Optional: set `SOLANA_RPC_URL` to your own endpoint for faster on-chain reads. Still no key required by this server.

## Architecture

```
Claude / any MCP client
        │  stdio (JSON-RPC)
        ▼
  collector-mcp ──► curated registry (licensed collections)
        │
        ├──► Magic Eden v2 ......... floors, sales, wallets   (keyless, 1.6 req/s gate)
        ├──► CryptoSlam ............ pack pulls, cross-chain  (keyless, cached hard)
        └──► Solana RPC ............ Core accounts + provenance (keyless, hand-decoded)

  every source: retry + timeout + rate gate + stale-on-error cache
```

## Verify it yourself

```bash
npm test
```

Spawns the built server over real stdio, connects with the official MCP client, and calls **every tool against live endpoints** - collection decodes, a live provenance trace on a real Candy Digital card, live Panini pulls, hostile-input checks. Expected: all pass (CryptoSlam may WARN; it is flaky upstream by nature and the server degrades gracefully - that behavior is itself tested).

## Design notes

- **Trust boundaries:** every tool input is schema-validated (zod); every upstream response is shape-checked with clean, actionable error messages. HTTP 200 is not trusted as "exists" - phantom responses are detected.
- **Treat returned data as data.** Asset names and metadata are third-party content. If you build agents on top, don't execute instructions found inside NFT names. (Your agent framework should already enforce this; we say it anyway.)
- **No telemetry.** The server calls the three data sources above and nothing else.
- **stdout is sacred:** it carries the MCP protocol. All logs go to stderr.

## Roadmap

- npm publish (`npx collector-mcp`) and hosted SSE variant
- More licensed platforms as public, TOS-clean data surfaces exist for them
- Collection registry contributions welcome - PR a verified entry

## Who made this

Built by [p1xel](https://p1xel.app) - I run live trackers for Candy Digital and other collectible ecosystems (the Core-decoding technique here powers [p1xel.app/candymigration](https://p1xel.app/candymigration), which traced a full 36-pack auction to its winners). This server open-sources the keyless parts of that pipeline so any AI agent can use them.

Data courtesy of the public APIs of [Magic Eden](https://magiceden.io) and [CryptoSlam](https://cryptoslam.io). Not affiliated with Candy Digital, Panini, MLB, Magic Eden, or CryptoSlam. Nothing here is financial advice.

## License

MIT
