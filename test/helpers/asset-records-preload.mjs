const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const MINT = "59oZornPbD1dVQLLvVRsws6YLFG5XSNBr1bmxUh2BVT4";
const OWNER = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2";
const profile = process.env.ASSET_RECORD_PROFILE;
const RPC_HOSTS = new Set(["api.mainnet-beta.solana.com", "solana-rpc.publicnode.com", "solana.leorpc.com"]);
const str = text => { const b = Buffer.from(text); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const asset = Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 7), Buffer.from([0]), str("Card"), str("https://example.com/metadata.json"), Buffer.from([0])]).toString("base64");
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (new URL(url).hostname === "api-mainnet.magiceden.dev") return json({});
  if (!RPC_HOSTS.has(new URL(url).hostname)) throw Error("Unexpected request: metadata URLs must not be fetched");
  const body = JSON.parse(init.body);
  let result;
  if (body.method === "getAccountInfo") {
    result = { context: { slot: 500 }, value: body.params[0] === MINT ? { data: [profile === "burned" ? "AA==" : asset, "base64"], owner: CORE, lamports: 1 } : { data: ["", "base64"], owner: "11111111111111111111111111111111", lamports: 1 } };
  } else if (body.method === "getAsset") {
    result = { id: body.params.id, interface: "MplCoreAsset", content: { json_uri: "https://example.com/metadata.json", metadata: { name: "Card", attributes: [{ trait_type: "Serial", value: "003" }, { trait_type: "Long", value: "x".repeat(140) }] }, links: { image: "https://example.com/card.png" } }, ownership: { owner: OWNER }, grouping: [], compression: { compressed: false }, burnt: profile === "burned" };
  } else if (body.method === "getSignaturesForAddress") {
    result = [{ signature: "3".repeat(88), blockTime: 1700000100, err: null }, { signature: "2".repeat(88), blockTime: 1700000000, err: null }];
  } else if (body.method === "getTransaction") {
    const burned = body.params[0] === "3".repeat(88);
    result = { blockTime: burned ? 1700000100 : 1700000000, meta: { err: null, logMessages: [], innerInstructions: [] }, transaction: { message: { accountKeys: [], instructions: [{ programId: CORE, accounts: [MINT, CORE, OWNER, OWNER, OWNER], data: burned ? "D" : "M" }] } } };
  } else throw Error(`Unexpected RPC ${body.method}`);
  return json({ jsonrpc: "2.0", id: body.id, result });
};
