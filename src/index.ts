#!/usr/bin/env node
/**
 * collector-mcp - zero-key MCP server for Solana digital collectibles.
 *
 * Runs over stdio. No API keys, no wallet, no config: every data source is a
 * public, keyless endpoint (Magic Eden v2, CryptoSlam, plain Solana RPC), and
 * the server is read-only by design - it cannot sign, send, or spend anything.
 *
 * IMPORTANT for contributors: never write to stdout (console.log) - stdout IS
 * the MCP protocol channel. Diagnostics go to stderr (console.error).
 */

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as me from "./sources/magiceden.js";
import * as cs from "./sources/cryptoslam.js";
import * as os from "./sources/opensea.js";
import * as sol from "./sources/solana.js";
import { REGISTRY, searchRegistry } from "./registry.js";

// Single-sourced from package.json so the MCP handshake, the startup banner,
// and the published package can never disagree about what version this is.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new McpServer({ name: "collector-mcp", version: VERSION });

// ---------------------------------------------------------------- helpers

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// Every tool reads public data and mutates nothing; declare it so MCP clients
// (and their users) can see the safety contract in the protocol itself.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

/** Uniform error surface: the agent gets a plain, actionable message. */
const guard =
  <A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) =>
  async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };

const addressSchema = z
  .string()
  .trim()
  .refine(sol.isBase58Address, "must be a base58 Solana address (32-44 chars)");

const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_\-.]+$/i, "must be a Magic Eden collection symbol (letters, digits, _ - .)");

/** Resolve a user-supplied id: registry id -> entry, else raw symbol/address. */
function resolve(idOrSymbolOrAddress: string) {
  const entry = REGISTRY.find((e) => e.id === idOrSymbolOrAddress);
  if (entry) return entry;
  if (sol.isBase58Address(idOrSymbolOrAddress)) return { coreCollection: idOrSymbolOrAddress };
  return { meSymbol: idOrSymbolOrAddress };
}

// ------------------------------------------------------------------ tools

server.registerTool(
  "search_collections",
  {
    title: "Search collections",
    description:
      "Find digital-collectible collections by name (e.g. 'candy gold series', 'panini', 'mad lads'). " +
      "Returns curated entries with the identifiers other tools need (Magic Eden symbol, Core collection " +
      "address, CryptoSlam contract). Collections not in the registry still work: pass a Magic Eden symbol " +
      "or a Metaplex Core collection address directly to the other tools.",
    annotations: READ_ONLY,
    inputSchema: { query: z.string().trim().max(200).describe("Free-text name search") },
  },
  guard(({ query }) => {
    const results = searchRegistry(query);
    return Promise.resolve(
      ok({
      query,
      results,
        hint:
          results.length === 0
            ? "No registry match. If you know the Magic Eden symbol or a Core collection address, pass it directly to get_collection_stats."
            : undefined,
      }),
    );
  }),
);

server.registerTool(
  "get_collection_stats",
  {
    title: "Collection stats",
    description:
      "Market + supply stats for a collection. Accepts a registry id, a Magic Eden symbol, or a Metaplex " +
      "Core collection ADDRESS. Addresses are decoded straight from the chain (name, minted, current size) - " +
      "works for collections no marketplace indexes, e.g. Candy Digital drops. If OPENSEA_API_KEY is set, " +
      "an OpenSea cross-marketplace view is added (pass openseaSlug, or rely on registry entries that carry one).",
    annotations: READ_ONLY,
    inputSchema: {
      collection: z.string().trim().min(1).max(80).describe("Registry id, ME symbol, or Core collection address"),
      openseaSlug: z
        .string()
        .trim()
        .max(120)
        .regex(/^[a-z0-9-]+$/i, "OpenSea collection slug")
        .optional()
        .describe("Optional OpenSea slug for a cross-marketplace view (requires OPENSEA_API_KEY)"),
    },
  },
  guard(async ({ collection, openseaSlug }) => {
    const r = resolve(collection);
    const out: Record<string, unknown> = { requested: collection };
    if ("name" in r) out.registry = { id: r.id, name: r.name, platform: r.platform };
    if (r.coreCollection) {
      const acct = await sol.getCoreAccount(r.coreCollection);
      if (acct?.kind === "collection") {
        out.onchain = {
          address: r.coreCollection,
          name: acct.name,
          numMinted: acct.numMinted,
          currentSize: acct.currentSize,
          burnedOrClosed: acct.numMinted - acct.currentSize,
          source: "solana-rpc (Metaplex Core account, decoded locally)",
        };
      }
    }
    if (r.meSymbol) {
      out.market = await me.collectionStats(r.meSymbol);
      out.meta = await me.collectionMeta(r.meSymbol).catch(() => undefined);
    }
    const slug = openseaSlug ?? ("openseaSlug" in r ? r.openseaSlug : undefined);
    if (slug && os.openSeaEnabled()) {
      out.opensea = await os.collectionStats(slug).catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e),
      }));
    } else if (slug) {
      out.openseaNote = "OpenSea slug known but OPENSEA_API_KEY not set - cross-marketplace view skipped (server stays zero-config by default).";
    }
    if (!out.onchain && !out.market) {
      throw new Error(
        `could not resolve "${collection}" - not a known registry id, and no market/on-chain source answered.`,
      );
    }
    return ok(out);
  }),
);

