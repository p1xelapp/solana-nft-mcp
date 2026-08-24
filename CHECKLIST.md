# CHECKLIST - collector-mcp v1

## Phase 1 - Plan
- ✅ Read showcase plan + memory (Core decode, web3-kit, CryptoSlam, candymigration)
- ✅ Competitive scan (Solana MCP servers, ME MCP, directories) - gap confirmed
- ✅ GOAL.md written (goal / audience / problem / kill criteria)
- ✅ TOS check: ME public API OK, CryptoSlam best-effort documented, no VeVe anywhere

## Phase 2 - Build
- ✅ TypeScript + official MCP SDK 1.30, strict mode, 2 runtime deps
- ✅ 8 tools + registry resource + report prompt
- ✅ Metaplex Core decoders (AssetV1, CollectionV1, TransferV1 heuristic)
- ✅ Plumbing: rate gates, retries (incl. 429), never-blank cache, bounded everything
- ✅ Input validation (zod) + phantom-200 detection + clean error surfaces

## Phase 3 - Verify
- ✅ Live smoke suite over real stdio: 15 checks, 0 FAIL (1 WARN = quiet market, by design)
- ✅ Live provenance trace of a real Candy MLB card (Zack Wheeler 1/250: mint → sale → owner)
- ✅ Hostile-input probes (bad address, phantom collection)
- ✅ npm audit 0 vulnerabilities
- ✅ Re-run smoke after final polish - 14 pass / 1 warn / 0 fail
- ✅ eslint (typescript-eslint typed rules) clean

## Phase 4 - Ship & launch
- ✅ README (45s quickstart, Claude Desktop + Claude Code snippets)
- ✅ docs/DEEP-DIVE.md · docs/DEMO-SCRIPT.md · docs/LAUNCH-KIT.md
- ✅ Visuals: logo.svg, banner.svg (social/OG), architecture.svg
- ✅ LAUNCH-NOTES.md (threat ledger + usage map)
- ✅ git init + pre-commit gate + 2 commits (noreply email, gate-clean)
- ⬜ GitHub repo creation + push - WAITING FOR DANIE'S GO
- ⬜ Record 45s demo video (script ready) - DANIE
- ⬜ Submit to directories (checklist in LAUNCH-KIT.md) - after push
- ⬜ X launch post + anchor thread - after video
