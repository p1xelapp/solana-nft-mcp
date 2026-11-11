import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, posix, win32 } from 'node:path';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const root = resolve(process.argv[2]);
const source = readFileSync(resolve(root, 'scripts/verify-bundle.mjs'), 'utf8');
const manifest = { version: '1.19.0', manifest_version: '0.3', icon: 'icon.png', prompts: [], server: { mcp_config: { args: ['${__dirname}/dist/index.js'] } } };
for (const platform of ['posix', 'win32']) {
  const path = platform === 'posix' ? posix : win32;
  const work = platform === 'posix' ? '/tmp/bundle' : 'C:\\tmp\\bundle';
  const repo = platform === 'posix' ? '/repo' : 'C:\\repo';
  let exitCode;
  const messages = [];
  const context = createContext({ console: { log: message => messages.push(message) }, process: { argv: ['node', 'verify', 'test.mcpb'], cwd: () => repo, exit: code => { exitCode = code; } } });
  const fs = {
    existsSync: name => [path.join(work, 'dist', 'index.js'), path.join(work, 'node_modules'), path.join(work, 'data', 'me-collections.json.gz')].includes(name),
    mkdtempSync: () => work,
    readdirSync: () => ['icon.png'],
    readFileSync: name => JSON.stringify(name.endsWith('manifest.json') ? manifest : { version: '1.19.0' }),
    statSync: () => ({ mtimeMs: 1 }),
  };
  const make = values => new SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  const imports = { './unzip.mjs': { unzipSync() {} }, 'node:fs': fs, 'node:os': { tmpdir: () => path.dirname(work) }, 'node:path': { dirname: path.dirname, join: path.join }, 'node:url': { fileURLToPath: () => path.join(repo, 'scripts', 'verify-bundle.mjs') } };
  const module = new SourceTextModule(source, { context, initializeImportMeta: meta => { meta.url = 'file:///repo/scripts/verify-bundle.mjs'; }, importModuleDynamically: async () => { const prompts = make({ PROMPT_LIST: [], PROMPT_TEXTS: {} }); await prompts.link(() => {}); await prompts.evaluate(); return prompts; } });
  await module.link(specifier => make(imports[specifier]));
  await module.evaluate();
  console.log(JSON.stringify({ platform, exitCode, failures: messages.filter(m => m.startsWith('FAIL')) }));
  assert.equal(exitCode, 0, `${platform} bundle entry must resolve to an extracted file`);
}
