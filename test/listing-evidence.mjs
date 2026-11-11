import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';

const root=resolve(process.argv[2]||'.');
const home=mkdtempSync(join(tmpdir(),'solana-nft-mcp-evidence-'));
Object.assign(process.env,{HOME:home,USERPROFILE:home,SOLANA_NFT_MCP_NO_AUTO_KEYS:'1',SOLANA_NFT_MCP_NO_UPDATE_CHECK:'1',SOLANA_RPC_URL:'https://evidence.fixture.invalid'});
delete process.env.SOLANA_NFT_MCP_OFFLINE;
const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encode=b=>{let n=BigInt('0x'+b.toString('hex')),s='';while(n){s=chars[Number(n%58n)]+s;n/=58n;}return s;};
const key=s=>encode(createHash('sha256').update(s).digest());
const seller=key('listing-seller'),owner=key('listing-owner');
const decode=s=>{let n=0n;for(const c of s)n=n*58n+BigInt(chars.indexOf(c));return Buffer.from(n.toString(16).padStart(64,'0'),'hex');};
const CORE='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const SYSTEM='11111111111111111111111111111111';
const accounts=new Map(),books=new Map();let sequence=0;
function book(kind,prices=[1]){
 const symbol=`evidence_${++sequence}`;
 const rows=prices.map((price,i)=>{
  const mint=key(`${symbol}-${i}`);
  const account=kind==='missing'?null:{owner:kind==='legacy'?SYSTEM:CORE,data:[Buffer.concat([Buffer.from([1]),decode(kind==='pool'?owner:seller)]).toString('base64'),'base64'],lamports:1,executable:false};
  accounts.set(mint,account);
  return {tokenMint:mint,seller:kind==='no-seller'?undefined:seller,price,token:{name:'Card (1/10)',attributes:[]}};
 });books.set(symbol,rows);return symbol;
}
accounts.set(owner,{owner:'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc',data:['','base64'],lamports:1,executable:false});
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));
 if(u.hostname==='api-mainnet.magiceden.dev'){
  const symbol=u.pathname.split('/')[3];
  if(u.pathname.endsWith('/stats'))return Response.json({symbol,floorPrice:1e9,listedCount:3,volumeAll:2e9});
  if(u.pathname.endsWith('/listings'))return Response.json(books.get(symbol)??[]);
  throw new Error(`Unexpected fixture route: ${u.pathname}`);
 }
 const b=JSON.parse(init.body);
 if(b.method==='getMultipleAccounts')return Response.json({jsonrpc:'2.0',id:b.id,result:{context:{slot:100},value:b.params[0].map(a=>accounts.get(a)??null)}});
 throw new Error(`Unexpected fixture method: ${b.method}`);
};
const {checkedFloor}=await import(pathToFileURL(resolve(root,'dist/lib/custody.js')).href);
const {custodyOfListings}=await import(pathToFileURL(resolve(root,'dist/lib/custody.js')).href);
const {verifyClaim,buildReceipt}=await import(pathToFileURL(resolve(root,'dist/verify.js')).href);
const {PROMPT_TEXTS}=await import(pathToFileURL(resolve(root,'dist/prompts.js')).href);
const {reconcileFloors}=await import(pathToFileURL(resolve(root,'dist/lib/reconcile.js')).href);
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log(`PASS ${name}`);}catch(e){failed++;console.log(`FAIL ${name}: ${e.message}`);}}
for(const kind of ['legacy','missing','pool','no-seller'])for(const claimed of [1,2])await check(`${kind} listing leaves a floor claim unverifiable at ${claimed} SOL`,async()=>{
 const r=await verifyClaim({claim:'floor',subject:book(kind),value:claimed});
 assert.equal(r.verdict,'unverifiable',JSON.stringify({verdict:r.verdict,explanation:r.explanation,receipt:r.receipt}));
});
for(const prices of [[null],[0],[-1],['1'],[null,0,-1],[null,1]])await check(`unusable prices ${JSON.stringify(prices)} do not prove stale custody`,async()=>{
 const r=await checkedFloor(book('seller',prices),1);
 assert.equal(r.checked,false,JSON.stringify({status:r.status,checked:r.checked,sentence:r.sentence}));
 assert.equal(r.status,'unread');assert.doesNotMatch(r.sentence,/every one the chain shows|can be bought:|one of those stale/);
});
await check('a backed priced listing still confirms a floor',async()=>{const r=await verifyClaim({claim:'floor',subject:book('seller'),value:1});assert.equal(r.verdict,'confirmed');});
await check('a backed priced listing still contradicts a different floor',async()=>{const r=await verifyClaim({claim:'floor',subject:book('seller'),value:2});assert.equal(r.verdict,'contradicted');});
await check('the starter prompt describes asks without assigning worth',()=>{assert.doesNotMatch(PROMPT_TEXTS.getting_started,/what a collection is worth at floor/);assert.match(PROMPT_TEXTS.getting_started,/ask|asking/);});
await check('an ownership receipt includes its UTC read time',()=>{
 const r=buildReceipt({claim:'owns item',subject:seller,verdict:'confirmed',explanation:'',evidence:[{source:'Solana account',method:'owner bytes',observed:seller}],reproduce:'',caveats:[]},new Date('2026-11-11T19:34:00Z'));
 assert.match(r,/2026-11-11T19:34/);
});
for(const encoding of ['base58','base64+zstd',null])await check(`an account tagged ${encoding} cannot establish listing custody`,async()=>{
 const mint=key(`encoding-${encoding}`);accounts.set(mint,{owner:CORE,data:[Buffer.concat([Buffer.from([1]),decode(seller)]).toString('base64'),encoding]});
 const [r]=await custodyOfListings([{mint,seller}],{fresh:true});assert.equal(r.state,'unread',JSON.stringify(r));
});
await check('invalid base64 cannot establish listing custody',async()=>{
 const mint=key('bad-base64');accounts.set(mint,{owner:CORE,data:[Buffer.concat([Buffer.from([1]),decode(seller)]).toString('base64')+'!','base64']});
 const [r]=await custodyOfListings([{mint,seller}],{fresh:true});assert.equal(r.state,'unread',JSON.stringify(r));
});
await check('a hundred comparison witnesses do not overflow a normal answer',()=>{
 const r=reconcileFloors([{source:'magiceden',value:1,currency:'SOL',listing:{mint:key('best'),maker:seller},alsoListed:Array.from({length:100},(_,i)=>({mint:key(`witness-${i}`),maker:key(`maker-${i}`)}))},{source:'opensea',value:2,currency:'SOL',listing:{mint:key('different'),maker:seller}}]);
 const bytes=Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(r,null,2)}],structuredContent:r}));
 assert.ok(bytes<=60000,`${bytes} bytes for one comparison`);
 assert.equal(r.spreadPct,100);
});
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
