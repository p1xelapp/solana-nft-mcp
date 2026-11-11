import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { registerSecret } = await import(pathToFileURL(resolve(process.env.TEST_SERVER_ROOT, 'dist/lib/secrets.js')).href);
registerSecret(process.env.OPENSEA_API_KEY);
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
