/**
 * Chain reads that break when Solana or an issuer changes something
 * underneath: a new transaction format, a collection that only NAMES an
 * issuer's key, a drop newer than the bundled registry, and a marketplace's
 * copy of an item's name and picture.
 *
 * Every upstream reply here is one read from the real services on 2026-11-14
 * and saved under test/fixtures/. Where a case needs a reply the services did
 * not give that day (a node naming version 2, a collection with no items), it
 * is built from a saved one by changing the one field the case is about, and
 * says so. Nothing here touches the network.
 *
 * Run: npm run build && node test/chain-format-and-issuers.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));
const TX = fixture("transaction-versions-2026-11-14.json");
const GPA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "fixtures", "collections-by-authority-2026-11-14.json.gz"))).toString("utf8"));

const ASSET = "AUjRXCikevZrK7JPEvgPE3HquYyYc2WF51pmS2ZuiQF9";
const V1_SALE = "5wrdbZQqjeqDGM1UuPe9eXJYPc1ZyM5d4ho55pqaVoq7qHmUou2j1wnyryA8qZcX8wn5ueV3TJNUbRn5PKVT63nZ";
const BUYER = "h4FoDwkztwipWbqdNV4jEa7FJkL32fz5hjE9w5q67zv";
const CANDY_AUTHORITY = "7wixESeixiY4f2A6JaDKNewNoiip9Tk9s5u1dze7nRwL";
const REGISTERED_WITH_ITEMS = "pUqAP37Cvdh8YEr8YssSC84hngnBWcPEaBNdqsvh4mA";
const REGISTERED_EMPTY = "FWuxBWTpxWmjG3LynZqNS7gxw7qEHGnymPrbHcsxQDoj";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name} - ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ------------------------------------------------------------ transport
// The person's own endpoint goes first, so every chain read lands here. A
// method the case did not script is a test failure, never a network call.
process.env.SOLANA_RPC_URL = "https://chain-format.invalid";
process.env.DAS_RPC_URL = "https://chain-format.invalid";
const requests = [];
let script = () => null;
const envelope = (id, body) => new Response(JSON.stringify({ ...body, id }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  if (new URL(String(url)).hostname !== "chain-format.invalid") throw new Error(`network denied by the test: ${String(url).slice(0, 80)}`);
  const body = JSON.parse(String(init.body));
  requests.push(body);
  const answer = script(body);
  if (!answer) throw new Error(`unscripted ${body.method}`);
  return envelope(body.id, answer);
};
/** The version each getTransaction request asked for, in order. */
const askedVersions = () => requests.filter((r) => r.method === "getTransaction").map((r) => r.params[1].maxSupportedTransactionVersion);
const formatOf = (sig) => {
  const v = TX.getTransaction[sig]?.result?.version;
  return v === "legacy" ? -1 : v;
};
/**
 * The saved refusal, as the node words it, for a transaction in format `n`.
 * Only the digits change: the text is the one read on 2026-11-14 for the
 * version-1 sale.
 */
const refusal = (n) => {
  const real = TX.refusedWithVersion0[V1_SALE];
  return { ...real, error: { ...real.error, message: real.error.message.replace("(1)", `(${n})`).replace(": 1", `: ${n}`) } };
};
/** The asset's real history: each transaction served only to a request that allows its format. */
const realHistory = (body) => {
  if (body.method === "getAccountInfo") return TX.getAccountInfo[body.params[0]] ?? { jsonrpc: "2.0", result: { context: { slot: 1 }, value: null } };
  if (body.method === "getSignaturesForAddress") return TX.getSignaturesForAddress[body.params[0]];
  if (body.method === "getMultipleAccounts") return TX.getMultipleAccounts.reply;
  if (body.method === "getTransaction") {
    const sig = body.params[0];
    return formatOf(sig) > body.params[1].maxSupportedTransactionVersion ? refusal(formatOf(sig)) : TX.getTransaction[sig];
  }
  return null;
};

const sol = await import("../dist/sources/solana.js");
const issuers = await import("../dist/issuers.js");
const das = await import("../dist/sources/das.js");

