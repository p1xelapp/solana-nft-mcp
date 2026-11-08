// Candy after the unlock: regressions use recorded chain bytes and offline feeds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? resolve(process.argv[2]) : root;
process.env.SOLANA_NFT_MCP_NO_AUTO_KEYS = '1';
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = '1';
delete process.env.SOLANA_RPC_URL;
delete process.env.DAS_RPC_URL;
const load = name => import(pathToFileURL(resolve(target, 'dist', name)).href);
let passed = 0, failed = 0;
const check = async (name, run) => {
  try { await run(); console.log('PASS ' + name); passed++; }
  catch(e) { console.log('FAIL ' + name + ': ' + e.message); failed++; }
};
const fixture = JSON.parse(readFileSync(resolve(root,'test/fixtures/candy-migration-2026-11-08.json')));
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type':'application/json' } });
let route = () => { throw new Error('Unexpected offline request'); };
globalThis.fetch = async (url, opts) => route(String(url), opts);
const { deriveTrust, decodeCoreAccountPlugins, decodeOracleValidation } = await load('lib/coreplugins.js');
const { compareReaderCounts } = await load('wallet.js');
const { verifyClaim } = await load('verify.js');
const me = await load('sources/magiceden.js');
const { explainMechanics } = await load('mechanics.js');
const { RECIPES } = await load('recipes.js');

await check('Candy custody guidance dates the unlock and keeps live trust as the authority', () => {
  const text = JSON.stringify(explainMechanics('venue-candy-custody'));
  assert.match(text,/2026-11-08/);
  assert.match(text,/burn.only|only.*burn/i);
  assert.match(text,/get_asset_trust/);
});

await check('a recorded October wallet migration cannot disprove a never-sold claim', async () => {
  route = (_url, opts) => {
    const req = JSON.parse(opts.body);
    let result;
    if(req.method === 'getAccountInfo') result = {context:{slot:fixture.slot},value:req.params[0]===fixture.mint?fixture.asset:fixture.collectionAccount};
    else if(req.method === 'getSignaturesForAddress') result = req.params[1]?.before ? [] : fixture.signatures;
    else if(req.method === 'getTransaction') result = fixture.transactions[req.params[0]] ?? null;
    else throw new Error('Unexpected RPC method ' + req.method);
    return json({jsonrpc:'2.0',id:req.id,result});
  };
  const result = await verifyClaim({claim:'never-traded',subject:fixture.mint});
  assert.equal(result.verdict,'unverifiable');
  assert.match(result.claim,/sold|sale/i);
  assert.match(result.explanation,/transfer|changed hands/i);
});

await check('index disagreement is not a minimum current holding count', () => {
  const result = compareReaderCounts({reader:'Magic Eden',count:3,bounded:false},{reader:'DAS',count:9,bounded:false});
  assert.doesNotMatch(result.note,/larger count as the floor/);
  assert.match(result.note,/lag|outdated|retain/i);
  const capped = compareReaderCounts({reader:'Magic Eden',count:100,bounded:true},{reader:'DAS',count:41,bounded:false});
  assert.match(capped.note,/index entr|indexed/i);
  assert.doesNotMatch(RECIPES['wallet-tracker'].skeleton,/this wallet holds more|assets on chain/);
});

await check('edition and master edition assurances do not promise uniqueness or a supply cap', () => {
  const asset={kind:'asset',collection:null,plugins:[{type:'Edition',authority:'update authority',data:{edition:1}},{type:'MasterEdition',authority:'update authority',data:{maxSupply:1}}],externalPlugins:0,external:[],updateAuthorityIsNone:false};
  const t=deriveTrust(asset);
  assert.doesNotMatch(t.assurances.join(' '),/serial is enforced|Master edition with max supply/);
  assert.match(t.assurances.join(' '),/not.*unique|uniqueness.*not/i);
  assert.match(t.assurances.join(' '),/not.*cap|not.*enforce/i);
});

await check('a non-sale activity page does not hide a later sale or claim a quiet market', async () => {
  const requested=[];
  route=(url) => {
    const u=new URL(url); const offset=Number(u.searchParams.get('offset'));requested.push(offset);
    if(offset===0)return json(Array.from({length:100},(_,i)=>({type:'transfer',signature:String(i),tokenMint:fixture.mint,blockTime:1794000000-i})));
    if(offset===100)return json([{type:'buyNow',signature:fixture.signatures[0].signature,tokenMint:fixture.mint,buyer:fixture.mint,seller:fixture.collection,price:0.01,blockTime:1794000000}]);
    return json([]);
  };
  const result=await me.recentSales('candy_audit_filtered_feed',10);
  assert.equal(result.sales.length,1);
  assert.deepEqual(requested,[0,100,200]);
  assert.equal(result.coverage.venueReportedEnd,true);
  assert.doesNotMatch(result.note??'',/quiet.*not an error/);
});

await check('permanent delegates survive transfer but are not unconditionally irremovable', () => {
  const t=deriveTrust(decodeCoreAccountPlugins(fixture.asset.data[0]),decodeCoreAccountPlugins(fixture.collectionAccount.data[0]));
  assert.doesNotMatch(t.warnings.join(' '),/without the holder's signature, forever/);
  for(const topic of ['plugin-permanent-freeze-delegate','plugin-permanent-transfer-delegate','q-can-the-project-take-it-back']){
    const text=JSON.stringify(explainMechanics(topic));
    assert.doesNotMatch(text,/Nobody can remove it|cannot be removed|can never be removed/);
  }
});

await check('burn-only, transfer-and-burn, no checks, removed and unread oracle states stay distinct', () => {
  const col=decodeCoreAccountPlugins(fixture.collectionAccount.data[0]);
  const a=decodeCoreAccountPlugins(fixture.asset.data[0]);
  const ext=col.external[0]; const key=`${ext.oracle.account}@${ext.oracle.resultsOffset}`;
  const reading={account:ext.oracle.account,...decodeOracleValidation(Buffer.concat([Buffer.alloc(36),Buffer.from([1,1,1,1,1])]).toString('base64'),36)};
  const burn=deriveTrust(a,col,new Map([[key,reading]]));
  assert.deepEqual(burn.blockedByOracle,['burn']);
  assert.doesNotMatch(burn.warnings[0],/transfer, sale or listing/);
  const locked={...col,external:[{...ext,checks:[...ext.checks,{event:'transfer',canReject:true,canApprove:false,canListen:false}]}]};
  assert.deepEqual(deriveTrust(a,locked,new Map([[key,reading]])).blockedByOracle,['transfer','burn']);
  const none={...col,external:[{...ext,checks:[]}]};
  assert.deepEqual(deriveTrust(a,none,new Map([[key,reading]])).blockedByOracle,[]);
  const removed={...col,external:[],externalPlugins:0};
  assert.deepEqual(deriveTrust(a,removed).oracleChecks,[]);
  assert.equal(deriveTrust(a,col).incomplete,true);
  const override={...a,externalPlugins:1,external:[{...ext,checks:[]}]};
  assert.deepEqual(deriveTrust(override,col,new Map([[key,reading]])).blockedByOracle,[]);
});
console.log(`candy-unlock: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
