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
- `npm test` is the OFFLINE suite (build + protocol, market, DAS, mechanics,
  hardening and wave-8 regression tests) and is what CI runs. The regression
  files hold one block per closed defect, named by the wrong answer it
  prevents; add to them rather than editing what a block asserts. `npm run test:smoke` is the live
  smoke test that makes real calls to the sources, and `npm run test:live` is
  the weekly keyless source check. All of them must pass before a release;
  `npm run lint` (eslint) and strict tsc are enforced in CI.
- Every fetch goes through the shared plumbing in `src/lib/http.ts` (rate gate,
  retry, bounded body read, stale-on-error cache) - no bare `fetch` in source
  modules.

## Release

`.npmrc` sets `ignore-scripts=true` as supply-chain hardening, and npm applies
that to OUR lifecycle scripts too - so `npm publish` on a fresh clone can ship a
package with no `dist/` in it, and `npx collector-mcp` dies with
MODULE_NOT_FOUND for every user. Build explicitly, prove the tarball, then
publish with scripts enabled for that one command:

```
npm run build && node scripts/pack-check.mjs && npm publish --ignore-scripts=false
```

`scripts/pack-check.mjs` asks npm what would actually go into the tarball and
fails unless `dist/index.js` and `data/me-collections.json.gz` are both in it.
It runs in CI too, so a missing build is caught before release day.

The ship-gate receipt (`.audit-receipt.json`) is produced by the audit tool on
release day and is bound to the commit it was run against, so it is not
tracked in this repository - a receipt in git is either stale or a claim about
a commit it did not check. Run the audit from the repository root so the SHA it
records is this repository's.

Before releasing, also refresh the bundled directory snapshot with
`npm run snapshot` - it refuses to overwrite a good snapshot with a partial
read, so a failed run leaves the existing data alone.
