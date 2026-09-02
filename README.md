<div align="center">

<img src="assets/logo.svg" alt="collector-mcp" width="96" />

# collector-mcp

**Ground truth on Solana collectibles, for whatever AI you already use.**

Zero API keys. Read-only. Runs on your machine.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-official%20SDK-8b5cf6)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)
[![Keys required](https://img.shields.io/badge/API%20keys-0-f59e0b)](#zero-keys-on-purpose)

</div>

---

I run trackers for Candy Digital, Panini and VeVe drops. Somewhere along the way I noticed
that every mainstream NFT API returns an **empty** transfer history for Metaplex Core assets,
which is most of what mints on Solana now. Ask an AI "who has owned this card?" and it either
guesses or tells you it never traded. Both wrong. Only one looks wrong.

This server fixes that, and a few related things, for Claude, Cursor, or any MCP client.

## Setup, once

```bash
git clone https://github.com/p1xelapp/collector-mcp.git
cd collector-mcp && npm install && npm run build
```

Claude Code:

```bash
claude mcp add collector -- node /absolute/path/to/collector-mcp/dist/index.js
```

Claude Desktop or Cursor, in the MCP config:

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

Restart the client. Ask *"search collections for candy gold"*. Done. No account, no `.env`,
no RPC signup. Real walkthroughs with personas: [docs/HOW-PEOPLE-USE-IT.md](docs/HOW-PEOPLE-USE-IT.md).

## Three tools do most of the work

| You ask | Tool | You get |
|---|---|---|
| *"Only 250 exist and it never sold under 2 SOL. True?"* | `verify_claim` | confirmed / contradicted / unverifiable, the numbers observed, how to re-check without trusting me, and a one-line receipt to paste back into the thread |
| *"Who has owned this?"* + a mint | `get_asset_provenance` | every owner, dated, marketplaces named |
| *"What is this?"* + anything | `identify` | what it is, where it trades, what to call next. Works on collections launched this morning |

The other eight: `get_collection_stats` (floors across venues, plus whether they can even be
compared), `get_recent_sales`, `get_floor_prices`, `get_asset`, `get_wallet_holdings`,
`get_pack_pulls` (live Panini rips), `search_collections`, and `get_integration_recipe`
(building a bot or dashboard? endpoints, rate limits, running cost, and the ways it fails
silently, learned the expensive way).

Plus a `collector://glossary` the assistant reads first, so it knows a floor is an ask and not
a value, and that a listed card's on-chain owner is the marketplace, not the seller.

Tool names are frozen. Agents reference them in prompts; renaming one breaks integrations
without an error.

## The part nobody else does

Real output, 1 Sep 2026, same card:

```
Helius enhanced transactions      collector-mcp
------------------------------    ---------------------------------------------
7 txs, all type "UNKNOWN"         "James Wood (29/250)" · 7 events
tokenTransfers: 0                 2026-07-15  minted
nft events:     0                 2026-07-17  transferred -> 6HykKUzW…
                                  2026-08-08  transferred -> 1BWutmTv… (Magic Eden escrow)
                                  2026-09-01  transferred -> 6HykKUzW… (delisted)
                                  2026-09-01  transferred -> 1BWutmTv… (relisted, 11 min later)
```

No indexer involved. It reads the Core account bytes and the `TransferV1` instruction
accounts straight off public RPC. Same technique traced all 36 packs of a live Gold Series
auction to their winners, none missed. Try it in a browser without installing anything:
[p1xel.app/collector-mcp/demo](https://p1xel.app/collector-mcp/demo/).

## Two things I'm proud of

**It refuses bad comparisons.** Collector Crypt is 0.053 SOL on Magic Eden and 9 USDC on
OpenSea. Merge those and you get "170x more expensive." They roughly agree once converted.
`get_collection_stats` says *not comparable as printed* and will not rank them. No currency
conversion on purpose; a stale price feed is wrong with the same confidence as a good one.

**NFT names are treated as hostile.** Anyone can mint an asset whose name is a fake message
boundary followed by instructions to your AI. Every name from chain or marketplace has that
structure stripped before a model sees it. I could not find another blockchain MCP server
that does this.

## Zero keys, on purpose

Every default source is public and keyless: Magic Eden v2, CryptoSlam, plain Solana RPC.
Requests are paced per source and cached; last-good data is served labelled `stale: true`
rather than erroring mid-conversation. Being polite is what keeps keyless working.

There is no signing code in this repo. It cannot transact because the ability was never
written, not because a flag says so. Every tool declares `readOnlyHint` in the protocol.

`SOLANA_RPC_URL` swaps in your own endpoint if you have one. Still no key needed here.

### Optional: OpenSea

Set `OPENSEA_API_KEY` in the config's `env` block (not your shell; MCP clients launch the
server with a clean environment) and `get_collection_stats` / `get_recent_sales` add the
OpenSea side. Free keys are one `curl -X POST https://api.opensea.io/api/v2/auth/keys` away,
capped at 2 a day and expire in 7 days. Without a key, nothing changes and nothing asks.

## What it does not do

- **Provenance is Metaplex Core only.** Legacy SPL and compressed NFTs are named as gaps,
  not returned as empty lists.
- **Solana only.** Keyless indexed NFT data on other chains died with Reservoir and
  SimpleHash. I'd rather say that than pretend.
- **No holder censuses.** That needs a paid indexer. It says so instead of estimating.
- **Public RPC throttles bursts.** Fine for conversation. Bring your own endpoint for heavy use.

## Check it yourself

```bash
node test/protocol.mjs   # offline: every tool, resource, prompt, validation, the injection defence
npm test                 # live: every tool against real endpoints, a real provenance trace, hostile inputs
```

CI runs the offline suite plus a full-history secrets scan on every push.

## Who made this

[p1xel](https://p1xel.app). The Core decoding here came out of
[CandyScan](https://candyscan.p1xel.app), which needed it to trace a 36-pack auction.
This is the keyless part of that pipeline, open-sourced.

Not affiliated with Candy Digital, Panini, MLB, Magic Eden, OpenSea or CryptoSlam. Not
financial advice. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security:
[SECURITY.md](SECURITY.md). Deep dive: [docs/DEEP-DIVE.md](docs/DEEP-DIVE.md).

MIT.
