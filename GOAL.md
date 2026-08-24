# GOAL - collector-mcp

**STAGE: demo** (open-source portfolio flagship; zero background burn, runs on the user's machine)

## Goal
The first MCP server for licensed digital collectibles: give ANY Claude / AI agent
live Solana collectibles data (Candy Digital, Panini, and any Metaplex Core or
Magic Eden collection) through standard MCP tools - with **zero API keys, zero
wallet, zero config**.

## Audience
1. AI developers who want on-chain collectibles data in their agents without signing up for RPC providers.
2. Collectors who use Claude and want "what's my wallet worth / who owned this card" answered from real data.
3. Hiring managers / Solana teams evaluating the author's work (portfolio flagship).

## Problem solved
Every existing Solana MCP server is a wallet/DeFi agent kit that wants your private
key and an RPC API key. There is nothing for the collectibles niche, nothing
read-only-by-design, and nothing that can read Metaplex Core provenance (Helius'
own enhanced parser returns empty tokenTransfers for Core assets). This server is
keyless, read-only, cached, and decodes Core ownership history directly from
instruction accounts.

## Why it matters
- True, verifiable "first in category" claim for MCP directories.
- Demonstrates rare domain expertise (Metaplex Core decoding) in public code.
- Distribution engine: every "agent found this" post can end with "powered by collector-mcp".

## Hard constraints
- Keyless/cached sources only. Never require or ship Helius or any project key.
- No VeVe/StackR surface anywhere in the repo.
- Read-only forever: no transactions, no wallets, no signing.
- Zero new metered spend.

## Kill criteria (from CUTTING-EDGE-SHOWCASE-PLAN.md)
<50 stars, no directory pickup, nobody but the author connects it by 2026-11-16 →
archive, stop maintaining, keep on portfolio.
