// Offline integration tests for previously unexecuted reads and scan limits.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { start,call } from './helpers/fake-server.mjs';
const base=process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
const MINT='59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4';
let passed=0,failed=0;
async function check(name,fn) {try{await fn();passed++;console.log(`PASS ${name}`);}catch(e){failed++;console.log(`FAIL ${name}: ${e.message}`);}}
async function fixture(mode,fn) {const s=await start(mode,base);try{await fn(s);}finally{await s.close();}}
await check('sales survive a page containing only transfers',()=>fixture('crowded',async s=>{
  const r=await call(s,'get_recent_sales',{collection:'mad_lads',limit:10});assert(!r.error);assert.equal(r.data.sales.length,1);assert.equal(r.data.activitiesScanned,101);
}));
await check('repeated non-sale page stops with incomplete coverage',()=>fixture('repeat-nonsales',async s=>{
  const r=await call(s,'get_recent_sales',{collection:'mad_lads'});assert(!r.error);assert.equal(r.data.coverage.repeatedPage,true);assert(!/quiet.*market/.test(r.data.note));
  const req=await s.control('requests');assert.equal(req.filter(x=>x.path.endsWith('/activities')).length,2);
}));
await check('five-page cap is disclosed instead of calling a market quiet',()=>fixture('cap-nonsales',async s=>{
  const r=await call(s,'get_recent_sales',{collection:'mad_lads'});assert(!r.error);assert.equal(r.data.coverage.budgetReached,true);assert.equal(r.data.activitiesScanned,500);assert(!/quiet.*market/.test(r.data.note));
}));
for(const profile of ['unlocked','oracle-missing','oracle-unread']) await check(`${profile} oracle is read over stdio`,()=>fixture(profile,async s=>{
  const r=await call(s,'get_asset_trust',{mint:MINT});assert(!r.error);assert(!r.data.blockedByOracle.includes('transfer'));assert(r.data.oracleChecks.length>0);
  if(profile==='oracle-unread') {assert.equal(r.data.incomplete,true);assert.equal(r.data.oracleChecks[0].reading.state,'unread');}
  else {assert.deepEqual(r.data.blockedByOracle,['burn']);assert.equal(r.data.oracleChecks[0].reading.state,profile==='oracle-missing'?'missing':'answered');}
  if(profile==='unlocked') assert(Number.isInteger(r.data.oracleChecks[0].reading.slot));
}));
await check('wallet migration is a transfer without an inferred sale',()=>fixture('migration',async s=>{
  const r=await call(s,'get_asset_provenance',{mint:MINT,depth:5});assert(!r.error);assert(r.data.events.some(e=>e.event==='transferred'));assert(!r.data.events.some(e=>/sale|sold|bought|minted/.test(e.event)));assert.equal(r.data.mintObserved,false);
}));
await check('oversized text-only response is refused',async()=>{
  const { readBoundedText,MAX_BODY_BYTES,OversizedBodyError }=await import(pathToFileURL(resolve(base,'dist/lib/http.js')));
  await assert.rejects(()=>readBoundedText({headers:new Headers(),body:null,text:async()=>'x'.repeat(MAX_BODY_BYTES+1)},'fixture'),OversizedBodyError);
});
await check('Candy mechanics do not assign every delegate to every card',async()=>{
  const { MECHANICS }=await import(pathToFileURL(resolve(base,'dist/mechanics.js')));
  const e=MECHANICS.find(e=>e.id==='venue-candy-custody');
  // The entry may name the collection-level transfer delegate it observed,
  // but must send per-card questions to get_asset_trust rather than claim
  // burn or freeze delegates on every card.
  assert(!/(burn|freeze)[^.]*every card|every card[^.]*(burn|freeze) delegate/i.test(e.plain),'a sampled card has no permanent burn delegate');
  assert.match(e.plain, /get_asset_trust/);
  assert.match(e.plain, /2026-11-08/);
});
await check('matching printed serials retain distinct mint identities',()=>fixture('duplicate-serial',async s=>{
  const r=await call(s,'find_listings',{symbol:'mad_lads',limit:3,lowestSerials:true});assert(!r.error);
  const matches=r.data.lowestSerials.filter(x=>x.serial===12);
  assert.equal(matches.length,2);assert.notEqual(matches[0].tokenMint,matches[1].tokenMint);
}));
console.log(`sales-coverage: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
