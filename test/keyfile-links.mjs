import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]||'.');
const parent=os.tmpdir();
const run=fs.mkdtempSync(path.join(parent,'keyfile-'));
let home=run;
os.homedir=()=>home;
syncBuiltinESMExports();
delete process.env.OPENSEA_API_KEY;
delete process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS;
const sea=await import(pathToFileURL(path.join(root,'dist/sources/opensea.js')));
const key=['synthetic','disk','canary','12345'].join('-');
const stored=()=>JSON.stringify({key,source:'opensea-agent-key',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString()});
globalThis.fetch=async()=>new Response(JSON.stringify({api_key:key,expires_at:new Date(Date.now()+7*86400000).toISOString()}),{headers:{'content-type':'application/json'}});
let failures=0;
const check=(n,b,d='')=>{console.log(`${b?'PASS':'FAIL'} ${n} ${d}`);if(!b)failures++;};
const fresh=name=>{home=path.join(run,name);fs.mkdirSync(path.join(home,'.solana-nft-mcp'),{recursive:true});sea.resetKeyCache();return path.join(home,'.solana-nft-mcp','opensea-key.json');};
for(const mode of ['corrupt','empty','directory','oversized']) {
  const file=fresh(mode);
  if(mode==='directory')fs.mkdirSync(file);else fs.writeFileSync(file,mode==='corrupt'?'{broken':mode==='empty'?'':'x'.repeat(17000));
  check(mode,!sea.openSeaState().enabled,'ignored as cached key');
  check(mode,await sea.ensureKey()===key,'mock issuance remains usable');
  check(mode,sea.openSeaState().persisted === (mode!=='directory'),'persistence state accurate');
}
{
 const file=fresh('regular');
 await sea.ensureKey();
 console.log(`platform=${process.platform} mode=${(fs.statSync(file).mode&0o777).toString(8)} O_NOFOLLOW=${fs.constants.O_NOFOLLOW??'absent'}`);
 
}
{
 const file=fresh('leaf-link'),target=path.join(run,'target-key.json');fs.writeFileSync(target,stored());
 try {fs.symlinkSync(target,file,'file');check('check',!sea.openSeaState().enabled,'leaf symlink refused');}
 catch(e) {console.log(`SKIP leaf symlink creation ${e.code}`);}
}
{
 home=path.join(run,'parent-link');fs.mkdirSync(home);
 const target=path.join(run,'junction-target');fs.mkdirSync(target);
 fs.symlinkSync(target,path.join(home,'.solana-nft-mcp'),process.platform==='win32'?'junction':'dir');
 sea.resetKeyCache();await sea.ensureKey();
 check('check',!fs.existsSync(path.join(target,'opensea-key.json')),'key directory link not followed on write');
 fs.writeFileSync(path.join(target,'opensea-key.json'),stored());sea.resetKeyCache();
 check('check',!sea.openSeaState().enabled,'key directory link not followed on read');
}
console.log(JSON.stringify({readAt:new Date().toISOString(),failures}));process.exitCode=failures?1:0;
