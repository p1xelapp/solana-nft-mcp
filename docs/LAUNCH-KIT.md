# Launch Kit - copy for every surface

All copy below is ready to paste. "-" only, no em-dashes, no hashtag spam.

---

## 1. MCP directory listings

### PulseMCP / mcp.so / Glama (short blurb, ~50 words)

> Read-only Solana collectibles ground truth for AI agents - zero API keys, and the Metaplex Core transfer history other indexers return empty. Live Solana collectibles data for any AI agent: floor prices, sales, wallet holdings, live Panini pack rips, and full on-chain ownership history for Metaplex Core assets (Candy Digital MLB cards and more). Zero API keys, zero wallet, read-only by design. TypeScript, MIT.

### Smithery (one-liner)

> Zero-key, read-only Solana digital-collectibles data: floors, sales, wallets, pack rips, and Metaplex Core provenance that most NFT APIs can't see.

### Category/tags for all directories
`solana` `nft` `digital-collectibles` `web3` `marketplace-data` `candy-digital` `panini` `metaplex` `read-only` `no-api-key`

### Submission checklist
- [ ] PulseMCP: https://www.pulsemcp.com (submit server form)
- [ ] mcp.so: submit via site form / GitHub
- [ ] Glama: https://glama.ai/mcp/servers (indexes GitHub automatically; claim listing)
- [ ] Smithery: https://smithery.ai (add server, needs smithery.yaml only for hosted - list as local)
- [ ] Official modelcontextprotocol/servers community list: PR to the README community section
- [ ] awesome-mcp-servers (punkpeye): PR under Web3 section

---

## 2. X launch (anchor thread - post AFTER the video post per showcase plan)

**Post 1 (with 45s video - see DEMO-SCRIPT.md)** - the hook post, copy lives in DEMO-SCRIPT.md.

**Anchor thread (1-2 days later):**

1/ Every Solana MCP server I found wants two things: an RPC API key, and often your PRIVATE key.

All I wanted was for Claude to answer "who owned this card before me?"

So I built the missing piece. Open-source, zero keys, read-only. 🧵

2/ The gap is real: MCP directories index 22,000+ servers. Licensed digital collectibles (Candy Digital's MLB cards, Panini's NBA/NFL cards)? Zero. These are exactly the assets mainstream NFT tooling handles worst.

3/ Worst how? Candy mints Metaplex Core assets. Ownership lives INSIDE the asset account - so enhanced-transaction APIs parse transfers as UNKNOWN with empty tokenTransfers. Your $500 card shows zero history in most tools. The data is on-chain. Nothing reads it.

4/ collector-mcp reads it. Raw account bytes -> owner. TransferV1 instruction accounts -> every ownership change, with marketplace labels. The heuristic survived a real test: 36/36 Candy auction packs traced to their winners.

5/ 8 tools: collection stats (even for collections no marketplace indexes), floors, sales, wallet holdings, live Panini pack rips, full provenance. Every response cached, rate-gated, and served stale-but-labeled when an upstream hiccups - agents hate exceptions mid-conversation.

6/ Design choice I care about: READ-ONLY by construction. No signing, no wallet, no keys. Your AI should be able to look at collectibles without being able to spend them.

7/ Install is genuinely 45 seconds (video in the pinned post). Repo + docs: [link]
If you run an agent, a tracker, or you just collect - try it, break it, star it. PRs for new verified collections welcome.

---

## 3. Personal website / portfolio section

### Card (short)

**collector-mcp** - zero-key Solana collectibles data for AI agents
Open-source TypeScript MCP server giving AI agents live Solana collectibles data with zero API keys. Hand-decodes Metaplex Core ownership history that mainstream NFT APIs return empty. 8 tools, full test suite against live endpoints, MIT.
`TypeScript` `MCP` `Solana` `Web3 data`

### Long-form (project page / case study)

**The problem.** AI agents had no way to see licensed digital collectibles. Existing Solana MCP servers are trading kits that require private keys; collectibles data - especially Metaplex Core assets like Candy Digital's MLB cards - was invisible to them, because even major indexers parse Core transfers as empty.

**What I built.** A production-grade MCP server exposing 8 read-only tools over stdio: collection stats, floor prices, sales, wallet holdings, live Panini pack rips, and full on-chain provenance. The provenance engine hand-decodes Metaplex Core account layouts and TransferV1 instruction accounts - a technique I developed running a live Candy Digital tracker, verified by tracing all 36 packs of a live auction to their winners.

**Engineering choices that matter.**
- Zero API keys: public endpoints only, made viable by per-source rate gates, retry with backoff, and never-blank caching (stale data is served labeled, never a blank error).
- Read-only by construction: no signing paths exist in the codebase.
- Honest degradation: every partial result says what it skipped and why.
- Full MCP surface (tools, resources, prompts) on the official SDK, strict TypeScript, and a live smoke suite that spawns the real server over stdio and exercises every tool against live mainnet data.

**Outcome.** First-in-category listing across MCP directories; installable in under a minute on Claude Desktop, Claude Code, or Cursor. [GitHub repo] [45s demo]

### LinkedIn post

I open-sourced collector-mcp - a zero-key, read-only MCP server for Solana collectibles.

It lets any AI agent (Claude, Cursor, etc.) answer questions like "who has owned this card since mint?" or "what did this collection sell for this week?" from live Solana data - with zero API keys and no wallet access, because it is read-only by design.

The technically interesting part: Metaplex Core assets (used by Candy Digital's official MLB collectibles) store ownership inside the asset account, so standard NFT APIs return empty transfer history for them. collector-mcp decodes the account bytes and instruction data directly - a technique verified by tracing a complete 36-pack auction to its winners.

TypeScript, official MCP SDK, live end-to-end tests, MIT licensed. Link in comments.

---

## 4. Reddit / community (r/solana, r/ClaudeAI, MCP Discord)

Title: "I built an MCP server that gives Claude read-only eyes on Solana collectibles - zero API keys, and it can read ownership history that most NFT APIs return empty"

Body: short version of the thread, ends with "feedback welcome - especially which collections to verify next for the registry." (Communities reward asking, not broadcasting.)

---

## 5. Hacker News (Show HN - optional, timing flexible)

Title: `Show HN: Collector-MCP - keyless MCP server for Solana collectibles data`
First comment: the Core-decoding story (technical depth is what HN wants), the read-only stance, and the honest limitations section copied from DEEP-DIVE.

---

## 6. Positioning one-liners (reuse anywhere)

- "Give your AI eyes on your collection - not keys to it."
- "The ownership history your NFT API returns empty? It's on-chain. This reads it."
- "0 API keys. 0 wallet. 8 tools. 45 seconds."
- "Zero keys, read-only, and the Core transfer history every other indexer returns empty."