// ======================================================= transaction formats

// First, while nothing is cached: a transaction read once is kept for an hour.
await check("a transaction this server cannot read fails the history instead of becoming an unread row", async () => {
  requests.length = 0;
  script = (body) => (body.method === "getTransaction" && body.params[0] === V1_SALE ? refusal(99) : realHistory(body));
  const r = await sol.getProvenance(ASSET, 15, { fresh: true }).then((v) => v, (e) => e);
  assert.ok(r instanceof Error, `the walk must not answer: ${JSON.stringify(r?.events?.map((e) => e.event))}`);
  assert.strictEqual(r.kind, "unsupported");
  assert.match(r.wording.headline, /out of date, not a gap in the chain/);
});

await check("an item whose last sale is a version-1 transaction has a readable history, not a failed tool", async () => {
  requests.length = 0;
  script = realHistory;
  const r = await sol.getProvenance(ASSET, 15, { fresh: true });
  const sale = r.events.find((e) => e.signature === V1_SALE);
  assert.ok(sale, "the version-1 sale is a row");
  assert.strictEqual(sale.event, "transferred");
  assert.strictEqual(sale.newOwner, BUYER, "the buyer is decoded from the version-1 message");
  assert.strictEqual(sale.marketplace, "OpenSea");
  assert.strictEqual(r.currentOwner, BUYER);
  assert.strictEqual(r.unreadableTransactions, 0);
  assert.ok(!r.events.some((e) => e.event === "unread_gap"), "no hole anywhere");
  assert.strictEqual(r.historyComplete, true);
  // Control: the version-0 and legacy transactions in the same history decode as before.
  assert.ok(r.events.some((e) => e.event === "minted" && e.signature.startsWith("4CkuRhTC")), "the version-0 mint is still read");
  assert.ok(r.events.some((e) => e.event === "transferred" && e.signature.startsWith("2mDLKBPD") && e.newOwner === "B1ZK9MwuGWM6rsfwheci9pyrmbNh7H7gLAcUpFegr8qG"), "the version-0 migration transfer is still read");
  assert.ok(askedVersions().every((v) => v === 1), `every read asked for version 1: ${askedVersions()}`);
});

await check("a collection whose recent transaction is version 1 still yields its members", async () => {
  requests.length = 0;
  script = (body) =>
    body.method === "getSignaturesForAddress" && body.params[0] === REGISTERED_WITH_ITEMS
      ? { jsonrpc: "2.0", result: [{ signature: V1_SALE, err: null, blockTime: 1794441995 }] }
      : realHistory(body);
  const r = await sol.findRecentCollectionAssets(REGISTERED_WITH_ITEMS, 3);
  assert.deepStrictEqual(r.assets, [ASSET]);
});

await check("a node naming a newer format is asked again once, and the newer format is kept", async () => {
  requests.length = 0;
  // The node now serves this sale only to a request that allows version 2.
  script = (body) => (body.method === "getTransaction" ? (body.params[1].maxSupportedTransactionVersion >= 2 ? TX.getTransaction[V1_SALE] : refusal(2)) : null);
  const tx = await sol.getParsedTransaction(V1_SALE);
  assert.strictEqual(tx.version, 1);
  assert.deepStrictEqual(askedVersions(), [1, 2], "one refusal, one retry");
  assert.strictEqual(sol.transactionVersionRequested(), 2, "remembered for the process");
  requests.length = 0;
  await sol.getParsedTransaction(V1_SALE);
  assert.deepStrictEqual(askedVersions(), [2], "the next read starts at the newer version");
});

await check("the version is taken from a refusal by the person's own endpoint, whose text is never relayed", async () => {
  requests.length = 0;
  script = (body) => {
    if (body.method !== "getTransaction") return null;
    if (body.params[1].maxSupportedTransactionVersion >= 3) return TX.getTransaction[V1_SALE];
    const r = refusal(3);
    return { ...r, error: { ...r.error, message: `${r.error.message} (served for FAKEKEYCANARY0000)` } };
  };
  const tx = await sol.getParsedTransaction(V1_SALE);
  assert.strictEqual(tx.version, 1);
  assert.deepStrictEqual(askedVersions(), [2, 3]);
});

