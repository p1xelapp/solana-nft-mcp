# LAUNCH-NOTES - collector-mcp v1.0.0

STAGE: demo (open-source portfolio flagship). No hosting, no background burn - runs on the user's machine only.

## USAGE-IMPACT MAP
- Now: $0. All sources keyless/free. No crons, no servers, no metered writes anywhere.
- At 10x users / 6 months: still $0 to us - every install runs on the USER's machine against public endpoints, paced client-side (ME ~1.6 req/s, RPC 1/350ms, CryptoSlam cached 60s). No shared pool of ours can be drained.
- Interaction with our other projects: none - no shared keys (there are no keys), no shared quotas.
- Breakage mode: an upstream (ME/CryptoSlam) tightening public limits degrades users to labeled-stale cache, never billing.

## THREAT-LEDGER
| # | Threat | Mitigation | Status |
|---|---|---|---|
| 1 | Secret leakage in public repo | No secrets exist by design; .gitignore guards .env*/keys; pre-commit gate installed; history clean (repo born public-ready) | MITIGATED |
| 2 | Malicious tool input (injection via mint/symbol/wallet params) | zod schemas: base58 regex for addresses, charset regex + length caps for symbols; all params URL-encoded at fetch sites | MITIGATED |
| 3 | Prompt injection via NFT metadata (asset names are attacker-controllable third-party content) | Server returns data as JSON text only, executes nothing; risk documented in README + DEEP-DIVE for integrators | DOCUMENTED (inherent to all data servers) |
| 4 | Upstream abuse / us being an impolite client (TOS heat) | Per-source serialized rate gates, aggressive caching, real User-Agent, retries with backoff on 429; read-only endpoints only; VeVe excluded entirely | MITIGATED |
| 5 | Supply chain | 2 runtime deps only (official MCP SDK + zod), versions verified on registry, lockfile committed, `npm audit` clean (0 vulns) | MITIGATED |
| 6 | DoS of the user's own machine (unbounded cache/loops) | Cache capped 500 entries oldest-evicted; provenance depth capped 25; pages capped 5; all loops bounded | MITIGATED |
| 7 | Stdout corruption breaking MCP protocol | All logging via console.error; rule documented in index.ts header | MITIGATED |
| 8 | Wrong data presented as fresh (silent staleness) | Every cached serve carries stale flag + cachedAt; partial results report skippedTransactions/activitiesScanned | MITIGATED |

## RE-CHECK
- RE-CHECK 2026-08-24: full live smoke suite after final edits - 15 checks, target 0 FAIL (CryptoSlam WARN acceptable by design). See test output in session report.
- RE-CHECK 2026-08-24: `npm audit` = 0 vulnerabilities; deps = @modelcontextprotocol/sdk@^1.30.0 (published 2026-07-27, >7 days old), zod@^3.25.1.
- RE-CHECK 2026-08-24: grep for secrets/keys in repo before first commit = none (no .env exists; no key strings in src).
- RE-CHECK before push: confirm GitHub repo public settings + social preview upload (assets/banner) + Dependabot enabled.

## DESIGN GATE
No web UI in this project (stdio server + static SVG assets) - design-gate pipeline N/A. Visual assets reviewed by rendered screenshot instead.