server.registerTool(
  "get_floor_prices",
  {
    title: "Floor prices",
    description:
      "Current floor price (SOL) for up to 10 Magic Eden collections in one call. " +
      "Use search_collections first if you only know a human name.",
    annotations: READ_ONLY,
    inputSchema: { symbols: z.array(symbolSchema).min(1).max(10).describe("Magic Eden collection symbols") },
  },
  guard(async ({ symbols }) => {
    const floors = [];
    for (const s of symbols) {
      // Sequential on purpose: one shared rate gate protects the keyless API.
      try {
        const st = await me.collectionStats(s);
        floors.push({ symbol: s, floorSol: st.floorPriceSol, listed: st.listedCount, stale: st.stale });
      } catch (e) {
        floors.push({ symbol: s, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok({ floors, source: "magiceden" });
  }),
);

server.registerTool(
  "get_recent_sales",
  {
    title: "Recent sales",
    description:
      "Most recent completed sales for a collection (price in SOL, buyer, seller, tx signature). " +
      "Accepts a registry id or Magic Eden symbol. With OPENSEA_API_KEY set and an openseaSlug, " +
      "OpenSea sales are included for a cross-marketplace picture.",
    annotations: READ_ONLY,
    inputSchema: {
      collection: z.string().trim().min(1).max(80),
      limit: z.number().int().min(1).max(50).default(10),
      openseaSlug: z
        .string()
        .trim()
        .max(120)
        .regex(/^[a-z0-9-]+$/i, "OpenSea collection slug")
        .optional(),
    },
  },
  guard(async ({ collection, limit, openseaSlug }) => {
    const r = resolve(collection);
    const slug = openseaSlug ?? ("openseaSlug" in r ? r.openseaSlug : undefined);
    const openseaPart =
      slug && os.openSeaEnabled()
        ? await os.recentSales(slug, limit).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
        : undefined;
    if (!r.meSymbol) {
      if (openseaPart) return ok({ requested: collection, opensea: openseaPart });
      throw new Error(
        `"${collection}" has no Magic Eden symbol. For Candy Digital collections use get_asset_provenance ` +
          `on a specific card, or get_pack_pulls for Panini rips - or pass an openseaSlug with OPENSEA_API_KEY set.`,
      );
    }
    const magiceden = await me.recentSales(r.meSymbol, limit);
    return ok(openseaPart ? { ...magiceden, opensea: openseaPart } : magiceden);
  }),
);

server.registerTool(
  "get_asset",
  {
    title: "Asset lookup",
    description:
      "Everything known about one asset by mint address: marketplace metadata (name, image, collection, " +
      "traits, listing state) plus authoritative on-chain owner for Metaplex Core assets.",
    annotations: READ_ONLY,
    inputSchema: { mint: addressSchema.describe("Asset mint address") },
  },
  guard(async ({ mint }) => {
    const [meToken, core] = await Promise.all([
      me.token(mint),
      sol.getCoreAccount(mint).catch(() => null),
    ]);
    if (!meToken && !core) {
      throw new Error(`no data found for ${mint} on Magic Eden or as a Metaplex Core account.`);
    }
    return ok({
      mint,
      onchain:
        core?.kind === "asset"
          ? {
              name: core.name,
              owner: core.owner,
              collection: core.collection,
              standard: "metaplex-core",
              note: "Owner read directly from the Core account - authoritative, but may be a marketplace escrow if listed.",
            }
          : undefined,
      market: meToken ?? undefined,
      sources: [core ? "solana-rpc" : null, meToken ? "magiceden" : null].filter(Boolean),
    });
  }),
);

server.registerTool(
  "get_asset_provenance",
  {
    title: "Asset provenance (Core)",
    description:
      "Full on-chain ownership history of a Metaplex Core asset: mint -> every transfer (with marketplace " +
      "labels) -> current owner. Decoded from TransferV1 instruction accounts - data most NFT APIs return " +
      "EMPTY for on Core assets. Ideal for Candy Digital cards and any Core collectible.",
    annotations: READ_ONLY,
    inputSchema: {
      mint: addressSchema.describe("Core asset mint address"),
      depth: z.number().int().min(1).max(25).default(15).describe("Max transactions to decode"),
    },
  },
  guard(async ({ mint, depth }) => ok(await sol.getProvenance(mint, depth))),
);

server.registerTool(
  "get_wallet_holdings",
  {
    title: "Wallet holdings",
    description:
      "Collectibles held by a wallet (as indexed by Magic Eden): names, collections, images, listing state. " +
      "Read-only - this server never asks for keys and cannot move anything.",
    annotations: READ_ONLY,
    inputSchema: {
      wallet: addressSchema.describe("Wallet address"),
      limit: z.number().int().min(1).max(100).default(50),
    },
  },
  guard(async ({ wallet, limit }) => ok(await me.walletTokens(wallet, limit))),
);

server.registerTool(
  "get_pack_pulls",
  {
    title: "Live pack pulls",
    description:
      "Live feed of licensed-card pack rips (default: Panini America - NBA/NFL/Soccer/Baseball). Each entry " +
      "is a card just pulled from a pack: player, set/parallel, serial number, population, owner wallet, image.",
    annotations: READ_ONLY,
    inputSchema: {
      contract: z
        .string()
        .trim()
        .max(60)
        .regex(/^[a-z0-9-]+$/i, "CryptoSlam contract slug, e.g. panini-america")
        .default("panini-america"),
      limit: z.number().int().min(1).max(20).default(10),
    },
  },
  guard(async ({ contract, limit }) => ok(await cs.recentMints(contract, limit))),
);

// -------------------------------------------------------------- resources

server.registerResource(
  "registry",
  "collector://registry",
  {
    title: "Curated collection registry",
    description: "Hand-verified licensed digital-collectible collections and their identifiers.",
    mimeType: "application/json",
  },
  (uri) =>
    Promise.resolve({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(REGISTRY, null, 2) }],
    }),
);

// ---------------------------------------------------------------- prompts

server.registerPrompt(
  "collection_report",
  {
    title: "Collection market report",
    description: "Build a concise market report for a collection using the collector-mcp tools.",
    argsSchema: { collection: z.string().describe("Collection name, symbol, or address") },
  },
  ({ collection }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Build a market report for "${collection}" using collector-mcp tools:\n` +
            `1. search_collections to resolve identifiers.\n` +
            `2. get_collection_stats for supply + floor.\n` +
            `3. get_recent_sales (if it trades on Magic Eden) - summarize price range and velocity.\n` +
            `4. If it is a Metaplex Core collection, pick one recently active asset and show its ` +
            `get_asset_provenance timeline as a story.\n` +
            `Close with 3 bullet takeaways for a collector. Label any stale data.`,
        },
      },
    ],
  }),
);

// ------------------------------------------------------------------ main

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`collector-mcp v${VERSION} ready (stdio) - 8 tools, 0 API keys`);
}

main().catch((err) => {
  console.error("collector-mcp fatal:", err);
  process.exit(1);
});
