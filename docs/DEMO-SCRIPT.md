# 45-Second Demo Script (X launch video)

**Format:** screen recording, no webcam needed. Payoff in first 3 seconds. No intro, no "hey guys".
**Setup before recording:** collector-mcp already added to Claude Desktop (or Claude Code); a Candy card mint address copied to clipboard (grab one fresh: run `npm test` and copy the discovered mint from the provenance line, or take any card from the ICON collection).

---

## Shot list

**0:00-0:03 - COLD OPEN (the hook)**
Screen already on Claude with the reply mid-render: an ownership timeline printing out.
Overlay text: **"I gave Claude eyes on my card collection."**

**0:03-0:12 - THE QUESTION**
Cut back. Type (fast, visible):
> who has owned this card since it was minted? `<paste mint>`

Claude calls `get_asset_provenance`. Timeline renders:
```
minted Jul 15 -> listed on Magic Eden -> SOLD Jul 31 -> current owner FfRv...
```
Overlay: **"full on-chain history. zero API keys."**

**0:12-0:22 - THE RANGE (rapid cuts, ~3s each)**
- > floor prices for mad lads and claynosaurz → instant table
- > show me the last 5 Panini pack rips → player names + serial numbers appear
  Overlay: **"live pack rips, in chat"**
- > what's in this wallet? `<wallet>` → holdings list with names

**0:22-0:33 - THE REVEAL (why this is different)**
Cut to the README architecture block, slow scroll. Voiceover or overlays:
**"Most NFT APIs return EMPTY history for Metaplex Core assets."**
**"This decodes ownership straight from the chain. By hand."**
**"No API keys. No wallet. Read-only by design."**

**0:33-0:42 - THE INSTALL (speed-run)**
Terminal, real time (it really is this short):
```
git clone ... && npm install && npm run build
claude mcp add collector -- node .../dist/index.js
```
Overlay: **"45 seconds. 0 keys. Works with Claude Desktop, Cursor, anything MCP."**

**0:42-0:45 - CLOSE**
Repo page (logo + stars area visible).
Overlay: **"collector-mcp - first MCP server for digital collectibles. Link below. MIT."**

---

## Launch post copy (paste with the video)

> your AI can't see your card collection. mine can.
>
> collector-mcp: the first MCP server for digital collectibles (Candy Digital, Panini, any Solana collection)
>
> - full on-chain ownership history (data most NFT APIs return EMPTY)
> - floors, sales, wallets, live pack rips
> - 0 API keys. 0 wallet. read-only. MIT.
>
> works with Claude Desktop / Claude Code / Cursor in under a minute 👇

Reply 1: repo link + "the provenance decode is the fun part - Metaplex Core assets store ownership in the account itself; most indexers see nothing. Write-up in the repo."
Reply 2: 45s quickstart GIF or screenshot of the config snippet.

## Recording gotchas
- Dark theme, font size up (mobile viewers).
- Pre-warm the tools once before recording (caches make the take snappy).
- If a live call is slow on camera, cut on the spinner - never show a stall.
- End card text stays on screen >=2s for screenshotters.
