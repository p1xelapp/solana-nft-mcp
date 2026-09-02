# How people actually use collector-mcp

Real steps, real personas, from "I heard about it" to "I got my answer." Written so
you can hand it to someone who has never touched an MCP server.

## The one-time setup (every client, ~3 minutes)

The server is a small Node program. Your AI client starts it in the background and
talks to it over stdin/stdout. Nothing runs on our side, nothing phones home.

**Step 1 - get the code**

```bash
git clone https://github.com/p1xelapp/collector-mcp.git
cd collector-mcp
npm install && npm run build
```

You now have `dist/index.js`. Note the full path, you need it once.

**Step 2 - tell your client about it**

*Claude Code (terminal):* one command, done.

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

Save, fully quit Claude Desktop, reopen it. A small tools icon appears under the
chat box; click it and you should see eleven collector tools listed.

*Cursor:* Settings → MCP → Add new global MCP server. Same JSON as above.
Cursor restarts the server on its own.

**Step 3 - ask something**

Type it like you would to a person. You never call a tool by name; the assistant
picks one. Try: *"search collections for candy gold"*. If you get a list back,
everything works.

Nothing else. No account, no key, no `.env`.

---

## Persona 1 - Marcus, collector, spends real money

Marcus is in three Candy Digital Discords and checks them between meetings. He asks
ChatGPT about cards already; it confidently makes things up.

**Scene:** someone posts *"Grabbed a James Wood /250, never traded, straight from the pack."*
Marcus wants it but the price is steep for an untouched card.

**What he does:** pastes the mint address into Claude Desktop and types:
*"Has this card ever changed hands?"*

**What happens:** Claude calls `verify_claim` (never-traded). Back comes
**CONTRADICTED - 4 transfers across 7 signatures**, and a one-line receipt. He asks
*"show me"*, Claude calls `get_asset_provenance`, and he sees it was listed, delisted,
and relisted twice this month.

**What he pastes back into Discord:** the receipt line. Argument over, no screenshots
of a block explorer needed.

**Why this beats asking an AI directly:** a plain AI has no way to read the chain and
no way to know a Core asset's history looks empty in the usual APIs. It would have
agreed with the seller.

---

## Persona 2 - Priya, solo dev, building a Discord sales bot

Priya uses Claude Code all day. A collection asked her for a bot that posts every
sale. She has done this before for an Ethereum project and knows the painful part
is not the first version, it is the version that is still correct in month three.

**Scene:** blank folder, Claude Code open.

**What she types:** *"I'm building a Discord sales bot for the Claynosaurz
collection on Solana. What endpoints, what rate limits, and where does this kind of
thing break silently?"*

**What happens:** Claude calls `get_integration_recipe` (sales-bot). She gets the
verified endpoints, the real rate limit (Magic Eden ~2/s, pace at 600 ms), a skeleton
built around a persisted cursor, and four failure modes with the fix for each -
including the one where a misspelled symbol returns HTTP 200 and the bot posts
nothing forever.

**Then:** *"identify claynosaurz"* to confirm the symbol and where it trades.
*"get the last 5 sales"* to see the exact shape she is parsing. She writes the bot
against real data in one sitting.

**Before she ships:** she runs the recipe's checklist - kill the process mid-batch
and confirm nothing double-posts.

**Why this beats a search engine:** the endpoints are findable; the silent failure
modes came from running these bots for real and are not in any docs.

---

## Persona 3 - Dev at a licensed drop (5-person team)

The team is launching a new series on Solana. The founder posts stats in Discord and
has been wrong twice, which collectors noticed.

**Scene:** Tuesday, the founder is about to announce *"786 minted, floor 2.1 SOL."*

**What the dev does:** in Cursor, with the collection's Core address:
*"Verify: supply is 786. And is the floor the same everywhere people check?"*

**What happens:** `verify_claim` confirms 786 against the collection account
(numMinted and currentSize both 786). `get_collection_stats` returns the Magic
Eden floor and, if they set an OpenSea key, the OpenSea floor - plus a
reconciliation block saying whether the two are even comparable.

**The catch it prevents:** the previous announcement compared a SOL floor to a USDC
floor. The tool now says "not comparable as printed" and the founder posts one number
with its venue instead of a wrong ratio.

**Why this matters to the project:** collectors trust announcements that come with a
receipt. Every `verify_claim` result ends in one they can re-run.

---

## Persona 4 - Analyst / researcher, new collection, no idea what it is

Someone shared an address with no context. Is it a wallet, a collection, a card?

**What they type:** *"identify 4Qz8DhTBmDNTGiQaEofESDEXHWs9AHmnfCpxzE267UPE"*

**What happens:** `identify` probes the registry, the chain, Magic Eden, and (if
keyed) OpenSea, and reports what each found - including the ones that found
nothing, and what was not checked. Verdict: Core asset "Gunnar Henderson (214/250)",
high confidence, next tools suggested.

**Why it works on brand-new things:** it does not match a list. It asks live sources.
A collection that launched this morning resolves the same way.

---

## What people do NOT use it for

- Buying, listing, transferring. It cannot. No signing code exists.
- Ethereum or Bitcoin collections. Solana only, and it says so rather than guessing.
- Portfolio valuation. A floor is one ask on one venue; the glossary tells the
  assistant not to multiply it by a holding count and call that a value.

## The tools that matter most, in the order people reach for them

1. `verify_claim` - weekly, everyone.
2. `get_asset_provenance` - when money is on the line.
3. `identify` - when something is pasted with no context.
4. `get_integration_recipe` - builders, once per project.
5. Everything else - when the assistant needs it.
