// Build only source-controlled code. Never copy public/data or development caches into the application.
import { build } from 'vite';
import { rolldown } from 'rolldown';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(studio, 'desktop-dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const attribution = process.env.STUDIO_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors';
const shared = { configFile: false, publicDir: false, esbuild: { jsx: 'automatic' }, logLevel: 'warn', define: { __STUDIO_TILE_ATTRIBUTION__: JSON.stringify(attribution) } };
await build({ ...shared, root: studio, build: { outDir: join(out, 'client'), emptyOutDir: true } });
await build({ ...shared, root: join(studio, 'src/hud'), base: './', build: { outDir: join(out, 'hud'), emptyOutDir: true } });
const bundle = await rolldown({ input: join(studio, 'desktop/main.ts'), platform: 'node',
  external: (id) => id === 'electron' || id.startsWith('node:') || ['vite', 'puppeteer-core', '@puppeteer/browsers'].includes(id) });
await bundle.write({ file: join(out, 'main.cjs'), format: 'cjs', codeSplitting: false });
await bundle.close();
mkdirSync(join(out, 'scripts'));
// Python helpers are our own code. No interpreter, SDK, private input or third-party corpus is bundled.
for (const name of readdirSync(join(studio, 'scripts'))) if (name.endsWith('.py') && !name.startsWith('test_')) cpSync(join(studio, 'scripts', name), join(out, 'scripts', name));
const pkg = JSON.parse(readFileSync(join(studio, 'package.json')));
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'ride-studio', version: pkg.version, main: 'main.cjs', description: 'Local cycling and outdoor video studio', license: 'MIT', author: 'Piotr Godlewski' }, null, 2));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(join(studio, '..', name), join(out, name));
for (const name of ['OSVPLAT-LICENSE']) cpSync(join(studio, 'scripts', name), join(out, 'scripts', name));
console.log('Built desktop-dist: production UI + HUD + bundled Electron main/backend; personal data excluded.');
