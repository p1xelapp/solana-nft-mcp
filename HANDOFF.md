# collector-mcp - SESSION HANDOFF

**Written 2026-09-01. Read this first, then start at "The mission".**
Everything below was verified against the repo at write time, not recalled.

---

## 1. What this project is

`collector-mcp` is a local **MCP server** (stdio) that gives any AI assistant - Claude Desktop, Claude Code, Cursor - live eyes on Solana digital collectibles: floor prices, sales, wallet holdings, live Panini pack rips, and **full on-chain ownership history for Metaplex Core assets**.

The differentiator, in one sentence: **Metaplex Core assets (Candy Digital's MLB cards plus most 2026 Solana collectibles) return EMPTY transfer history from mainstream NFT/enhanced-transaction APIs, and this server decodes that history from raw account bytes and `TransferV1` instruction accounts.** The technique came from running a live Candy Digital tracker; it traced all 36 packs of a real Gold Series auction to their winners, zero missed.

Positioning: **zero API keys, zero wallet, read-only by construction, runs on the user's own machine.** Nobody hosts it. That is deliberate - $0 forever, no server to breach, no user queries passing through us.

---

## 2. Verified current state

| Fact | Value |
|---|---|
| Version | **1.1.0** |
| Location | `C:\Users\Danie\Claude_Projects\collector-mcp` |
| Git | 6 commits on `main`, **working tree clean**, **no remote yet** |
| GitHub CLI | **`gh` IS authenticated as `p1xelapp`** (checked 2026-09-01) |
| Commit identity | `p1xel` / `274085188+p1xelapp@users.noreply.github.com` (already configured locally) |
| Pre-commit gate | Installed (gitleaks + semgrep + eslint). Commits must pass it |
| Tests | `npm test` = live smoke (14 pass / 1 warn / 0 fail as of last run) · `node test/protocol.mjs` = offline, passes |
| Lint/build | `npx tsc` clean, `npx eslint src test` clean |
| Secrets | **None exist in the repo.** Nothing to rotate, nothing to scrub |

**Tools (8):** `search_collections`, `get_collection_stats`, `get_floor_prices`, `get_recent_sales`, `get_asset`, `get_asset_provenance`, `get_wallet_holdings`, `get_pack_pulls`. Plus a `collector://registry` resource and a `collection_report` prompt. All declare `readOnlyHint` in MCP annotations.

**Sources:** Magic Eden public v2 (keyless, ~2 req/s) · CryptoSlam public API (keyless, flaky by nature, cached hard) · plain Solana RPC (keyless, hand-decoded Core) · **OpenSea (OPTIONAL, only when `OPENSEA_API_KEY` is set)**.

---

## 3. The mission for this session

**Take collector-mcp from "built and committed locally" to "public, installable, and launched."**

Definition of done:
1. Public GitHub repo exists at `p1xelapp/collector-mcp` with all commits pushed.
2. The optional OpenSea path is **live-verified**, not just compiled.
3. Repo is presentable: social preview image set, topics added, CI green.
4. Launch assets are ready to fire (video recorded by Danie, directory submissions drafted).

---

## 4. Task list, in order

### Task 0 - verify before touching anything
```bash
cd "C:/Users/Danie/Claude_Projects/collector-mcp"
npx tsc && npx eslint src test && node test/protocol.mjs   # offline, fast
npm test                                                    # live, ~2-3 min, needs network
```
Expect protocol test to pass and live smoke at 14 pass / 0 fail (CryptoSlam may WARN - that is by design, it is a flaky upstream and graceful degradation is the tested behavior).

### Task 1 - live-verify the OpenSea path (v1.1.0's only unverified piece)
The OpenSea source compiles and lints but **has never made a real request**. OpenSea issues instant free API keys with **no signup and no wallet** via a single POST, but free keys are rate-capped and expire in days.

**⚠️ This touches a capped free tier - ask Danie for an explicit yes before fetching a key.** Once approved:
1. Get a free key (`POST https://api.opensea.io/api/v2/auth/keys` - check current docs first, this endpoint's terms change).
2. **Never commit it.** Use it as an env var for the test run only: `OPENSEA_API_KEY=... node test/smoke.mjs`, and never print the value.
3. Verify against a Solana collection that trades on OpenSea (Mad Lads, Claynosaurz, Candy Digital, Collector Crypt): `get_collection_stats` should return an `opensea` block, `get_recent_sales` should return OpenSea sales with correct currency/decimals.
4. Fix whatever breaks (likely candidates: the stats response shape, the slug for Solana collections, or currency symbol handling).
5. Add the verified `openseaSlug` values to `src/registry.ts` entries.
6. Add an OpenSea case to `test/smoke.mjs` that **skips cleanly when no key is present** (CI and normal users must never need one).

### Task 2 - push the repo public
`gh` is already authed, so this is one command plus checks:
```bash
gh repo create p1xelapp/collector-mcp --public --source=. --remote=origin --push \
  --description "Zero-key MCP server for Solana digital collectibles - floors, sales, wallets, pack pulls, and Metaplex Core provenance most NFT APIs return empty. No API keys, no wallet, read-only."
```
Then:
- Confirm the CI workflow runs green (`.github/workflows/ci.yml`: gitleaks + build + offline protocol test + npm audit).
- Add repo topics: `mcp`, `model-context-protocol`, `solana`, `nft`, `digital-collectibles`, `metaplex-core`, `candy-digital`, `claude`, `ai-agent`, `web3`.
- Set the social preview image to `assets/banner.png` (Settings → General → Social preview - **this is a manual UI step, tell Danie**).
- Enable Dependabot alerts.
- **Verify with fresh eyes:** clone the public repo into a temp dir, run `npm install && npm run build && node test/protocol.mjs`. If a stranger's first five minutes fail, nothing else matters.

### Task 3 - npm publish (optional, decide with Danie)
`npx collector-mcp` would halve install friction. Requires an npm account and the name being free. Check availability first; do not publish without an explicit yes.

### Task 4 - launch sequence
All copy is **already written** - do not rewrite it, just execute:
- `docs/DEMO-SCRIPT.md` - the 45-second video (Danie records; the payoff is the provenance timeline printing).
- `docs/LAUNCH-KIT.md` - X thread, directory blurbs, portfolio/LinkedIn copy, submission checklist.
- Directories: PulseMCP, mcp.so, Glama, Smithery, and a PR to `awesome-mcp-servers` (Web3 section) + the MCP community servers list.

---

## 5. Hard constraints - do not break these

1. **Zero-config default is the product.** The server must work with no keys, no env vars, no accounts. Any new source is OPTIONAL and degrades silently when absent. A PR that makes a key mandatory gets declined.
2. **Read-only forever.** No signing, no transactions, no wallet code, no private keys. Ever.
3. **No secrets in the repo, no secret VALUES in output.** Log key names/lengths only. The pre-commit gate enforces this; do not bypass with `--no-verify`.
4. **Paid/metered services need explicit consent first** - that includes the OpenSea free tier (capped) in Task 1.
5. **No VeVe/StackR data anywhere** - unofficial access surface, TOS risk, stays out of public code permanently.
6. **Politeness is the product.** Every source stays rate-gated (ME ~600ms, RPC ~350ms). A public repo that hammers a free API is an abuse tool with Danie's name on it.
7. **stdout is the MCP protocol channel.** All diagnostics go to `console.error`.

---

## 6. Positioning facts the new session must get right

- **The claim that holds:** "the first MCP server for **licensed digital collectibles**" and "the only zero-key, read-only one that can read Metaplex Core provenance."
- **The claim that does NOT hold:** "the only NFT MCP server." **OpenSea ships an official MCP** (key-gated, ~22 tools, multi-chain). Never imply the category is empty. Frame them as complementary: OpenSea's is a mall directory, ours is the authenticator's loupe.
- **OpenSea's Solana expansion is a tailwind, not a threat.** Candy Digital, Mad Lads, Claynosaurz, and Collector Crypt now trade there too, which is exactly why v1.1.0 added the optional cross-marketplace view. It also validates that "AI agents + NFT data" is a real category.
- **Magic Eden is Solana-only as of March 2026** (EVM and Bitcoin marketplaces wound down, Bitcoin API shut off). Do not describe it as multi-chain.
- **The dead-provider story is real and citable:** SimpleHash shut down March 2025, Reservoir sunset its NFT API October 2025. This is the "don't depend on one provider" narrative.

---

## 7. File map

```
collector-mcp/
├── src/index.ts              MCP server: 8 tools, resource, prompt, zod validation
├── src/registry.ts           Curated collections (id → ME symbol / Core address / CryptoSlam / openseaSlug)
├── src/lib/http.ts           Rate limiter, retry+backoff, stale-on-error cache
├── src/sources/solana.ts     ★ Core decoders + provenance (the crown jewel)
├── src/sources/magiceden.ts  Keyless ME v2 (phantom-200 guarded, sales paging)
├── src/sources/cryptoslam.ts Panini pack rips
├── src/sources/opensea.ts    ★ NEW in 1.1.0 - optional, key-gated, UNVERIFIED LIVE
├── test/smoke.mjs            Live suite over real stdio (needs network)
├── test/protocol.mjs         Offline suite (CI-safe)
├── docs/DEEP-DIVE.md         Full technical + why/who/pros-cons breakdown
├── docs/DEMO-SCRIPT.md       45-second launch video, shot by shot
├── docs/LAUNCH-KIT.md        Every post, blurb, and directory submission, pre-written
├── LAUNCH-NOTES.md           THREAT-LEDGER + RE-CHECK (ship-gate artifacts)
├── CHECKLIST.md              4-phase progress
└── assets/                   logo.svg, banner.svg/png (social preview), architecture.svg
```

Sibling project (same author, same thesis, separate repo folder): `C:\Users\Danie\Claude_Projects\web3-trust-stack` - apipulse, nft-data-router, mintcheck, program-inspector-mcp, chain-skills (17 skills). Cross-link them in READMEs at launch; they share the "web3 runs on data nobody verifies" umbrella.

---

## 8. Decisions already made - do not re-litigate

- Local stdio server, not hosted. (A hosted variant needs a paid RPC provider because public Solana RPC blocks datacenter IPs; local-first is the free AND the trust option.)
- Keyless sources only in the default path; OpenSea optional.
- Metaplex Core provenance first; legacy SPL NFT provenance is the top ROADMAP item, not a v1 gap.
- SOL-denominated, no USD conversion (avoids a price-feed dependency).
- MIT license.

## 9. Open questions for Danie

1. **OpenSea free key** - yes/no to fetching one for the live test (capped free tier).
2. **npm publish** - yes/no, and does he want the `collector-mcp` name reserved now?
3. **Social preview upload** - manual GitHub UI step, he has to click it.
4. **Launch timing** - push now and launch later, or push + launch same day?

---

## 10. Known limitations (state them honestly, never hide them)

Provenance covers **Metaplex Core only** (not legacy SPL or compressed NFTs) · no holder censuses without an indexer key (the tools say so rather than faking) · CryptoSlam is flaky upstream · SOL prices only · public RPC throttles heavy parallel use (`SOLANA_RPC_URL` override supported, still keyless) · escrow-held listed items show the escrow as owner (flagged in output).
