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
import { reconcileFloors, type FloorQuote } from "./lib/reconcile.js";
import { GLOSSARY, PRESENTATION_RULES } from "./glossary.js";
import { identify } from "./identify.js";
import { RECIPES, RECIPE_GOALS } from "./recipes.js";
import { verifyClaim } from "./verify.js";
import { decodeCoreTrust } from "./lib/coreplugins.js";

// Single-sourced from package.json so the MCP handshake, the startup banner,
// and the published package can never disagree about what version this is.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new McpServer({ name: "collector-mcp", version: VERSION });

// Counted, not hand-written. The banner said "8 tools" for two releases after
// the ninth was added - a stale count is a small lie that erodes trust in the
// larger numbers this server reports.
let toolCount = 0;
const registerTool: typeof server.registerTool = (...args) => {
  toolCount++;
  return server.registerTool(...args);
};

// ---------------------------------------------------------------- helpers

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Every tool reads public data and mutates nothing; declare it so MCP clients
// (and their users) can see the safety contract in the protocol itself.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Every tool result carries the same payload twice, on purpose.
 *
 * `structuredContent` is what a spec-current client parses directly - typed,
 * no string-scraping, no chance of a model mis-reading a number it had to
 * pull out of prose. `content` keeps the pretty-printed JSON so older clients
 * and plain transcripts still work, which the spec explicitly asks for.
 */
const ok = (data: unknown): ToolResult => {
  const text = JSON.stringify(data, null, 2);
  const structured =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return { content: [{ type: "text", text }], structuredContent: structured };
};

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

registerTool(
  "identify",
  {
    title: "Identify anything",
    description:
      "START HERE when you do not already know what an identifier is. Takes ANY string a user might " +
      "paste - a Solana address, a marketplace symbol or slug, or a plain collection name - works out " +
      "what it actually is, which venues list it, and which tools to call next. Works on collections " +
      "that launched today and are in no registry, because it probes live sources rather than matching " +
      "a hardcoded list. Returns the evidence: every source checked INCLUDING the ones that found " +
      "nothing, what was not checked and why, and a confidence rating. Never report 'this does not " +
      "exist' from an empty result - report what was searched.",
    annotations: READ_ONLY,
    inputSchema: {
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("An address, marketplace symbol/slug, or collection name"),
    },
  },
  guard(async ({ query }) => ok(await identify(query))),
);

registerTool(
  "verify_claim",
  {
    title: "Verify a claim against the chain",
    description:
      "Check whether something a user was TOLD is actually true. Use this whenever a claim about a " +
      "collection or asset carries stakes - a project announcing a supply, a seller saying a card has " +
      "never been traded, a post claiming a wallet holds something, a quoted floor price. Returns " +
      "confirmed, contradicted, or unverifiable, together with the exact numbers observed, where they " +
      "were read, and instructions to reproduce the check independently - so the answer does not " +
      "require trusting this server either. Willingly answers UNVERIFIABLE rather than guessing; a " +
      "tool that always returns true or false will eventually return false with confidence.",
    annotations: READ_ONLY,
    inputSchema: {
      claim: z
        .enum(["supply", "never-traded", "ownership", "floor"])
        .describe("What kind of statement is being checked"),
      subject: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("Collection address for supply, asset mint for never-traded/ownership, Magic Eden symbol for floor"),
      value: z
        .number()
        .positive()
        .optional()
        .describe("The claimed number - required for supply (count) and floor (SOL)"),
      wallet: addressSchema.optional().describe("The wallet said to own it - required for ownership claims"),
    },
  },
  guard(async (args) => ok(await verifyClaim(args))),
);

