# FAQ

**Do I have to type tool names like `verify_claim`?**
No. Ask the way you would ask a person: "is it true this card never traded", "what is
this wallet worth", "find me the cheapest Rex". Your assistant reads the tool
descriptions and picks the right one, chains several when it needs to, and shows you
the result. The names exist for people writing scripts; a collector never sees them.

**I do not have an address. I only know the name of the project or the player.**
Say the name. The server searches the whole Magic Eden collection index and the OpenSea
Solana index by name, tells you what matched, and carries the identifiers forward
itself. For a single item, the collection name plus the card number or the trait
("Rex", "#1390", "Aaron Judge") is enough to find it in that collection's listings.
If a name matches several collections you get the list and a question, not a guess.

**Does it collect anything about me?**
No. It runs on your machine, talks to public data sources, and keeps nothing. No
account, no sign-in, no telemetry, no log sent anywhere. The only thing that leaves your
computer is the public address or name you asked about, sent to the public source that
can answer it. There is nothing to opt out of because nothing is collected.

**Why does it make answers faster and cheaper?**
Without it your assistant has to guess, search the web, open marketplace pages, read
raw transactions and reconcile them, and it often gets that wrong. With it, one call
returns the number, its source, its time and its gaps as typed data. One tool call replaces several
searches and page reads, and the server does the confirming so the conversation
does not have to.

**Can I paste a screenshot?**
The tools take text: an address, a marketplace link, a symbol or a plain name. Your
assistant may be able to read the picture and pull those out for you, but the server
itself never sees the image. If the screenshot shows a name and a number, type those.

**What happens when Magic Eden or OpenSea goes down, or stops existing?**
The tool keeps answering from the sources that are up and says which one is missing.
Chain reads (supply, ownership, history, custody rules) do not depend on any
marketplace. Every source sits in a catalog with a tier, a fallback and a weekly live
check, so a venue going quiet shows up as a failed check, not as a wrong answer. See
docs/SOURCES.md for the full list and how a source gets added or retired.

**How far back does it look?**
As far as the source keeps. Ownership history for Metaplex Core assets is walked from
the chain itself, back to the mint. Marketplace feeds page back as far as the venue
serves; when a window is cut short the result says `truncated: true` and how far it got.
It never fills a gap with a guess.

**What if a number is wrong?**
Then a source was wrong, late, or unreachable, and the answer will have said which
source and when it was read. Chain reads are authoritative. Marketplace reads are that
marketplace's index. The tool reports those conditions instead of smoothing them over.
See docs/TRUST-AND-LIMITS.md for what that sounds like in practice.

