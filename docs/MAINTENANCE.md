# Maintenance

Run `get_source_status` first, then use the dependency table to find the module a break touches.

Every dependency here belongs to somebody else. None of them owes this project notice
before it changes. So each one will break at some point. When it does: does the server
notice, does the user get a sentence they can act on, and how long is the repair? This
page answers those three for each one.

## Dependencies

| What would change | How the server notices | What the user sees | What a maintainer does | Likely per year |
| --- | --- | --- | --- | --- |
| **Solana RPC endpoints** - a public endpoint rate-limits harder, stops answering, or disappears | Every chain read falls through a fixed endpoint list (`src/sources/solana.ts`); `get_source_status` pings each one and reports latency per endpoint | "The public Solana endpoint is rate-limiting right now" with the endpoint named and the next one tried automatically; a chain answer is labelled with the endpoint that produced it | Add or reorder an endpoint in the list in `src/sources/solana.ts` and its row in `src/sources/catalog.ts`; ~30 minutes. A user can point `SOLANA_RPC_URL` at their own endpoint with no code change at all | High - expect one endpoint to degrade at least once |
| **The undocumented asset index (DAS) on the public RPC** - the methods are withdrawn or start refusing | A capability probe asks `getAsset` directly and distinguishes "withdrawn" (JSON-RPC -32601) from "busy" | "The chain's asset index is not serving those methods" - and every tool that leaned on it says which part of its answer is now missing, rather than returning a shorter list as if it were complete | Nothing urgent: the tools already degrade. To restore coverage, wire a keyed DAS provider (catalog rows exist for Helius, Triton, Shyft); ~half a day | Medium - it is explicitly documented as unfit for production |
| **Magic Eden v2 endpoints and rate limits** - a path moves, a field is renamed, the keyless tier tightens | Every page passes a shape guard (`page()` / `objectRows()` / `assertPageSize()`); a non-array or an over-served page is treated as an outage, never as "no more results" | "Magic Eden paused reads for a minute" or "Magic Eden answered with a shape this server does not recognise" - never an empty result presented as an empty market | Fix the path or field in `src/sources/magiceden.ts` and its catalog row; ~1-2 hours for a rename, longer if an endpoint is retired | Medium |
| **OpenSea agent keys** - key issue is refused, or the free key programme ends | The self-issue path records why it failed; `get_source_status` reports which key is in use and when it expires | "OpenSea off (no key; auto-issue unavailable: OpenSea's key limit; retry after a day)" at startup, and each answer names OpenSea as the missing half rather than dropping it | Nothing, usually - the cap resets daily. If the programme ends, document `OPENSEA_API_KEY` as the only route in `README.md`; ~1 hour | Medium - the per-IP cap is hit routinely on shared addresses |
| **OpenSea API** - v2 changes shape or retires a path | Same shape guards as Magic Eden, plus a stats block with no usable numbers is treated as a shape change | The OpenSea half of a cross-venue answer is absent and named; Magic Eden answers alone | Fix `src/sources/opensea.ts`; ~1-2 hours | Medium |
| **The Metaplex Core account layout or the TransferV1 discriminator** - a program upgrade moves a field or renumbers an instruction | Discriminators are pinned in `src/sources/solana.ts` (AssetV1 = 1, CollectionV1 = 5, TransferV1 = 14) and a decode that does not match the pin refuses rather than guessing | "That account does not decode as a Metaplex Core asset" - the one failure mode this project refuses to paper over, because a mis-decoded byte is a confident wrong owner | Re-derive the layout against the current program and update the decoder in `src/sources/solana.ts` plus `src/lib/coreplugins.ts`; half a day, and it is the highest-care change in the repo | Low - but the highest cost if missed |
| **The bundled collection snapshot** - it ages, and new collections are invisible to it | Every name answer reports the snapshot's date, its size, and whether it covers the whole catalogue; a miss carries `directoryComplete: false` and says so | "No collection by that name in the layers searched" - explicitly not "it does not exist", with the layers and their dates listed | Re-run `npm run snapshot`, commit the new `data/me-collections.json.gz`; ~15 minutes plus the walk | High - it ages every day by design, which is why the live layer exists behind it |
| **Node and the MCP SDK** - a major Node release, or an SDK protocol change | `npm test` runs a real client handshake against the built server (`test/protocol.mjs`); the engines field pins the floor at Node 20 | A client that cannot connect at all, or an older client that still works because every result carries both structured and text content | Bump the SDK, run the suite, fix whatever the handshake test names; ~1-2 hours | Medium |
| **Dependabot** - dependency advisories and version bumps | Weekly batched pull requests with a cooldown; CI runs the full suite on each | Nothing - this never reaches a user directly | Merge what passes; treat a major bump as its own task with the suite as the gate; minutes per batch | High by design |

