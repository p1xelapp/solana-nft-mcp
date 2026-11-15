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
const { decodeSale, currencyOfMint, scanCollectionSales, readTransaction, chainSaleRow, feedSignatures, chainRowsInRange = missing } = await import(pathToFileURL(path.join(dist, "lib", "chain-sales.js")).href).catch(() => ({
  decodeSale: missing, currencyOfMint: missing, scanCollectionSales: missing, readTransaction: missing, chainSaleRow: missing, feedSignatures: missing, chainRowsInRange: missing,
}));
const { plainReason = missing } = await import(pathToFileURL(path.join(dist, "lib", "http.js")).href).catch(() => ({ plainReason: missing }));
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
/**
 * A signature of its own for one case's rewritten reply: the fourth-to-last
 * character set to `salt`, which keeps it 64 bytes. Each case uses its own
 * salt, because a reply read under one signature is kept for the process.
 */
const saltedSig = (s, salt) => {
  const out = s.slice(0, -4) + salt + s.slice(-3);
  if (out === s) throw new Error(`salt ${salt} leaves ${s} unchanged`);
  return out;
};
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

/**
 * A real transaction with one more top-level System Program transfer, in the
 * shape the node lists one, and the balances moved to match. `from` or `to`
 * may be a wallet the transaction did not name, which is added to its accounts.
 */
const withSideTransfer = (short, from, to, lamports) => {
  const t = tx(short);
  const keys = t.transaction.message.accountKeys;
  for (const a of [from, to]) {
    if (keys.some((k) => k.pubkey === a)) continue;
    keys.push({ pubkey: a, signer: a === from, source: "transaction", writable: true });
    t.meta.preBalances.push(100_000_000_000);
    t.meta.postBalances.push(100_000_000_000);
  }
  const fi = keys.findIndex((k) => k.pubkey === from);
  const ti = keys.findIndex((k) => k.pubkey === to);
  if (t.meta.preBalances[fi] < lamports) { t.meta.preBalances[fi] += lamports; t.meta.postBalances[fi] += lamports; }
  t.transaction.message.instructions.push({ parsed: { info: { destination: to, lamports, source: from }, type: "transfer" }, program: "system", programId: "11111111111111111111111111111111", stackHeight: null });
  t.meta.postBalances[fi] -= lamports;
  t.meta.postBalances[ti] += lamports;
  return t;
};
/** A valid address none of the saved sales names. */
const STRANGER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

