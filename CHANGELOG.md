# Changelog

## 1.0.0 - 2026-08-24

Initial public release.

- 8 tools: search_collections, get_collection_stats, get_floor_prices,
  get_recent_sales, get_asset, get_asset_provenance, get_wallet_holdings,
  get_pack_pulls
- `collector://registry` resource + `collection_report` prompt
- Metaplex Core account + TransferV1 provenance decoding (no DAS API needed)
- Zero API keys: Magic Eden v2, CryptoSlam, and plain Solana RPC only
- Per-source rate gates, retries, and stale-on-error caching
- Live smoke suite (`npm test`) exercising every tool over real stdio

## 1.1.0 - 2026-09-01

- Optional OpenSea cross-marketplace source: set `OPENSEA_API_KEY` and pass
  (or registry-resolve) an `openseaSlug` to add OpenSea floor/volume/owners to
  `get_collection_stats` and OpenSea sales to `get_recent_sales`. Without the
  key nothing changes - the server stays zero-config by default.
- Registry entries can now carry `openseaSlug`.

## 1.1.1 - 2026-09-01

- Upstream errors now carry the reason, not just a status code. Every source
  previously surfaced a bare `HTTP 400`, discarding the body that explained
  what actually went wrong; an agent relaying that dead end sends the user
  hunting for a bug that isn't there. Error bodies are redacted (any
  configured key is stripped) and truncated before they reach output.
- `get_wallet_holdings` now explains the marketplace-escrow case. Magic Eden
  blocks its own escrow accounts from the wallet endpoint, and an address
  taken from `get_asset_provenance` is often exactly that - a listed item's
  on-chain owner is the escrow, not the seller. The tool now says so and
  points at the transfer that names the seller.

## 1.2.0 - 2026-09-01

- **The OpenSea path is now verified against the live API**, not just compiled.
  Verifying it found that it never worked end to end: a stdio MCP server is
  launched with a small allowlisted environment and does not inherit shell
  variables, so `OPENSEA_API_KEY` never reached the server and the
  cross-marketplace view silently stayed off. Documented the `env` block that
  MCP clients actually require, and the smoke suite now forwards the key the
  same way a real client does.
- Registry gained four verified OpenSea slugs: `mad-lads`, `claynosaurz`,
  `candy-mlb` (a new `candy-mlb-opensea` entry - OpenSea files every Candy MLB
  series under one collection, so it is deliberately not attached to the
  per-series Core entries, which would compare different populations), and a
  new `collector-crypt` entry priced in USDC rather than SOL.
- Smoke suite gained a SKIP status and an OpenSea case that skips cleanly with
  no key, so the zero-key path stays the tested default.
