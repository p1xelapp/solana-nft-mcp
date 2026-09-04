# FAQ

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
Also keyless, also useful, also one venue's API surfaced as tools. Same answer.

**Is it really zero keys?**
Yes for everything Magic Eden, CryptoSlam and plain Solana RPC can answer, which is
most of the tools. An OpenSea key is optional and adds OpenSea floors, sales, plain
transfers (airdrops, gifts) and a searchable index of the Solana collections OpenSea
lists. Free keys exist (`POST https://api.opensea.io/api/v2/auth/keys`), two a day,
seven-day expiry. Put it in the MCP config's `env` block; clients launch servers with a
clean environment, so your shell variable will not reach it.

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
pools. Not Tensor. Not OpenSea without a key. Not mints, not plain transfers. The result
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
