# Contributing

The highest-value contribution is a **verified registry entry** - see below.
Bug reports with a failing tool call + expected vs actual output are next.

## Adding a collection to the registry

Edit `src/registry.ts` and open a PR with:

1. **Identifiers, verified live:**
   - `meSymbol` - confirm `https://api-mainnet.magiceden.dev/v2/collections/<symbol>/stats` returns a floor or volume (a bare `{symbol, listedCount: 0}` echo means the symbol does NOT exist - the phantom-200 trap).
   - `coreCollection` - confirm the address decodes as a Core collection: `get_collection_stats` on it must return `onchain.name`.
   - `cryptoslamContract` - confirm `/v1/mints/<contract>/5/last` returns entries.
2. **Keywords** collectors would actually type.
3. In the PR description: one line on why this collection matters + the command output proving each identifier.

Licensed/official collections (sports, entertainment, branded drops) are the
priority; blue-chip Solana collections are welcome when they help demos.

## Ground rules

- Keyless sources only. PRs that add an API-key requirement will be declined -
  zero-config is the product.
- Read-only forever. No signing, no transactions, no wallet code.
- `npm test` (live smoke) and `node test/protocol.mjs` (offline) must pass;
  eslint + strict tsc are enforced.
- Every fetch goes through the shared plumbing in `src/lib/http.ts` (rate gate,
  retry, stale-on-error cache) - no bare `fetch` in source modules.
