# Fifteen ways people use it

Worked examples. The names, wallets and numbers are invented; the mistakes behind them are
ones I have watched happen. Install the server, then try one with your own wallet address
or a collection name.

The short version: you install it once, then you talk to your AI like a person. It picks
the tool. You never type a tool name.

---

## Setup, once (any client, about 3 minutes)

The server is a small Node program. Your AI client starts it in the background and talks
to it over stdin/stdout. Nothing runs on my side. Nothing phones home. It cannot sign,
send or spend anything; there is no such code in it.

**1. Get the code**

```bash
git clone https://github.com/p1xelapp/collector-mcp.git
cd collector-mcp
npm install && npm run build
```

You now have `dist/index.js`. Note its full path. You need it once.

**2. Tell your client about it**

*Claude Code (terminal):*

```bash
claude mcp add collector -- node /absolute/path/to/collector-mcp/dist/index.js
```

*Claude Desktop:* Settings → Developer → Edit Config. That opens
`claude_desktop_config.json`. Paste:

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

Save, fully quit Claude Desktop, reopen. A small tools icon appears under the chat box.
Click it: 21 collector tools.

*Cursor:* Settings → MCP → Add new global MCP server. Same JSON.

*Anything else that speaks MCP* (Windsurf, Zed, Cline, your own agent): same JSON shape,
`command: node`, `args: [path to dist/index.js]`.

**3. Ask something**

*"What's in wallet 7HHs3...?"* or *"search collections for claynosaurz"*. If you get real
numbers back, everything works. No account, no key, no `.env`.

**OpenSea turns itself on.** The first question that needs it asks OpenSea for one of its
free agent keys and stores it under your home folder, so a second marketplace arrives with
no sign-up: OpenSea floors, sales, plain transfers (airdrops and gifts) and a searchable
index of every Solana collection OpenSea lists. Set `COLLECTOR_MCP_NO_AUTO_KEYS=1` to stop
it. When OpenSea is off, nothing breaks and every answer names it as the missing half.

---

## Questions it answers

Say them in your own words. Roughly grouped by who tends to ask.

