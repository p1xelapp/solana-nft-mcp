// An issued OpenSea key longer than the stored-key limit is refused before it
// is saved. A normal-length key goes through first, so the refusal cannot pass
// just because issuance failed for some other reason.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]||fileURLToPath(new URL('..', import.meta.url)));
let home=fs.mkdtempSync(path.join(os.tmpdir(),'key-size-'));
os.homedir=()=>home;syncBuiltinESMExports();
delete process.env.OPENSEA_API_KEY;delete process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS;
let issued='';
globalThis.fetch=async()=>new Response(JSON.stringify({api_key:issued,expires_at:new Date(Date.now()+7*86400000).toISOString()}),{headers:{'content-type':'application/json'}});
const sea=await import(pathToFileURL(path.join(root,'dist/sources/opensea.js')));
const keyFile=()=>path.join(home,'.solana-nft-mcp','opensea-key.json');
let failures=0;
const check=(b,d)=>{console.log(`${b?'PASS':'FAIL'} ${d}`);if(!b)failures++;};

issued='k'.repeat(100);
check(await sea.ensureKey()===issued,'control: a 100-character issued key is accepted');

home=fs.mkdtempSync(path.join(os.tmpdir(),'key-size-'));sea.resetKeyCache();
issued='x'.repeat(20000);
const accepted=await sea.ensureKey()!==null;
const bytes=fs.existsSync(keyFile())?fs.statSync(keyFile()).size:0;
check(!accepted&&bytes===0,`oversized issued key refused; persistedBytes=${bytes}`);
process.exitCode=failures?1:0;
