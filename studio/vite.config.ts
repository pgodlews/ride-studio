import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { studioServer } from './server/plugin';
import { tileAttribution } from './server/tiles';

export default defineConfig({
  plugins: [studioServer(fileURLToPath(new URL('.', import.meta.url)))],
  esbuild: { jsx: 'automatic' },
  define: { __STUDIO_TILE_ATTRIBUTION__: JSON.stringify(tileAttribution) },
  server: { port: 5178, watch: { ignored: ['**/.cache/**', '**/exports/**'] } },
});
