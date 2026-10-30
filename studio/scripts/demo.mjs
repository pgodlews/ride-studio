import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const loader = await createServer({ root, configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' });
try { const { createDemo } = await loader.ssrLoadModule('/server/demo.ts'); await createDemo(root); console.log('Synthetic demo ready. npm run dev, then open http://localhost:5178/'); }
finally { await loader.close(); }
