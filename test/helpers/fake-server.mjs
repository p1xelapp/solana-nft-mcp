import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function start(profile = 'normal', base = '.') {
  const home = resolve('audit/home');
  mkdirSync(home, { recursive: true });
  const ready = resolve(home, `fixture-${process.pid}-${profile}.json`);
  rmSync(ready, { force: true });
  const env = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, USERPROFILE: home, AUDIT_PROFILE: profile, AUDIT_READY: ready,
    SOLANA_NFT_MCP_NO_UPDATE_CHECK: '1', SOLANA_NFT_MCP_NO_AUTO_KEYS: '1',
    OPENSEA_API_KEY: 'fixture-only-not-a-credential', SOLANA_RPC_URL: 'https://rpc.fixture.invalid', DAS_RPC_URL: 'https://das.fixture.invalid' });
  if (process.env.NODE_V8_COVERAGE) env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  const client = new Client({ name: 'offline-battery', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(resolve('test/helpers/fake-upstream.mjs')).href, resolve(base, 'dist/index.js')], env, stderr: 'pipe' });
  await client.connect(transport);
  let stderr = '';
  transport.stderr?.on('data', b => { stderr = (stderr + b).slice(-12000); });
  const port = JSON.parse(readFileSync(ready, 'utf8')).port;
  const control = async path => (await fetch(`http://127.0.0.1:${port}/${path}`)).json();
  return { client, transport, control, stderr: () => stderr,
    async close() { await client.close(); rmSync(ready, { force: true }); } };
}

export async function call(session, tool, args) {
  const begin = performance.now();
  try {
    const raw = await session.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 45000 });
    let data=raw.structuredContent;
    if(data===undefined) {try{data=JSON.parse(raw.content?.[0]?.text ?? '{}');}catch{data={message:raw.content?.[0]?.text ?? ''};}}
    return { raw, data,
      ms: performance.now() - begin, bytes: Buffer.byteLength(JSON.stringify(raw)),
      textBytes: Buffer.byteLength(raw.content?.[0]?.text ?? ''), error: raw.isError === true };
  } catch (e) { return { error: true, exception: true, data: { message: String(e.message) }, ms: performance.now() - begin, bytes: Buffer.byteLength(String(e.message)), textBytes: Buffer.byteLength(String(e.message)) }; }
}
