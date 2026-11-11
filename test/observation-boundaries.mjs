import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]||'.');
const home=mkdtempSync(join(tmpdir(),'solana-nft-mcp-boundaries-'));
Object.assign(process.env,{HOME:home,USERPROFILE:home,SOLANA_NFT_MCP_NO_AUTO_KEYS:'1',SOLANA_NFT_MCP_NO_UPDATE_CHECK:'1'});
delete process.env.DAS_RPC_URL;delete process.env.SOLANA_RPC_URL;delete process.env.SOLANA_NFT_MCP_OFFLINE;
const canary='8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K';
const mint='59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4';
let code=-32603,mode='error';
globalThis.fetch=async(input,init)=>{
 const b=JSON.parse(init.body);
 return Response.json({jsonrpc:'2.0',id:b.id,...(b.params.id===canary?{result:{id:canary}}:mode==='empty'?{result:null}:mode==='missing'?{error:{code:-32000,message:'Database Error: RecordNotFound Error: Asset not found'}}:mode==='found'?{result:{id:mint,interface:'MplCoreAsset',ownership:{owner:canary},content:{metadata:{name:'Card'}}}}:{error:{code,message:'asset not found in temporarily unavailable index shard'}})});
};
const {getAsset}=await import(pathToFileURL(resolve(root,'dist/sources/das.js')).href);
const {MECHANICS}=await import(pathToFileURL(resolve(root,'dist/mechanics.js')).href);
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log(`PASS ${name}`);}catch(e){failed++;console.log(`FAIL ${name}: ${e.message}`);}}
await check('an internal index failure mentioning not found is still a failed read',async()=>{await assert.rejects(getAsset(mint),/did not answer/);});
await check('a node-behind failure mentioning not found is still a failed read',async()=>{code=-32005;await assert.rejects(getAsset(mint),/did not answer/);});
await check('a recovered index can answer after a failed read',async()=>{mode='found';const r=await getAsset(mint);assert.equal(r.asset?.id,mint,'a failure must not cache an absent asset');});
await check('an explicit missing asset remains distinct from an outage',async()=>{mode='missing';const r=await getAsset('BEZZtuZt2i28mBjEhUiR1dsJmbH85FMYrCwY8amBKBba');assert.equal(r.asset,null);});
await check('an empty index reply is a failed read, not a missing asset',async()=>{mode='empty';await assert.rejects(getAsset('7jNwdBaQwsVyqKxPRLRBWccnGPQtJkXMdrQz5mbkWWt'),/empty result/);});
await check('plugin family guidance agrees with the specific delegate entries',()=>{
 const family=MECHANICS.find(x=>x.id==='standard-core-plugin-classes');
 assert.doesNotMatch(family.plain,/never go away|fall away when/);
 assert.match(family.plain,/remov|permission/);
});
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
