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

Ask your AI about a Solana wallet, card or collection today and it answers from memory.
It will tell you a card "never traded" because the usual APIs return an empty history for
Metaplex Core assets. It will add a SOL floor to a USDC floor. It will call a floor a value.

This server plugs into Claude, Cursor or any MCP client and gives the same AI live,
labelled data: the chain for supply, provenance, custody rules and wallet age; Magic Eden
without a key; OpenSea if you add one. Then it does the part a raw API cannot: it says what
each number is, what the source could not see, and how to check it without trusting me.

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

Restart the client. Ask *"profile wallet 7HHs3…"* in your own words. You never type a tool
name. No account, no `.env`, no RPC signup. Walkthroughs for fifteen kinds of people, from
first-week newbie to brand licensing lead: [docs/HOW-PEOPLE-USE-IT.md](docs/HOW-PEOPLE-USE-IT.md).
Questions people ask before installing: [docs/FAQ.md](docs/FAQ.md).

## Things you can ask

**A wallet.** What do they collect, which collection is most of the wallet, how much of the
supply is that. Flipper or holder, median hold, best flip, net SOL in or out. Order book or
AMM pools; OpenSea too with a key, including plain transfers, so "airdropped or bought?" gets
an answer. How old is the wallet. What is it worth at floor (you get a ceiling, called one).

**An item.** Who has owned it, dated, marketplaces named. Whether "never traded" is true.
Whether the issuer can freeze, move or burn it without the holder. Whether the royalty is
enforced by the program or just written down. Whether the art can still be edited.

**A collection.** Real supply from the chain. Floors on Magic Eden and OpenSea and whether
they can even be compared. Whether the floor is one listing or a book. What buyers paid this
week. Which Solana collections OpenSea indexes and each one's on-chain address.

**A build.** Sales bot, floor dashboard, wallet tracker, pack watcher: endpoints, rate limits,
running cost, and the ways each one fails silently, learned on live trackers.

## The tools

| Ask | Tool | Back |
|---|---|---|
| "What's in this wallet?" | `get_wallet_profile` | holdings by collection, share of wallet and of supply, listed and compressed counts, royalty asked, floor ceiling with assumptions, wallet age and tx count |
| "Do they flip or hold?" | `get_wallet_activity` | buys/sells with SOL totals, net flow, venue split, top collections, every flip with hold time and P&L, a behaviour label with its reason; OpenSea transfers with a key |
| "Is that true?" | `verify_claim` | confirmed / contradicted / unverifiable, the numbers seen, how to re-check, a one-line receipt |
| "Who has owned this?" | `get_asset_provenance` | every owner, dated, marketplaces named. The history other indexers return empty |
| "Is it really mine?" | `get_asset_trust` | Core plugins decoded from bytes: delegates, frozen state, enforced vs advisory royalties, mutable metadata, on-chain editions |
| "What is this?" | `identify` | what it is, where it trades, what to call next. Works on collections launched this morning |
| "Floor?" | `get_collection_stats` | chain supply, Magic Eden and OpenSea floors, reconciliation that refuses to rank SOL against USDC, OpenSea supply and royalty with a key |
| "Build me a…" | `get_integration_recipe` | endpoints, pace, cost, skeleton, silent failure modes |

Plus `search_collections`, `get_floor_prices`, `get_recent_sales`, `get_asset`,
`get_wallet_holdings`, `get_pack_pulls`. Two prompts (`collection_report`, `wallet_report`)
and a `collector://glossary` the assistant reads first, so it knows a floor is an ask, a
listed item's on-chain owner is the escrow, an opened Candy pack is returned not burned, and
a transfer-in is not automatically an airdrop.

Tool names are frozen. Agents reference them in prompts; a rename breaks integrations
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

No indexer. It reads the Core account bytes and the `TransferV1` instruction accounts
straight off public RPC. Same technique traced all 36 packs of a live Gold Series auction to
their winners. Try it in a browser without installing anything:
[p1xel.app/collector-mcp/demo](https://p1xel.app/collector-mcp/demo/).

## Three things I'm proud of

**It labels what a number is.** A wallet's floor-times-count comes back as a *ceiling* with
the items it could not price counted, the thin books named, and a pointer to recent sales.
A behaviour label comes with its reason. Every wallet answer says which feed it read and
which venues that feed cannot see.

**It refuses bad comparisons.** Collector Crypt is 0.053 SOL on Magic Eden and 9 USDC on
OpenSea. Merge those and you get "170x more expensive." `get_collection_stats` says *not
comparable as printed* and will not rank them. No currency conversion on purpose; a stale
price feed is wrong with the same confidence as a good one.

**NFT names are treated as hostile.** Anyone can mint an asset whose name is a fake message
boundary followed by instructions to your AI. Every name from chain or marketplace has that
structure stripped before a model sees it, and it is tested offline in CI.

## Zero keys, on purpose

Every default source is public and keyless: Magic Eden v2, CryptoSlam, plain Solana RPC.
Requests are paced per source and cached; last-good data is served labelled `stale: true`
rather than erroring mid-conversation. Being polite is what keeps keyless working.

There is no signing code in this repo. It cannot transact because the ability was never
written. Every tool declares `readOnlyHint` in the protocol. Wallet questions take a public
address, the same one anyone can paste into an explorer.

`SOLANA_RPC_URL` swaps in your own endpoint if you have one. Still no key needed here.

### Optional: OpenSea

Solana collections trade on OpenSea since 31 Aug 2026. Set `OPENSEA_API_KEY` in the
config's `env` block (not your shell; MCP clients launch the server with a clean
environment) and you get OpenSea floors, sales, supply and royalty per collection, plain
transfers per wallet, and a searchable index of every Solana collection OpenSea lists. Free
keys are one `curl -X POST https://api.opensea.io/api/v2/auth/keys` away, two a day, seven-day
expiry. Without a key, nothing changes and nothing asks.

## What it does not do

- **Buy, sell, list, sign.** No code for it.
- **Provenance and trust decoding are Metaplex Core only.** Legacy SPL and compressed NFTs
  are named as gaps, not returned as empty lists. Holdings and activity cover both.
- **Solana only.** Keyless indexed NFT data on other chains died with Reservoir and
  SimpleHash. I'd rather say that than pretend.
- **No valuations.** Ceilings, sales and gaps. Not advice.
- **Public RPC throttles bursts.** Fine for conversation. Bring your own endpoint for heavy use.

## Check it yourself

```bash
node test/protocol.mjs   # offline: every tool, resource, prompt, validation, wallet logic on captured feeds, the injection defence
npm test                 # live: every tool against real endpoints, a real provenance trace, a real wallet, hostile inputs
```

CI runs the offline suite plus a full-history secrets scan on every push.

## Who made this

[p1xel](https://p1xel.app). The Core decoding here came out of
[CandyScan](https://candyscan.p1xel.app), which needed it to trace a 36-pack auction. This
is the keyless part of that pipeline, open-sourced.

Not affiliated with Candy Digital, Panini, MLB, Magic Eden, OpenSea or CryptoSlam. Not
financial advice. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security:
[SECURITY.md](SECURITY.md). Deep dive: [docs/DEEP-DIVE.md](docs/DEEP-DIVE.md).

MIT.
