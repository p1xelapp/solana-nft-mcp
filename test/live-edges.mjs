/**
 * Live edge cases: the questions that made the server hit a wall in the real
 * world, and their siblings. Reads the real chain and the real venues, so it
 * is gated: COLLECTOR_LIVE_EDGES=1 node test/live-edges.mjs
 *
 * Every case prints one line. PASS means the assertion held; CHECK means the
 * server answered but a person should read the numbers; FAIL means the
 * assertion broke. The run never stops on a failure, so one bad venue minute
 * does not hide the rest. Nothing here signs, buys or lists anything.
 */
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.COLLECTOR_LIVE_EDGES !== "1") {
  console.error("live-edges reads live venues. Set COLLECTOR_LIVE_EDGES=1 to run it.");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
// A throwaway home so this run cannot touch the real key file; OpenSea stays
// off unless the server issues itself a key, which is its normal behaviour.
const home = fs.mkdtempSync(path.join(tmpdir(), "collector-mcp-live-edges-"));
const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, HOME: home, USERPROFILE: home, COLLECTOR_MCP_NO_UPDATE_CHECK: "1" };
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

const ACES = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K"; // Candy Digital Gold Series - Aces (Core collection)
const BATMAN = "EmFy7YohG4GZxgE5DEDgHuuvibqXK2jRLcXcJa3RvDRX"; // Absolute Batman (2024-) #1, Core collection
const CANDY_WALLET = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2"; // held 10 of the 36 packs on 2026-09-17
const ME_ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix";
const MLB_SYMBOL = "2026_mlb_base_series_icons_candy_digital";

const client = new Client({ name: "live-edges", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], env, stderr: "ignore" }));

