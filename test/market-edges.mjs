// Offline regressions from the 2026-11-08 marketplace review.
// Pass another build's folder as the first argument to run the same checks on it.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dist = path.resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)), 'dist');
process.env.SOLANA_NFT_MCP_NO_UPDATE_CHECK = '1';
process.env.OPENSEA_API_KEY = ['TEST', 'market-edges', '1234567890'].join('-');
let route;
const calls = [];
globalThis.fetch = async url => { calls.push(String(url)); return route(new URL(String(url))); };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const me = await import(pathToFileURL(path.join(dist, 'sources/magiceden.js')));
const os = await import(pathToFileURL(path.join(dist, 'sources/opensea.js')));
const market = await import(pathToFileURL(path.join(dist, 'market.js')));
const wallet = await import(pathToFileURL(path.join(dist, 'wallet.js')));
const mint = '59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4';
const buyer = 'h4FoDwkztwipWbqdNV4jEa7FJkL32fz5hjE9w5q67zv';
const seller = '7VzKwP6CoW6QAhbVaWNjB1NTfgTVefbFAQhsvxVdGB7X';
const sale = { type: 'buyNow', price: 0.01, signature: '4'.repeat(87), tokenMint: mint, buyer, seller, blockTime: 1794092057, source: 'magiceden_v2' };
let failures = 0, passed = 0;
async function check(name, fn) {
  calls.length = 0;
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
}
await check('recent sales walks past a page with no sales', async () => {
  route = url => json(url.searchParams.get('offset') === '0' ? Array.from({ length: 100 }, (_, i) => ({ type: 'list', signature: `${i}`, tokenMint: mint })) : url.searchParams.get('offset') === '100' ? [sale] : []);
  const r = await me.recentSales('audit-no-sales-first-page', 2);
  assert.equal(r.sales.length, 1, `expected the next page's sale, got ${r.sales.length}`);
  assert.equal(r.activitiesScanned, 101);
  assert.equal(r.coverage.venueReportedEnd, true);
});
await check('recent sales reports a page cap without calling the market quiet', async () => {
  route = url => json(Array.from({ length: 100 }, (_, i) => ({ type: 'list', signature: `${url.searchParams.get('offset')}-${i}`, tokenMint: mint })));
  const r = await me.recentSales('audit-five-full-no-sales', 2);
  assert.equal(r.activitiesScanned, 500);
  assert.equal(r.coverage.budgetReached, true);
  assert.doesNotMatch(r.note, /quiet.*market|not an error/i);
});
await check('a real small OpenSea volume is not rounding dust', async () => {
  route = () => json({ total: { floor_price: 0.01, floor_price_symbol: 'SOL', volume: 1e-10, volume_symbol: 'ETH', sales: 1, num_owners: 1 } });
  const r = await os.collectionStats('audit-small-volume');
  assert.equal(r.totalVolume, 1e-10);
  assert.equal(r.volumeCurrency, 'ETH');
});
await check('zero-sale OpenSea dust is still explained', async () => {
  route = () => json({ total: { floor_price: 0, volume: 7.6e-17, volume_symbol: 'ETH', sales: 0, num_owners: 1 } });
  const r = await os.collectionStats('audit-zero-sale-dust');
  assert.equal(r.totalVolume, 0);
  assert.match(r.volumeNote, /rounding dust/);
});
await check('OpenSea recent sales follows a short page cursor', async () => {
  const event = { event_type: 'sale', event_timestamp: sale.blockTime, transaction: sale.signature, nft: { identifier: mint }, buyer, seller, payment: { quantity: '10000000', decimals: 9, symbol: 'SOL' } };
  route = url => json(url.searchParams.has('next') ? { asset_events: [{ ...event, transaction: '5'.repeat(87) }] } : { asset_events: [event], next: 'page2' });
  const r = await os.recentSales('audit-short-cursor', 3);
  assert.equal(r.sales.length, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.sales[0].price, 0.01);
  assert.equal(r.sales[0].currency, 'SOL');
});
await check('OpenSea recent sales reports unconsumed history', async () => {
  route = () => json({ asset_events: [{ event_type: 'sale', event_timestamp: sale.blockTime, nft: { identifier: mint }, payment: { quantity: '1', decimals: 9, symbol: 'SOL' } }], next: 'more' });
  const r = await os.recentSales('audit-limited-cursor', 1);
  assert.equal(r.sales.length, 1);
  assert.equal(r.truncated, false);
  assert.equal(r.moreAvailable, true);
});
await check('tiny sales survive collection and wallet arithmetic', async () => {
  const r = market.summarizeSales([sale], { windowStartUnix: sale.blockTime - 1, windowEndUnix: sale.blockTime + 1 });
  assert.equal(r.sales, 1); assert.equal(r.volumeSol, 0.01); assert.equal(r.averageSol, 0.01);
  const w = wallet.summarizeActivity(buyer, [sale], false);
  assert.equal(w.buys.count, 1); assert.equal(w.buys.totalSol, 0.01);
});
await check('new fractional names keep issue and serial separate', async () => {
  assert.deepEqual(market.parseSerial('Absolute Batman #1 (12/250)'), { serial: 12, of: 250 });
  assert.equal(market.baseName('Absolute Batman #1 (12/250)'), 'Absolute Batman #1');
});
await check('Candy trading guidance includes the November reopening', async () => {
  const { MECHANICS } = await import(pathToFileURL(path.join(dist, 'mechanics.js')));
  const custody = MECHANICS.find(e => e.id === 'venue-candy-custody');
  assert.equal(custody.sourceRead, '2026-11-08');
  assert.match(custody.plain, /2026-11-06|November 6, 2026/);
  assert.match(custody.source, /how-to-connect-your-candy-wallet/);
});
await check('recent Candy symbols resolve without a directory refresh', async () => {
  const { REGISTRY } = await import(pathToFileURL(path.join(dist, 'registry.js')));
  const names = await import(pathToFileURL(path.join(dist, 'names.js')));
  for (const [address, symbol] of [
    ['Fr42ujZwVq2PH5Pb6cDRcmmTkRrk18XyM2AHCH8aqEyY', 'portraits_echoes_across_the_lens_of_time'],
    ['YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX', '2026_mlb_allstar_game_icons_candy_digital'],
    ['BYSfa4LYpChyhLqvcB9o1vPp9riGUECPuaQ8tkw1ii5G', 'base_series_collection_quests_candy_digital'],
  ]) {
    const entry = REGISTRY.find(e => e.coreCollection === address);
    assert.equal(entry?.meSymbol ?? names.symbolForCollectionName(entry?.name || '')?.symbol ?? null, symbol);
  }
});
await check('a live-only symbol names the live directory as its source', async () => {
  const names = await import(pathToFileURL(path.join(dist, 'names.js')));
  route = url => json(url.searchParams.get('offset') === '0' ? [{ symbol: 'audit_new_symbol', name: 'Audit New Directory Collection' }] : []);
  names.resolveName('Audit New Directory Collection');
  let found;
  for (let i = 0; i < 100 && !found; i++) {
    await new Promise(r => setTimeout(r, 40));
    found = names.symbolForCollectionName('Audit New Directory Collection');
  }
  assert.equal(found?.symbol, 'audit_new_symbol');
  assert.match(found.note, /live directory/);
  assert.doesNotMatch(found.note, /2026-09-11|bundled directory snapshot/);
});
await check('an aggregated floor does not identify an execution venue', async () => {
  const { reconcileFloors } = await import(pathToFileURL(path.join(dist, 'lib/reconcile.js')));
  const r = reconcileFloors([{ source: 'magiceden', value: 0.06, currency: 'SOL' }, { source: 'opensea', value: 0.01, currency: 'SOL' }]);
  assert.doesNotMatch(r.verdict, /Cheapest on opensea/);
  assert.match(r.caveats.join(' '), /aggregat/);
  route = () => json({ total: { floor_price: 0.01, floor_price_symbol: 'SOL', volume: 1, volume_symbol: 'ETH', sales: 1 } });
  const s = await os.collectionStats('audit-aggregated-floor');
  assert.equal(s.floorScope, 'aggregated-marketplaces');
  assert.match(s.floorNote, /marketplaces/);
});
await check('an index floor is not presented as checked listing validity', async () => {
  route = () => json({ symbol: 'audit-advertised-floor', floorPrice: 146681335, listedCount: 48 });
  const s = await me.collectionStats('audit-advertised-floor');
  assert.equal(s.floorPriceSol, 0.146681335);
  assert.equal(s.listingValidityChecked, false);
  assert.match(s.floorNote, /custody|active orders/);
});
console.log(`${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