await check("a refusal is retried at most once, and never above the ceiling", async () => {
  // Always one version ahead: one retry, then a typed failure.
  requests.length = 0;
  script = (body) => (body.method === "getTransaction" ? refusal(body.params[1].maxSupportedTransactionVersion + 1) : null);
  const ahead = await sol.getParsedTransaction(V1_SALE).then(() => null, (e) => e);
  assert.ok(ahead, "it fails");
  assert.strictEqual(ahead.kind, "unsupported");
  assert.match(ahead.message, /format version 5/);
  assert.ok(!/FAKEKEYCANARY/.test(ahead.message));
  assert.deepStrictEqual(askedVersions(), [3, 4], "exactly one retry");
  // A version far past anything real is not asked for.
  requests.length = 0;
  const before = sol.transactionVersionRequested();
  script = (body) => (body.method === "getTransaction" ? refusal(99) : null);
  const far = await sol.getParsedTransaction(V1_SALE).then(() => null, (e) => e);
  assert.strictEqual(far?.kind, "unsupported");
  assert.deepStrictEqual(askedVersions(), [before], "no retry above the ceiling");
  assert.strictEqual(sol.transactionVersionRequested(), before);
  // A refusal that names no version is not guessed at. The saved wording with the numbers taken out.
  requests.length = 0;
  const real = TX.refusedWithVersion0[V1_SALE];
  const bare = { ...real, error: { ...real.error, message: real.error.message.replace(" (1)", "").replace(/ Please try.*$/, "") } };
  script = (body) => (body.method === "getTransaction" ? bare : null);
  const unnamed = await sol.getParsedTransaction(V1_SALE).then(() => null, (e) => e);
  assert.strictEqual(unnamed?.kind, "unsupported");
  assert.deepStrictEqual(askedVersions(), [before]);
});

const sigOf = (label) => sol.base58Encode(createHash("sha512").update(label).digest());

await check("a sale through Tensor's marketplace program is labelled Tensor, not as a compressed-item program", async () => {
  // The saved version-1 sale with its outer program swapped for Tensor's TComp.
  const TENSOR_SIG = sigOf("tensor-label");
  const saved = TX.getTransaction[V1_SALE];
  const ix = saved.result.transaction.message.instructions.map((i) => ({ ...i, programId: "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp" }));
  const tensorTx = { ...saved, result: { ...saved.result, transaction: { ...saved.result.transaction, message: { ...saved.result.transaction.message, instructions: ix } } } };
  const sigRow = TX.getSignaturesForAddress[ASSET].result[0];
  script = (body) => {
    if (body.method === "getSignaturesForAddress") return { jsonrpc: "2.0", result: [{ ...sigRow, signature: TENSOR_SIG }] };
    if (body.method === "getTransaction" && body.params[0] === TENSOR_SIG) return tensorTx;
    return realHistory(body);
  };
  const r = await sol.getProvenance(ASSET, 15, { fresh: true });
  const row = r.events.find((e) => e.signature === TENSOR_SIG);
  assert.strictEqual(row?.marketplace, "Tensor");
});

/** A first page of exactly 1,000: the asset's six real signatures and 994 failed ones in the saved row shape. */
const fullFirstPage = () => {
  const real = TX.getSignaturesForAddress[ASSET].result;
  const filler = Array.from({ length: 1000 - real.length }, (_, i) => ({ ...real[real.length - 1], signature: sigOf(`filler-${i}`), err: { InstructionError: [0, { Custom: 1 }] } }));
  return { jsonrpc: "2.0", result: [...real, ...filler] };
};
const UNKNOWN_CURSOR = fixture("unknown-cursor-2026-11-14.json").reply;