registerTool(
  "get_asset_trust",
  {
    title: "What owning this actually means",
    description:
      "Decode the Metaplex Core plugins on an asset and translate them into custody facts: can the " +
      "issuer move or burn it without the holder's signature (permanent delegates - normal on packs, a " +
      "red flag on keepers), is it frozen, are royalties enforced by a program rule set or merely " +
      "advisory, is the metadata mutable, is the serial an on-chain edition or just printed text. " +
      "Marketplaces show the picture and the price; this shows the rules attached to the account. Use " +
      "before a purchase, when a listing 'cannot transfer', or when someone asks whether a pack burns " +
      "on open. Read-only, decoded from raw bytes, no indexer.",
    annotations: READ_ONLY,
    inputSchema: { mint: addressSchema.describe("Metaplex Core asset address") },
  },
  guard(async ({ mint }) => {
    const raw = await sol.getCoreAccountRaw(mint);
    if (!raw) throw new Error(`no account at ${mint} - burned assets leave a tiny rent-exempt stub or nothing at all`);
    const acct = await sol.getCoreAccount(mint);
    if (!acct || acct.kind !== "asset") throw new Error(`${mint} is not a Core asset (it is a ${acct?.kind ?? "non-Core account"})`);
    const trust = decodeCoreTrust(raw);
    return ok({
      mint,
      name: acct.name,
      owner: acct.owner,
      collection: acct.collection,
      ...trust,
      readThis:
        "Warnings are facts about who else can act on this asset. A permanent delegate on a PACK is expected (it is consumed on open); the same plugin on a card you intend to keep means it is not unconditionally yours.",
    });
  }),
);

registerTool(
  "get_integration_recipe",
  {
    title: "Get a build recipe",
    description:
      "Use when the user wants to BUILD something with collectible data - a sales bot, a floor " +
      "dashboard, a provenance page, a wallet tracker, a pack-pull watcher - rather than just look a " +
      "number up. Returns the verified endpoints and their real rate limits, a runnable skeleton, the " +
      "steady-state running cost, a pre-launch checklist, and most importantly the specific ways this " +
      "kind of integration fails SILENTLY. The pitfalls come from production incidents on live " +
      "trackers (a feed capped too low silently dropped 8,409 real records; an idle two-minute cron " +
      "cost $180 in a month) and are not in any API documentation. Read this BEFORE writing " +
      "integration code, not after it breaks.",
    annotations: READ_ONLY,
    inputSchema: {
      goal: z
        .enum(["sales-bot", "floor-dashboard", "provenance-lookup", "wallet-tracker", "pack-watcher"])
        .describe("What the user is building"),
    },
  },
  guard(({ goal }) => {
    const recipe = RECIPES[goal];
    if (!recipe) throw new Error(`unknown goal "${goal}" - available: ${RECIPE_GOALS.join(", ")}`);
    return Promise.resolve(
      ok({
        ...recipe,
        readFirst:
          "Read collector://glossary before writing user-facing copy - it names the wrong answers this domain invites.",
      }),
    );
  }),
);

registerTool(
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

registerTool(
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

    // Cross-source reconciliation. Two venues quoting the same collection is
    // the normal case now, and handing an agent two bare numbers is how it
    // ends up comparing SOL to USDC and calling one "cheaper". Only venues
    // that actually returned a floor become quotes.
    const quotes: FloorQuote[] = [];
    const mkt = out.market as { floorPriceSol?: number | null } | undefined;
    if (typeof mkt?.floorPriceSol === "number" && mkt.floorPriceSol > 0) {
      quotes.push({ source: "magiceden", value: mkt.floorPriceSol, currency: "SOL" });
    }
    const osBlock = out.opensea as { floor?: number | null; floorCurrency?: string | null } | undefined;
    if (osBlock && typeof osBlock.floor === "number" && osBlock.floor > 0 && osBlock.floorCurrency) {
      quotes.push({ source: "opensea", value: osBlock.floor, currency: osBlock.floorCurrency });
    }

    const extra: string[] = [];
    if (out.onchain && mkt?.floorPriceSol !== undefined) {
      extra.push(
        "On-chain supply counts every asset that exists; a marketplace's listed count only covers what is currently for sale on that venue. They answer different questions and will not match.",
      );
    }
    if (quotes.length > 0) out.reconciliation = reconcileFloors(quotes, extra);
    return ok(out);
  }),
);

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
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
  "glossary",
  "collector://glossary",
  {
    title: "Collectibles glossary + presentation rules",
    description:
      "Domain vocabulary with the specific wrong answer each term exists to prevent (floor is not a valuation, " +
      "a listed item's on-chain owner is the marketplace escrow, an opened Candy pack is returned not burned), " +
      "plus how to present this data to a person. Read this before interpreting or summarising any output.",
    mimeType: "application/json",
  },
  (uri) =>
    Promise.resolve({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ glossary: GLOSSARY, presentationRules: PRESENTATION_RULES }, null, 2),
        },
      ],
    }),
);

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
  console.error(`collector-mcp v${VERSION} ready (stdio) - ${toolCount} tools, 0 API keys`);
}

main().catch((err) => {
  console.error("collector-mcp fatal:", err);
  process.exit(1);
});
