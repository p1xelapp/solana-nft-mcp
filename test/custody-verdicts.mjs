// The custody verdict itself, one case at a time, against a stubbed chain.
// The point of every case: a verdict is given only on what was actually read.
// A failed read, a listing with no seller, or an owner that is a marketplace's
// own account must never come out as "cannot be bought".
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
delete process.env.SOLANA_RPC_URL;
delete process.env.SOLANA_NFT_MCP_OFFLINE;

const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encode = (b) => { let n = BigInt("0x" + Buffer.from(b).toString("hex")); let s = ""; while (n) { s = chars[Number(n % 58n)] + s; n /= 58n; } return s; };
const decode = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(chars.indexOf(c)); return Buffer.from(n.toString(16).padStart(64, "0"), "hex"); };
const key = (label) => encode(createHash("sha256").update(`verdict-${label}`).digest());

const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SYSTEM = "11111111111111111111111111111111";
const OPENSEA = "7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V";
const ME_POOLS = "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc";
const TENSOR = "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN";
const ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix";
const UNKNOWN_PROGRAM = key("some-program");

// What the stubbed chain holds: item -> owner, and owner account -> owning program.
const itemOwner = new Map();
const ownerProgram = new Map();
let failProgramRead = false;
let programReads = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  if (body.method !== "getMultipleAccounts") return reply(null);
  const [addresses, opts] = body.params;
  const wantsBytes = (opts?.dataSlice?.length ?? 0) > 0;
  if (!wantsBytes) {
    programReads++;
    // An answer that does not line up with the question: read as unread at
    // once, with no retries to wait out.
    if (failProgramRead) return reply({ context: { slot: 1 }, value: [] });
    return reply({ context: { slot: 1 }, value: addresses.map((a) => (ownerProgram.has(a) ? { data: ["", "base64"], owner: ownerProgram.get(a), lamports: 1, executable: false } : null)) });
  }
  return reply({
    context: { slot: 1 },
    value: addresses.map((a) => {
      const o = itemOwner.get(a);
      if (o === undefined) return null;
      if (o === "burned") return { data: [Buffer.from([0]).toString("base64"), "base64"], owner: CORE, lamports: 1, executable: false };
      return { data: [Buffer.concat([Buffer.from([1]), decode(o)]).toString("base64"), "base64"], owner: CORE, lamports: 1, executable: false };
    }),
  });
};

const { custodyOfListings } = await import(pathToFileURL(path.join(root, "dist/lib/custody.js")).href);

let passed = 0;
let n = 0;
// Every case uses fresh addresses, so nothing is answered from a cache.
async function verdict({ owner, program, seller, venue, failPrograms = false }) {
  n++;
  const mint = key(`mint-${n}`);
  const sellerKey = seller === null ? null : key(`seller-${n}`);
  const ownerKey = owner === "seller" ? sellerKey : owner === "escrow" ? ESCROW : owner === "burned" ? "burned" : key(`owner-${n}`);
  itemOwner.set(mint, ownerKey);
  if (program) ownerProgram.set(ownerKey, program);
  failProgramRead = failPrograms;
  const [c] = await custodyOfListings([{ mint, seller: sellerKey }], { venue, fresh: true });
  failProgramRead = false;
  return c;
}
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

try {
  // Controls first: the plain verdicts still come out.
  assert.equal((await verdict({ owner: "seller" })).state, "backed");
  assert.equal((await verdict({ owner: "escrow" })).state, "backed");
  const moved = await verdict({ owner: "wallet", program: SYSTEM });
  assert.equal(moved.state, "not-backed");
  assert.equal(moved.reason, "moved");
  const noSol = await verdict({ owner: "wallet-without-an-account" });
  assert.equal(noSol.state, "not-backed", "a new wallet that holds no SOL has no account, and is still a wallet");
  assert.equal((await verdict({ owner: "burned" })).reason, "burned");
  ok("held by the seller, in escrow, moved to a wallet and burned each get their verdict");

  const unread = await verdict({ owner: "listing-account", program: OPENSEA, failPrograms: true });
  assert.equal(unread.state, "unread", `a failed second read gave ${unread.state}: ${unread.why}`);
  assert.doesNotMatch(unread.why, /cannot be bought/);
  ok("when the owner's kind cannot be read the listing is unread, never 'cannot be bought'");

  const onOpenSea = await verdict({ owner: "listing-account", program: OPENSEA, venue: "opensea" });
  assert.equal(onOpenSea.state, "backed");
  const onMagicEden = await verdict({ owner: "listing-account", program: OPENSEA, venue: "magiceden" });
  assert.equal(onMagicEden.state, "not-backed");
  assert.equal(onMagicEden.reason, "opensea-listing");
  ok("an OpenSea listing account backs an OpenSea listing and not a Magic Eden one");

  const noSeller = await verdict({ owner: "wallet", program: SYSTEM, seller: null });
  assert.equal(noSeller.state, "not-checked", `a listing with no seller gave ${noSeller.state}`);
  ok("a listing that names no seller is not checked, because there is nothing to compare");

  const pool = await verdict({ owner: "pool", program: ME_POOLS });
  assert.equal(pool.state, "not-checked", `a pool-held item gave ${pool.state}: ${pool.why}`);
  const strange = await verdict({ owner: "program-account", program: UNKNOWN_PROGRAM });
  assert.equal(strange.state, "not-checked");
  const elsewhere = await verdict({ owner: "tensor-account", program: TENSOR });
  assert.equal(elsewhere.state, "not-backed");
  assert.equal(elsewhere.reason, "other-program");
  ok("an item in a Magic Eden pool or an unknown program's account gets no verdict; one in another marketplace's account is not backed");

  // The second read is one request for the whole page, not one per listing.
  programReads = 0;
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const mint = key(`bulk-mint-${i}`);
    const owner = key(`bulk-owner-${i}`);
    itemOwner.set(mint, owner);
    ownerProgram.set(owner, SYSTEM);
    rows.push({ mint, seller: key(`bulk-seller-${i}`) });
  }
  const all = await custodyOfListings(rows, { fresh: true });
  assert.equal(all.filter((c) => c.state === "not-backed").length, 60);
  assert.equal(programReads, 1, `sixty foreign owners took ${programReads} requests`);
  ok("sixty moved items are explained with one extra request");
} finally {
  globalThis.fetch = realFetch;
}
console.log(`custody-verdicts: ${passed} blocks passed`);