await check("a history page whose cursor no endpoint knows keeps the pages read and shows the gap first", async () => {
  requests.length = 0;
  script = (body) => {
    if (body.method === "getSignaturesForAddress") return body.params[1].before ? UNKNOWN_CURSOR : fullFirstPage();
    return realHistory(body);
  };
  const r = await sol.getProvenance(ASSET, 15, { fresh: false });
  assert.strictEqual(r.historyComplete, false);
  assert.strictEqual(r.events[0].event, "unread_gap", "the unlisted stretch is the first row");
  assert.match(r.events[0].label, /-32020/);
  assert.match(r.historyNote, /no endpoint knew where the next page began/);
  assert.ok(r.events.some((e) => e.signature === V1_SALE && e.newOwner === BUYER), "the pages that were read are still decoded");
  assert.ok(requests.filter((q) => q.method === "getSignaturesForAddress" && q.params[1].before).length >= 2, "the endpoint that served the first page was asked again before moving on");
  // Not kept: the next read walks again rather than reusing a cut-short list.
  requests.length = 0;
  await sol.getProvenance(ASSET, 15, { fresh: false });
  assert.ok(requests.some((q) => q.method === "getSignaturesForAddress" && !q.params[1].before), "walked again");
});

await check("a wallet's age read past an unknown cursor is a lower bound that says why", async () => {
  script = (body) => (body.method === "getSignaturesForAddress" ? (body.params[1].before ? UNKNOWN_CURSOR : fullFirstPage()) : null);
  const age = await sol.walletAge(BUYER, 3);
  assert.strictEqual(age.transactions, 1000);
  assert.strictEqual(age.transactionsExact, false);
  assert.strictEqual(age.firstSeenIsBound, true);
  assert.match(age.note, /no endpoint knew the signature the next page had to continue from/);
});

// ============================================================ asset index shapes

await check("the asset index's newer interfaces and an inherited royalty are read, not reported as unknown or 655%", async () => {
  const CARD = fixture("asset-record-2026-11-14.json");
  const CANARY = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K";
  const saved = CARD.getAsset.result;
  const LEAF = sol.base58Encode(createHash("sha256").update("bubblegum-v2-leaf").digest());
  const RESOLVED = sol.base58Encode(createHash("sha256").update("bubblegum-v2-resolved").digest());
  const GROUP_ID = sol.base58Encode(createHash("sha256").update("core-group").digest());
  // Built from the saved record: only the fields each case is about change.
  const records = new Map([
    [GROUP_ID, { ...saved, id: GROUP_ID, interface: "MplCoreGroup", grouping: [{ group_key: "group", group_value: null }] }],
    [LEAF, { ...saved, id: LEAF, interface: "MplBubblegumV2", compression: { ...saved.compression, compressed: true }, grouping: [{ group_key: "collection", group_value: saved.grouping[0].group_value }], royalty: { ...saved.royalty, basis_points: 65535, basis_points_raw: 65535, inherited: true } }],
    [RESOLVED, { ...saved, id: RESOLVED, interface: "MplBubblegumV2", compression: { ...saved.compression, compressed: true }, royalty: { ...saved.royalty, basis_points: 500, basis_points_raw: 65535, inherited: true } }],
  ]);
  script = (body) => {
    if (body.method !== "getAsset") return null;
    if (body.params.id === CANARY) return { jsonrpc: "2.0", result: { ...saved, id: CANARY, interface: "MplCoreCollection" } };
    return { jsonrpc: "2.0", result: records.get(body.params.id) };
  };
  const group = (await das.getAsset(GROUP_ID)).asset;
  assert.strictEqual(group.interface, "MplCoreGroup");
  assert.strictEqual(group.collection, null, "membership in a group is not a collection");
  const leaf = (await das.getAsset(LEAF)).asset;
  assert.strictEqual(leaf.interface, "MplBubblegumV2");
  assert.strictEqual(leaf.standard, "compressed");
  assert.strictEqual(leaf.royaltyPct, null, "the inherit sentinel is not a royalty");
  assert.match(leaf.royaltyNote, /inherits its royalty from its collection/);
  assert.strictEqual(leaf.collection, saved.grouping[0].group_value);
  const resolved = (await das.getAsset(RESOLVED)).asset;
  assert.strictEqual(resolved.royaltyPct, 5);
  assert.match(resolved.royaltyNote, /inherits/);
});

