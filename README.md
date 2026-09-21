<div align="center">

<img src="assets/banner.png" alt="solana-nft-mcp" width="100%" />

# solana-nft-mcp

**The NFT APIs I tried return an empty ownership history for a Metaplex Core asset, and an AI reading that empty answer tells you the card has never traded.** solana-nft-mcp reads the chain itself: who owned it, who can freeze it, what sold and for how much, and where the deals are. Read-only, no sign-up, nothing collected, runs on your machine.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://github.com/p1xelapp/solana-nft-mcp/blob/main/tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-official%20SDK-8b5cf6)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](https://github.com/p1xelapp/solana-nft-mcp/blob/main/LICENSE)
[![Sign-up](https://img.shields.io/badge/sign--up-none-f59e0b)](#what-it-reads)

</div>

---

## Why

Ask an assistant about a Solana card today and it answers from memory. It will report that a
card "never traded", because the mainstream enhanced-transaction APIs return an empty history
for Metaplex Core assets while the transfers sit on chain the whole time. It will compare two
floors quoted in two currencies as if they were one.

solana-nft-mcp hands the same assistant live, labelled data instead: the chain for supply,
ownership, provenance and custody rules, Magic Eden without a key, and OpenSea
through a free key the server issues itself. Each number comes back with its marketplace, its currency, its read time, and what the
source could not see.

## How it fits together

<img src="assets/architecture.svg" alt="Your AI app talks to solana-nft-mcp over stdio; the server reads the Solana chain, the asset index, Magic Eden and OpenSea" width="100%" />

The server runs on your machine and your AI app starts it. Nothing here is a hosted
service, and there is no account between you and the data. This picture is generated
from the running server, so the counts and the source list cannot drift away from the
code: `npm test` fails if they do.

## Install

Requires Node 22 or newer (tested on 22 and 24; Node 20 is end of life). Build once:

```bash
git clone https://github.com/p1xelapp/solana-nft-mcp.git
cd solana-nft-mcp && npm install && npm run build
```

### Claude Code

```bash
claude mcp add solana-nft -- node /absolute/path/to/solana-nft-mcp/dist/index.js
```

### Claude Desktop

Settings -> Developer -> Edit Config, then add:

```json
{
  "mcpServers": {
    "solana-nft": {
      "command": "node",
      "args": ["/absolute/path/to/solana-nft-mcp/dist/index.js"]
    }
  }
}
```

Quit the app fully and reopen it.

### Other MCP clients

Tested hosts, with the version each was tested on: Claude Desktop (the `.mcpb` bundle), Claude
Code, and Codex CLI 0.153.4 (`codex exec -c 'mcp_servers.collector.command="node"' -c
'mcp_servers.collector.args=["/absolute/path/to/dist/index.js"]'`). Cursor, Windsurf, Gemini CLI,
Zed, Cline and VS Code take the same `command` / `args` pair in their own MCP config and should
run it, because the server speaks plain stdio and holds no client-specific code, but they have
not been tested here and each host's config syntax differs. ChatGPT on the web and Grok cannot
run it: they have nowhere to launch a local process.

### Did it work?

Most apps list the tools under a small icon near the message box; Claude Code shows them with
`/mcp`. You should see 21 tools, starting with `identify`. If you see none: the path in the
config must be absolute and must point at `dist/index.js`, `npm run build` must have been run,
and the app must be fully quit and reopened, tray icon included.

### Optional: OpenSea

Solana collections have traded on OpenSea since 31 Aug 2026, with Candy Digital among the
launch partners. OpenSea adds second-marketplace floors, sales, supply and royalty per collection,
plain transfers per wallet (how airdrops and gifts become visible), and a searchable index of
every Solana collection OpenSea lists.

You do not have to know a collection's OpenSea slug. It is found from the collection's
on-chain address against OpenSea's own Solana index, and failing that by trying the name and
accepting it only when OpenSea's record for that slug carries the same chain address. Pass
`openseaSlug` yourself to override. When neither path finds one, the answer says the second
marketplace was not read and why, which is a gap in what was searched rather than evidence the
collection is absent from OpenSea.

There is nothing to sign up for. The first time a question needs OpenSea, the server asks
OpenSea for one of its free agent keys and stores it in `~/.solana-nft-mcp/opensea-key.json` on
your own machine, renewing it before it expires. The key stays in that file: never logged,
never printed into an answer, and never requested at all by a session that asks no OpenSea
question. OpenSea caps new keys at about two a day per IP address, so if yours is refused,
OpenSea stays off and every answer names it as the missing half.

- `OPENSEA_API_KEY` - your own key from the OpenSea developer portal, for when the self-issued
  one cannot be had. It overrides the self-issued key entirely. Put it in the config's `env`
  block rather than the shell, because MCP clients launch the server with a clean environment:

```json
{
  "mcpServers": {
    "solana-nft": {
      "command": "node",
      "args": ["/absolute/path/to/solana-nft-mcp/dist/index.js"],
      "env": { "OPENSEA_API_KEY": "..." }
    }
  }
}
```

- `SOLANA_NFT_MCP_NO_AUTO_KEYS=1` - never request a key. OpenSea is then off unless you set
  `OPENSEA_API_KEY` yourself.

`SOLANA_RPC_URL` and `DAS_RPC_URL` swap in a private endpoint if one is available, and neither
is required. A key in that URL is registered and redacted from every answer: the userinfo password
and any query field named like a credential (`?api-key=`) at four characters or more, and any path
segment of eight or more characters that is not a route word. A path key shorter than eight
characters is the one shape not covered; put it in a query field or the userinfo instead, where
the shorter floor applies.

## Ask it anything

Nobody types a tool name. These are asked in plain words and the assistant picks the calls.

- Who has owned this card since it was minted, with dates and the marketplaces involved?
- Is it true this card has never traded?
- Can the project still freeze, move or burn what is in my wallet?
- What is in wallet 7HHs3..., and does that wallet flip or hold?
- What is the cheapest Legendary listing in that DC collection right now?
- Any Superman or Batman DC comic #1 or #100 for sale, and are any of them close to floor?
- Which collection is performing best right now on Magic Eden?
- What did Shohei Ohtani cards sell for this week, and how many changed hands?
- Are the Magic Eden and OpenSea floors for this collection even comparable?
- What would it take to build a sales bot on this, and where would it fail quietly?

A collection name, a player name, a card number or a trait is enough to start. Names resolve
against a bundled snapshot of the Magic Eden directory (30,499 collections, refreshed in the
background), against OpenSea's Solana index, and - when those do not produce a single
confident match - by asking Magic Eden about the name directly.

That last step matters more than it sounds. Magic Eden refuses to page past offset 30,000, so
the directory snapshot is a prefix of the marketplace rather than the whole of it, and the
collections past that ceiling are not obscure ones. Asking it for "DeGods" used to return
eight imitations and not DeGods. A name is now also tried as a symbol against the marketplace
itself, which has no ceiling, and the answer is accepted only when the marketplace's own record
confirms it. A single fuzzy match whose name is not what you asked for is offered as a
candidate with the mismatch stated, never presented as the answer.

Answers are also sized to arrive whole. Clients put a ceiling on a tool result (Claude Code cuts
at 25,000 tokens) and the model then reads the surviving prefix as the complete list, so a long answer drops
per-row detail before it drops rows, and says in the answer what it left out and how to get
it back.

## What it reads

| Source | Answers | Key |
|---|---|---|
| Solana RPC (three public endpoints, rotated) | supply, current owner from decoded Core account bytes, transfer history, wallet age | none |
| Asset index (DAS) on the public RPC | a second, independent opinion on ownership and wallet contents | none |
| Magic Eden v2 | floors, listings, sales, activity, top traders, trending | none |
| OpenSea v2 | second-marketplace floors, sales, supply, royalty, wallet transfers | self-issued |

No account, no sign-in, no telemetry, no analytics, no log of your questions. There is no signing
code in the repository, and every tool declares `readOnlyHint` in the protocol.

Precisely what leaves the machine, and nothing else:

- The public address, symbol or name you asked about, sent to the public source that can answer
  it: Solana RPC, the asset index, Magic Eden, and OpenSea when it is on.
- One request to `registry.npmjs.org` at startup to see whether a newer version exists. It sends
  the package name and the version you are running as a user-agent, and nothing about you or your
  question. Turn it off with `SOLANA_NFT_MCP_NO_UPDATE_CHECK=1`, or `SOLANA_NFT_MCP_OFFLINE=1` to
  stop every background request.
- One request to OpenSea to issue a free agent key, made only the first time a question actually
  needs OpenSea, and not at all if you set `OPENSEA_API_KEY` yourself or
  `SOLANA_NFT_MCP_NO_AUTO_KEYS=1`.

One file is written on your machine: `~/.solana-nft-mcp/opensea-key.json`, holding that self-issued
key at permissions 600. It is never logged and never printed into an answer: every key this
process has sent is registered, and every result is scrubbed against that registry before it
leaves, so even an upstream that echoes the request header back cannot carry it into a reply.
Nothing else is written to disk. An in-memory cache of recent answers lives for the process and is
gone when it exits, and no question you ask is written anywhere. Your AI client and its model
provider have their own data practices, which this server cannot speak for.

To remove it: `npm uninstall -g solana-nft-mcp` if it was installed from npm, delete the clone if
it was built from source, or remove the extension in Claude Desktop; then delete
`~/.solana-nft-mcp/` if it exists. npm keeps its own download cache, which
`npm cache clean --force` clears.

## Tools

21 tools. Names are frozen: agents reference them in prompts, and a rename breaks integrations
without raising an error.

| Tool | Back |
|---|---|
| `identify` | what an address or name is, where it trades, which tool to call next |
| `verify_claim` | confirmed, contradicted or unverifiable, with the numbers seen and how to re-check |
| `get_asset_trust` | Core plugins decoded from bytes: delegates, frozen state, enforced vs advisory royalties, mutable metadata, editions |
| `get_integration_recipe` | endpoints, pacing, running cost, skeleton and the silent failure modes for a given build |
| `search_collections` | name lookup across the Magic Eden directory and the OpenSea Solana index, saying which layers were read |
| `get_collection_stats` | chain supply, floors per marketplace, and a reconciliation that refuses to rank SOL against USDC |
| `get_collection_holders` | census of a Core collection from the chain's asset index: each asset and its last-indexed owner, listed or not, filterable by trait or name, holders ranked by count with a role on each (issuer, marketplace escrow as `venue-escrow`, or wallet, the issuer read from the collection's update authority on chain), capped at 2,000 rows by default and saying so when the cap is hit |
| `get_floor_prices` | current floor and listed count for up to 10 collections, Magic Eden only (cross-marketplace floors live in `get_collection_stats`) |
| `get_recent_sales` | latest completed fills with buyer, seller, price and signature |
| `get_asset` | three readers for one item: the marketplace, a byte-level decode, and the chain's asset index, with owner agreement reported |
| `get_asset_provenance` | bounded ownership history of a Core asset, dated, marketplaces named, every unread hole marked in place - `historyComplete` says every transaction was read, `mintObserved` says the mint itself was decoded |
| `get_wallet_holdings` | holdings from two independent readers, with the gap between them named |
| `get_wallet_profile` | holdings by collection, share of wallet and of supply, listed and compressed counts, floor ceiling with assumptions, wallet age |
| `get_wallet_activity` | buys and sells, net flow, marketplace split, every flip with hold time and P&L, realized totals, a behaviour label with its reason |
| `get_collection_sales` | sales over a window: count, volume, top and bottom sale, median, buyers, sellers, per-day series, a per-name breakdown (which player or character sold most), a name filter, how far back the feed was read |
| `find_in_group` | one edition number hunted across a whole family of collections, each match against that collection's own floor, with a cursor for the rest |
| `find_listings` | cheapest-first listings, trait filters combined with AND, a name filter that says whether it matched the item's own name or the set title around it, a lowest-serials mode for #1 and #100 hunters, each ask against its trait floor |
| `get_top_traders` | the largest wallets in a collection by Magic Eden volume, all time |
| `get_trending` | Magic Eden's trending list, with an explicit note when the marketplace publishes nothing |
| `explain_mechanics` | escrow, freezing, delegates, royalties, wash trades and migrations, per standard and marketplace, each entry citing its source |
| `get_source_status` | every source pinged live: tier, fallback, what it cannot see, which need a key |

## Prompts

Three, and none of them asks you to fill in a box. `getting_started` says what the server
answers and hands you five questions to try. `collection_report` and `wallet_report` ask which
collection or wallet you mean and then run the whole sequence: identifiers, supply, floor, what
sold, and one item's story.

There are deliberately no MCP resources. A client shows those to you as files to attach beside
your message, and nobody wants to attach a glossary to ask what a card is worth. Everything they
used to carry is reachable by a tool the assistant calls on its own: `explain_mechanics` for how
a standard or a marketplace behaves and for the vocabulary (ask it for "glossary" to get all of it
with the rules for presenting this data), `get_source_status` for the source catalog, and
`search_collections` for the collection registry.

## Trust and limits

- Buying, selling, listing and signing are absent. No code exists for them.
- Provenance and trust decoding cover Metaplex Core only. Legacy SPL and compressed NFTs are
  reported as named gaps, never as empty lists. Holdings and activity cover both.
- Magic Eden and OpenSea only, for marketplace data. Tensor has no self-serve API keys. Rarible's
  Solana API needs a key on a 100-request-a-month free tier and cannot say that a fill happened
  on Magic Eden, which is the mislabelling this server exists to avoid. Both sit in the source
  catalog as planned, with the condition that would add them. Magic Eden's feed sometimes carries
  rows it labels with another execution marketplace; each answer lists the marketplaces it observed
  and never claims that a marketplace absent from those rows is absent from the market.
- Every money figure names its currency and the API it came from (`currency: "SOL"`,
  `source: "magiceden"`) on the summary and on every priced row. Nested rows such as top buyers
  and per-day points carry the currency and inherit the source and coverage of the block they sit
  in, so keep that block's `source` and coverage flags with any row you copy out. Counts keep their coverage beside them (`truncated`,
  `membershipComplete`, `nameFilter.incomplete`, `unmeasuredCycles`). A program should
  refuse to act on a row whose coverage flag says the read was partial.