await check("money moved outside the marketplace's instructions is never part of the price", () => {
  const ops = decode("5wrdbZQq");
  // The buyer also sends a friend 0.5 SOL in a separate instruction.
  const toFriend = decodeSale(withSideTransfer("5wrdbZQq", ops.buyer, STRANGER, 500_000_000), ITEM["5wrdbZQq"], sig("5wrdbZQq"));
  assert.equal(toFriend.status, "sale");
  assert.equal(toFriend.buyerPaid, 0.3);
  assert.equal(toFriend.price, 0.3);
  // A stranger sends the Tensor take_bid seller 40 SOL beside the fill:
  // what the item sold for cannot be told, never 40.03.
  const bid = decode("3NoxXys3");
  const toSeller = decodeSale(withSideTransfer("3NoxXys3", STRANGER, bid.seller, 40_000_000_000), ITEM["3NoxXys3"], sig("3NoxXys3"));
  assert.equal(toSeller.status, "cannot-tell", JSON.stringify(toSeller.price));
  assert.match(toSeller.reason, /40 SOL from .* reached the seller .* outside Tensor's own/);
  // The buyer pays the OpenSea seller 40 SOL more on the side.
  const sidePrice = decodeSale(withSideTransfer("5wrdbZQq", ops.buyer, ops.seller, 40_000_000_000), ITEM["5wrdbZQq"], sig("5wrdbZQq"));
  assert.equal(sidePrice.status, "cannot-tell");
  // Money between two wallets the venue never named is not a payee of the take_bid.
  const unrelated = decodeSale(withSideTransfer("3NoxXys3", STRANGER, ops.buyer, 3_000_000_000), ITEM["3NoxXys3"], sig("3NoxXys3"));
  assert.equal(unrelated.status, "sale");
  assert.equal(unrelated.price, 0.0294);
  // The seller tipping someone outside the fill does not shrink what the venue paid it.
  const tip = decodeSale(withSideTransfer("3NoxXys3", bid.seller, STRANGER, 1_000_000), ITEM["3NoxXys3"], sig("3NoxXys3"));
  assert.equal(tip.sellerReceived, 0.025872);
  assert.equal(tip.price, 0.0294);
  // Control: the untouched transactions keep their figures.
  assert.equal(ops.buyerPaid, 0.3);
  assert.equal(bid.price, 0.0294);
  assert.equal(bid.sellerReceived, 0.025872);
});

await check("only the formats legacy, 0 and 1 are decoded; any other version is cannot-tell", () => {
  for (const v of [2, 9, 255, "v1"]) {
    const t = tx("5wrdbZQq");
    t.version = v;
    const d = decodeSale(t, ITEM["5wrdbZQq"], sig("5wrdbZQq"));
    assert.equal(d.status, "cannot-tell", String(v));
    assert.match(d.reason, /format version/, String(v));
  }
  // Control: version 1, version 0 and legacy replies are read.
  assert.equal(tx("5wrdbZQq").version, 1);
  assert.equal(decode("5wrdbZQq").status, "sale");
  assert.equal(tx("4f2Arm2W").version, 0);
  assert.equal(decode("4f2Arm2W").status, "sale");
  assert.equal(tx("5c9JdsqK").version, "legacy");
  assert.equal(decode("5c9JdsqK").status, "sale");
});

await check("a reply that does not carry the signature asked for is never decoded as it", () => {
  const none = tx("5wrdbZQq");
  delete none.transaction.signatures;
  const d = decodeSale(none, ITEM["5wrdbZQq"], sig("5wrdbZQq"));
  assert.equal(d.status, "cannot-tell");
  assert.match(d.reason, /carries no signature/);
  // Control: the same reply with its signature decodes.
  assert.equal(decode("5wrdbZQq").status, "sale");
});

await check("token decimals that do not match the currency's mint give no price", () => {
  const withDecimals = (short, mint, decimals) => {
    const t = tx(short);
    for (const list of [t.meta.preTokenBalances, t.meta.postTokenBalances]) for (const b of list ?? []) if (b.mint === mint) b.uiTokenAmount.decimals = decimals;
    return decodeSale(t, ITEM[short], sig(short));
  };
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  for (const dec of [0, 9]) {
    const d = withDecimals("2tssstvw", USDC, dec);
    assert.equal(d.status, "sale", String(dec));
    assert.equal(d.price, null, String(dec));
    assert.equal(d.sellerReceived, null, String(dec));
    assert.match(d.noPriceReason, new RegExp(`USDC ${dec} decimal places where its mint has 6`));
  }
  // Control: the saved reply (6, as USDC's mint has) reads 896, and a token
  // that is no known currency keeps the decimals its own reply states.
  assert.equal(decode("2tssstvw").price, 896);
  assert.equal(decode("A3SuTWZ4").price, 3115.141221);
});

await check("Tensor's AMM program is a venue the decoder names, not an unknown program", () => {
  // The real take_bid's venue instruction, reassigned to Tensor's AMM
  // program: an instruction of that venue this decoder does not know.
  const t = tx("3NoxXys3");
  const ix = t.transaction.message.instructions.find((i) => i.programId === "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp");
  ix.programId = "TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg";
  const d = decodeSale(t, ITEM["3NoxXys3"], sig("3NoxXys3"));
  assert.equal(d.status, "cannot-tell");
  assert.equal(d.venue, "Tensor pools");
  assert.match(d.reason, /Tensor pools instruction this decoder does not know/);
  // Control: the real one is Tensor's marketplace.
  assert.equal(decode("3NoxXys3").venue, "Tensor");
});

await check("Magic Eden's order price is read from its instruction: 1 SOL on an accepted offer the seller kept 0.98 of", () => {
  const offer = decodeSale(tx("3Vru15vv"), "9An7kmr9tpTqrBeKtXNxq9BGjW7frN5anFhgKmethNPK", sig("3Vru15vv"));
  assert.equal(offer.orderPrice, 1);
  assert.equal(offer.sellerReceived, 0.98);
  assert.equal(offer.price, 1.1);
  assert.equal(decodeSale(tx("j3shXmBY"), "GckVrtAxCMVcdXL7hnV9Bx4ckeTtqPTsBuECCLqNuSjr", sig("j3shXmBY")).orderPrice, 0.001);
  assert.equal(decode("5c9JdsqK").orderPrice, 2);
  assert.equal(decode("2tssstvw").orderPrice, 800);
  // The pool fill's seller signed and paid the network fee: what it kept.
  assert.equal(decode("3nTJSyQD").sellerAfterFee, 0.000840415);
  // Control: no order price where the venue's data does not carry one.
  assert.equal(decode("5wrdbZQq").orderPrice, undefined);
  assert.equal(decode("1ox3d2go").orderPrice, undefined);
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

/** The real Tensor take_bid rewritten as OpenSea's take_bid_core, whose slots are Tensor's plus one and inferred: no real one has been seen. */
const asOpenSeaTakeBid = (newSig) => {
  const t = tx("3NoxXys3");
  const ix = t.transaction.message.instructions.find((i) => i.programId === "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp");
  ix.programId = "7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V";
  ix.accounts = ["11111111111111111111111111111111", ...ix.accounts];
  if (newSig) t.transaction.signatures[0] = newSig;
  return t;
};

await check("a chain row through a layout no real transaction has checked says it is a probable sale", () => {
  const d = decodeSale(asOpenSeaTakeBid(), ITEM["3NoxXys3"], sig("3NoxXys3"));
  assert.equal(d.status, "sale", d.reason);
  assert.equal(d.layout, "inferred");
  const row = chainSaleRow(d);
  assert.equal(row.layoutUnchecked, true);
  assert.match(row.layoutNote, /probable sale, not a proven one/);
  // Control: the real Tensor take_bid, a published layout, carries no such flag.
  const real = chainSaleRow(decode("3NoxXys3"));
  assert.equal(real.layoutUnchecked, undefined);
  assert.equal(real.layoutNote, undefined);
});

await check("a chain row far above the SOL sales already in the answer carries the feed rows' flag", () => {
  const rows = [chainSaleRow(decode("5wrdbZQq")), chainSaleRow(decode("1ox3d2go"))];
  // Magic Eden rows of the answer, in the field the feed uses (priceSol),
  // around 0.01 SOL: the 0.3 SOL OpenSea fill is 30 times their median.
  const answer = { sales: [0.01, 0.012, 0.009, 0.011, 0.01, 0.013].map((priceSol, i) => ({ signature: `me-${i}`, priceSol })) };
  const { rows: out, flagged } = chainRowsInRange(rows, answer);
  const hi = out.find((r) => r.signature === sig("5wrdbZQq"));
  assert.equal(flagged >= 1, true);
  assert.equal(hi.farAboveRecentRange.priceSol, 0.3);
  assert.match(hi.farAboveRecentRange.note, /Shown as the chain recorded it/);
  // Controls: a row in another token and a self-fill are never judged, rows
  // of the same fill on OpenSea do not count twice, and five or more others
  // are needed before anything is called far above them.
  const meme = chainSaleRow(decode("A3SuTWZ4"));
  assert.equal(chainRowsInRange([meme], answer).rows[0].farAboveRecentRange, undefined);
  const self = chainSaleRow(decodeSale(selfFilled("5wrdbZQq", sig("5wrdbZQq")), ITEM["5wrdbZQq"], sig("5wrdbZQq")));
  assert.equal(chainRowsInRange([self], answer).rows[0].farAboveRecentRange, undefined);
  const few = { sales: answer.sales.slice(0, 3), opensea: { sales: [{ sameTransactionAs: "magiceden", currency: "SOL", price: 0.01 }, { sameTransactionAs: "magiceden", currency: "SOL", price: 0.01 }] } };
  assert.equal(chainRowsInRange([rows[0]], few).flagged, 0);
  // A price in range is not flagged.
  const near = { sales: [0.25, 0.3, 0.28, 0.35, 0.31].map((priceSol, i) => ({ signature: `me-${i}`, priceSol })) };
  assert.equal(chainRowsInRange([rows[0]], near).flagged, 0);
});

await check("a failure reason reads as a sentence, and its code sits in its own field", () => {
  const cases = [
    [new Error("Solana RPC -32603: Internal error"), /overloaded/, "solana-rpc -32603"],
    [new Error("Solana RPC -32603 from your SOLANA_RPC_URL (its message is not relayed, because a provider can echo your key in it)"), /your own Solana endpoint/, "solana-rpc -32603"],
    [new DOMException("The operation was aborted.", "AbortError"), /ran past its time budget/, "timeout"],
    [new Error("public Solana RPC is not answering right now. Every endpoint that keeps transaction history was tried and none returned a result (rpc-mainnet-beta HTTP 429: asked for a 10 s pause; rpc-publicnode HTTP 503). That is the free public RPC being busy."), /none of the Solana endpoints asked answered, and at least one asked for a pause/, "solana-rpc HTTP 429"],
    [new Error("the Solana endpoint this read was pinned to stopped answering part-way (rpc-mainnet-beta HTTP 503)"), /^the Solana endpoint this read was pinned to stopped answering part-way$/, "solana-rpc HTTP 503"],
    [new Error("no Solana endpoint asked would serve this transaction in a format the request allowed (rpc-mainnet-beta refused transaction format version 1 although the request allowed version 1)"), /^no Solana endpoint asked would serve this transaction in a format the request allowed$/, null],
  ];
  for (const [err, sentence, code] of cases) {
    const r = plainReason(err);
    assert.match(r.sentence, sentence, err.message);
    assert.doesNotMatch(r.sentence, /-32\d{3}|HTTP \d{3}|operation was aborted|rpc-mainnet-beta|not relayed/, r.sentence);
    assert.equal(r.code, code, err.message);
  }
  // Control: text that is not this server's own phrasing stays as it was, cleaned.
  assert.deepEqual(plainReason(new Error("Magic Eden returned an unexpected token shape (outage or API change)")), { sentence: "Magic Eden returned an unexpected token shape (outage or API change)", code: null });
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
/**
 * Other replies the public node gave on 2026-11-14, by method and first
 * parameter: one card's whole history (account, signatures, transactions),
 * two more cards' provenance walks, and the accounts of a wallet, the USDC
 * mint and an address one character away from a real card (no account).
 */
const fixtureFile = (name) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));
const TV = fixtureFile("transaction-versions-2026-11-14.json");
const PV = fixtureFile("provenance-sales-2026-11-14.json");
const AK = fixtureFile("address-kinds-2026-11-14.json");
const saved = new Map();
for (const c of [...PV.calls, ...AK.calls]) saved.set(`${c.method}:${JSON.stringify(c.params[0])}`, c.reply);
for (const [method, field] of [["getAccountInfo", "getAccountInfo"], ["getSignaturesForAddress", "getSignaturesForAddress"], ["getTransaction", "getTransaction"]]) {
  for (const [first, reply] of Object.entries(TV[field])) saved.set(`${method}:${JSON.stringify(first)}`, reply);
}
saved.set(`getMultipleAccounts:${JSON.stringify(TV.getMultipleAccounts.params[0])}`, TV.getMultipleAccounts.reply);
const CARD_TLH = TV.asset;
const WALLET = AK.calls[0].params[0];
const NO_ACCOUNT = AK.calls[1].params[0];
/** Signature lists served instead of the saved ones, by address. */
const listOverride = new Map();
/** Milliseconds to hold each reply, by method, so concurrent callers overlap; Infinity never answers. */
const holdFor = {};
const callsBy = { getSignaturesForAddress: 0, getTransaction: new Map() };
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
  if (b.method === "getSignaturesForAddress") callsBy.getSignaturesForAddress++;
  if (b.method === "getTransaction") callsBy.getTransaction.set(b.params[0], (callsBy.getTransaction.get(b.params[0]) ?? 0) + 1);
  const hold = holdFor[b.method];
  if (hold === Infinity) return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  if (hold) await new Promise((r) => setTimeout(r, hold));
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  const savedReply = saved.get(`${b.method}:${JSON.stringify(b.params[0])}`);
  if (b.method === "getSignaturesForAddress" && listOverride.has(b.params[0])) return reply(listOverride.get(b.params[0]).slice(0, b.params[1].limit));
  if (b.method === "getSignaturesForAddress" && b.params[0] === COLLECTION_TLH) return reply(SIGS.slice(0, b.params[1].limit));
  if (b.method === "getTransaction" && synthetic.has(b.params[0])) {
    const { tx: t, needs } = synthetic.get(b.params[0]);
    const asked = b.params[1]?.maxSupportedTransactionVersion;
    versionAsked.push(asked);
    if (needs !== undefined && !(asked >= needs)) return new Response(JSON.stringify({ ...refusalNaming(needs), id: b.id }), { status: 200, headers: { "content-type": "application/json" } });
    return reply(t);
  }
  if (savedReply && b.method === "getTransaction" && savedReply.result?.version === 1 && !(b.params[1]?.maxSupportedTransactionVersion >= 1)) {
    return new Response(JSON.stringify({ ...load("version-refusal").reply, id: b.id }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (savedReply) return new Response(JSON.stringify({ ...savedReply, id: b.id }), { status: 200, headers: { "content-type": "application/json" } });
  if (b.method === "getSignaturesForAddress") return reply([]);
  // An account nobody saved is not invented as missing: the read fails.
  if (b.method === "getAccountInfo" || b.method === "getMultipleAccounts") return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "not in the chain-sales fixtures" } }), { status: 200, headers: { "content-type": "application/json" } });
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
  // One account read (what the address is), one signature list, and the one
  // transaction among them the node does not hold, asked again because a
  // miss is never kept; every other transaction was kept by the first scan.
  assert.ok(rpcCalls - before <= 3, `made ${rpcCalls - before} calls`);
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

await check("verify_claim sale on a self-fill: neither a sale nor a price is confirmed or contradicted", async () => {
  const fake = otherSig(sig("5c9JdsqK"));
  synthetic.set(fake, { tx: selfFilled("5c9JdsqK", fake) });
  const priced = await verifyClaim({ claim: "sale", subject: fake, item: ITEM["5c9JdsqK"], value: 2 });
  assert.equal(priced.verdict, "unverifiable", priced.explanation);
  assert.match(priced.explanation, /same wallet/);
  // "It was sold" with no price: one wallet on both sides sold it to nobody.
  const bare = await verifyClaim({ claim: "sale", subject: fake, item: ITEM["5c9JdsqK"] });
  assert.equal(bare.verdict, "unverifiable", bare.explanation);
  assert.match(bare.explanation, /same wallet .*not a sale from one owner to another/);
  // Control: the real two-wallet fill at 2 SOL is confirmed.
  const real = await verifyClaim({ claim: "sale", subject: sig("5c9JdsqK"), item: ITEM["5c9JdsqK"], value: 2 });
  assert.equal(real.verdict, "confirmed", real.explanation);
});

await check("verify_claim sale gives no verdict through an unchecked layout, not even on the currency", async () => {
  const fake = saltedSig(sig("3NoxXys3"), "Q");
  synthetic.set(fake, { tx: asOpenSeaTakeBid(fake) });
  const r = await verifyClaim({ claim: "sale", subject: fake, item: ITEM["3NoxXys3"], value: 0.0294, currency: "USDC" });
  assert.equal(r.verdict, "unverifiable", r.explanation);
  assert.match(r.explanation, /inferred/);
  assert.match(r.evidence[0].method, /inferred from a sibling program/);
  // Control: the real take_bid, a published layout, is contradicted on the same currency.
  const real = await verifyClaim({ claim: "sale", subject: sig("3NoxXys3"), item: ITEM["3NoxXys3"], value: 0.0294, currency: "USDC" });
  assert.equal(real.verdict, "contradicted", real.explanation);
  assert.match(real.explanation, /paid in SOL, not USDC/);
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
await check("an item that is not in the transaction is contradicted only once its account proves it is a Core item", async () => {
  // No account at the address (what a compressed NFT's id and a typo both
  // look like): never contradicted.
  const missing = await verifyClaim({ claim: "sale", subject: sig("4LpSHwhD"), item: NO_ACCOUNT, value: 0.4928 });
  assert.equal(missing.verdict, "unverifiable", missing.explanation);
  assert.match(missing.explanation, /no account at .*compressed NFT/);
  assert.match(missing.explanation, /Core item this transaction moved: 2AgPQ61f/);
  // Control: a real Core card the transaction never touched is contradicted.
  const absent = await verifyClaim({ claim: "sale", subject: sig("4LpSHwhD"), item: CARD_TLH, value: 0.4928 });
  assert.equal(absent.verdict, "contradicted", absent.explanation);
  assert.match(absent.explanation, /read on chain and is a Metaplex Core item/);
});

await check("a collection or a wallet given as the item is named as one, with the item that did move", async () => {
  const col = await verifyClaim({ claim: "sale", subject: sig("5wrdbZQq"), item: COLLECTION_TLH, value: 0.3 });
  assert.equal(col.verdict, "unverifiable", col.explanation);
  assert.match(col.explanation, /is a Metaplex Core collection \(Batman: The Long Halloween\), not one item/);
  assert.match(col.explanation, new RegExp(`${CARD_TLH} \\(OpenSea sale for 0\\.3 SOL\\)`));
  const wallet = await verifyClaim({ claim: "sale", subject: sig("5wrdbZQq"), item: WALLET, value: 0.3 });
  assert.equal(wallet.verdict, "unverifiable", wallet.explanation);
  assert.match(wallet.explanation, /is a wallet/);
  // Control: the card itself is confirmed.
  assert.equal((await verifyClaim({ claim: "sale", subject: sig("5wrdbZQq"), item: CARD_TLH, value: 0.3 })).verdict, "confirmed");
});

await check("a sale claim is matched at the precision it was written, against every figure the chain gives", async () => {
  const v = async (short, item, value) => verifyClaim({ claim: "sale", subject: sig(short), item, value });
  // Rounded: 0.27 for a seller's 0.267, 2.2 for 2.24 paid in all.
  const r1 = await v("5wrdbZQq", ITEM["5wrdbZQq"], 0.27);
  assert.equal(r1.verdict, "confirmed", r1.explanation);
  assert.match(r1.explanation, /what the seller received, 0\.267 SOL .*precision it was written/);
  assert.equal((await v("5c9JdsqK", ITEM["5c9JdsqK"], 2.2)).verdict, "confirmed");
  // The order price of two accepted offers.
  const offer = await v("3Vru15vv", "9An7kmr9tpTqrBeKtXNxq9BGjW7frN5anFhgKmethNPK", 1);
  assert.equal(offer.verdict, "confirmed", offer.explanation);
  assert.match(offer.explanation, /matches the order price written in the marketplace instruction, 1 SOL\.$/);
  assert.equal((await v("j3shXmBY", "GckVrtAxCMVcdXL7hnV9Bx4ckeTtqPTsBuECCLqNuSjr", 0.001)).verdict, "confirmed");
  // A pool seller's own wallet figure, after the network fee it paid.
  const kept = await v("3nTJSyQD", ITEM["3nTJSyQD"], 0.000840415);
  assert.equal(kept.verdict, "confirmed", kept.explanation);
  assert.match(kept.explanation, /after the network fee/);
  // Controls: clearly different prices are still contradicted.
  assert.equal((await v("5wrdbZQq", ITEM["5wrdbZQq"], 0.5)).verdict, "contradicted");
  assert.equal((await v("3Vru15vv", "9An7kmr9tpTqrBeKtXNxq9BGjW7frN5anFhgKmethNPK", 2)).verdict, "contradicted");
  assert.equal((await v("5c9JdsqK", ITEM["5c9JdsqK"], 1)).verdict, "contradicted");
});

await check("money outside the marketplace's instructions does not confirm a sale claim", async () => {
  const ops = decode("5wrdbZQq");
  const s = saltedSig(sig("5wrdbZQq"), "m");
  const t = withSideTransfer("5wrdbZQq", ops.buyer, ops.seller, 40_000_000_000);
  t.transaction.signatures[0] = s;
  synthetic.set(s, { tx: t });
  const r = await verifyClaim({ claim: "sale", subject: s, item: ITEM["5wrdbZQq"], value: 40.3 });
  assert.equal(r.verdict, "unverifiable", r.explanation);
  assert.match(r.explanation, /outside OpenSea's own/);
  // Control: the real transaction at its real price.
  assert.equal((await verifyClaim({ claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.3 })).verdict, "confirmed");
});

await check("a reply without the signature asked for is not kept, and a sale claim on it is unverifiable", async () => {
  const s = saltedSig(sig("4f2Arm2W"), "n");
  const t = tx("4f2Arm2W");
  delete t.transaction.signatures;
  synthetic.set(s, { tx: t });
  const before = callsBy.getTransaction.get(s) ?? 0;
  await readTransaction(s);
  await readTransaction(s);
  assert.equal((callsBy.getTransaction.get(s) ?? 0) - before, 2, "a reply that is not this transaction must not be kept");
  const r = await verifyClaim({ claim: "sale", subject: s, item: ITEM["4f2Arm2W"], value: 0.0039 });
  assert.equal(r.verdict, "unverifiable", r.explanation);
  // Control: a real reply is kept, so a second read sends nothing.
  await readTransaction(sig("4f2Arm2W"));
  const kept = callsBy.getTransaction.get(sig("4f2Arm2W")) ?? 0;
  await readTransaction(sig("4f2Arm2W"));
  assert.equal(callsBy.getTransaction.get(sig("4f2Arm2W")) ?? 0, kept);
});

await check("the scan counts a reply with no status or no message as unreadable, never as not a sale", async () => {
  const noMeta = tx("5wrdbZQq");
  noMeta.meta = null;
  const sB = saltedSig(sig("5wrdbZQq"), "u");
  noMeta.transaction.signatures[0] = sB;
  const sC = saltedSig(sig("5oTJN3Po"), "u");
  // A reply that carries a status and a signature and nothing else.
  const noMessage = { slot: 1, blockTime: 1794500000, meta: { err: null }, transaction: { signatures: [sC] }, version: 1 };
  synthetic.set(sB, { tx: noMeta });
  synthetic.set(sC, { tx: noMessage });
  listOverride.set(COLLECTION_TLH, [sig("5wrdbZQq"), sB, sC].map((signature, i) => ({ signature, blockTime: 1794500000 - i, err: null, confirmationStatus: "finalized", memo: null, slot: 469000000 - i })));
  try {
    const s = await scanCollectionSales(COLLECTION_TLH, { maxReads: 10, deadlineMs: 60_000 });
    assert.equal(s.coverage.unreadable, 2);
    assert.equal(s.coverage.notSales, 0);
    assert.equal(s.coverage.transactionsDecoded, 1);
    assert.equal(s.coverage.cannotTell.length, 2);
    assert.doesNotMatch(s.note, /read and decoded/);
    assert.match(s.note, /1 decoded, 2 could not be read or decoded/);
    // Control: the readable one is still the sale it is.
    assert.equal(s.sales.length, 1);
    assert.equal(s.sales[0].signature, sig("5wrdbZQq"));
  } finally {
    listOverride.delete(COLLECTION_TLH);
  }
});

await check("the scan reads an item's own history when given an item, and refuses a wallet or a missing account", async () => {
  const item = await scanCollectionSales(CARD_TLH, { maxReads: 10, deadlineMs: 60_000 });
  assert.equal(item.scanned, "item");
  assert.equal(item.item, CARD_TLH);
  assert.equal(item.collection, COLLECTION_TLH);
  assert.deepEqual(item.sales.map((x) => [x.signature, x.price]), [[sig("5wrdbZQq"), 0.3]]);
  assert.match(item.note, /is one Metaplex Core item of the collection/);
  const wallet = await scanCollectionSales(WALLET);
  assert.equal(wallet.addressKind, "wallet");
  assert.match(wallet.refused, /is a wallet .*nothing was read for it/);
  const missing = await scanCollectionSales(NO_ACCOUNT);
  assert.equal(missing.addressKind, "no-account");
  // Control: the collection is scanned as one.
  const col = await scanCollectionSales(COLLECTION_TLH, { maxReads: 2, deadlineMs: 60_000 });
  assert.equal(col.scanned, "collection");
  assert.match(col.note, /the collection account/);
});

await check("the scan's budget ends every read, and concurrent scans of one collection share their reads", async () => {
  /** Real transactions under signatures nobody has read in this process, so nothing answers from the cache. */
  const unreadCopies = (shorts, salt) =>
    shorts.map((short) => {
      const s = saltedSig(sig(short), salt);
      const t = tx(short);
      t.transaction.signatures[0] = s;
      synthetic.set(s, { tx: t });
      return s;
    });
  // Every transaction read hangs: the scan stops at its budget, not after
  // each endpoint's retries.
  const hanging = unreadCopies(["4zWky7c8", "p6RGzxyr", "KiCPgAf4"], "h");
  listOverride.set(COLLECTION_TLH, hanging.map((signature, i) => ({ signature, blockTime: 1794600000 - i, err: null })));
  holdFor.getTransaction = Infinity;
  const started = Date.now();
  let hung;
  // Abort timers do not hold a process open the way the server's stdio does.
  const alive = setInterval(() => {}, 1_000);
  try {
    hung = await scanCollectionSales(COLLECTION_TLH, { maxReads: 10, deadlineMs: 1_500, signatures: 30 });
  } finally {
    clearInterval(alive);
    delete holdFor.getTransaction;
    listOverride.delete(COLLECTION_TLH);
  }
  const took = Date.now() - started;
  assert.ok(took < 6_000, `took ${took} ms`);
  assert.equal(hung.coverage.stoppedBecause, "deadline");
  assert.equal(hung.coverage.unreadable, 0);
  assert.ok(hung.coverage.notRead > 0);
  // Four scans at once, on transactions nobody has read yet.
  const fresh = unreadCopies(["4zWky7c8", "p6RGzxyr", "KiCPgAf4"], "q");
  listOverride.set(COLLECTION_TLH, fresh.map((signature, i) => ({ signature, blockTime: 1794600000 - i, err: null })));
  holdFor.getSignaturesForAddress = 1_500;
  holdFor.getTransaction = 300;
  const lists = callsBy.getSignaturesForAddress;
  try {
    await Promise.all([1, 2, 3, 4].map(() => scanCollectionSales(COLLECTION_TLH, { maxReads: 10, deadlineMs: 60_000, signatures: 30 })));
  } finally {
    delete holdFor.getSignaturesForAddress;
    delete holdFor.getTransaction;
    listOverride.delete(COLLECTION_TLH);
  }
  assert.equal(callsBy.getSignaturesForAddress - lists, 1, "one signature list for four scans");
  for (const s of fresh) assert.equal(callsBy.getTransaction.get(s), 1, `${s} read ${callsBy.getTransaction.get(s)} times`);
});

await check("never sold: a sale the decoder proves in the history contradicts it, and the receipt reads as prose", async () => {
  const r = await verifyClaim({ claim: "never-traded", subject: CARD_TLH });
  assert.equal(r.verdict, "contradicted", r.explanation);
  assert.match(r.explanation, /an OpenSea sale at 2026-11-12T00:06:35\.000Z for 0\.3 SOL \(transaction 5wrdbZQq/);
  assert.doesNotMatch(r.receipt, /endpointPinned|contextSlot|slotFloorHonoured|=/);
  assert.match(r.receipt, /^CONTRADICTED: .* chain shows OpenSea sale/);
  // Control: the walk itself, without the decoder, still has the sale as a
  // plain transfer, which is what the claim used to rest on.
  const sol = await import(pathToFileURL(path.join(dist, "sources", "solana.js")).href);
  const plain = await sol.getProvenance(CARD_TLH, 25, { fresh: true });
  const row = plain.events.find((e) => e.signature === sig("5wrdbZQq"));
  assert.equal(row.event, "transferred");
  assert.equal(row.sale, undefined);
});

await check("history rows name decoded sales and listings, and a pool owner's wallet is not an escrow", async () => {
  const sol = await import(pathToFileURL(path.join(dist, "sources", "solana.js")).href);
  const { getProvenanceWithSales } = await import(pathToFileURL(path.join(dist, "lib", "chain-sales.js")).href);
  const labels = (p) => Object.fromEntries(p.events.filter((e) => e.event === "transferred").map((e) => [e.signature.slice(0, 8), e]));
  const heq = labels(await getProvenanceWithSales(PV.assets[0], 25, { fresh: true }));
  // Sold into a Magic Eden pool: the pool owner's wallet is the buyer, not an escrow.
  assert.match(heq["2dYQFw2A"].label, /^sale on Magic Eden pools \(sol_mpl_core_fulfill_buy\)/);
  assert.equal(heq["2dYQFw2A"].magicEdenEscrow, undefined);
  assert.equal(heq["2dYQFw2A"].sale.price, 0.0011);
  assert.match(heq["36imtaLW"].label, /^listed on Magic Eden \(core_sell\)/);
  assert.equal(heq["36imtaLW"].escrowDirection, "into");
  assert.match(heq["4owaVQNs"].label, /^sale on Magic Eden \(core_execute_sale_v2\).*came out of the Magic Eden escrow/);
  assert.equal(heq["4owaVQNs"].escrowDirection, "out_of");
  // (The same history with its first transaction unread is checked through
  // the server below: a walk keeps transactions it read for an hour.)
  // The version-1 OpenSea fill after an OpenSea listing is named as a sale.
  const six = labels(await getProvenanceWithSales(PV.assets[1], 25, { fresh: true }));
  assert.match(six["6b2HgFuD"].label, /into an OpenSea listing account, decoded from this transaction \(OpenSea list_core\)/);
  assert.match(six["5orFUynX"].label, /^sale on OpenSea \(buy_core\).*0\.15 SOL paid in all/);
  assert.equal(six["5orFUynX"].sale.currency, "SOL");
  // Control: without the decoder that v1 row has no label and no sale.
  const plain = labels(await sol.getProvenance(PV.assets[1], 25, { fresh: true }));
  assert.equal(plain["5orFUynX"].sale, undefined);
});

await check("an unverifiable receipt with nothing read still carries the time it was tried", async () => {
  const s = otherSig(sig("2gAgsKK7"));
  synthetic.set(s, { tx: null, needs: 99 });
  const r = await verifyClaim({ claim: "sale", subject: s, item: ITEM["2gAgsKK7"], value: 0.1 });
  assert.equal(r.verdict, "unverifiable");
  assert.equal(r.evidence.length, 0);
  assert.match(r.receipt, / · attempted via solana-nft-mcp at \d{4}-\d\d-\d\dT/);
  // Control: a receipt with evidence keeps its own wording.
  assert.match((await verifyClaim({ claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.3 })).receipt, /checked on-chain via solana-nft-mcp at /);
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
  await check("verify_claim sale: the version-1 OpenSea sale at 0.3 SOL is confirmed, 0.29 between its figures is unverifiable, 0.25 is contradicted", async () => {
    const yes = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.3, currency: "SOL" });
    assert.equal(yes.verdict, "confirmed", yes.explanation);
    assert.match(yes.explanation, /OpenSea/);
    assert.match(yes.receipt, /^CONFIRMED: .* chain shows /);
    const net = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.267 });
    assert.equal(net.verdict, "confirmed");
    assert.match(net.explanation, /what the seller received/);
    // Between what the seller received (0.267) and what was paid (0.3): a
    // figure after some fees but not others, so no verdict either way.
    const between = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.29 });
    assert.equal(between.verdict, "unverifiable", between.explanation);
    assert.match(between.explanation, /lies between what the seller received \(0\.267\) and .*\(0\.3\)/);
    const no = await s.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.25 });
    assert.equal(no.verdict, "contradicted", no.explanation);
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

  await check("get_recent_sales chainScan on a card reads the card's own history; on a wallet it is not run", async () => {
    const card = await s.call("get_recent_sales", { collection: CARD_TLH, chainScan: true });
    if (card.isError) assert.fail(`refused: ${card.text}`);
    assert.equal(card.chainScan.status, "read");
    assert.equal(card.chainScan.item, CARD_TLH);
    assert.equal(card.chainScan.collection, COLLECTION_TLH);
    assert.deepEqual(card.chainScan.sales.map((x) => [x.signature, x.price]), [[sig("5wrdbZQq"), 0.3]]);
    const wallet = await s.call("get_recent_sales", { collection: WALLET, chainScan: true });
    if (wallet.isError) assert.fail(`refused: ${wallet.text}`);
    assert.equal(wallet.chainScan.status, "not-run");
    assert.match(wallet.chainScan.reason, /is a wallet/);
    // Control: the collection is scanned as a collection.
    const col = await s.call("get_recent_sales", { collection: COLLECTION_TLH, limit: 1, chainScan: true });
    assert.equal(col.chainScan.collection, COLLECTION_TLH);
    assert.equal(col.chainScan.item, undefined);
  });

  await check("get_asset_provenance names decoded sales and listings", async () => {
    const p = await s.call("get_asset_provenance", { mint: PV.assets[0], depth: 25 });
    if (p.isError) assert.fail(`refused: ${p.text}`);
    const row = (prefix) => p.events.find((e) => e.signature.startsWith(prefix));
    assert.match(row("2dYQFw2A").label, /^sale on Magic Eden pools/);
    assert.match(row("36imtaLW").label, /^listed on Magic Eden \(core_sell\)/);
    assert.match(row("4owaVQNs").label, /^sale on Magic Eden \(core_execute_sale_v2\)/);
    assert.equal(row("4owaVQNs").sale.price, 0.0112);
  });
} finally {
  await s.close();
}

const unreadMint = await server("unread-mint");
try {
  await check("an unread first transaction does not blank the decoded labels after it", async () => {
    const p = await unreadMint.call("get_asset_provenance", { mint: PV.assets[0], depth: 25 });
    if (p.isError) assert.fail(`refused: ${p.text}`);
    assert.equal(p.events[0].event, "unread_gap");
    const row = (prefix) => p.events.find((e) => e.signature.startsWith(prefix));
    assert.match(row("2dYQFw2A").label, /^sale on Magic Eden pools/);
    assert.match(row("36imtaLW").label, /^listed on Magic Eden/);
    assert.equal(row("36imtaLW").escrowDirection, "into");
    assert.match(row("4owaVQNs").label, /^sale on Magic Eden .*came out of the Magic Eden escrow/);
    assert.doesNotMatch(JSON.stringify(p.events), /history before it was not read/);
  });
} finally {
  await unreadMint.close();
}

const busy = await server("busy");
try {
  await check("a busy chain makes a sale claim unverifiable, never contradicted", async () => {
    const r = await busy.call("verify_claim", { claim: "sale", subject: sig("5wrdbZQq"), item: ITEM["5wrdbZQq"], value: 0.3 });
    if (r.isError) assert.fail(`refused: ${r.text}`);
    assert.equal(r.verdict, "unverifiable");
    // In words, with the code beside them: the reader's own text used to be
    // pasted in as it was ("Solana RPC -32603 from your SOLANA_RPC_URL ...").
    assert.match(r.explanation, /could not be read for this transaction just now \(your own Solana endpoint/);
    assert.doesNotMatch(r.explanation + r.receipt, /Solana RPC -32603|-32603|not relayed/);
    assert.equal(r.code, "solana-rpc -32603");
  });

  await check("a busy chain leaves the scan's unread transactions in words, with their codes apart", async () => {
    const r = await busy.call("get_recent_sales", { collection: COLLECTION_TLH, limit: 1, chainScan: true });
    if (r.isError) assert.fail(`refused: ${r.text}`);
    assert.equal(r.chainScan.status, "read");
    assert.equal(r.chainScan.sales.length, 0);
    const unread = r.chainScan.coverage.cannotTell;
    assert.ok(unread.length > 0, JSON.stringify(r.chainScan.coverage));
    for (const u of unread) {
      assert.match(u.reason, /^could not be read: your own Solana endpoint/);
      assert.doesNotMatch(u.reason, /-32603|not relayed/);
      assert.equal(u.code, "solana-rpc -32603");
    }
    // Control: nothing unread is counted as not a sale.
    assert.equal(r.chainScan.coverage.notSales, 0);
  });
} finally {
  await busy.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
