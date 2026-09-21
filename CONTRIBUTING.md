# Contributing

The highest-value contribution is a **verified registry entry** - see below.
Bug reports with a failing tool call + expected vs actual output are next.

## Adding a collection to the registry

Edit `src/registry.ts` and open a PR with:

1. **Identifiers, verified live:**
   - `meSymbol` - confirm `https://api-mainnet.magiceden.dev/v2/collections/<symbol>/stats` returns a floor or volume (a bare `{symbol, listedCount: 0}` echo means the symbol does NOT exist - the phantom-200 trap).
   - `coreCollection` - confirm the address decodes as a Core collection: `get_collection_stats` on it must return `onchain.name`.
2. **Keywords** collectors would type.
3. In the PR description: one line on why this collection matters + the command output proving each identifier.

Licensed/official collections (sports, entertainment, branded drops) are the
priority; blue-chip Solana collections are welcome when they help demos.

## Ground rules

- Keyless sources only. PRs that add an API-key requirement will be declined -
  zero-config is the product.
- Read-only forever. No signing, no transactions, no wallet code.
- `npm test` is the OFFLINE suite (build, lint and every regression suite under
  `test/`) and is what CI runs. The regression
  files hold one block per closed defect, named by the wrong answer it
  prevents; add to them rather than editing what a block asserts. `npm run test:smoke` is the live
  smoke test that makes real calls to the sources, and `npm run test:live` is
  the weekly keyless source check; both are useful locally and neither is a
  release gate, because a marketplace being slow is not a reason to hold a
  build. `npm run lint` (eslint) and strict tsc are enforced in CI.
- Every fetch goes through the shared plumbing in `src/lib/http.ts` (rate gate,
  retry, bounded body read, stale-on-error cache) - no bare `fetch` in source
  modules.

## Release

`.npmrc` sets `ignore-scripts=true` as supply-chain hardening, and npm applies
that to this project's lifecycle scripts too - so `npm publish` on a fresh clone can ship a
package with no `dist/` in it, and `npx solana-nft-mcp` dies with
MODULE_NOT_FOUND for every user. Build explicitly, prove the tarball, then
publish with scripts enabled for that one command:

```
npm run build && node scripts/pack-check.mjs && npm publish --ignore-scripts=false
```

`scripts/pack-check.mjs` asks npm what would actually go into the tarball and
fails unless `dist/index.js` and `data/me-collections.json.gz` are both in it.
It runs in CI too, so a missing build is caught before release day.

Before a release, run the checks anyone can run from a clean clone: `npm test`,
`npm run pack-check`, `npm run check:images` and `npm audit --audit-level=high`.
Those four are the release gate; nothing else is required.

Before releasing, also refresh the bundled directory snapshot with
`npm run snapshot` - it refuses to overwrite a good snapshot with a partial
read, so a failed run leaves the existing data alone.

## Conduct

Short version: be straight with people, argue with the work rather than the person.
The full text is in [CODE_OF_CONDUCT.md](https://github.com/p1xelapp/solana-nft-mcp/blob/main/CODE_OF_CONDUCT.md).
