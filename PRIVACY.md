# Privacy

solana-nft-mcp runs on your machine. It has no account system, no analytics and no server of
its own, so there is nothing for it to report back to. This page lists every request it makes
and every file it writes.

## What leaves your machine

A tool call sends the thing you asked about (a wallet address, a mint address, a collection
name) to the service that can answer it, and to nobody else:

| Service | Host | When | What it receives |
|---|---|---|---|
| Solana RPC and asset index | `api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com`, `solana.leorpc.com`, or the endpoint you set in `SOLANA_RPC_URL` / `DAS_RPC_URL` | Any question answered from the chain | The addresses being read |
| Magic Eden | `api-mainnet.magiceden.dev` | Listings, floors, sales, wallet activity | Collection symbols, mint and wallet addresses |
| OpenSea | `api.opensea.io` | Stats, listings and sales that OpenSea carries | Collection slugs, mint and wallet addresses, and an API key |
| npm registry | `registry.npmjs.org` | Once at start | A request for this package's latest version number. No identifier is added |

Each of those services sees your IP address and a user-agent naming this package and its
version, as any website does. What they keep is covered by their own policies. Your
questions, the assistant's answers and your chat never go to any of them: only the addresses
and names a tool call needs.

Nothing is sent to the author of this package.

## What is written to disk

- `~/.solana-nft-mcp/opensea-key.json`: a free OpenSea API key the server requests the first
  time a question needs OpenSea, with its expiry date. Set `SOLANA_NFT_MCP_NO_AUTO_KEYS=1` and
  the key is never requested and the file never written.

That is the only file. Answers are cached in memory and are gone when the process exits.

## Logs

Diagnostics go to stderr, which your AI app may keep in its own log. With
`SOLANA_NFT_MCP_LOG=1` each tool call adds one line with the tool's name, the names of the
arguments, the time it took and whether it worked. Argument values, including wallet
addresses, are not logged.

## Turning things off

- `SOLANA_NFT_MCP_NO_AUTO_KEYS=1`: no OpenSea key is requested.
- `SOLANA_NFT_MCP_NO_UPDATE_CHECK=1`: no request to npm at start.
- `SOLANA_RPC_URL`, `DAS_RPC_URL`: send chain reads to an endpoint you choose.

Questions: open an issue at https://github.com/p1xelapp/solana-nft-mcp/issues.