const results = [];
const bytes = (r) => Buffer.byteLength(JSON.stringify(r));
async function call(name, args, timeout = 240_000) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const body = r.isError ? null : (r.structuredContent ?? JSON.parse(r.content[0].text));
  return { r, body, err: r.isError ? r.content?.[0]?.text ?? "" : "", ms: Date.now() - t, bytes: bytes(r) };
}
async function edge(id, what, fn) {
  try {
    const out = await fn();
    results.push({ id, status: out.status ?? "PASS", note: out.note });
    console.log(`${(out.status ?? "PASS").padEnd(5)} ${id} ${what}: ${out.note}`);
  } catch (e) {
    results.push({ id, status: "FAIL", note: e.message });
    console.log(`FAIL  ${id} ${what}: ${e.message.split("\n")[0].slice(0, 300)}`);
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

let packs = [];
await edge("E01", "the Aces question: who holds the 36 packs", async () => {
  // The Gold Series collection holds several series; the Aces are the 36
  // whose name starts with the series name, and every series' packs share
  // the Pack trait (144 on 2026-09-17).
  const { body, err, ms, bytes } = await call("get_collection_holders", { collection: ACES, namePrefix: "Gold Series - Aces" });
  must(body, `tool error: ${err}`);
  packs = body.assets ?? [];
  must(body.matched === 36, `expected 36 Aces packs, got ${body.matched}`);
  must(body.truncated === false && body.membershipComplete === true, `census not complete: truncated=${body.truncated} complete=${body.membershipComplete}`);
  must(body.distinctHolders >= 8, `too few holders: ${body.distinctHolders}`);
  must(bytes < 100_000, `answer too big: ${bytes}`);
  const top = body.holders[0];
  return { note: `${body.assetsInCollection} assets, 36 packs, ${body.distinctHolders} holders, top ${top.owner.slice(0, 6)} holds ${top.held} (${top.shareOfOwnerKnownPct}%), ${ms} ms, ${bytes} B` };
});

await edge("E02", "every pack in the collection by trait, all series", async () => {
  const { body, err } = await call("get_collection_holders", { collection: ACES, trait: "Item Type", value: "Pack" });
  must(body, `tool error: ${err}`);
  must(body.matched >= 36, `the trait route must cover the Aces at least: ${body.matched}`);
  must(body.filter.undecided === 0, `undecided rows: ${body.filter.undecided}`);
  return { note: `${body.matched} packs across all series, ${body.distinctHolders} holders, undecided ${body.filter.undecided}` };
});

await edge("E03", "the census name nobody can search for", async () => {
  const { body, err } = await call("search_collections", { query: "Gold Series Aces" });
  must(body, `tool error: ${err}`);
  const honest = body.magicEdenDirectory?.directoryComplete === false && /absence/i.test(body.magicEdenDirectory?.directoryNote ?? "");
  must(honest, "a miss must say the directory is incomplete and absence is not evidence");
  return { note: `0 registry hits, ${body.magicEdenDirectory?.matches?.length ?? 0} lookalikes, says absence is not evidence` };
});

await edge("E04", "a collection ADDRESS asked for stats (no venue symbol known)", async () => {
  const { body, err, ms } = await call("get_collection_stats", { collection: ACES });
  must(body, `tool error: ${err}`);
  const text = JSON.stringify(body);
  must(/gold_series_auction_1_candy_digital/.test(text), "the address must resolve to its Magic Eden symbol");
  return { note: `keys ${Object.keys(body).join(",")}; ${ms} ms` };
});

let listedPack = null;
await edge("E05", "provenance of a pack sitting in Magic Eden escrow", async () => {
  listedPack = packs.find((a) => a.owner === ME_ESCROW);
  must(listedPack, "no pack currently in escrow (nothing listed right now); rerun when one is");
  const { body, err, ms } = await call("get_asset_provenance", { mint: listedPack.mint });
  must(body, `tool error: ${err}`);
  const last = [...body.events].reverse().find((e) => e.event === "transferred");
  must(last, "no transfer decoded");
  must(last.escrowDirection === "into", `last transfer should be INTO escrow, got ${last.escrowDirection} (${last.label})`);
  must(body.currentOwner === ME_ESCROW, "current owner is the escrow");
  return { note: `${body.events.length} events, historyComplete=${body.historyComplete}, last transfer into escrow, ${ms} ms` };
});

let candyPack = null;
await edge("E06", "provenance at depth 3 shows the hole in place", async () => {
  candyPack = packs.find((a) => a.owner === CANDY_WALLET) ?? packs[0];
  const { body, err } = await call("get_asset_provenance", { mint: candyPack.mint, depth: 3 });
  must(body, `tool error: ${err}`);
  if (body.totalSignatures <= 3) return { status: "CHECK", note: `only ${body.totalSignatures} signatures, depth 3 covers it all; historyComplete=${body.historyComplete}` };
  const gap = body.events.findIndex((e) => e.event === "unread_gap");
  must(gap > 0 && gap < body.events.length - 1, `gap must sit inside the story, index ${gap} of ${body.events.length}`);
  must(body.events[gap].reason === "depth", "reason is depth");
  must(body.historyComplete === false, "a depth-cut walk is not complete");
  return { note: `${body.totalSignatures} sigs, gap of ${body.events[gap].unreadTransactions} at index ${gap}, events ${body.events.map((e) => e.event[0]).join("")}` };
});

await edge("E07", "full provenance of the same pack, no hole, buyer visible", async () => {
  const { body, err, ms } = await call("get_asset_provenance", { mint: candyPack.mint, depth: 25 });
  must(body, `tool error: ${err}`);
  must(!body.events.some((e) => e.event === "unread_gap"), "no gap at depth 25");
  must(body.mintObserved === true, "mint decoded");
  const owners = body.events.filter((e) => e.event === "transferred").map((e) => e.newOwner?.slice(0, 6));
  return { status: body.historyComplete ? "PASS" : "CHECK", note: `historyComplete=${body.historyComplete}, unreadable=${body.unreadableTransactions}, owners in order ${owners.join(">")}, ${ms} ms` };
});

await edge("E08", "verify_claim never-traded on a pack that moved", async () => {
  const { body, err } = await call("verify_claim", { claim: "never-traded", subject: candyPack.mint });
  must(body, `tool error: ${err}`);
  must(body.verdict !== "unverifiable", `unverifiable: ${body.explanation}`);
  return { note: `${body.verdict}: ${body.explanation.slice(0, 140)}` };
});

await edge("E09", "get_asset_trust on a pack: collection-level delegates inherited", async () => {
  const { body, err } = await call("get_asset_trust", { mint: candyPack.mint });
  must(body, `tool error: ${err}`);
  const text = JSON.stringify(body);
  return { status: /collection/i.test(text) ? "PASS" : "CHECK", note: text.slice(0, 200).replace(/\s+/g, " ") };
});

await edge("E10", "a big collection census hits the cap and says so", async () => {
  const { body, err, ms, bytes } = await call("get_collection_holders", { collection: BATMAN });
  must(body, `tool error: ${err}`);
  must(bytes < 100_000, `answer too big: ${bytes}`);
  if (body.assetsInCollection >= 2000) {
    must(body.truncated === true && body.membershipComplete === false, "a capped read must say so");
    must(body.readThis.some((s) => /INCOMPLETE/.test(s)), "coverage sentence present");
  }
  return { note: `${body.assetsInCollection} assets read, truncated=${body.truncated}, ${body.distinctHolders} holders, ${body.holders.length}+${body.holdersOmitted} holder rows, ${ms} ms, ${bytes} B` };
});

await edge("E11", "holdings of the issuer wallet (large), two readers, bounded", async () => {
  const { body, err, ms, bytes } = await call("get_wallet_holdings", { wallet: CANDY_WALLET });
  must(body, `tool error: ${err}`);
  must(bytes < 120_000, `answer too big: ${bytes}`);
  const text = JSON.stringify(body);
  return { note: `${bytes} B, ${ms} ms, mentions gap/truncated: ${/truncat|omitted|gap/i.test(text)}` };
});

await edge("E12", "activity of the issuer wallet: labels, no negative money", async () => {
  const { body, err, ms } = await call("get_wallet_activity", { wallet: CANDY_WALLET });
  must(body, `tool error: ${err}`);
  const nums = JSON.stringify(body).match(/"(?:netFlowSol|totalSol|priceSol|buySol|sellSol)":(-?[\d.]+)/g) ?? [];
  const negatives = nums.filter((n) => /:-/.test(n) && !/netFlowSol/.test(n));
  must(negatives.length === 0, `negative money fields: ${negatives.slice(0, 3).join(",")}`);
  return { note: `keys ${Object.keys(body).join(",")}; ${ms} ms` };
});

await edge("E13", "get_asset on the escrow ADDRESS (a wallet, not an asset)", async () => {
  const { body, err } = await call("get_asset", { mint: ME_ESCROW });
  if (body) return { status: "CHECK", note: `answered as an asset: ${JSON.stringify(body).slice(0, 160)}` };
  must(/escrow/i.test(err) && !/try again/i.test(err), `must name the escrow, never say try again: ${err.slice(0, 160)}`);
  return { note: `named: ${err.slice(0, 140)}` };
});

await edge("E14", "identify the escrow address", async () => {
  const { body, err } = await call("identify", { query: ME_ESCROW });
  must(body, `tool error: ${err}`);
  must(body.kind === "venue-account", `kind ${body.kind}: ${body.summary?.slice(0, 120)}`);
  return { note: `kind=${body.kind}: ${body.summary?.slice(0, 120)}` };
});

await edge("E15", "a collection that does not exist", async () => {
  const { body, err } = await call("get_collection_stats", { collection: "this_collection_does_not_exist_xyz" });
  if (body) return { status: "CHECK", note: `answered: ${JSON.stringify(body).slice(0, 160)}` };
  must(/does not match|no collection|not found|unknown/i.test(err), `refusal must name the miss: ${err.slice(0, 160)}`);
  return { note: err.slice(0, 140) };
});

await edge("E16", "a physical comic name: the answer names the digital collection", async () => {
  const { body, err } = await call("identify", { query: "Absolute Batman #1" });
  must(body, `tool error: ${err}`);
  const text = JSON.stringify(body);
  return { status: /digital|Solana|Core/i.test(text) ? "PASS" : "CHECK", note: `kind=${body.kind}: ${body.summary?.slice(0, 160)}` };
});

await edge("E17", "a question in another script does not crash", async () => {
  const { body, err } = await call("search_collections", { query: "バットマン" });
  must(body || /no|not/i.test(err), `crash or blank: ${err}`);
  return { note: body ? `${body.magicEdenDirectory?.matches?.length ?? 0} lookalikes, honest miss` : err.slice(0, 120) };
});

await edge("E18", "sales window on a Candy Magic Eden symbol", async () => {
  const { body, err, ms } = await call("get_collection_sales", { symbol: MLB_SYMBOL, days: 30 });
  must(body, `tool error: ${err}`);
  const text = JSON.stringify(body);
  must(!/-\d+(\.\d+)?\s*SOL/.test(text), "negative SOL figure");
  return { note: `keys ${Object.keys(body).join(",")}; coverage truncated=${body.coverage?.truncated}, ${ms} ms` };
});

await edge("E19", "listings with trait floors: no discount without a comparison", async () => {
  const { body, err, ms } = await call("find_listings", { symbol: MLB_SYMBOL, limit: 20 });
  must(body, `tool error: ${err}`);
  const deals = body.deals ?? body.listings ?? [];
  const bad = deals.filter((d) => /unavailable/.test(body.comparison ?? "") && d.underStrongestTraitFloorPct !== null);
  must(bad.length === 0, `${bad.length} deals carry a discount while the comparison is unavailable`);
  return { note: `${deals.length} listings, comparison=${String(body.comparison).slice(0, 40)}, ${ms} ms` };
});

await edge("E20", "six provenance walks at once, none starves", async () => {
  const six = packs.slice(0, 6).map((a) => call("get_asset_provenance", { mint: a.mint }));
  const t = Date.now();
  const rs = await Promise.all(six);
  const failed = rs.filter((x) => !x.body);
  must(failed.length === 0, `${failed.length} of 6 failed: ${failed[0]?.err.slice(0, 120)}`);
  const abandoned = rs.filter((x) => x.body.abandonedTransactions > 0).length;
  return { status: abandoned === 0 ? "PASS" : "CHECK", note: `6 walks in ${Date.now() - t} ms, ${abandoned} ran out of budget, ${rs.map((x) => x.body.events.length).join("/")} events` };
});

await edge("E21", "the same census twice: identical numbers", async () => {
  const a = await call("get_collection_holders", { collection: ACES, trait: "Item Type", value: "Pack" });
  const b = await call("get_collection_holders", { collection: ACES, trait: "Item Type", value: "Pack" });
  must(a.body && b.body, "both answered");
  must(a.body.matched === b.body.matched && a.body.distinctHolders === b.body.distinctHolders, "numbers differ between two reads a second apart");
  return { note: `${a.body.matched}/${a.body.distinctHolders} both times, second read ${b.ms} ms (cached)` };
});

await edge("E22", "provenance asked for a Token Metadata (non-Core) asset names the limit", async () => {
  // Mad Lads is a programmable NFT, not Core: the byte-level walk does not
  // apply and the answer must say so and point at what does, never "try again".
  const { body, err } = await call("get_asset_provenance", { mint: "6CuvTFPkRcB3EQR1orNGsze81eaJ1xuKPHeJX9h9Wn3x" });
  if (body) return { status: "CHECK", note: `answered: historyComplete=${body.historyComplete}, ${body.events?.length} events` };
  must(!/try again/i.test(err) && /Core|standard|Token Metadata|programmable/i.test(err), `must name the standard gap: ${err.slice(0, 200)}`);
  return { note: err.slice(0, 160).replace(/\s+/g, " ") };
});

await edge("E23", "the issuer wallet's outgoing transfers are itemised", async () => {
  const { body, err } = await call("get_wallet_activity", { wallet: CANDY_WALLET, includeOpenSea: true });
  must(body, `tool error: ${err}`);
  const os = body.opensea;
  if (!os || typeof os !== "object" || !("transfersOut" in os)) return { status: "CHECK", note: `OpenSea half absent: ${JSON.stringify(body.openseaNote ?? "").slice(0, 120)}` };
  must(Array.isArray(os.sentWithoutSale), "sentWithoutSale list present");
  must(os.transfersOut === 0 || os.sentWithoutSale.length > 0, `${os.transfersOut} transfers out but nothing itemised`);
  return { note: `${os.transfersOut} out, ${os.sentWithoutSale.length} itemised (cap 25), first to ${os.sentWithoutSale[0]?.to?.slice(0, 6)}` };
});

await edge("E24", "the issuer's wallet is named as the issuer, not a whale", async () => {
  const { body, err } = await call("get_collection_holders", { collection: ACES, namePrefix: "Gold Series - Aces" });
  must(body, `tool error: ${err}`);
  must(body.issuer?.updateAuthority === CANDY_WALLET, `issuer read from the chain: ${JSON.stringify(body.issuer)}`);
  const row = body.holders.find((h) => h.owner === CANDY_WALLET);
  must(row && row.role === "issuer", `the issuer's row carries the role: ${JSON.stringify(row)}`);
  must(body.readThis[0].includes("ISSUER"), "the first sentence says so");
  must(body.heldByIssuer + body.heldInVenueEscrow + body.heldByCollectors === body.nonBurntMatched, "the three custody buckets add up");
  const id = await call("identify", { query: CANDY_WALLET });
  must(id.body?.kind === "issuer-key", `identify names the key: ${id.body?.kind}`);
  return { note: `issuer ${body.issuer.name ?? "unnamed"} holds ${body.heldByIssuer}, escrow ${body.heldInVenueEscrow}, collectors ${body.heldByCollectors}; identify=${id.body.kind}` };
});

// ---------------------------------------------------------------- beyond Candy
// The questions people type about the collections they already own.
const pick = async (query) => {
  const { body } = await call("search_collections", { query });
  // A curated registry hit outranks the venue directory, which stops short
  // of its catalogue and once answered a 0.055 SOL derivative for SMB.
  const hit = (body?.results ?? []).find((r) => r.meSymbol);
  if (hit) return hit.meSymbol;
  const m = body?.magicEdenDirectory?.matches ?? [];
  return (m.find((x) => x.badged) ?? m[0])?.symbol ?? null;
};
const bad = (err) => /try again/i.test(err);

let madMint = null;
let madSeller = null;
await edge("N01", "Mad Lads: search, stats, listings, one asset", async () => {
  const sym = await pick("Mad Lads");
  must(sym === "mad_lads", `badged symbol resolves: ${sym}`);
  const stats = await call("get_collection_stats", { collection: sym });
  must(stats.body?.market?.floorPriceSol > 0, `floor read: ${stats.err}`);
  const listings = await call("find_listings", { symbol: sym, limit: 3 });
  must(listings.body?.deals?.length > 0, `listings read: ${listings.err}`);
  madMint = listings.body.deals[0].tokenMint;
  madSeller = listings.body.deals[0].seller;
  const asset = await call("get_asset", { mint: madMint });
  must(asset.body, `get_asset on a listed pNFT: ${asset.err}`);
  return { note: `floor ${stats.body.market.floorPriceSol} SOL, ${listings.body.deals.length} listings, asset owner=${asset.body.market?.owner?.slice(0, 6) ?? "?"}, listed=${asset.body.market?.listed}` };
});

await edge("N02", "Mad Lads: freeze, fees, custody on a non-Core asset are named as a gap", async () => {
  const t = await call("get_asset_trust", { mint: madMint });
  if (t.body) return { status: "CHECK", note: `answered: ${JSON.stringify(t.body).slice(0, 140)}` };
  must(!bad(t.err) && /Core|standard|Token Metadata|programmable/i.test(t.err), `names the standard: ${t.err.slice(0, 160)}`);
  const v = await call("verify_claim", { claim: "never-traded", subject: madMint });
  must(v.body ? v.body.verdict === "unverifiable" : !bad(v.err), `a claim on a non-Core asset is unverifiable by name: ${v.body?.verdict ?? v.err.slice(0, 120)}`);
  return { note: `trust: ${t.err.slice(0, 90)}; claim: ${v.body?.verdict ?? "error named"}` };
});

await edge("N03", "Mad Lads: the seller's wallet profile and activity, bounded, no role invented", async () => {
  const prof = await call("get_wallet_profile", { wallet: madSeller });
  must(prof.body, `profile: ${prof.err}`);
  must(prof.bytes < 120_000, `profile size ${prof.bytes}`);
  must(prof.body.walletRole === undefined, `a collector has no role: ${prof.body.walletRole}`);
  const act = await call("get_wallet_activity", { wallet: madSeller });
  must(act.body, `activity: ${act.err}`);
  return { note: `profile ${prof.bytes} B, activity label=${act.body.magiceden?.behaviour?.label}` };
});

await edge("N04", "Mad Lads: sales window, recent sales, top traders", async () => {
  const s7 = await call("get_collection_sales", { symbol: "mad_lads", days: 7 });
  must(s7.body, `sales: ${s7.err}`);
  const recent = await call("get_recent_sales", { collection: "mad_lads", limit: 5 });
  must(recent.body, `recent: ${recent.err}`);
  const top = await call("get_top_traders", { symbol: "mad_lads", limit: 5 });
  must(top.body, `traders: ${top.err}`);
  return { note: `7d sales=${s7.body.sales ?? "?"} vol=${s7.body.volumeSol ?? "?"} SOL, recent rows=${(recent.body.sales ?? recent.body.rows ?? []).length}, traders=${JSON.stringify(top.body).length} B` };
});

await edge("N05", "a Token Metadata collection asked for a Core census is refused by name", async () => {
  const asset = await call("get_asset", { mint: madMint });
  const col = asset.body?.chainIndex?.collection ?? null;
  if (!col) return { status: "CHECK", note: "no collection address surfaced for a pNFT; nothing to census" };
  const r = await call("get_collection_holders", { collection: col });
  if (r.body) return { status: "CHECK", note: `census answered for a non-Core group: ${r.body.assetsInCollection} rows, standards ${[...new Set(r.body.assets.map((a) => a.standard))].join(",")}` };
  must(!bad(r.err), `refusal names the standard, never try again: ${r.err.slice(0, 160)}`);
  return { note: r.err.slice(0, 140) };
});

await edge("N06", "SMB and Claynosaurz resolve and answer floors", async () => {
  const out = [];
  for (const q of ["Solana Monkey Business", "Claynosaurz"]) {
    const sym = await pick(q);
    must(sym, `${q} resolves`);
    const f = await call("get_floor_prices", { symbols: [sym] });
    must(f.body?.floors?.[0]?.symbolKnown, `${sym} known on the venue`);
    out.push(`${sym}=${f.body.floors[0].floorSol}`);
  }
  must(out[0].startsWith("solana_monkey_business="), `SMB must resolve to the real collection, not a lookalike: ${out[0]}`);
  return { note: out.join(", ") };
});

await edge("N07", "names people type: Pikachu, Shohei, Batman", async () => {
  const out = [];
  for (const q of ["Pikachu", "Shohei Ohtani", "Batman"]) {
    const id = await call("identify", { query: q });
    must(id.body || !bad(id.err), `${q}: ${id.err.slice(0, 100)}`);
    out.push(`${q}=${id.body?.kind ?? "error"}`);
  }
  return { note: out.join(", ") };
});

await edge("N08", "explain_mechanics answers freeze, royalties, escrow and the Candy issuer", async () => {
  const out = [];
  for (const topic of ["freeze", "royalties", "escrow", "candy wallet", "pack opened"]) {
    const m = await call("explain_mechanics", { topic });
    must(m.body && (m.body.entries?.length ?? 0) > 0, `${topic}: ${m.err || "no entries"}`);
    out.push(`${topic}=${m.body.entries.length}`);
  }
  return { note: out.join(", ") };
});

await edge("N09", "a dormant-looking wallet: the first Aces recipient who never traded", async () => {
  const { body } = await call("get_collection_holders", { collection: ACES, namePrefix: "Gold Series - Aces" });
  const one = body.holders.find((h) => h.role === "wallet" && h.held === 1);
  must(one, "a single-pack collector exists");
  const act = await call("get_wallet_activity", { wallet: one.owner });
  must(act.body, `activity: ${act.err}`);
  const label = act.body.magiceden?.behaviour?.label;
  must(label && label !== "unknown" || /no completed/i.test(act.body.magiceden?.behaviour?.why ?? ""), `quiet wallets get a reason, not 'unknown': ${label} / ${act.body.magiceden?.behaviour?.why}`);
  return { note: `${one.owner.slice(0, 6)} label=${label}: ${(act.body.magiceden?.behaviour?.why ?? "").slice(0, 90)}` };
});

await client.close();
fs.rmSync(home, { recursive: true, force: true });
const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
console.log(`\nlive-edges: ${JSON.stringify(counts)}`);
fs.writeFileSync(path.join(root, "live-edges-report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exitCode = counts.FAIL ? 1 : 0;