// ============================================================ issuer verdicts

await check("a collection is an issuer's only with items and a place in the table", () => {
  const issued = issuers.collectionIssuer(REGISTERED_WITH_ITEMS, CANDY_AUTHORITY, 630);
  assert.strictEqual(issued.verdict, "issued");
  assert.strictEqual(issued.issuer, "Candy Digital");
  const SYNTHETIC = "Syn7hetic1111111111111111111111111111111111";
  const empty = issuers.collectionIssuer(SYNTHETIC, CANDY_AUTHORITY, 0);
  assert.strictEqual(empty.verdict, "no-items");
  assert.strictEqual(empty.issuer, null, "an empty collection naming the key is never called Candy's");
  assert.strictEqual(empty.keyKnownAs, "Candy Digital");
  assert.strictEqual(empty.label, "no items yet");
  assert.match(empty.note, /unverified/);
  // Even a registered collection is not called issued while it is empty.
  assert.strictEqual(issuers.collectionIssuer(REGISTERED_EMPTY, CANDY_AUTHORITY, 0).issuer, null);
  const unlisted = issuers.collectionIssuer(SYNTHETIC, CANDY_AUTHORITY, 12);
  assert.strictEqual(unlisted.verdict, "not-in-registry");
  assert.strictEqual(unlisted.issuer, null, "items minted under another key can be handed to Candy's key afterwards");
  assert.match(unlisted.note, /without that key signing/);
  const stranger = issuers.collectionIssuer(SYNTHETIC, "Stranger11111111111111111111111111111111111", 5);
  assert.strictEqual(stranger.verdict, "unknown-key");
  assert.strictEqual(stranger.issuer, null);
});

// ======================================================= collections by key

await check("the saved list of collections under Candy's key is the code's own query, and decodes", () => {
  assert.deepStrictEqual(GPA.params, sol.discoveryParams(CANDY_AUTHORITY), "the saved reply answers exactly the query the code sends");
  const d = sol.decodeCollectionsByAuthority(CANDY_AUTHORITY, GPA.reply.result);
  assert.strictEqual(d.state, "ok");
  assert.strictEqual(d.unreadable, 0);
  assert.strictEqual(d.collections.length, 401);
  assert.strictEqual(d.collections.filter((c) => c.numMinted > 0).length, 391);
  const halloween = d.collections.find((c) => c.address === REGISTERED_WITH_ITEMS);
  assert.strictEqual(halloween.name, "Batman: The Long Halloween");
  assert.strictEqual(halloween.numMinted, 630, "the same counter the account read gives");
});

await check("the release check: the registry and the chain's list under the key agree", () => {
  const d = sol.decodeCollectionsByAuthority(CANDY_AUTHORITY, GPA.reply.result);
  const registered = issuers.tableCollectionsOf(CANDY_AUTHORITY);
  const { problems, noItemsYet } = issuers.discoveryDisagreements(CANDY_AUTHORITY, d.collections, registered);
  assert.deepStrictEqual(problems, [], problems.slice(0, 3).join("\n"));
  assert.strictEqual(noItemsYet.length, 10, "ten collections have no items yet");
  assert.ok(noItemsYet.some((s) => s.startsWith(REGISTERED_EMPTY)));
  // Control: a registry collection gone from the chain's list, and a new one with items.
  const missing = issuers.discoveryDisagreements(CANDY_AUTHORITY, d.collections.slice(1), registered).problems;
  assert.ok(missing.some((p) => p.startsWith(d.collections[0].address) && /chain lists no collection/.test(p)));
  const newDrop = { address: "NewDrop111111111111111111111111111111111111", name: "Superman Unlimited (2025-) #6", numMinted: 12 };
  const added = issuers.discoveryDisagreements(CANDY_AUTHORITY, [...d.collections, newDrop], registered).problems;
  assert.deepStrictEqual(added.length, 1);
  assert.match(added[0], /12 item\(s\).*not in the registry/);
  const upcoming = issuers.discoveryDisagreements(CANDY_AUTHORITY, [...d.collections, { ...newDrop, numMinted: 0 }], registered);
  assert.deepStrictEqual(upcoming.problems, [], "an empty collection is not a problem");
  assert.strictEqual(upcoming.noItemsYet.length, 11);
});

