# Security Policy

## The security model in one paragraph

collector-mcp is read-only by construction. It holds no keys, no wallets, and no
secrets; it contains no signing or transaction paths; it talks to three public
data sources (Magic Eden v2, CryptoSlam, a Solana RPC endpoint) plus OpenSea v2
only when the user supplies their own `OPENSEA_API_KEY`, and nothing else. That
key is read from the environment, sent only to api.opensea.io, and redacted from
every error message before it can reach a log or a model. The worst plausible failure is wrong or stale data - never lost
funds. Data returned from upstreams (asset names, metadata) is third-party
content: agent frameworks consuming this server must treat it as data, never as
instructions.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or a plain issue if the
finding is not sensitive. Realistic classes worth reporting:

- input validation bypasses that reach an upstream un-encoded
- ways to make the server amplify traffic against an upstream (rate-gate bypass)
- cache poisoning between tool calls
- dependency issues (`npm audit` runs in CI on every push)

No bug bounty - this is an open-source, zero-revenue project - but reports get
fixed fast and credited in the changelog.

## Supply chain

Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), lockfile
committed, install scripts disabled via `.npmrc`. CI runs a full-history secrets
scan (gitleaks) on every push to every branch, and `npm audit` plus the offline
suite on `main` and pull requests. The gitleaks allowlist is scoped to the one
rule that misreads base58 chain addresses in `test/fixtures`, not to those
paths wholesale - a real credential committed there still fails the scan.

Releases run `node scripts/pack-check.mjs` to prove the tarball carries
`dist/index.js` before going out; the exact release steps are in
CONTRIBUTING.md.
