import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { install, key, MMM, OS, SYSTEM } from './helpers/marketplace-state-preload.mjs';
const project=path.resolve(import.meta.dirname,'..');
const root=path.resolve(process.argv[2]??project);
const load=name=>import(pathToFileURL(path.join(root,'dist',name+'.js')).href);
delete process.env.SOLANA_RPC_URL; delete process.env.SOLANA_NFT_MCP_OFFLINE;
const f=install();
const {checkedFloor,custodyOfListings}=await load('lib/custody');
const {verifyClaim}=await load('verify');
const {reconcileFloors}=await load('lib/reconcile');
const {summarizeActivity}=await load('wallet');
const {MECHANICS}=await load('mechanics');
let passed=0,failed=0;
async function check(name,fn) {try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
await check('Tensor Core custody links its published implementation',()=>{
  const entry=MECHANICS.find(x=>x.id==='venue-tensor-custody');
  assert.equal(entry.verified,true);
  assert.match(entry.source,/tensor-foundation\/marketplace\/.*mpl_core\/list\.rs$/);
  assert.doesNotMatch(JSON.stringify(entry),/not published|undocumented|not published as readable source/);
});
await check('a readable seller-held listing can confirm a floor',async()=>{
  f.row('current-control');const r=await verifyClaim({claim:'floor',subject:'current-control',value:1});assert.equal(r.verdict,'confirmed');
});
await check('a floor receipt refreshes custody after an owner changes',async()=>{
  const row=f.row('moved-after-read');await checkedFloor('moved-after-read',1);
  f.owners.set(row.tokenMint,key('new-owner'));f.programs.set(key('new-owner'),SYSTEM);
  const before=f.reads.assets;const r=await verifyClaim({claim:'floor',subject:'moved-after-read',value:1});
  assert.equal(r.verdict,'unverifiable',JSON.stringify({verdict:r.verdict,newAssetReads:f.reads.assets-before}));
});
await check('a floor receipt refreshes a withdrawn listing book',async()=>{
  f.row('withdrawn-after-read');await checkedFloor('withdrawn-after-read',1);f.books.set('withdrawn-after-read',[]);
  const before=f.reads.books;const r=await verifyClaim({claim:'floor',subject:'withdrawn-after-read',value:1});
  assert.equal(r.verdict,'unverifiable',JSON.stringify({verdict:r.verdict,newBookReads:f.reads.books-before}));
});
await check('unread pool custody cannot confirm or contradict a floor',async()=>{
  const pool=key('pool');f.programs.set(pool,MMM);f.row('pool-floor',pool);
  const r=await verifyClaim({claim:'floor',subject:'pool-floor',value:1});assert.equal(r.verdict,'unverifiable',r.explanation);
});
await check('a legacy floor without a custody read stays unverifiable',async()=>{
  f.row('legacy-floor','legacy');const r=await verifyClaim({claim:'floor',subject:'legacy-floor',value:2});assert.equal(r.verdict,'unverifiable',r.explanation);
});
await check('a book with no usable prices is not declared entirely stale',async()=>{
  f.row('bad-price','seller',null);const r=await checkedFloor('bad-price',1);
  assert.equal(r.status,'unread',JSON.stringify({status:r.status,checked:r.checked,sentence:r.sentence}));assert.equal(r.checked,false);
});
await check('a fresh OpenSea custody check does not reuse an unread owner program',async()=>{
  const owner=key('os-account');f.programs.set(owner,OS);const row=f.row('os-fresh',owner);
  assert.equal((await custodyOfListings([{mint:row.tokenMint,seller:row.seller}],{venue:'opensea',fresh:true}))[0].state,'backed');
  f.failPrograms=true;
  try { const r=(await custodyOfListings([{mint:row.tokenMint,seller:row.seller}],{venue:'opensea',fresh:true}))[0];assert.equal(r.state,'unread',r.why); }
  finally { f.failPrograms=false; }
});
await check('one hundred stale listings disclose unread higher asks',async()=>{
  const rows=[];for(let i=0;i<100;i++) {const r=f.row('bounded-'+i,key('bounded-owner'),i+1);rows.push(r);}
  f.books.set('bounded-book',rows);f.programs.set(key('bounded-owner'),SYSTEM);
  const r=await checkedFloor('bounded-book',1);assert.equal(r.status,'none-backed');assert.equal(r.floorSol,null);assert.match(r.sentence,/further up/);
});
await check('a remaining unread venue floor is not called buyable',()=>{
  const r=reconcileFloors([{source:'magiceden',value:1,currency:'SOL',listingCustody:'not-backed'},{source:'opensea',value:2,currency:'SOL',listingCustody:'unread'}]);
  assert.doesNotMatch(r.verdict,/chain shows can be bought/);
});
await check('pool price differences do not claim to exclude royalties',()=>{
  const wallet=key('pool-buyer'),mint=key('pool-item');
  const r=summarizeActivity(wallet,[{type:'buyNow',source:'mmm',tokenMint:mint,buyer:key('next-buyer'),seller:wallet,price:2,blockTime:200},{type:'buyNow',source:'mmm',tokenMint:mint,buyer:wallet,seller:key('pool-seller'),price:1.1,blockTime:100}],false);
  assert.equal(r.realized.pnlSol,0.9);
  assert.doesNotMatch(r.realized.note+' '+r.caveats.join(' '),/before (?:marketplace )?fees and royalties/);
});
f.restore();
const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function custodyKey(label){let n=BigInt('0x'+createHash('sha256').update('custody-'+label).digest('hex')),s='';while(n){s=chars[Number(n%58n)]+s;n/=58n;}return s;}
async function session(profile) {
  const home=fs.mkdtempSync(path.join(tmpdir(),'solana-nft-mcp-market-state-'));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(path.join(project,'test/helpers/marketplace-state-preload.mjs')).href,path.join(root,'dist/index.js')],env:{...process.env,HOME:home,USERPROFILE:home,SOLANA_NFT_MCP_TEST_HOME:home,MARKET_STATE_PROFILE:profile,SOLANA_NFT_MCP_NO_AUTO_KEYS:'1',SOLANA_NFT_MCP_NO_UPDATE_CHECK:'1',OPENSEA_API_KEY:'fixture-not-a-credential',SOLANA_RPC_URL:'https://custody-rpc.invalid',DAS_RPC_URL:'https://custody-rpc.invalid'},stderr:'ignore'});
  const client=new Client({name:'marketplace-state',version:'1'});await client.connect(transport);
  return {close:()=>client.close(),call:async(name,args)=>{const r=await client.callTool({name,arguments:args},undefined,{timeout:60000});assert.equal(r.isError,undefined,JSON.stringify(r.structuredContent));return r.structuredContent;}};
}
await check('unread holder programs remain unknown in the census',async()=>{
  const s=await session('holder-unread');try{
    const r=await s.call('get_collection_holders',{collection:custodyKey('collection')});
    assert.equal(r.heldByCollectors,0,JSON.stringify({heldByCollectors:r.heldByCollectors,heldByUnknownRole:r.heldByUnknownRole,rolesIncomplete:r.rolesIncomplete}));assert.equal(r.rolesIncomplete,true);
  }finally{await s.close();}
});
const s=await session('sales');
try {
  await check('floor receipts accept symbols with hyphens and dots',async()=>{
    const r=await s.call('verify_claim',{claim:'floor',subject:'custody-fixture.v2',value:1});
    assert.equal(r.subject,'custody-fixture.v2');
  });
  await check('floor receipts normalize symbol case',async()=>{
    const r=await s.call('verify_claim',{claim:'floor',subject:'Custody_Fixture',value:1});
    assert.equal(r.subject,'custody_fixture');
  });
  const r=await s.call('get_recent_sales',{collection:'custody-fixture',openseaSlug:'custody-os',limit:10});
  await check('a price disagreement does not invent a fee explanation',()=>assert.doesNotMatch(r.opensea.sales[0].sameTransactionNote,/figure includes the royalty|fee paid on top/));
  await check('different sale currencies are not described as equal prices',()=>assert.doesNotMatch(r.opensea.sales[1].sameTransactionNote,/Both feeds give it the same price/));
  await check('an unidentified item in a multi-fill transaction is not merged',()=>assert.equal(r.opensea.sales[2].sameTransactionAs,undefined));
  await check('different parties in the same transaction are not the same fill',()=>assert.equal(r.opensea.sales[3].sameTransactionAs,undefined));
  await check('unread sale parties do not establish the same fill',()=>assert.equal(r.opensea.sales[4].sameTransactionAs,undefined));
  await check('cross-feed counting keeps each item in a multi-fill transaction',()=>assert.doesNotMatch(r.opensea.sameTransactionsNote,/count each signature once/));
} finally {await s.close();}
console.log(`marketplace-state: ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