## Questions that can still go wrong

These are not bugs. They are the edges of what public sources can see, and the wording that
keeps an honest answer honest.

| The question | What the server returns today | How to say it |
| --- | --- | --- |
| **A collection that only trades on Tensor** | Magic Eden and OpenSea both report no such collection; the chain still answers for supply and ownership if a Core address is known | "Neither venue this server reads lists it. It may trade on Tensor, which is not wired here - absence in these two is not absence from the market." |
| **A collection only on OpenSea, when key issue failed** | The OpenSea half is absent and named, with the reason and the retry window | "OpenSea could not be read for this - no key could be issued today. Chain and Magic Eden answers stand; the OpenSea figure is missing, not zero." |
| **A brand-new collection in no directory yet** | `searched` lists every layer and its date; `directoryComplete` says whether any layer was the full catalogue | "Nothing by that name in the layers read, the newest of which is from <date>. A mint address from one of its items finds it straight from the chain instead." |
| **A dead collection with no sales for years** | Supply and ownership answer from the chain; floor and recent sales come back empty with the feed named | "The chain still knows it. Nobody has listed or sold one on the venues read, so there is no floor - no price, rather than a price of zero." |
| **A name shared by a real and a fake collection** | Both are returned, flagged in `lookalikes`, with the warning sentence and each entry's badge status | "Several collections carry nearly the same name; fakes imitate popular names. Prefer the badged one or confirm the collection address from the project's official channel." |
| **A compressed NFT's history** | Current state via the asset index when it is available; no byte-level ownership history, because there is no account to read | "Ownership history at this depth is a Metaplex Core answer. For a compressed item the index can say who holds it now, not the chain of transfers." |
| **A card that was burned** | The account read fails or returns no owner; an opened Candy pack is returned to the issuer, not burned, and the glossary says so | "The asset account no longer holds an owner. For a Candy pack that usually means it was opened and returned to the issuer, not destroyed - check the provenance timeline before calling it burned." |
| **A wallet with 10,000 items** | Pages are walked to a bounded ceiling; anything past it sets `truncated: true` with the reason, and counts say what they cover | "This covers the first N items the feed returned, not the whole wallet - the totals below are for that slice, and the wallet holds more." |
| **A marketplace returning stale or wrong data** | A failed refresh serves the previous value labelled `stale` with its read time; two venues that disagree are reported side by side and never averaged | "Magic Eden and OpenSea disagree on this, and they are quoted in different currencies. Here is each one with its venue and read time; this server will not merge them into one number." |
| **A question in another language** | Tools take identifiers and free-text names; a non-English collection name resolves if the directory holds it, since case, spacing and punctuation are normalised away before matching | Answer in the user's language. The data itself is language-neutral: symbols, addresses and numbers. Only say a name was not found, never that it is not a name. |
| **A screenshot** | Nothing - this server reads addresses, symbols and names, and has no image input | "Type or paste the collection name, the mint address, or the wallet address and it can be looked up. An image cannot be read here." |

## Adding or retiring a source

`src/sources/catalog.ts` is the single description of every source, wired or not, including
the ones this server deliberately does not read. `docs/SOURCES.md` is generated from it
(`npm run docs:sources`) - edit the catalog, never the markdown. A source that is retired
keeps its row with `wired: false`, so a number that used to be available is a documented
gap rather than a silent absence.

## How you find out

Three signals, none of which need you to remember to look:

- **The weekly live check** (`.github/workflows/live-check.yml`, Mondays 09:00 Boise) opens or updates one issue titled "Live source check: a source is not answering" whenever a source fails or degrades, and pings the `LIVE_CHECK_WEBHOOK` repository secret if you set one to a Discord webhook. Close the issue when a run is green again.
- **Dependabot** batches dependency bumps weekly; CI runs the full suite on each.
- **Users see it too.** At startup the server asks the npm registry once and prints one line if a newer version is published; `get_source_status` reports the same in its `update` field, so an assistant can tell them. Every answer already names its source and read time, and every miss names the layer that missed, so a stale directory or a dead venue reads as exactly that.
