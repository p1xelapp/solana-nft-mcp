/**
 * Integration recipes - the reason to use this server rather than a search engine.
 *
 * Looking a number up is a solved problem. Building something that keeps
 * looking it up correctly, for months, without quietly going wrong or running
 * up a bill, is not. Everything below is operational knowledge that cost real
 * outages and real money to learn on live collectible trackers, written down
 * in the form an agent needs it: which endpoint, what it actually costs, and
 * the specific way this particular integration fails silently.
 *
 * The pitfalls are the payload. Endpoints are discoverable; knowing that
 * Magic Eden answers HTTP 200 for collections that do not exist, that a pull
 * feed capped at a guessed number silently drops history, or that an idle
 * two-minute cron cost $180 in a month - that is not in any documentation.
 */

export interface Recipe {
  goal: string;
  buildingWhat: string;
  /** Endpoints and tools to use, in the order a build should reach for them. */
  dataSources: { name: string; use: string; auth: string; rateLimit: string }[];
  /** The specific ways THIS integration goes wrong. Ordered by how quietly. */
  pitfalls: { trap: string; why: string; instead: string }[];
  /** Steady-state running cost, because "it works" is not the same as "it is affordable". */
  costNote: string;
  /** Concrete shape to build against. */
  skeleton: string;
  /** Checks to run before anyone depends on it. */
  beforeShipping: string[];
}

const ME_SOURCE = {
  name: "Magic Eden public v2",
  use: "Floors, listings, recent sale activity for any Solana collection.",
  auth: "None. Keyless.",
  rateLimit: "~2 requests/second. Pace at one request per 600ms and cache; a keyless API stays usable only while its callers stay polite.",
};

const RPC_SOURCE = {
  name: "Solana JSON-RPC",
  use: "Ground truth: account state, transaction history, Metaplex Core decoding.",
  auth: "None for public endpoints. SOLANA_RPC_URL overrides with your own, still keyless.",
  rateLimit: "Public RPC throttles aggressively and blocks many datacenter IPs. Serialise requests; do not fan out in parallel.",
};