- Two error surfaces, on purpose. Input that fails a tool's schema is refused by the MCP SDK
  before the handler runs: `isError: true` with a text message, and no `structuredContent`.
  Every failure inside a handler carries `structuredContent.error`, a stable category a
  program can switch on: `not-found`, `wrong-kind`, `escrow`, `source-unsupported`,
  `bad-input`, `upstream-unavailable`, `error`. Treat a missing `structuredContent` on an
  error as the schema surface.
- Solana only. Keyless indexed NFT data on other chains went away with Reservoir and SimpleHash.
- No valuations and no currency conversion. A floor-times-count figure is returned as a ceiling
  with its assumptions attached, because a stale price feed is wrong with the same confidence as
  a good one.
- Sales history reaches as far as the marketplace keeps it, and the result says how far it got.
  Ownership history for Core assets comes from the chain and is bounded by `depth`: the result
  carries `historyComplete` and `skippedTransactions`, so a partial trail is never presented as
  the whole story.
- Public RPC throttles bursts, and cached values come back labelled `stale: true` rather than
  erroring mid-conversation. Full detail in [docs/TRUST-AND-LIMITS.md](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/TRUST-AND-LIMITS.md)
  and [docs/SOURCES.md](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/SOURCES.md).

## Security

Minting is permissionless, so a collection name is attacker-controlled text. Every name from a
chain or a marketplace is neutralised before a model sees it: invisible and bidi characters
stripped, newlines collapsed, delimiter markup defanged, instruction-shaped phrasing flagged.
This is covered by the offline test suite. Reporting: [SECURITY.md](https://github.com/p1xelapp/solana-nft-mcp/blob/main/SECURITY.md).

## Development

```bash
npm test           # offline: every tool, prompt, validation, wallet and market logic
                   # on captured feeds, plus the prompt-injection defence. No network at all.
npm run test:live  # live: floors, a real provenance trace, source status per family, name lookup
npm run test:smoke # live: every tool against real endpoints, a real wallet, hostile inputs
npm run snapshot   # refresh the bundled Magic Eden collection directory
npm run inspect    # open the MCP Inspector against a local build
```

CI runs a full-history secrets scan on every push to every branch, the offline suite, lint, the
tarball check and `npm audit` on `main` and pull requests, and the live check weekly.

## Docs

- [Under the hood: why it exists, how it works, what was tested](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/DEEP-DIVE.md)
- [Every data source, tiered](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/SOURCES.md)
- [Trust language and limits](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/TRUST-AND-LIMITS.md)
- [Questions people ask, and which ones it can answer](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/QUESTIONS.md)
- [Fifteen ways people use it](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/HOW-PEOPLE-USE-IT.md)
- [Things people build with it](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/BUILD-IDEAS.md)
- [What can change under this server, and what happens when it does](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/MAINTENANCE.md)
- [FAQ: questions about the server itself](https://github.com/p1xelapp/solana-nft-mcp/blob/main/docs/FAQ.md)
- [Contributing](https://github.com/p1xelapp/solana-nft-mcp/blob/main/CONTRIBUTING.md) and [Security policy](https://github.com/p1xelapp/solana-nft-mcp/blob/main/SECURITY.md)

## Why I built this

I was tracing a 36-pack Candy Digital auction, trying to work out which wallets actually won
the cards. Every NFT API I asked handed back an empty history. Not an error and not a warning:
an empty array, which anything reading it takes to mean the card has never traded. Those cards
had changed hands six times. The transfers had been on chain the whole time, sitting in
Metaplex Core account bytes that none of those APIs decode.

What bothered me was not the missing data. It was that the wrong answer arrived with exactly
as much confidence as a right one, and an assistant reading it would repeat that with no idea
anything was wrong.

So I wrote the decoder. Then I started seeing the same shape of error everywhere: a SOL floor
put beside a USDC floor and called 170x. A floor multiplied by an item count and called a
portfolio. A fuzzy name match on a different collection, answered as though it were the one you
asked about. Every one of them confident, every one of them wrong.

solana-nft-mcp is that decoder plus the rules I had to learn the hard way. Chain first. Label
the marketplace. Say what you could not see. Refuse to guess.

## Running on the same decoding

<a href="https://candyscan.p1xel.app"><img src="assets/using/candyscan.png" width="86" alt="CandyScan" /></a>

**[CandyScan](https://candyscan.p1xel.app)** tracks the Candy Digital collections on Solana:
supply, holders, migrations and sales, kept current. It is where the Core decoding was written
first, and this repository is the keyless half of that pipeline.

Shipped something on top of solana-nft-mcp? Open an issue and it goes here.

## About

Built and maintained by P1xel ([p1xel.app](https://p1xel.app),
[@P1xelCollector](https://x.com/P1xelCollector)), a long-time Solana collector.

**Independent project, not affiliated with the Solana Foundation.** SOLANA and SOL
are trademarks of the Solana Foundation. They appear in this project's name and
documentation for one reason only: to say which chain the server reads. Nothing
here is endorsed, sponsored or reviewed by the Solana Foundation, and no
affiliation is claimed or implied.

## License

MIT. See [LICENSE](https://github.com/p1xelapp/solana-nft-mcp/blob/main/LICENSE).

MIT covers this code, not the data it reads. Magic Eden and OpenSea publish API terms of their
own (attribution, permission for commercial use and redistribution, no working around a quota
with extra keys), and the collections' names and artwork belong to their issuers. A dashboard or
bot you sell on top of this server has to meet those terms itself.

Not affiliated with the Solana Foundation, Candy Digital, MLB, DC Comics, Magic
Eden or OpenSea. Every product name used here belongs to its owner and is used
only to say what the server reads. Nothing here is financial advice.