await check("an implausible list, or an account the filter should not have let through, is not taken", () => {
  const rows = GPA.reply.result;
  const flood = Array.from({ length: sol.DISCOVERY_MAX_ACCOUNTS + 1 }, (_, i) => rows[i % rows.length]);
  const refused = sol.decodeCollectionsByAuthority(CANDY_AUTHORITY, flood);
  assert.strictEqual(refused.state, "refused");
  assert.deepStrictEqual(refused.collections, []);
  // An endpoint that ignored the filter: the same bytes under another key, and an asset's key byte.
  const other = sol.decodeCollectionsByAuthority("Stranger11111111111111111111111111111111111", rows.slice(0, 3));
  assert.strictEqual(other.collections.length, 0);
  assert.strictEqual(other.unreadable, 3);
  const bytes = Buffer.from(rows[0].account.data[0], "base64");
  bytes[0] = 1;
  const asAsset = { ...rows[0], account: { ...rows[0].account, data: [bytes.toString("base64"), "base64"] } };
  assert.strictEqual(sol.decodeCollectionsByAuthority(CANDY_AUTHORITY, [asAsset]).unreadable, 1);
  // A row cut short before its counters is unreadable, not a zero.
  const cut = { ...rows[0], account: { ...rows[0].account, data: [Buffer.from(rows[0].account.data[0], "base64").subarray(0, 60).toString("base64"), "base64"] } };
  const short = sol.decodeCollectionsByAuthority(CANDY_AUTHORITY, [cut]);
  assert.strictEqual(short.unreadable, 1);
  assert.strictEqual(short.collections.length, 0);
});

await check("the list is read once and kept, and a failure is not asked again per question", async () => {
  const keyOf = (label) => {
    const bytes = createHash("sha256").update(label).digest();
    return { bytes, address: sol.base58Encode(bytes) };
  };
  const A = keyOf("discovery-cache-a");
  requests.length = 0;
  // Five saved rows, re-keyed to this test's authority so the decoder's own check accepts them.
  const rekeyed = GPA.reply.result.slice(0, 5).map((r) => {
    const b = Buffer.from(r.account.data[0], "base64");
    A.bytes.copy(b, 1);
    return { ...r, account: { ...r.account, data: [b.toString("base64"), "base64"] } };
  });
  script = (body) => (body.method === "getProgramAccounts" ? { jsonrpc: "2.0", result: rekeyed } : null);
  const first = await sol.collectionsByAuthority(A.address);
  const second = await sol.collectionsByAuthority(A.address);
  assert.strictEqual(first.state, "ok", first.note);
  assert.strictEqual(first.collections.length, 5);
  assert.deepStrictEqual(second.collections, first.collections);
  assert.strictEqual(requests.filter((r) => r.method === "getProgramAccounts").length, 1, "one request for both");
  // A refusal by the node is remembered for half an hour.
  const KEY_B = keyOf("discovery-cache-b").address;
  requests.length = 0;
  script = (body) => (body.method === "getProgramAccounts" ? { jsonrpc: "2.0", error: { code: -32010, message: "this endpoint does not serve that query" } } : null);
  const failedOnce = await sol.collectionsByAuthority(KEY_B);
  const failedAgain = await sol.collectionsByAuthority(KEY_B);
  assert.strictEqual(failedOnce.state, "failed");
  assert.deepStrictEqual(failedOnce.collections, []);
  assert.strictEqual(failedAgain.state, "failed");
  assert.match(failedAgain.note, /not asked for again within half an hour/);
  assert.strictEqual(requests.filter((r) => r.method === "getProgramAccounts").length, 1);
});

// ============================================================ names and art

