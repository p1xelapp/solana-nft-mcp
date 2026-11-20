import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const target = resolve(process.argv[2] ?? ".");
const home = process.env.SOLANA_NFT_MCP_TEST_HOME || join(tmpdir(), "solana-nft-claim-reads");
const col = "EmFy7YohG4GZxgE5DEDgHuuvibqXK2jRLcXcJa3RvDRX";
const empty = "58BZER6WANRWCvJCFXLSgWBz29dcPnR8RvSmN7LT2Mut";
const item = "59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4";
const owner = "AgJbH68itZ7VzsCxhMvW3d3ebddXi3sjTMjrgPEV6n1B";
const compressed = "GDEC7TRDAdU1BUhSSAK2WLc5DqLSCCcq6W2b7rVpfHcS";
const sale = { claim: "sale", item: "AUjRXCikevZrK7JPEvgPE3HquYyYc2WF51pmS2ZuiQF9", subject: "5wrdbZQqjeqDGM1UuPe9eXJYPc1ZyM5d4ho55pqaVoq7qHmUou2j1wnyryA8qZcX8wn5ueV3TJNUbRn5PKVT63nZ" };
async function session(unavailable = "") {
  const client = new Client({ name: "collector-questions", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./helpers/claim-reads.mjs", import.meta.url).href, resolve(target,"dist/index.js")],
    stderr: "ignore",
    env: { HOME: home, USERPROFILE: home, SOLANA_NFT_MCP_NO_AUTO_KEYS: "1", SOLANA_NFT_MCP_NO_UPDATE_CHECK: "1", UNAVAILABLE_READ: unavailable },
  });
  await client.connect(transport);
  return client;
}
const call = (c, name, args) => c.callTool({ name, arguments: args });
const claim = async (c, args) => (await call(c, "verify_claim", args)).structuredContent;
async function check(name, fn) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { console.log("FAIL", name, String(e.message).slice(0,220)); process.exitCode = 1; }
}
const c = await session();
try {
  await check("zero is a valid collection count", async () => {
    assert.equal((await claim(c,{claim:"supply",subject:empty,value:0}))?.verdict,"confirmed");
    assert.equal((await claim(c,{claim:"supply",subject:col,value:0})).verdict,"contradicted");
    assert.equal((await claim(c,{claim:"supply",subject:col,value:2468})).verdict,"confirmed");
  });
  await check("currency-only sale receipts name the claim they judged", async () => {
    for (const [currency,verdict] of [["USDC","contradicted"],["SOL","confirmed"]]) {
      const r=await claim(c,{...sale,currency});
      assert.equal(r.verdict,verdict);
      assert.match(r.claim,new RegExp(currency));
      assert.ok(r.receipt.includes(r.claim));
    }
  });
  await check("sale receipts refuse a wallet they cannot check as a claim", async () => {
    assert.equal((await call(c,"verify_claim",{...sale,wallet:col})).isError,true);
    assert.equal((await claim(c,sale)).verdict,"confirmed");
  });
  await check("a checked ask describes custody and discloses execution limits", async () => {
    const r=await claim(c,{claim:"floor",subject:"gold_series_auction_1_candy_digital",value:0.316010094});
    assert.equal(r.verdict,"confirmed");
    assert.doesNotMatch(JSON.stringify(r),/can be bought|nobody can buy at those prices/);
    assert.match(JSON.stringify(r),/transfer rules|execution|could execute/i);
  });
  await check("a holder census fits on the wire with full counts", async () => {
    const r=await call(c,"get_collection_holders",{collection:col,max:100});
    assert.equal(r.structuredContent?.matched,100);
    const size=Buffer.byteLength(JSON.stringify(r));
    assert.ok(size<=60000,"returned "+size+" bytes");
    assert.equal(r.structuredContent.assets.length+r.structuredContent.assetsOmitted,100);
    assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);
  });
  await check("validation gives a repair and the receipt schema names every verdict", async () => {
    const bad=await call(c,"get_asset",{mint:null});
    assert.equal(bad.isError,true);
    assert.match(bad.content[0].text,/Use text for "mint"/);
    const tool=(await c.listTools()).tools.find(t=>t.name==="verify_claim");
    assert.ok(tool.outputSchema.oneOf.some((shape)=>shape.required.includes("verdict")));
    const refused=await call(c,"verify_claim",{...sale,wallet:col});
    assert.equal(refused.isError,true);
    assert.ok(refused.structuredContent.error);
    assert.equal((await claim(c,sale)).verdict,"confirmed");
  });
  await check("prompt discovery describes asks in the wallet report", async () => {
    const {prompts}=await c.listPrompts();
    assert.equal(prompts.length,3);
    assert.doesNotMatch(prompts.find(p=>p.name==="wallet_report").description,/worth at floor/);
  });
  await check("an identified item does not trigger collection slug probes", async () => {
    const r=(await call(c,"identify",{query:item})).structuredContent;
    assert.equal(r.kind,"core-asset");
    assert.equal(r.checked.find(x=>x.source==="magiceden" && x.looked_for.includes("symbol"))?.result,"skipped");
  });
  await check("identify refuses a paste containing only invisible characters", async () => {
    const emptyQuery=await call(c,"identify",{query:"\u200b\u202e"});
    assert.equal(emptyQuery.isError,true);
    assert.match(emptyQuery.structuredContent.message,/nothing to identify/i);
    assert.ok(emptyQuery.structuredContent.next);
    assert.equal((await call(c,"identify",{query:item})).structuredContent.kind,"core-asset");
  });
  await check("quiet-market guidance allows for relayed Tensor fills",async()=>{
    const events=JSON.parse(readFileSync(new URL("./fixtures/reads-2026-11-19/claynosaurz-buys.json",import.meta.url)));
    assert.ok(events.some(e=>e.source==="tensortrade" && e.type==="buyNow"));
    assert.ok(events.some(e=>e.source==="magiceden_v2" && e.type==="buyNow"));
    const r=(await call(c,"explain_mechanics",{topic:"quiet collection"})).structuredContent;
    assert.match(JSON.stringify(r.entries),/Magic Eden reports some Tensor fills/);
  });
} finally { await c.close(); }
const down=await session("batman-owner");
try {
  await check("unread holder classification leaves indirect ownership open",async()=>{
    assert.equal((await claim(down,{claim:"ownership",subject:item,wallet:col})).verdict,"unverifiable");
    assert.equal((await claim(down,{claim:"ownership",subject:item,wallet:owner})).verdict,"confirmed");
    assert.equal((await claim(down,{claim:"ownership",subject:item,wallet:col})).evidence.length>0,true);
  });
} finally { await down.close(); }
const noSupply=await session("batman-account");
try {
  await check("an unavailable supply account has no standard verdict",async()=>{
    const r=await claim(noSupply,{claim:"supply",subject:col,value:2468});
    assert.equal(r.verdict,"unverifiable");
    assert.match(r.explanation,/could not (?:be )?read|did not answer/);
    assert.doesNotMatch(r.explanation,/does not decode/);
    assert.equal((await claim(noSupply,{claim:"supply",subject:empty,value:1})).verdict,"contradicted");
  });
} finally { await noSupply.close(); }
const noIndex=await session("compressed-index");
try {
  await check("a missing account and an unread index leave the asset unknown",async()=>{
    const r=await call(noIndex,"get_asset_trust",{mint:compressed});
    assert.equal(r.isError,true);
    assert.equal(r.structuredContent?.error,"upstream-unavailable");
    assert.match(r.content[0].text,/asset index could not be read/);
    assert.equal((await claim(noIndex,{claim:"ownership",subject:item,wallet:owner})).verdict,"confirmed");
  });
} finally { await noIndex.close(); }