export const RECIPES: Record<string, Recipe> = {
  "sales-bot": {
    goal: "sales-bot",
    buildingWhat:
      "A bot that watches a collection and posts every sale to Discord, X, or a webhook, with card art, price, and buyer.",
    dataSources: [
      ME_SOURCE,
      RPC_SOURCE,
      {
        name: "collector-mcp get_recent_sales",
        use: "The read path, already rate-gated and cached. Use it rather than calling marketplaces directly.",
        auth: "None.",
        rateLimit: "Inherits the source gates.",
      },
    ],
    pitfalls: [
      {
        trap: "Polling a sales endpoint on a timer and posting whatever is new.",
        why: "Restarts re-post old sales, and any downtime silently swallows the sales that happened while you were down. The feed looks healthy either way.",
        instead:
          "Persist the last processed signature or timestamp to disk, resume from it on boot, and reconcile against the marketplace's own history on startup rather than trusting that the process was running.",
      },
      {
        trap: "Treating the on-chain owner of a sold item as the buyer.",
        why: "Listed items sit in a marketplace escrow. The address you read may be the escrow, not a person.",
        instead: "Read the buyer from the sale event, and use get_asset_provenance to attribute the transfer chain when it matters.",
      },
      {
        trap: "Assuming an HTTP 200 means the collection exists.",
        why: "Magic Eden echoes unknown symbols back as a valid-looking object with listedCount 0, and OpenSea returns an empty shell collection. Both look like a quiet market rather than a typo.",
        instead: "Validate the payload - a real collection carries volume or a floor. A silently wrong symbol produces a bot that posts nothing forever.",
      },
      {
        trap: "One alert channel with no failure path.",
        why: "If posting fails, the sale is gone; you will not learn about it until someone asks why the bot is quiet.",
        instead: "Log every send outcome and alert yourself when the failure rate rises. Throttle those self-alerts so one outage cannot spam you.",
      },
    ],
    costNote:
      "Keyless sources: $0. The cost risk is your own hosting and any database writes. A two-minute cron rewriting a table 720 times a day cost $180 in a month on a project nobody was even using - price the steady state, not one run, and give any scheduled job a review date.",
    skeleton: `// Poll → diff against a persisted cursor → post → persist.
// The cursor is the whole design; everything else is presentation.
let cursor = await loadCursor();            // survives restarts
const sales = await getRecentSales(symbol, 50);
const fresh = sales.filter(s => s.time > cursor);
for (const s of fresh.reverse()) {          // oldest first, so order reads true
  await post(s);
  cursor = s.time;
  await saveCursor(cursor);                 // save per item, not per batch:
}                                            // a crash mid-batch must not skip`,
    beforeShipping: [
      "Kill the process mid-batch and restart it. No sale should be double-posted or skipped.",
      "Point it at a deliberately misspelled collection symbol. It must fail loudly, not go quiet.",
      "Let it run through a period with zero sales and confirm it stays silent without erroring.",
      "Confirm the steady-state request rate against the source's published limit, with headroom.",
    ],
  },

  "floor-dashboard": {
    goal: "floor-dashboard",
    buildingWhat:
      "A web dashboard showing live floors, listings, and recent sales across several collections and marketplaces.",
    dataSources: [
      ME_SOURCE,
      {
        name: "OpenSea v2 (optional)",
        use: "Cross-marketplace floors so a Solana-only view does not undercount liquidity.",
        auth: "Needs OPENSEA_API_KEY. Free instant keys via POST /api/v2/auth/keys - capped at 2/day, 600 reads/hour, and they expire after 7 days. The developer portal issues permanent keys.",
        rateLimit: "Read the X-RateLimit-Remaining header rather than hardcoding a number; free-tier limits change.",
      },
      {
        name: "collector-mcp get_floor_prices",
        use: "Several collections in one call, already gated.",
        auth: "None.",
        rateLimit: "Inherits source gates.",
      },
    ],
    pitfalls: [
      {
        trap: "Putting two marketplaces' floors side by side and calling the lower one cheaper.",
        why: "The same collection can be quoted in different currencies per venue. Collector Crypt is 0.053 SOL on Magic Eden and 9 USDC on OpenSea - a 170x gap that is not a gap at all.",
        instead: "Use the reconciliation block from get_collection_stats. When comparable is false, show both with their currencies and say they are not comparable rather than ranking them.",
      },
      {
        trap: "Showing a blank panel when a source fails.",
        why: "Every upstream here is flaky by nature. A blank dashboard reads as 'the market is empty' rather than 'the API is down'.",
        instead: "Serve the last good value labelled with its age. Stale and honest beats blank.",
      },
      {
        trap: "Refreshing on a timer whether or not anyone is looking.",
        why: "A dashboard nobody has open still burns quota and money around the clock.",
        instead: "Refresh on page load, or on an interval only while a viewer is connected. For a demo, on-demand only.",
      },
      {
        trap: "Presenting a floor as a valuation.",
        why: "A floor is the lowest current ask. On a thin book one listing sets it, and it can sit far from anything that traded.",
        instead: "Show the floor next to recent sale prices, and label it as an ask.",
      },
    ],
    costNote:
      "Reads are free on the keyless sources. Cost appears when you cache into metered storage - price writes per refresh times refreshes per day, and remember index writes multiply the row count. If it exceeds a fifth of a free tier, redesign before shipping.",
    skeleton: `// Fan out per collection, tolerate partial failure, never block the page.
const results = await Promise.allSettled(collections.map(getStats));
const panels = results.map((r, i) =>
  r.status === "fulfilled"
    ? { ...r.value }                      // keeps the server's own stale flag + cachedAt
    : { collection: collections[i], ...lastGood(collections[i]), stale: true }
);
// Render stale panels with their age visible, never blank.`,
    beforeShipping: [
      "Block one upstream at the network level and confirm the page still renders with labelled stale data.",
      "Check a collection quoted in a non-SOL currency renders without an implied comparison.",
      "Measure it at 390px wide. Nothing should scroll sideways.",
      "Confirm the refresh stops when nobody is viewing.",
    ],
  },

  "provenance-lookup": {
    goal: "provenance-lookup",
    buildingWhat:
      "A page or command that takes a card and shows every owner it has had, from mint to now.",
    dataSources: [
      RPC_SOURCE,
      {
        name: "collector-mcp get_asset_provenance",
        use: "The whole job in one call - Core account decode plus the transfer trail, with marketplaces named.",
        auth: "None.",
        rateLimit: "Serialised RPC. One asset at a time.",
      },
    ],
    pitfalls: [
      {
        trap: "Using a mainstream NFT API and reporting the empty result.",
        why: "Metaplex Core assets return an EMPTY transfer list from most enhanced-transaction APIs. Empty means unsupported, not untraded, and the two are indistinguishable in the response.",
        instead: "Decode Core TransferV1 instruction accounts directly, which is what get_asset_provenance does. Never render an empty history as 'never traded'.",
      },
      {
        trap: "Labelling the current on-chain owner as the collector.",
        why: "If the item is listed, the owner is the marketplace escrow.",
        instead: "Detect the escrow and name the wallet that transferred it in as the seller. Say the item is listed rather than showing a meaningless address.",
      },
      {
        trap: "Capping the signature fetch at a round number and rendering what comes back.",
        why: "An item with more history than your cap silently loses its oldest events - usually the mint, which is the one people care about.",
        instead: "Always include the oldest signature explicitly, and report how many were skipped rather than dropping them quietly.",
      },
    ],
    costNote: "Entirely free. Public RPC, one asset at a time, no storage required.",
    skeleton: `const p = await getAssetProvenance(mint);
// Oldest first - provenance is a story and stories run forward.
for (const e of p.events) render(e.time, e.event, e.newOwner, e.marketplace);
if (p.skippedTransactions > 0) renderNotice(\`\${p.skippedTransactions} older events not shown\`);
if (isEscrow(p.currentOwner)) renderNotice("Currently listed - held in marketplace escrow.");`,
    beforeShipping: [
      "Test an item that is currently listed. The escrow must be explained, not printed as the owner.",
      "Test a freshly minted item with one event, and one with a long history.",
      "Confirm a skipped-event count appears rather than history silently vanishing.",
    ],
  },

  "wallet-tracker": {
    goal: "wallet-tracker",
    buildingWhat: "A view of what a wallet holds, what it has bought and sold, and what that is worth now.",
    dataSources: [
      ME_SOURCE,
      RPC_SOURCE,
      {
        name: "collector-mcp get_wallet_holdings",
        use: "Holdings as the marketplace indexes them, with escrow addresses explained.",
        auth: "None.",
        rateLimit: "Inherits source gates.",
      },
    ],
    pitfalls: [
      {
        trap: "Treating a marketplace's wallet endpoint as the complete picture.",
        why: "It only covers collections that marketplace indexes. Anything else is invisible, and the response gives no hint that it is partial.",
        instead: "State the coverage explicitly in the UI. 'As indexed by Magic Eden' is honest; a bare total is not.",
      },
      {
        trap: "Counting listed items as still held, or as already sold.",
        why: "A listed item has left the wallet on chain but has not been sold. Both naive readings are wrong.",
        instead: "Track it as a distinct state: held, listed, sold. Where an asset SITS is a guess about what it IS.",
      },
      {
        trap: "Valuing a portfolio by multiplying item count by floor.",
        why: "Serial numbers, grades and 1-of-1s make items within one collection wildly unequal, and the floor is one optimistic ask.",
        instead: "Show a floor-based range with the assumption stated, or value from comparable recent sales at similar serials.",
      },
      {
        trap: "Assuming a blocked or empty wallet response means an empty wallet.",
        why: "Magic Eden refuses its own escrow addresses outright, returning an error that looks like a bug.",
        instead: "Distinguish 'no holdings' from 'this source will not answer for this address' and say which one happened.",
      },
    ],
    costNote: "Free on keyless sources. Portfolio valuation over many wallets multiplies requests quickly - cache per wallet and refresh on demand.",
    skeleton: `const h = await getWalletHoldings(wallet, 100);
// Three states, never two. Listed is not held and not sold.
const held   = h.tokens.filter(t => !t.listed);
const listed = h.tokens.filter(t =>  t.listed);
if (h.capped) renderNotice("Showing the first 100 - this wallet holds more.");
renderNotice("Coverage: collections indexed by Magic Eden only.");`,
    beforeShipping: [
      "Run it against a wallet holding more than the page size and confirm the cap is disclosed.",
      "Run it against a marketplace escrow address and confirm the explanation is human-readable.",
      "Confirm listed items are not double-counted as both held and sold.",
    ],
  },

  "pack-watcher": {
    goal: "pack-watcher",
    buildingWhat: "A feed of cards as they appear from packs, with rarity and serial numbers.",
    dataSources: [
      {
        name: "The public Solana asset index (DAS getAssetsByGroup)",
        use: "Every asset in the pack's collection, paged. New ids since the last page are the new pulls.",
        auth: "None on the Foundation endpoint; a keyed DAS provider is faster and has a higher ceiling.",
        rateLimit:
          "About 100 requests per 10 seconds per IP, shared with plain RPC reads. There is no sort by creation time on the " +
          "public endpoint, so a watcher diffs ids it has already seen rather than asking for the newest.",
      },
      {
        name: "collector-mcp get_asset_provenance",
        use: "The story behind any single pull: mint, pack open, transfers, sales.",
        auth: "None.",
        rateLimit: "Inherits source gates.",
      },
    ],
    pitfalls: [
      {
        trap: "Sizing storage to the number of cards announced so far.",
        why: "Sets grow. A feed capped at 12,000 for a set that reached 25,375 silently evicted 8,409 real pulls from a tracker collectors were spending money on.",
        instead: "Size to the maximum the domain can ever reach, and alert when you approach it. Never evict quietly.",
      },
      {
        trap: "Building the feed purely by accumulating events.",
        why: "Restarts and downtime lose events permanently, and the result looks complete.",
        instead: "Run a reconciliation pass against the issuer's own counts automatically, on startup and on a schedule. Diff against truth; do not trust uptime.",
      },
      {
        trap: "Filtering on the field that names the item rather than the product.",
        why: "Two products sharing one feed will contaminate each other's buckets - gold cards carrying a base-set marker leaked into every base-set count.",
        instead: "Filter on the field identifying the PRODUCT, and check counts against a known total before trusting the split.",
      },
    ],
    costNote: "Free to read. The cost is storage if you retain full history - size it to the full set, not to today's count.",
    skeleton: `const page = await dasGetAssetsByGroup(collection, { page: 1, limit: 1000 });
const fresh = page.items.filter((a) => !seen.has(a.id));  // ids you have never stored ARE the new pulls
// Reconcile on boot: what the issuer says exists vs what we stored.
const missing = await reconcileAgainstIssuer(storedCount);
if (missing > 0) log.warn(\`backfilling \${missing} pulls missed while down\`);`,
    beforeShipping: [
      "Stop the watcher for an hour, restart it, and confirm the gap is backfilled rather than lost.",
      "Confirm the store is sized to the full set and that approaching the limit alerts loudly.",
      "Verify per-product counts against the issuer's published totals.",
    ],
  },
};

export const RECIPE_GOALS = Object.keys(RECIPES);