**About a wallet** (yours, a whale's, a seller's, a giveaway winner's)

- What do they collect? Which collection is most of the wallet?
- How many of X do they own, and what share of the whole supply is that?
- Do they flip or hold? Median hold time? Best and worst flip?
- Are they buying or selling lately? Net SOL in or out?
- Magic Eden order book, AMM pools, or OpenSea? Plain transfers as well as fills?
- Was this airdropped, gifted, or bought?
- How old is this wallet? How many transactions? Fresh wallet holding a grail?
- What is it worth at floor? (you get a ceiling, labelled as one, with the assumptions)
- Anything listed right now they may have forgotten about? Compressed spam?

**About one item**

- Who has owned this, in order, with dates and which marketplace?
- Has it ever changed hands, or is "never traded" a story?
- Can the issuer freeze it, move it, or burn it without my signature?
- Is the royalty enforced by the program or just written in the metadata?
- Is the metadata still editable? Is the serial on-chain or printed text?
- Is this a pack, a card, a collection account, or nothing?

**About a collection**

- What is the real supply? Minted vs still existing vs listed?
- Floor on Magic Eden vs OpenSea, and can those two numbers even be compared?
- Is the floor one optimistic listing or a real book? What are people paying?
- Recent sales, velocity, who is buying.
- Which Solana collections does OpenSea index, and what is each one's on-chain address?

**About building something**

- I want a sales bot / floor dashboard / wallet tracker / pack watcher. Endpoints,
  limits, running cost, and where it fails silently?

---

## The people

Fifteen people, each built around one mistake I have watched someone make.

### 1. Sam, first week in Solana

**Level:** newbie. **Background:** bought a Claynosaurz on OpenSea because a friend
said so. Has a Phantom wallet and a lot of questions. **Why collector-mcp:** every
answer online is either a shill or a scam warning.

**Asks:** *"I just bought this. What is it, is it real, and did I overpay?"* and pastes
the OpenSea link.

**What happens:** `identify` reads the mint out of the link and says what it is (a
Solana NFT in the Claynosaurz collection, listed on both marketplaces). `get_asset` shows the
item, its traits and the royalty the project asks for. `get_collection_stats` gives the
floor on both marketplaces and says whether they are comparable. `get_recent_sales`
shows what people paid this week. Sam finds out he paid a touch over floor, which is
normal, and that his item is a Core asset with nothing unusual attached.

**Then:** *"Can I sell it on Magic Eden even though I bought it on OpenSea?"* The
glossary already told the assistant the answer: yes, it is the same asset, marketplaces are
just storefronts.

### 2. Marcus, spends real money on Candy cards

**Level:** experienced collector. **Background:** three Candy Digital Discords, checks
them between meetings. **Why collector-mcp:** ChatGPT confidently made up a card's history
once and it cost him.

**Asks:** someone posts *"James Wood /250, never traded, straight from the pack."*
Marcus pastes the mint: *"Has this ever changed hands?"*

**What happens:** `verify_claim` (never-traded) returns **CONTRADICTED, 4 transfers**,
and a one-line receipt. *"Show me"* runs `get_asset_provenance`: listed, delisted,
relisted twice this month. He pastes the receipt and the transfer history into the thread.

**Why it beats a plain AI:** the usual NFT APIs return an empty history for Metaplex
Core assets. A plain AI reads empty as "never traded" and agrees with the seller.

### 3. Lena, long-term holder wondering what she has

**Level:** intermediate. **Background:** has been buying Mad Lads and a few smaller
collections since 2023, never sold, never counted. **Why collector-mcp:** she wants a
profile of her own wallet without connecting it to anything.

**Asks:** *"Profile my wallet"* + address. (No signing, no connection. It is a public
address, read like any other.)

**What happens:** `get_wallet_profile`: 61 items across 9 collections, Mad Lads 41% of
the wallet, 4 items listed (two she forgot), 3 compressed airdrops she never asked for,
Mad Lads share of supply 0.25% (supply from OpenSea's index, or the chain
for registry collections). Floor ceiling 214 SOL, called a ceiling, with a line saying
her Mad Lads position is small versus what is listed so it would not move the floor.
Wallet age 2 years 8 months, 4,100+ transactions ("at least", the walk was bounded).

**Then:** *"Which of my items should I look at before selling anything?"* The assistant
runs `get_asset_trust` on the top few and finds one with a permanent freeze delegate
held by the issuer. Worth knowing before listing it.

### 4. Rio, trader who studies other wallets

**Level:** advanced. **Background:** flips mid-tier Solana collections, follows six
wallets that seem to know things. **Why collector-mcp:** wallet-tracker sites show
transactions; he wants behaviour.

**Asks:** *"Is 9taD9... a flipper or a holder? What do they trade and where?"*

**What happens:** `get_wallet_activity` reads 300 Magic Eden events: 48 buys totalling
131 SOL, 39 sells totalling 158 SOL, net +27 SOL, label **flipper** (33 of 48 purchases
resold inside the window, median hold 2.1 days), 71% order book / 29% AMM pools, top
collections listed, best flip +6.2 SOL on a Claynosaurz held four days. The caveats say
this is Magic Eden's API feed. OpenSea answered too, so plain transfers are in the
picture and an airdropped item is not counted as a buy.

**What he does not get:** a signal. The tool describes; it does not recommend.

### 5. Priya, solo dev, sales bot by Friday

**Level:** senior dev, new to Solana. **Background:** built an Ethereum sales bot once;
the painful part was month three, not day one. **Why collector-mcp:** she wants the
traps before she hits them.

**Asks:** *"Discord sales bot for Claynosaurz. Endpoints, rate limits, where does this
break silently?"*

**What happens:** `get_integration_recipe` (sales-bot): verified endpoints, the real
Magic Eden pace (about 2/s, so 600 ms), a cursor-based skeleton, running cost, and the
trap where a misspelled symbol returns HTTP 200 and the bot posts nothing forever. She
ships against real data the same afternoon and runs the kill-mid-batch check first
because the recipe told her to.

### 6. Tomas, founder launching a Core collection

**Level:** technical founder. **Background:** launching packs that open into cards, has
a dev but wants to check the dev's work. **Why collector-mcp:** one wrong plugin and
holders cannot transfer their cards.

**Asks:** *"Here is a test pack and a test card from our devnet-to-mainnet dry run.
What can we, the issuer, do to each one after sale?"*

**What happens:** `get_asset_trust` on the pack: permanent burn delegate held by the
issuer (expected, that is how packs get consumed on open). On the card: permanent
freeze delegate held by the issuer and mutable metadata. The tool says the second one is
a red flag on an item meant to be kept. Tomas asks the dev why. Turns out it was
copy-pasted from the pack config. Fixed before launch instead of in a Twitter thread
after.

**Then, launch day:** *"We are announcing 5,000 minted. Confirm."* `verify_claim`
(supply) reads the collection account: 4,996. Four failed mints. He posts 4,996.

### 7. Maya, community mod running giveaways

**Level:** non-technical. **Background:** moderates a 20k-member Discord, runs weekly
raffles, gets sybil-farmed constantly. **Why collector-mcp:** she needs a fast, fair
check she can explain.

**Asks:** *"Winner is wallet Cbj.... Is this a real collector or a fresh wallet made for
raffles?"*

**What happens:** `get_wallet_profile`: created 6 days ago, 11 transactions, holds 1
item. `get_wallet_activity`, with OpenSea read as well: the one item arrived by plain
transfer from another wallet that entered the same raffle. She has an explanation in
plain language, not an accusation: "received without a recorded sale, from wallet X, 6
days old". She re-rolls.

### 8. Jordan, writing about the Solana card boom

**Level:** analyst / journalist. **Background:** covering the gacha-card wave
(Collector Crypt, Jupiter Gacha, Candy). **Why collector-mcp:** every number in the
space is quoted without a unit or a marketplace.

**Asks:** *"Collector Crypt: floor, volume, supply, and is the floor the same on
Magic Eden and OpenSea?"*

**What happens:** `get_collection_stats` returns a SOL floor on Magic Eden and a USDC floor on
OpenSea and says **not comparable as printed**. No conversion, on purpose, because a
price feed that has gone stale gives a wrong number with no warning. The glossary reminds
the assistant that gacha odds are an operator claim the chain cannot verify. Jordan
writes both numbers with their marketplaces and one sentence about odds.

### 9. Chen, brand licensing lead doing due diligence

**Level:** business, not technical. **Background:** the company's IP is about to be
minted by a partner platform. Legal wants to know what the platform can do to the
items after fans buy them. **Why collector-mcp:** the platform's deck says "true
ownership". Chen wants the bytes.

**Asks:** *"Take three items from the partner's existing collection. Can they freeze,
move or burn them? Are royalties enforced? Can they edit the art later?"*

**What happens:** `get_asset_trust` on each: permanent transfer delegate held by the
platform on all three, royalties advisory not enforced, metadata mutable. Every one of
those is a sentence in the contract negotiation now. Chen also asks for the
`provenance-lookup` recipe so their own engineer can reproduce the check without this
server.

### 10. Ava, building an autonomous research agent

**Level:** AI engineer. **Background:** her agent reads marketplaces all day and has
been prompt-injected twice by NFT names. **Why collector-mcp:** she needs data that is
typed and defanged.

**What she gets:** every tool result carries `structuredContent` (no number scraped out
of prose), every NFT name is neutralised before her model sees it (fake message
boundaries, bidi tricks, imperative phrasing flagged), every tool declares
`readOnlyHint`, and `verify_claim` returns receipts her agent can log. She runs
`node test/protocol.mjs` in her CI to pin the surface.

### 11. Diego, hobbyist with a messy wallet

**Level:** casual. **Background:** minted a hundred things in 2022, mostly forgot.
**Why collector-mcp:** spring cleaning.

**Asks:** *"What's in here that I should deal with?"*

**What happens:** `get_wallet_profile`: 143 items, 31 with no collection name, 22
compressed (mostly unsolicited), 3 still listed on Magic Eden from a year ago at prices
that no longer make sense. The assistant lists the three listings first, because a stale
listing at last year's floor is the one thing in that wallet that can cost him money
today.

### 12. Grace, about to buy a "1 of 1 legendary"

**Level:** intermediate. **Background:** the price is a month's rent. **Why
collector-mcp:** she wants to check the seller's claims before she pays.

**Asks:** the OpenSea link + *"Everything I should know before I pay for this."*

**What happens:** `identify` pulls the mint. `get_asset_provenance`: minted, one
transfer to the seller, listed. `verify_claim` (never-traded): **CONFIRMED** with a
receipt. `get_asset_trust`: no delegates, royalties enforced, metadata immutable,
edition 1 of 1 on-chain rather than in the name. `get_wallet_activity` on the seller:
holder, not flipper, three years old. `get_collection_stats`: supply 1 as claimed. She
buys. Later, someone in the Discord says the item was "flipped five times". She pastes
the receipt.

### 13. Kofi, reads floors for a living

**Level:** power trader. **Background:** Tensor and Magic Eden all day. **Why
collector-mcp:** "floor" lies more than any other number in the hobby.

**Asks:** *"Is the Bulltoshi floor real?"*

**What happens:** `get_collection_stats`: floor 1.9 SOL, 3 listed. `get_recent_sales`:
last ten sales average 1.2 SOL, the newest four days ago. The assistant says what the
data says: the floor is three asks, the book is thin, buyers have been paying a third
less. Kofi already knew how to read that; he just did not want to open four tabs.

### 14. Nadia, needs her year in one table

**Level:** intermediate. **Background:** did a lot of trading, needs a record of it.
**Why collector-mcp:** every explorer export is either raw or paywalled.

**Asks:** *"List every NFT I bought and sold this year with dates and prices."*

**What happens:** `get_wallet_activity` with five pages: every Magic Eden buy and sell,
dated, priced, flips paired with hold time. The caveats say what is missing:
fees and royalties, anything older than the window, and that coverage of marketplaces
outside Magic Eden's feed is not established. It is a record with its gaps labelled,
which is more than the alternatives gave her. It is not tax advice and says so.

### 15. Oren, project dev building a dashboard

**Level:** dev at a Solana project. **Background:** the community wants a floor
dashboard that shows both marketplaces now that the collection is on OpenSea. **Why
collector-mcp:** he wants to get cross-marketplace right the first time.

**Asks:** *"Floor dashboard for our collection across Magic Eden and OpenSea. How do I
not make a fool of myself?"*

**What happens:** `get_integration_recipe` (floor-dashboard) plus a live
`get_collection_stats` showing the reconciliation block: comparable or not, spread,
cheapest marketplace only when the currencies match. He copies the rule into his dashboard.
The recipe also tells him OpenSea has been seen labelling Magic Eden fills as its own
sales, so he labels by the program that executed the transaction, not by who reported it.

---

## What it will not do

- Buy, sell, list, transfer, or sign. There is no code for it.
- Other chains.
- Tell you what something is *worth*. It tells you the ceiling, the sales, and the gaps.
- See everything. Every answer names the feeds it read and the ones it could not.
