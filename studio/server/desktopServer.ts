/** Production loopback server. No Vite development server or renderer filesystem access. */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { studioMiddleware, studioPaths } from './plugin';
import { ridesDir } from './paths';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
export async function startDesktopServer(o: { studio: string; dataRoot: string; clientDir: string; hudDir: string; token: string; port?: number }) {
  if (o.token.length < 32) throw new Error('Desktop server requires a random session token');
  const paths = studioPaths(o.studio, o.dataRoot);
  paths.hudPage = o.hudDir;
  const middleware = studioMiddleware(paths);
  let origin = '';
  const server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${o.token}`);
    if (req.headers.host !== new URL(origin).host || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
      || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end('Forbidden'); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.url?.split('?')[0] === '/api/capabilities' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ desktop: true, webUsb: false })); return;
    }
    void middleware(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      let path: string;
      try { path = decodeURIComponent(new URL(req.url ?? '/', origin).pathname); }
      catch { res.writeHead(400).end(); return; }
      let root = o.clientDir;
      let relative = path === '/' ? 'index.html' : path.slice(1);
      if (path.startsWith('/__hud/')) { root = o.hudDir; relative = path.slice(7); }
      else if (/^\/data\/rides\/[\w-]+\.json$/.test(path)) { root = ridesDir(paths); relative = path.split('/').pop()!; }
      else if (path.startsWith('/data/')) { root = join(o.dataRoot, 'public/data'); relative = path.slice(6); }
      const file = resolve(root, relative);
      if (!file.startsWith(resolve(root) + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Content-Length', statSync(file).size);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Request failed'); });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      accept();
    });
  });
  return { origin, paths, close: () => new Promise<void>((accept) => { server.close(() => accept()); server.closeAllConnections(); }) };
}