await check("an arweave picture is the same picture through any gateway or proxy, and a sibling's is not", () => {
  const id = "tW7nHi6yJG4gm2G0usZgFPTY9jhZx2YwEnt92dAxMP4";
  const other = "vqqDDkq8BZytlHI477uLzY4QfhFXOval-rxhkcsN1Gg";
  assert.strictEqual(das.arweaveId(`https://arweave.net/${id}`), id);
  assert.strictEqual(das.arweaveId(`https://img-cdn.magiceden.dev/rs:fill:400:0:0/plain/${encodeURIComponent(`https://arweave.net/${id}`)}`), id);
  assert.ok(das.sameImage(`https://arweave.net/${id}`, `https://ar-io.net/${id}?ext=png`));
  assert.ok(das.sameImage(`https://permaweb.candy.io/${id}`, `https://arweave.net/${id}`));
  assert.ok(!das.sameImage(`https://arweave.net/${id}`, `https://arweave.net/${other}`), "two parallels are two pictures");
  assert.ok(!das.sameImage(`https://arweave.net/${id}`, "https://example.com/picture.png"));
  assert.ok(!das.sameImage(null, `https://arweave.net/${id}`));
  assert.strictEqual(das.arweaveId("https://example.com/" + id), null, "a 43-character path on another host is not an arweave id");
});

// ============================================================ over stdio
// get_collection_holders, search_collections, identify and get_asset, run
// against the saved replies through the real server.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chain-format-"));
  const log = path.join(home, "requests.log");
  fs.writeFileSync(log, "");
  const preload = pathToFileURL(path.join(here, "helpers", "chain-format-preload.mjs")).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist", "index.js")],
    env: {
      ...getDefaultEnvironment(),
      HOME: home,
      USERPROFILE: home,
      SOLANA_NFT_MCP_TEST_HOME: home,
      SOLANA_NFT_MCP_TEST_LOG: log,
      SOLANA_RPC_URL: "https://chain-format.invalid",
      DAS_RPC_URL: "https://chain-format-index.invalid",
      SOLANA_NFT_MCP_NO_AUTO_KEYS: "1",
      SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "chain-format", version: "0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return res.structuredContent ?? JSON.parse(text);
  };
  const { EMPTY_NAMING_CANDY, NEW_DROP, NEW_EMPTY, RENAMED_MINT, SAME_MINT, ASSET_NAMING_CANDY, DC_COMIC } = await import(preload);
  const methods = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  try {
    await check("get_collection_holders does not call an empty collection naming Candy's key Candy's", async () => {
      const empty = await call("get_collection_holders", { collection: EMPTY_NAMING_CANDY });
      assert.strictEqual(empty.issuer.updateAuthority, CANDY_AUTHORITY);
      assert.strictEqual(empty.issuer.name, null, `named: ${JSON.stringify(empty.issuer)}`);
      assert.strictEqual(empty.issuer.verdict, "no-items");
      assert.strictEqual(empty.issuer.keyKnownAs, "Candy Digital");
      assert.strictEqual(empty.issuer.label, "no items yet");
      assert.match(empty.readThis[0], /no items yet/);
      // Control: a registered collection with items is Candy's.
      const real = await call("get_collection_holders", { collection: REGISTERED_WITH_ITEMS });
      assert.strictEqual(real.issuer.name, "Candy Digital");
      assert.strictEqual(real.issuer.verdict, "issued");
    });

    await check("an item outside any collection that names Candy's key as its authority is not called Candy's anywhere", async () => {
      const trust = await call("get_asset_trust", { mint: ASSET_NAMING_CANDY });
      assert.strictEqual(trust.collection, null);
      assert.ok(!/Candy Digital/.test(JSON.stringify(trust)), "the asset's own authority is not an issuer verdict");
      const id = await call("identify", { query: ASSET_NAMING_CANDY });
      assert.strictEqual(id.kind, "core-asset");
      assert.strictEqual(id.issuer, undefined);
      assert.ok(!/Candy Digital/.test(JSON.stringify(id)));
    });

    await check("search_collections finds a drop newer than the registry on chain, labelled, with its verdict", async () => {
      fs.writeFileSync(log, "");
      const r = await call("search_collections", { query: "Superman Unlimited (2025-) #6" });
      const hit = r.foundOnChain?.matches?.find((m) => m.address === NEW_DROP);
      assert.ok(hit, `found: ${JSON.stringify(r.foundOnChain)}`);
      assert.strictEqual(hit.foundOn, "the chain (not in the bundled registry)");
      assert.strictEqual(hit.issuer.verdict, "not-in-registry");
      assert.strictEqual(hit.issuer.issuer, null);
      const up = await call("search_collections", { query: "Absolute Batman (2024) #99" });
      const empty = up.foundOnChain?.matches?.find((m) => m.address === NEW_EMPTY);
      assert.ok(empty, `found: ${JSON.stringify(up.foundOnChain)}`);
      assert.strictEqual(empty.issuer.label, "no items yet");
      assert.strictEqual(methods().filter((m) => m === "getProgramAccounts").length, 1, "one chain list for both searches");
      // Control: a name the registry holds exactly does not read the chain's list at all.
      fs.writeFileSync(log, "");
      const known = await call("search_collections", { query: "Batman: The Long Halloween" });
      assert.ok(known.results.some((e) => e.coreCollection === REGISTERED_WITH_ITEMS));
      assert.strictEqual(known.foundOnChain, undefined);
      assert.ok(!methods().includes("getProgramAccounts"));
    });

    await check("identify names a drop newer than the registry from the chain, with its verdict", async () => {
      const r = await call("identify", { query: "Superman Unlimited (2025-) #6" });
      assert.strictEqual(r.kind, "core-collection", r.summary);
      assert.strictEqual(r.identifiers.coreCollection, NEW_DROP);
      assert.strictEqual(r.foundOn, "the chain (not in the bundled registry)");
      assert.strictEqual(r.issuer.verdict, "not-in-registry");
      assert.match(r.summary, /not in the bundled registry/);
      // An empty one named by address: a collection, unverified, no items yet.
      const e = await call("identify", { query: EMPTY_NAMING_CANDY });
      assert.strictEqual(e.kind, "core-collection");
      assert.strictEqual(e.issuer.verdict, "no-items");
      assert.match(e.summary, /no items yet/);
    });

    await check("get_asset shows the item's own name and the index's picture over a marketplace's copy", async () => {
      const r = await call("get_asset", { mint: RENAMED_MINT });
      assert.strictEqual(r.market.name, "Gold Series - Power (20/36)", "the name in the account bytes wins");
      assert.strictEqual(r.market.marketplaceName, "Gold Series - Auction #1 (20/36)", "what the marketplace said stays beside it");
      assert.strictEqual(r.market.image, "https://arweave.net/tW7nHi6yJG4gm2G0usZgFPTY9jhZx2YwEnt92dAxMP4");
      assert.match(r.market.marketplaceImage, /YsOTkYe3Kr7na1GituNfDh1p7sv7EccCh7y52dgjTSg/);
      assert.match(r.market.nameAndImageNote, /account on chain/);
      // Control: the same picture through Magic Eden's proxy and the same name: nothing is replaced.
      const same = await call("get_asset", { mint: SAME_MINT });
      assert.strictEqual(same.market.name, "Gold Series - Power (20/36)");
      assert.match(same.market.image, /img-cdn\.magiceden\.dev/, "the marketplace's link is kept when it is the same picture");
      assert.strictEqual(same.market.marketplaceName, undefined);
      assert.strictEqual(same.market.nameAndImageNote, undefined);
      // Control, every reply real: a DC comic's account and index say "Batman: The Long Halloween 51",
      // and Magic Eden shows its metadata file's "(51/800)". That fuller copy is the item's own and stays.
      const dc = await call("get_asset", { mint: DC_COMIC });
      assert.strictEqual(dc.onchain.name, "Batman: The Long Halloween 51");
      assert.strictEqual(dc.market.name, "Batman: The Long Halloween (51/800)");
      assert.strictEqual(dc.market.nameAndImageNote, undefined);
      assert.strictEqual(dc.market.marketplaceName, undefined);
    });
  } finally {
    await client.close();
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
