# Security Policy

## The security model in one page

solana-nft-mcp reads. It has no signing code, no wallet code and no transaction
path: it cannot buy, sell, list, transfer or spend anything, and that is true
because the ability was never written, not because it is switched off. Every
tool declares `readOnlyHint` in the protocol, which here means that nothing on
the chain or at a marketplace is changed; the two local side effects below are
not covered by that annotation and are listed instead. Against the chain and
the marketplaces, the failure to plan for is a wrong or stale number, and the
server is built to label those rather than hide them.

That is the boundary against the chain and the marketplaces. Two things this server
does on the machine it runs on are worth knowing about, because "read-only"
does not describe them:

- **It may create and store one credential.** The first question that needs
  OpenSea asks OpenSea's instant-key endpoint for a free key, with no sign-up,
  and keeps it in `~/.solana-nft-mcp/opensea-key.json` at permissions 600 so the
  next session does not spend another. Set `OPENSEA_API_KEY` and it uses yours
  instead; set `SOLANA_NFT_MCP_NO_AUTO_KEYS=1` and it never asks. A refused
  issue is remembered for a cooldown and any `Retry-After` the marketplace sends is
  honoured, so a failing endpoint is not asked again on every call. The
  status tool (`get_source_status`) describes this state and never requests a
  key itself.
- **It asks npm once at startup** whether a newer version exists, sending the
  package name and version as a user-agent and nothing else. Off with
  `SOLANA_NFT_MCP_NO_UPDATE_CHECK=1`; `SOLANA_NFT_MCP_OFFLINE=1` stops every
  request the server would make on its own.

Whichever key is in use, it is sent only to `api.opensea.io`, and never across
a redirect: every request this server makes refuses a 3xx answer rather than
following it, so a header cannot be carried to a host a redirect names. Every
credential
this process has sent is registered, and every string that leaves the process
for a client, a model or a log goes through that registry: an upstream that
reflects the request header in an error body gets the reflection replaced,
and the tool boundary scrubs the whole serialised result as a last gate. The
key file is never logged, never printed and never part of an answer.

Nothing is collected. There is no telemetry, no analytics and no log of your
questions. What leaves the machine is the public address, symbol or name you
asked about, sent to the source that can answer it: Solana RPC, the asset
index on it, Magic Eden, and OpenSea when it is on. An in-memory cache of
recent answers lives for the process and is gone when it exits. Your AI client
and its model provider have their own data practices, and this server cannot
speak for them.

Everything an upstream returns is third-party content. Names and metadata
are neutralised before they reach an answer, typed fields (addresses,
signatures, tickers, amounts, timestamps) are validated against the shape
they claim and set to null with a reason when they fail, and a client or
agent framework consuming this server must still treat every string in a
result as data, never as instructions. A local string filter is a control,
not a proof against prompt injection at the model.

Every response body from every source, including the RPC health batch and
the update check, is read through one bounded reader that refuses anything
over 4 MB before it is buffered. Requests a client cancels stop at the next
gate wait, retry sleep, fetch or page, and a read shared by several callers
is abandoned only when the last of them has gone.

Solana's public RPC endpoints are shared infrastructure that their operator
says is not for production traffic. They are the default here because they
are free and keyless, which suits interactive research; anyone who needs
reliable throughput or archival history should point `SOLANA_RPC_URL` at an
endpoint of their own. The label a tool prints for a configured endpoint is
its host only, never its URL, because private endpoints carry their key in
the query string.

## Reporting a vulnerability

Open a GitHub security advisory on this repository
(https://github.com/p1xelapp/solana-nft-mcp/security/advisories/new), or a plain
issue if the finding is not sensitive. Realistic classes worth reporting:

- a credential, a file path or an environment value reaching an answer or a log
- input validation bypasses that reach an upstream un-encoded
- ways to make the server amplify traffic against an upstream (rate-gate bypass, retry storms)
- a response path that reads a body without the bounded reader
- cancelled work that keeps spending an upstream's budget
- cache poisoning between tool calls
- dependency issues (`npm audit` runs in CI on every push)

No bug bounty - this is an open-source, zero-revenue project - but confirmed
reports get fixed and credited in the changelog.

## Supply chain

Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), lockfile
committed, install scripts disabled via `.npmrc`. CI runs a full-history secrets
scan (gitleaks) on every push to every branch, and `npm audit` plus the offline
suite on `main` and pull requests. The gitleaks allowlist is scoped to the one
rule that misreads base58 chain addresses in `test/fixtures`, not to those
paths wholesale - a real credential committed there still fails the scan.

The offline suite (`npm test`) runs every child server with
`SOLANA_NFT_MCP_OFFLINE=1` or with every upstream stubbed by a preload, so a
test that reaches the network fails loudly rather than passing against live
data. `test/credentials-and-cancellation.mjs` holds one regression per fixed
credential and cancellation defect, each asserting the correct behaviour on
the fixture that reproduced it.

Releases run `node scripts/pack-check.mjs` to prove the tarball carries
`dist/index.js` before going out, and `npm run bundle` verifies the `.mcpb`
it builds; the exact release steps are in CONTRIBUTING.md.
