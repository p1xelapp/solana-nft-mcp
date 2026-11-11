import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const home=mkdtempSync(join(tmpdir(),'solana-nft-mcp-account-'));
Object.assign(process.env,{HOME:home,USERPROFILE:home,SOLANA_RPC_URL:'https://account.fixture.invalid',SOLANA_NFT_MCP_NO_AUTO_KEYS:'1',SOLANA_NFT_MCP_NO_UPDATE_CHECK:'1'});
delete process.env.SOLANA_NFT_MCP_OFFLINE;
let result={};
globalThis.fetch=async(_input,init)=>Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result});
const {getCoreAccountRaw}=await import(pathToFileURL(resolve(process.argv[2]||'.','dist/sources/solana.js')).href);
const mint='59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4';
let passed=0,failed=0;
for(const value of [{},null,{context:{slot:100}}]){
 result=value;
 try{await assert.rejects(getCoreAccountRaw(mint),/account response|not answering/);passed++;console.log(`PASS incomplete account result ${JSON.stringify(value)} stays unread`);}catch(e){failed++;console.log(`FAIL incomplete account result ${JSON.stringify(value)} became absence: ${e.message}`);}
}
result={context:{slot:100},value:null};assert.equal(await getCoreAccountRaw(mint),null);passed++;console.log('PASS explicit null account remains a successful absence read');
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
