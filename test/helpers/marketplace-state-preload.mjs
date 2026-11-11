import { createHash } from 'node:crypto';
const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encode = b => { let n=BigInt('0x'+b.toString('hex')), s=''; while(n) {s=chars[Number(n%58n)]+s;n/=58n;} return s; };
const decode = s => {let n=0n;for(const c of s)n=n*58n+BigInt(chars.indexOf(c));return Buffer.from(n.toString(16).padStart(64,'0'),'hex');};
export const key = label => encode(createHash('sha256').update(`market-state-${label}`).digest());
export const CORE='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const SYSTEM='11111111111111111111111111111111';
export const MMM='mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc';
export const OS='7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V';
const json = body => new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});

export function install() {
  const prior=globalThis.fetch;
  const books=new Map(), owners=new Map(), programs=new Map(), reads={books:0,assets:0,programs:0};
  const state={books,owners,programs,reads,failPrograms:false};
  globalThis.fetch=async (url,init={}) => {
    const u=new URL(String(url));
    if(u.hostname==='api-mainnet.magiceden.dev') {
      const symbol=u.pathname.split('/')[3];
      if(u.pathname.endsWith('/stats')) return json({symbol,floorPrice:1000000000,listedCount:1,volumeAll:1});
      if(u.pathname.endsWith('/listings')) {reads.books++;return json(books.get(symbol)??[]);}
      throw Error('Unexpected fixture route '+u.pathname);
    }
    const b=JSON.parse(init.body??'{}');
    if(b.method!=='getMultipleAccounts') throw Error('Unexpected fixture method '+b.method);
    const isAsset=b.params[1]?.dataSlice?.length>0;
    reads[isAsset?'assets':'programs']++;
    if(!isAsset&&state.failPrograms) return json({jsonrpc:'2.0',id:b.id,result:{context:{slot:100},value:[]}});
    const value=b.params[0].map(a=>{
      if(!isAsset) return programs.has(a)?{owner:programs.get(a),data:['','base64'],lamports:1}:null;
      const o=owners.get(a);
      if(o===undefined)return null;
      if(o==='legacy')return {owner:key('token-program'),data:[Buffer.alloc(82).toString('base64'),'base64']};
      if(o==='burned')return {owner:CORE,data:['AA==','base64']};
      return {owner:CORE,data:[Buffer.concat([Buffer.from([1]),decode(o)]).toString('base64'),'base64']};
    });
    return json({jsonrpc:'2.0',id:b.id,result:{context:{slot:100},value}});
  };
  state.row=(label,owner='seller',price=1)=>{
    const mint=key(label),seller=key(label+'-seller');
    owners.set(mint,owner==='seller'?seller:owner);
    const row={tokenMint:mint,seller,price}; books.set(label,[row]);return row;
  };
  state.restore=()=>{globalThis.fetch=prior;};return state;
}

if(process.env.MARKET_STATE_PROFILE) {
  const {M,S,COL}=await import('./custody-preload.mjs');
  const prior=globalThis.fetch;
  const signature=encode(createHash('sha512').update('market-state-fill').digest());
  globalThis.fetch=async (url,init={})=>{
    const u=new URL(String(url));
    if(process.env.MARKET_STATE_PROFILE==='holder-unread'&&init.body) {
      const b=JSON.parse(init.body);
      if(b.method==='getMultipleAccounts'&&b.params[1]?.dataSlice?.length===0) return json({jsonrpc:'2.0',id:b.id,result:{context:{slot:1000},value:[]}});
    }
    if(process.env.MARKET_STATE_PROFILE==='sales') {
      const time=Math.floor(Date.now()/1000)-10;
      if(u.hostname==='api-mainnet.magiceden.dev'&&u.pathname.endsWith('/activities')) return json(Number(u.searchParams.get('offset'))>0?[]:[
        {signature,type:'buyNow',tokenMint:M.A,buyer:S[1],seller:S[2],price:1,blockTime:time},
        {signature,type:'buyNow',tokenMint:M.B,buyer:S[1],seller:S[2],price:2,blockTime:time},
      ]);
      if(u.hostname==='api.opensea.io'&&u.pathname.includes('/events/collection/'))return json({asset_events:[
        {event_type:'sale',transaction:signature,nft:{identifier:M.A,name:'Card A'},buyer:S[1],seller:S[2],event_timestamp:time,payment:{quantity:'900000000',decimals:9,symbol:'SOL'}},
        {event_type:'sale',transaction:signature,nft:{identifier:M.B,name:'Card B'},buyer:S[1],seller:S[2],event_timestamp:time,payment:{quantity:'2000000',decimals:6,symbol:'USDC'}},
        {event_type:'sale',transaction:signature,nft:{name:'Unidentified item'},buyer:S[1],seller:S[2],event_timestamp:time,payment:{quantity:'1000000000',decimals:9,symbol:'SOL'}},
        {event_type:'sale',transaction:signature,nft:{identifier:M.A,name:'Card A resold'},buyer:S[3],seller:S[1],event_timestamp:time,payment:{quantity:'1500000000',decimals:9,symbol:'SOL'}},
        {event_type:'sale',transaction:signature,nft:{identifier:M.B,name:'Card B unknown buyer'},seller:S[2],event_timestamp:time,payment:{quantity:'2100000000',decimals:9,symbol:'SOL'}},
      ]});
      if(u.hostname==='api.opensea.io'&&u.pathname.endsWith('/collections/custody-os'))return json({collection:'custody-os',name:'Fixture',contracts:[{chain:'solana',address:COL}],total_supply:9,fees:[]});
    }
    return prior(url,init);
  };
}
