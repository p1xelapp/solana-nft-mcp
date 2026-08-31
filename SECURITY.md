# Security Policy

## The security model in one paragraph

collector-mcp is read-only by construction. It holds no keys, no wallets, and no
secrets; it contains no signing or transaction paths; it talks to exactly three
public data sources (Magic Eden v2, CryptoSlam, a Solana RPC endpoint) and
nothing else. The worst plausible failure is wrong or stale data - never lost
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
committed, CI runs a secrets scan (gitleaks) + `npm audit` on every push.
