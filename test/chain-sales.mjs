/**
 * Sales proven from the chain, offline.
 *
 * Every transaction here is a real reply captured on 2026-11-14 and saved
 * under test/fixtures/chain-sales/: the six signatures that drove this work,
 * six Tensor Candy sales, Magic Eden fills and an accepted offer, and real
 * non-sales of every kind (listings, delistings, plain transfers, delegate
 * moves, a wallet migration, bids, a pool closing, a failed transaction).
 * The decoder is checked directly, then through verify_claim and
 * get_recent_sales on a child server whose chain and Magic Eden answer from
 * the same captured replies. Each block carries a control, so a test cannot
 * pass by calling everything a sale or nothing a sale.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, ".."));
const dist = path.join(root, "dist");
const fx = path.join(here, "fixtures", "chain-sales");
const load = (short) => JSON.parse(fs.readFileSync(path.join(fx, `${short}.json`), "utf8"));
const tx = (short) => load(short).reply.result;
const sig = (short) => load(short).params[0];

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const COLLECTION_TLH = "pUqAP37Cvdh8YEr8YssSC84hngnBWcPEaBNdqsvh4mA";
const ITEM = {
  "5wrdbZQq": "AUjRXCikevZrK7JPEvgPE3HquYyYc2WF51pmS2ZuiQF9",
  A3SuTWZ4: "ChPyLJdbodV1iSeR46fwiXsw6ezociyJdHNWNY3x8P2p",
  "5c9JdsqK": "Go3Uy64SeJ8XwG7UzE7LCPRgtTE1cnyEcTaMGcChw5sf",
  "2tssstvw": "dk9Dwn5SfkokXz8giAa8bNdVSUibeBJSnGbpNsnLcFJ",
  "4f2Arm2W": "6uTKNQ96GsQDULodRNcNtgNnFAr7VpDnN2V9MFSerhfV",
  "1ox3d2go": "2Dup4UBdb5eETvP7MEawbPpUJdakXThM2w35Snfe48dT",
  "5oTJN3Po": "2s5cSiUPhYe127DeZKheq7GdfzdvyBngpc9zn5AozaRx",
  "3NoxXys3": "2s5cSiUPhYe127DeZKheq7GdfzdvyBngpc9zn5AozaRx",
  "2gAgsKK7": "7Caoeknhi3g9K4xk5GCoe6WJCwkBhA9LQLThhbKEyLXW",
  "5rkXdHRH": "3UF7vjZbWRduKBNv9mvU6zzVJ6X9B8gJL2xsSdHnMrxz",
  "4LpSHwhD": "2AgPQ61fQJ7K3pF9gZafcEnA2n17fCWSUTk5eVXkASPs",
  d7VsRSh6: "U4xNSNN2UMQBRGfFLi4it8jk8fA884hatTKttMtrQqa",
  "3mF1UcUZ": "DuGbyHgSZq7X2BX6vKbxZ48BXsu13tK9xNMqoaF6Abce",
  "3nTJSyQD": "89eYY1M4gX3a9y7GPZQabx12KrBKkrHQ5u2g4yrEAVBT",
  sfR2hT38: "FQqoxoEtn4hbt2QHqNJJDTi1MBE5zDwjCg6T2Qw2pty1",
  "4qJqjndw": "FQqoxoEtn4hbt2QHqNJJDTi1MBE5zDwjCg6T2Qw2pty1",
  "4kJo5Nvj": "H4fEadnkVTRteDXXtSh959KpKkknY4dEQVNwjqmh83Ld",
};
/** The item a Core transfer in this transaction moved, for fixtures saved without one. */
const firstMoved = (t) => {
  const all = [...t.transaction.message.instructions, ...(t.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
  return all.find((i) => i.programId === "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d" && (i.accounts ?? []).length >= 5 && i.data === "24o")?.accounts[0];
};

// A build without the decoder fails each check below on its own, instead of
// stopping the file before the server checks run.
const missing = () => { throw new Error("this build has no chain sale decoder"); };
const { decodeSale, currencyOfMint, scanCollectionSales, readTransaction, chainSaleRow, feedSignatures } = await import(pathToFileURL(path.join(dist, "lib", "chain-sales.js")).href).catch(() => ({
  decodeSale: missing, currencyOfMint: missing, scanCollectionSales: missing, readTransaction: missing, chainSaleRow: missing, feedSignatures: missing,
}));
const { classifyPaymentToken, currencyByMint } = await import(pathToFileURL(path.join(dist, "lib", "reconcile.js")).href).catch(() => ({ classifyPaymentToken: missing, currencyByMint: missing }));
const { verifyClaim } = await import(pathToFileURL(path.join(dist, "verify.js")).href).catch(() => ({ verifyClaim: missing }));
/** A real transaction rewritten so its buyer is also its seller, under a signature of its own. */
const selfFilled = (short, newSig) => {
  const t = tx(short);
  const d = decodeSale(t, ITEM[short], sig(short));
  const out = JSON.parse(JSON.stringify(t).replaceAll(d.seller, d.buyer));
  out.transaction.signatures[0] = newSig;
  return out;
};
/** Another well-formed signature: the second-to-last character changed, which keeps it 64 bytes. */
const otherSig = (s) => s.slice(0, -2) + (s.at(-2) === "Z" ? "Y" : "Z") + s.slice(-1);
const decode = (short, item) => decodeSale(tx(short), item ?? ITEM[short] ?? firstMoved(tx(short)), sig(short));

// ------------------------------------------------------------ the decoder

await check("a version-1 OpenSea sale decodes: 0.3 SOL paid, 0.267 to the seller", () => {
  assert.equal(tx("5wrdbZQq").version, 1);
  const d = decode("5wrdbZQq");
  assert.equal(d.status, "sale");
  assert.equal(d.venue, "OpenSea");
  assert.equal(d.instruction, "buy_core");
  assert.equal(d.currency.code, "SOL");
  assert.equal(d.price, 0.3);
  assert.equal(d.sellerReceived, 0.267);
  assert.equal(d.buyerPaid, 0.3);
  assert.equal(d.seller, "B1ZK9MwuGWM6rsfwheci9pyrmbNh7H7gLAcUpFegr8qG");
  assert.equal(d.buyer, "h4FoDwkztwipWbqdNV4jEa7FJkL32fz5hjE9w5q67zv");
  assert.equal(d.collection, COLLECTION_TLH);
  // Control: the same transaction is not a sale of an item it never touched.
  assert.equal(decode("5wrdbZQq", ITEM["5oTJN3Po"]).status, "not-a-sale");
});

await check("a memecoin payment is another token, never SOL, and the rule is the mint", () => {
  const d = decode("A3SuTWZ4");
  assert.equal(d.status, "sale");
  assert.equal(d.instruction, "buy_core_spl");
  assert.equal(d.currency.code, null);
  assert.equal(d.currency.paidInOtherToken, true);
  assert.equal(d.currency.mint, "ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump");
  assert.equal(d.price, 3115.141221);
  assert.match(d.notes.join(" "), /never a SOL figure/);
  // Control: the same amounts under the USDC mint read as USDC. Only the
  // mint address decides, so the decoder cannot be calling everything odd.
  const t = JSON.parse(JSON.stringify(tx("A3SuTWZ4")).replaceAll("ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  const usdc = decodeSale(t, ITEM.A3SuTWZ4);
  assert.equal(usdc.currency.code, "USDC");
  assert.equal(usdc.currency.paidInOtherToken, false);
  assert.equal(currencyOfMint("So11111111111111111111111111111111111111112", 9).code, "SOL");
  assert.equal(currencyOfMint("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", 6).code, "PYUSD");
  assert.equal(currencyOfMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6).code, "USDT");
  // Control: an address that only looks like USDT's (it is not even 32
  // bytes; the chain answered WrongSize for it on 2026-11-14) is another token.
  const lookalike = currencyOfMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCemc8NQi1Jg3", 6);
  assert.equal(lookalike.code, null);
  assert.equal(lookalike.paidInOtherToken, true);
});

await check("the decoder and the marketplace rows name a currency from one table, by the same rule", () => {
  const mints = [
    "11111111111111111111111111111111",
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    "ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump",
  ];
  for (const m of mints) {
    const row = classifyPaymentToken(m, undefined, "test");
    const chain = currencyOfMint(m, 6);
    // A known currency carries its name on both; another token has none on either.
    assert.equal(chain.code, row.kind === "other-token" ? null : row.currency, m);
    assert.equal(chain.paidInOtherToken, row.kind === "other-token", m);
    assert.equal(currencyByMint(m), chain.code, m);
  }
  // Control: a token NAMED USDC at another address is not USDC on either side.
  assert.equal(classifyPaymentToken("ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump", "USDC", "test").currency, null);
  assert.equal(currencyOfMint("ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump", 6).code, null);
});

await check("Magic Eden: the seller received the 2 SOL list price, the buyer paid 2.24", () => {
  const d = decode("5c9JdsqK");
  assert.equal(d.venue, "Magic Eden");
  assert.equal(d.instruction, "core_execute_sale_v2");
  assert.equal(d.sellerReceived, 2);
  assert.equal(d.price, 2.24);
  assert.equal(d.buyerPaid, 2.24);
  assert.equal(d.otherRecipients.length, 3);
});

await check("Magic Eden in USDC: 800 to the seller, 896 in all, and never called SOL", () => {
  const d = decode("2tssstvw");
  assert.equal(d.currency.code, "USDC");
  assert.equal(d.currency.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(d.sellerReceived, 800);
  assert.equal(d.price, 896);
});

await check("one fill carried by two feeds has both figures on chain: 0.0039 to the seller, 0.004368 paid", () => {
  const d = decode("4f2Arm2W");
  assert.equal(d.sellerReceived, 0.0039);
  assert.equal(d.price, 0.004368);
  // The seller's balance rose by 0.007142496 because the listing's rent came
  // back in the same transaction; the decoder reads the transfer, not that.
  const t = tx("4f2Arm2W");
  const i = t.transaction.message.accountKeys.findIndex((k) => k.pubkey === d.seller);
  assert.equal(t.meta.postBalances[i] - t.meta.preBalances[i], 7142496);
});

await check("a pool fill: the pool paid, the buyer's balance did not, the seller proves the price", () => {
  const d = decode("1ox3d2go");
  assert.equal(d.venue, "Magic Eden pools");
  assert.equal(d.instruction, "sol_mpl_core_fulfill_buy");
  assert.equal(d.sellerReceived, 0.034399783);
  assert.equal(d.price, 0.038612);
  assert.equal(d.buyerPaid, undefined);
  assert.match(d.notes.join(" "), /did not pay for this item/);
});

await check("Tensor buy_core and take_bid_core decode, including a take_bid with no transfer instruction", () => {
  const buy = decode("5oTJN3Po");
  assert.equal(buy.venue, "Tensor");
  assert.equal(buy.instruction, "buy_core");
  assert.equal(buy.sellerReceived, 0.37);
  assert.equal(buy.price, 0.4144);
  const bid = decode("3NoxXys3");
  assert.equal(bid.instruction, "take_bid_core");
  assert.equal(bid.priceBasis, "balance-changes");
  assert.equal(bid.price, 0.0294);
  assert.equal(bid.sellerReceived, 0.025872);
  assert.equal(bid.priceExact, true);
  const bid2 = decode("2gAgsKK7");
  assert.equal(bid2.price, 0.1);
  assert.equal(bid2.sellerReceived, 0.088);
  for (const s of ["5rkXdHRH", "4LpSHwhD", "d7VsRSh6"]) assert.equal(decode(s).venue, "Tensor", s);
  assert.equal(decode("4LpSHwhD").sellerReceived, 0.44);
});

await check("an accepted offer (listed and sold in one transaction) is a sale, not two moves nobody can read", () => {
  const d = decode("3mF1UcUZ");
  assert.equal(d.status, "sale");
  assert.equal(d.price, 0.00231);
  assert.equal(d.sellerReceived, 0.002058);
  assert.match(d.notes.join(" "), /accepted offer/);
});

await check("listings, delistings, transfers, delegate moves, a migration, bids and a failed transaction are not sales", () => {
  const expect = {
    sfR2hT38: "listing", r6dsegA5: "listing", KiCPgAf4: "listing",
    "4qJqjndw": "delisting", "4kJo5Nvj": "delisting", RqoJfCB2: "delisting", "5W8AHjRX": "delisting",
    "6243RUUw": "direct-transfer", "2fzoBTHv": "direct-transfer",
    HiiXpi2U: "direct-transfer", "3fnjY1cz": "direct-transfer", "2aXMu7cV": "direct-transfer",
    "4mMTabLd": "bid", ExTVsUKG: "bid", "2y9vyqaq": "pool-admin",
  };
  for (const [s, kind] of Object.entries(expect)) {
    const d = decode(s, ITEM[s] ?? firstMoved(tx(s)) ?? ITEM["5oTJN3Po"]);
    assert.equal(d.status, "not-a-sale", s);
    assert.equal(d.kind, kind, `${s}: ${d.reason}`);
    assert.equal(d.price, undefined, s);
  }
  assert.match(decode("HiiXpi2U").reason, /authority 7wixESeixiY4f2A6JaDKNewNoiip9Tk9s5u1dze7nRwL/);
  assert.match(decode("2aXMu7cV").reason, /12 other item/);
  const f = decodeSale(tx("2WfAER88"), ITEM["1ox3d2go"], sig("2WfAER88"));
  assert.equal(f.kind, "failed");
});

await check("anything the decoder cannot establish is cannot-tell, never a sale and never a non-sale", () => {
  assert.equal(decodeSale(null, ITEM["5wrdbZQq"]).status, "cannot-tell");
  assert.equal(decodeSale({ meta: null }, ITEM["5wrdbZQq"]).status, "cannot-tell");
  // The endpoint answered with another transaction than the one asked for.
  assert.equal(decodeSale(tx("5wrdbZQq"), ITEM["5wrdbZQq"], sig("5c9JdsqK")).status, "cannot-tell");
  // The seller slot points at a royalty wallet: the layout and the money disagree.
  const swapped = JSON.parse(JSON.stringify(tx("5wrdbZQq")));
  const ix = swapped.transaction.message.instructions[0];
  [ix.accounts[7], ix.accounts[15]] = [ix.accounts[15], ix.accounts[7]];
  const d = decodeSale(swapped, ITEM["5wrdbZQq"]);
  assert.equal(d.status, "cannot-tell");
  assert.match(d.reason, /disagree/);
  // An inner group whose parent is not in the list: the order is unknown.
  const orphan = JSON.parse(JSON.stringify(tx("5wrdbZQq")));
  orphan.meta.innerInstructions[0].index = 7;
  assert.equal(decodeSale(orphan, ITEM["5wrdbZQq"]).status, "cannot-tell");
  // Control: the untouched transaction is still a sale.
  assert.equal(decodeSale(tx("5wrdbZQq"), ITEM["5wrdbZQq"]).status, "sale");
});

await check("a transaction that moves several items is a sale with no per-item price", () => {
  const t = JSON.parse(JSON.stringify(tx("5c9JdsqK")));
  const group = t.meta.innerInstructions.find((g) => g.index === 4);
  const core = group.instructions.find((i) => i.programId === "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
  group.instructions.push({ ...core, accounts: [ITEM["5oTJN3Po"], ...core.accounts.slice(1)] });
  const d = decodeSale(t, ITEM["5c9JdsqK"]);
  assert.equal(d.status, "sale");
  assert.equal(d.itemsMoved, 2);
  assert.equal(d.price, null);
  assert.equal(d.sellerReceived, null);
  assert.match(d.noPriceReason, /2 items/);
  // The row beside the marketplace rows carries their multi-item flag.
  const row = chainSaleRow(d);
  assert.equal(row.sharedTransaction.items, 2);
  assert.equal(row.price, null);
  // Control: the untouched one-item fill has a price and no flag.
  const one = chainSaleRow(decode("5c9JdsqK"));
  assert.equal(one.sharedTransaction, undefined);
  assert.equal(one.price, 2.24);
});

await check("a self-fill is a sale with no price, flagged selfFill, as on the marketplace rows", () => {
  for (const short of ["5c9JdsqK", "5wrdbZQq"]) {
    const t = selfFilled(short, sig(short));
    const d = decodeSale(t, ITEM[short], sig(short));
    assert.equal(d.status, "sale", short);
    assert.equal(d.selfFill, true, short);
    // What one wallet pays itself cancels out of the transfers: on the
    // OpenSea fill the legs left only 0.0307 of a 0.3 SOL order. No price.
    assert.equal(d.price, null, short);
    assert.equal(d.sellerReceived, null, short);
    assert.match(d.noPriceReason, /same wallet/, short);
    const row = chainSaleRow(d);
    assert.equal(row.selfFill, true, short);
    assert.equal(row.price, null, short);
    assert.equal(row.currency, "SOL", short);
    // Control: the real fill, two wallets, keeps its price and has no flag.
    const real = decode(short);
    assert.equal(real.selfFill, undefined, short);
    assert.ok(real.price > 0, short);
  }
});

await check("chain rows use the marketplace rows' currency fields: paymentToken, paidInOtherToken, currencyNote", () => {
  const memecoinMint = "ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump";
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const meme = chainSaleRow(decode("A3SuTWZ4"));
  assert.equal(meme.currency, null);
  assert.equal(meme.paidInOtherToken, true);
  assert.equal(meme.paymentToken, memecoinMint);
  assert.match(meme.currencyNote, /left out of every SOL figure/);
  const usdc = chainSaleRow(decode("2tssstvw"));
  assert.equal(usdc.currency, "USDC");
  assert.equal(usdc.paymentToken, usdcMint);
  assert.equal(usdc.paidInOtherToken, undefined);
  // Control: native SOL is named by the System Program's address, as OpenSea's rows name it.
  const sol = chainSaleRow(decode("5wrdbZQq"));
  assert.equal(sol.currency, "SOL");
  assert.equal(sol.paymentToken, "11111111111111111111111111111111");
  assert.equal(sol.paidInOtherToken, undefined);
});

await check("the signatures a get_recent_sales answer carries are taken from both feeds' rows", () => {
  // The shapes get_recent_sales returns: Magic Eden rows keyed by signature
  // (marked sameTransactionAs when OpenSea has the same fill) and OpenSea
  // rows keyed by transaction.
  const answer = {
    sales: [{ signature: "MEonly", tokenMint: "a" }, { signature: "Both", tokenMint: "b", sameTransactionAs: "opensea" }],
    opensea: { sales: [{ transaction: "Both", mint: "b", sameTransactionAs: "magiceden" }, { transaction: "OSonly", mint: "c" }] },
  };
  assert.deepEqual([...feedSignatures(answer)].sort(), ["Both", "MEonly", "OSonly"]);
  // Magic Eden failed and only OpenSea answered.
  assert.deepEqual([...feedSignatures({ requested: "x", sourceErrors: { magiceden: "down" }, opensea: { sales: [{ transaction: "OSonly" }] } })], ["OSonly"]);
  // Control: an answer with no rows knows no signature.
  assert.equal(feedSignatures({ requested: "x", marketplaceFeeds: "not read" }).size, 0);
});

// ------------------------------------------------------------ the scan, in this process

const SIGS = load("sigs-pUqAP3").reply.result;
const realFetch = globalThis.fetch;
let rpcCalls = 0;
/** Transactions served under signatures of their own: a rewritten real one, or a refusal naming a newer format. */
const synthetic = new Map();
/** The node's captured -32015 refusal, naming another format version. */
const refusalNaming = (v) => {
  const r = JSON.parse(JSON.stringify(load("version-refusal").reply));
  r.error.message = r.error.message.replace("version (1)", `version (${v})`).replace('"maxSupportedTransactionVersion": 1', `"maxSupportedTransactionVersion": ${v}`);
  return r;
};
const versionAsked = [];
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.hostname !== "chain-sales-rpc.invalid") return new Response("{}", { status: 404 });
  const b = JSON.parse(String(init.body));
  rpcCalls++;
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  if (b.method === "getSignaturesForAddress") return reply(b.params[0] === COLLECTION_TLH ? SIGS.slice(0, b.params[1].limit) : []);
  if (b.method === "getTransaction" && synthetic.has(b.params[0])) {
    const { tx: t, needs } = synthetic.get(b.params[0]);
    const asked = b.params[1]?.maxSupportedTransactionVersion;
    versionAsked.push(asked);
    if (needs !== undefined && !(asked >= needs)) return new Response(JSON.stringify({ ...refusalNaming(needs), id: b.id }), { status: 200, headers: { "content-type": "application/json" } });
    return reply(t);
  }
  if (b.method === "getTransaction") {
    const f = fs.readdirSync(fx).find((n) => n.endsWith(".json") && load(n.slice(0, -5)).params?.[0] === b.params[0] && load(n.slice(0, -5)).reply?.result);
    const t = f ? load(f.slice(0, -5)).reply.result : null;
    // The node's own refusal, as it answered on 2026-11-14.
    if (t?.version === 1 && !(b.params[1]?.maxSupportedTransactionVersion >= 1)) {
      return new Response(JSON.stringify({ ...load("version-refusal").reply, id: b.id }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return reply(t);
  }
  return reply(null);
};
process.env.SOLANA_RPC_URL = "https://chain-sales-rpc.invalid";

await check("a version-1 transaction is asked for with version 1 and read; asking for 0 is refused", async () => {
  const t = await readTransaction(sig("5wrdbZQq"));
  assert.equal(t?.version, 1);
  // Control: the same endpoint refuses a client that asks for version 0.
  const res = await globalThis.fetch("https://chain-sales-rpc.invalid", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig("5wrdbZQq"), { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }) });
  assert.equal((await res.json()).error.code, -32015);
});

await check("the scan finds the OpenSea sale Magic Eden's feed does not carry, and says where it stopped", async () => {
  const s = await scanCollectionSales(COLLECTION_TLH, { maxReads: 12, deadlineMs: 60_000 });
  assert.equal(s.sales.length, 1);
  assert.equal(s.sales[0].signature, sig("5wrdbZQq"));
  assert.equal(s.sales[0].venue, "OpenSea");
  assert.equal(s.coverage.transactionsRead, 12);
  assert.equal(s.coverage.stoppedBecause, "read-cap");
  assert.ok(s.coverage.notRead > 0);
  assert.match(s.note, /missing from this list, not absent from the chain/);
});

await check("a signature the feeds already carry is not read again and not listed twice", async () => {
  const before = rpcCalls;
  const s = await scanCollectionSales(COLLECTION_TLH, { maxReads: 12, deadlineMs: 60_000, known: new Set([sig("5wrdbZQq")]) });
  assert.equal(s.sales.length, 0);
  assert.equal(s.coverage.alreadyInFeeds, 1);
  // One signature list; every transaction it would read was read and kept by the first scan.
  assert.ok(rpcCalls - before <= 2, `made ${rpcCalls - before} calls`);
});

await check("a scan out of time reports what it did not read instead of calling the collection quiet", async () => {
  const s = await scanCollectionSales(COLLECTION_TLH, { maxReads: 12, deadlineMs: -1 });
  assert.equal(s.coverage.transactionsRead, 0);
  assert.equal(s.coverage.stoppedBecause, "deadline");
  assert.ok(s.coverage.notRead >= 12);
  assert.match(s.note, /budget ran out/);
});

await check("a fill only OpenSea's rows carry is not listed again by the scan", async () => {
  const os = await scanCollectionSales(COLLECTION_TLH, { maxReads: 12, deadlineMs: 60_000, known: feedSignatures({ requested: COLLECTION_TLH, opensea: { sales: [{ transaction: sig("5wrdbZQq") }] } }) });
  assert.equal(os.sales.length, 0);
  assert.equal(os.coverage.alreadyInFeeds, 1);
  // Control: a Magic Eden row for some other fill does not hide it.
  const me = await scanCollectionSales(COLLECTION_TLH, { maxReads: 12, deadlineMs: 60_000, known: feedSignatures({ sales: [{ signature: sig("5c9JdsqK") }] }) });
  assert.equal(me.sales.length, 1);
  assert.equal(me.sales[0].signature, sig("5wrdbZQq"));
});

await check("verify_claim sale on a self-fill: the fill is confirmed, a price is neither confirmed nor contradicted", async () => {
  const fake = otherSig(sig("5c9JdsqK"));
  synthetic.set(fake, { tx: selfFilled("5c9JdsqK", fake) });
  const priced = await verifyClaim({ claim: "sale", subject: fake, item: ITEM["5c9JdsqK"], value: 2 });
  assert.equal(priced.verdict, "unverifiable", priced.explanation);
  assert.match(priced.explanation, /same wallet/);
  const bare = await verifyClaim({ claim: "sale", subject: fake, item: ITEM["5c9JdsqK"] });
  assert.equal(bare.verdict, "confirmed", bare.explanation);
  assert.match(bare.explanation, /one wallet as buyer and seller/);
  // Control: the real two-wallet fill at 2 SOL is confirmed.
  const real = await verifyClaim({ claim: "sale", subject: sig("5c9JdsqK"), item: ITEM["5c9JdsqK"], value: 2 });
  assert.equal(real.verdict, "confirmed", real.explanation);
});

await check("the decoder reads through the shared transaction helper: a newer format is asked for once, past the ceiling is unread", async () => {
  // A node naming format 2 is asked again with 2, and the sale decodes.
  const v2 = otherSig(sig("4f2Arm2W"));
  const t2 = JSON.parse(JSON.stringify(tx("4f2Arm2W")));
  t2.transaction.signatures[0] = v2;
  synthetic.set(v2, { tx: t2, needs: 2 });
  versionAsked.length = 0;
  const d = decodeSale(await readTransaction(v2), ITEM["4f2Arm2W"], v2);
  assert.equal(d.status, "sale");
  assert.equal(d.price, 0.004368);
  assert.deepEqual(versionAsked, [1, 2]);
  // A format past the server's ceiling is a typed failure, and verify_claim
  // calls the sale unverifiable, never contradicted.
  const v99 = otherSig(sig("2tssstvw"));
  synthetic.set(v99, { tx: null, needs: 99 });
  await assert.rejects(readTransaction(v99), /cannot read/);
  const r = await verifyClaim({ claim: "sale", subject: v99, item: ITEM["2tssstvw"], value: 800, currency: "USDC" });
  assert.equal(r.verdict, "unverifiable", r.explanation);
  assert.match(r.explanation, /cannot read/);
});
globalThis.fetch = realFetch;
delete process.env.SOLANA_RPC_URL;

// ------------------------------------------------------------ through the server

async function server(profile = "normal") {
  const home = fs.mkdtempSync(path.join(tmpdir(), "solana-nft-mcp-chain-sales-"));
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(path.join(here, "helpers", "chain-sales-preload.mjs")).href, path.join(dist, "index.js")],
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      SOLANA_NFT_MCP_TEST_HOME: home,
      CHAIN_SALES_PROFILE: profile,
      SOLANA_NFT_MCP_NO_AUTO_KEYS: "1",
      SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1",
      SOLANA_RPC_URL: "https://chain-sales-rpc.invalid",
      DAS_RPC_URL: "https://chain-sales-rpc.invalid",
    },
    stderr: "ignore",
  });
  const c = new Client({ name: "chain-sales", version: "1" }, { capabilities: {} });
  await c.connect(transport);
  return {
    call: async (name, args) => {
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      return r.isError ? { isError: true, text: r.content?.[0]?.text ?? "" } : r.structuredContent;
    },
    close: async () => {
      await c.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const s = await server();
try {
  await check("verify_claim sale: the version-1 OpenSea sale at 0.3 SOL is confirmed, 0.29 is contradicted", async () => {
    const yes = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.3, currency: "SOL" });
    assert.equal(yes.verdict, "confirmed", yes.explanation);
    assert.match(yes.explanation, /OpenSea/);
    assert.match(yes.receipt, /^CONFIRMED: .* chain shows /);
    const net = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.267 });
    assert.equal(net.verdict, "confirmed");
    assert.match(net.explanation, /what the seller received/);
    const no = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.29 });
    assert.equal(no.verdict, "contradicted");
    assert.match(no.explanation, /0\.3/);
    // No price claimed: whether it was a sale at all.
    assert.equal((await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"] })).verdict, "confirmed");
  });

  await check("verify_claim sale: a memecoin sale claimed in SOL is contradicted, in its own mint confirmed", async () => {
    const asSol = await s.call("verify_claim", { claim: "sale", subject: sig("A3SuTWZ4"), item: ITEM.A3SuTWZ4, value: 3115.141221 });
    assert.equal(asSol.verdict, "contradicted");
    assert.match(asSol.explanation, /another token .*not SOL/);
    const asToken = await s.call("verify_claim", { claim: "sale", subject: sig("A3SuTWZ4"), item: ITEM.A3SuTWZ4, value: 3115.141221, currency: "ABAodYixeMG3pmuyohdgNft51PncJiadDqBBZvxWpump" });
    assert.equal(asToken.verdict, "confirmed", asToken.explanation);
  });

  await check("verify_claim sale: Magic Eden's SOL equivalent of a USDC sale is not a SOL price", async () => {
    const equiv = await s.call("verify_claim", { claim: "sale", subject: sig("2tssstvw"), item: ITEM["2tssstvw"], value: 6.733786 });
    assert.equal(equiv.verdict, "contradicted");
    assert.match(equiv.explanation, /USDC, not SOL/);
    const usdc = await s.call("verify_claim", { claim: "sale", subject: sig("2tssstvw"), item: ITEM["2tssstvw"], value: 800, currency: "USDC" });
    assert.equal(usdc.verdict, "confirmed");
  });

  await check("verify_claim sale: both feeds' figures for one fill are confirmed, and say which they match", async () => {
    const me = await s.call("verify_claim", { claim: "sale", subject: sig("4f2Arm2W"), item: ITEM["4f2Arm2W"], value: 0.0039 });
    const os = await s.call("verify_claim", { claim: "sale", subject: sig("4f2Arm2W"), item: ITEM["4f2Arm2W"], value: 0.004368 });
    assert.equal(me.verdict, "confirmed");
    assert.equal(os.verdict, "confirmed");
    assert.match(me.explanation, /seller received/);
    assert.match(os.explanation, /everything paid/);
    // A pool fill: the buyer's SOL did not move, the seller's proceeds prove it.
    assert.equal((await s.call("verify_claim", { claim: "sale", subject: sig("1ox3d2go"), item: ITEM["1ox3d2go"], value: 0.038612 })).verdict, "confirmed");
    assert.equal((await s.call("verify_claim", { claim: "sale", subject: sig("5c9JdsqK"), item: ITEM["5c9JdsqK"], value: 2 })).verdict, "confirmed");
  });

  await check("verify_claim sale: a listing is contradicted as a sale, an unread transaction is never contradicted", async () => {
    const listing = await s.call("verify_claim", { claim: "sale", subject: sig("sfR2hT38"), item: ITEM.sfR2hT38, value: 0.1 });
    assert.equal(listing.verdict, "contradicted");
    assert.match(listing.explanation, /listing/);
    // A signature the node does not hold answers null: unverifiable.
    const real = sig("5wrdbZQq");
    const unknown = real.slice(0, -2) + (real.endsWith("Z") ? "Y" : "Z") + real.slice(-1);
    const missing = await s.call("verify_claim", { claim: "sale", subject: unknown, item: ITEM["5wrdbZQq"], value: 0.3 });
    if (missing.isError) assert.fail(`refused: ${missing.text}`);
    assert.equal(missing.verdict, "unverifiable", missing.explanation);
  });

  await check("verify_claim sale needs an item and a signature; other claims still refuse a signature", async () => {
    const noItem = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq") });
    assert.ok(noItem.isError);
    assert.match(noItem.text, /item/);
    const notSig = await s.call("verify_claim", { claim: "sale", subject: ITEM["5wrdbZQq"], item: ITEM["5wrdbZQq"] });
    assert.ok(notSig.isError);
    const sigForOwnership = await s.call("verify_claim", { claim: "ownership", subject: sig("5wrdbZQq"), wallet: ITEM["5wrdbZQq"] });
    assert.ok(sigForOwnership.isError);
    assert.match(sigForOwnership.text, /transaction signature/);
  });

  await check("get_recent_sales chainScan lists the OpenSea sale the Magic Eden rows miss, as its own row", async () => {
    const plain = await s.call("get_recent_sales", { collection: COLLECTION_TLH, limit: 10 });
    assert.equal(plain.chainScan, undefined);
    assert.ok(!plain.sales.some((r) => r.signature === sig("5wrdbZQq")));
    const r = await s.call("get_recent_sales", { collection: COLLECTION_TLH, limit: 10, chainScan: true });
    assert.equal(r.chainScan.status, "read");
    assert.equal(r.chainScan.sales.length, 1);
    const row = r.chainScan.sales[0];
    assert.equal(row.venue, "OpenSea");
    assert.equal(row.signature, sig("5wrdbZQq"));
    assert.equal(row.price, 0.3);
    assert.equal(row.currency, "SOL");
    // Magic Eden's rows are exactly what its feed said: nothing added to them.
    assert.deepEqual(r.sales.map((x) => x.signature), plain.sales.map((x) => x.signature));
    assert.equal(r.chainScan.coverage.stoppedBecause, "read-cap");
    assert.match(r.chainScan.readThis, /Never add them/);
  });
} finally {
  await s.close();
}

const busy = await server("busy");
try {
  await check("a busy chain makes a sale claim unverifiable, never contradicted", async () => {
    const r = await busy.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.3 });
    if (r.isError) assert.fail(`refused: ${r.text}`);
    assert.equal(r.verdict, "unverifiable");
  });
} finally {
  await busy.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