**Why not just ask ChatGPT or Claude directly?**
A plain model cannot read a chain or a marketplace. It answers from memory, which for
NFTs means from months-old training data plus whatever tone the question had. It will
tell you a card "never traded" because it cannot see that it did. collector-mcp gives
the same model live data, typed, with the vocabulary to read it correctly (a floor is an
ask, a listed item's owner is the escrow, a returned pack is not burned) and receipts
you can paste to someone who does not trust either of you.

**OpenSea has its own MCP server now. Why use this one?**
Use both if you like. OpenSea's server is OpenSea's view: its listings, its sales, its
portfolio numbers, behind its key and login. collector-mcp is nobody's view. It reads
the chain directly for supply, provenance, custody rules and wallet age; reads Magic Eden
keylessly; adds OpenSea when you give it a key; and then reconciles them and refuses to
rank a SOL floor against a USDC floor. It also does things no marketplace server does:
decode Metaplex Core plugins into "who can freeze, move or burn this", verify a claim
and hand back a receipt, and label a wallet's behaviour from its history.

**There is a Magic Eden MCP too.**
Magic Eden's MCP is keyless too and it covers Magic Eden's data. Same answer.

**Is it really zero keys?**
Yes, including OpenSea. Magic Eden and plain Solana RPC need no key at all.
OpenSea does, so the server issues itself one: the first question that actually needs
OpenSea asks OpenSea for one of its free weekly agent keys, keeps it in
`~/.collector-mcp/opensea-key.json` on your own machine, and renews it a day before it
expires. That key is yours - it never leaves your computer and is never printed into a log
or an answer - and a session that never asks an OpenSea question never requests one.

**What if the key cannot be issued?**
OpenSea caps key creation at about two a day per IP address, so on a shared or busy
address it can refuse. Then OpenSea stays off exactly as it always could: every tool still
answers, and the OpenSea half of a cross-venue answer is named as missing rather than
quietly dropped. `get_source_status` says which key is in use and when it expires.

**Can I use my own OpenSea key, or none at all?**
Yes. `OPENSEA_API_KEY` (from the OpenSea developer portal) overrides the self-issued key
completely - put it in the MCP config's `env` block, since clients launch servers with a
clean environment. `COLLECTOR_MCP_NO_AUTO_KEYS=1` turns the self-issue off entirely.

**What about Tensor and Rarible?**
Neither is read. Tensor has no self-serve API keys. Rarible relaunched a Solana marketplace in
August 2026, but its API needs a key with a 100-requests-per-month free tier and cannot label
a Magic Eden fill as Magic Eden's, so reading it would repeat the venue mix-ups this server
exists to avoid. Both sit in the source catalog as planned, with the trigger for adding them.

**Does it cost anything to run?**
No. Public endpoints, paced politely, cached in memory. Heavy use of the public Solana
RPC will get throttled; set `SOLANA_RPC_URL` to any endpoint you have and it uses that.
Still no key required by this server.

**Can it move my NFTs? Does it need my wallet?**
No and no. There is no signing code in the repository. Every tool declares
`readOnlyHint` in the protocol. Wallet questions take a public address, the same one
anyone can paste into an explorer.

**What does "profile my wallet" actually read?**
Magic Eden's index of what the address holds (grouped, counted, share of wallet, listed
and compressed counts, royalty asked), a floor-times-count *ceiling* for the biggest
positions, share of supply when a supply is known (from the chain for registry
collections, from OpenSea with a key), and the wallet's first and last transaction from
the chain. Every number says where it came from and what that source cannot see.

**Why do you call it a ceiling and not a portfolio value?**
Because it is not a value. A floor is one seller's ask. Selling ten items into it moves
it. Illiquid collections carry a floor nobody has paid in months. Unindexed items count
as zero. The tool gives you the arithmetic and the assumptions; recent sales tell you
what buyers pay.

**Can it tell me if an NFT was airdropped?**
With an OpenSea key it sees plain transfers, so it can tell you an item arrived without
a recorded sale and from which address. It will say "received without a recorded sale",
not "airdropped", because a gift, a self-transfer and a trade settled elsewhere look
identical on chain.

**Which wallet activity does it see?**
Magic Eden's feed: listings, delists, bids, buys and sells on the order book and AMM
pools. It excludes Tensor, mints and plain transfers, and OpenSea unless a key is present. The result
says this every time so the model does not present one venue as a wallet's whole life.

**Does it understand packs?**
Yes. Sealed packs are separate assets from the cards they open into; opening either
burns the pack or returns it to a treasury (Candy does the second, most others the
first), and each reading changes supply math. Packs normally carry a permanent burn or
transfer delegate so the opening program can consume them; the same plugin on a card
meant to be kept is a red flag. `get_asset_trust` shows which case you are looking at.

**Compressed NFTs? Legacy SPL NFTs?**
Holdings and activity cover whatever Magic Eden indexes, which includes both. Provenance
and trust decoding are Metaplex Core only, and they say so instead of returning an
empty list.

**Why Solana only?**
Because the answer had to be honest. Keyless indexed NFT data on other chains went away
with Reservoir and SimpleHash. Adding "multi-chain" with a paid key behind every tool
would make the zero-key promise a lie.

**How accurate is it?**
As accurate as the source, with the source named. On-chain reads are authoritative.
Marketplace reads are that marketplace's index and may lag or miss. Stale cached values
are labelled `stale: true` rather than hidden. `verify_claim` tells you how to reproduce
the check without trusting this server.

**Is it safe to let an agent read NFT names?**
Minting is permissionless, so a name can be a fake message boundary followed by
instructions to your AI. Every name from chain or marketplace is neutralised before a
model sees it: invisible and bidi characters stripped, newlines collapsed, delimiter
markup defanged, imperative phrasing flagged. This is tested offline in CI.

**Will tool names change?**
No. Agents reference them in prompts and a rename breaks integrations silently. New
tools get added; existing names stay.

**Something is wrong or missing.**
Open an issue with the tool name and the input. If it is a security matter, see
SECURITY.md instead.
