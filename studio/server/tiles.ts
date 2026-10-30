/**
 * Map tile proxy with a disk cache, so previews and exports fetch each tile from the
 * provider at most once (per expiry). Defaults to the OpenStreetMap standard layer, whose
 * tile usage policy asks for: an identifying User-Agent, modest request rates, caching,
 * and visible "© OpenStreetMap contributors" attribution (drawn by every map widget).
 * Heavy use should move to a self-hosted or commercial tile server: set STUDIO_TILE_URL
 * (e.g. https://tiles.example/{z}/{x}/{y}.png) — the cache is kept per tile source.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCE = process.env.STUDIO_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const USER_AGENT = 'GarminRideStudio/0.2 (personal non-commercial ride video tool; local tile cache)';
const MIN_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_PARALLEL = 2;

const sourceKey = createHash('sha1').update(SOURCE).digest('hex').slice(0, 10);
const inflight = new Map<string, Promise<Buffer>>();
const queue: (() => void)[] = [];
let active = 0;

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export function validTile(z: number, x: number, y: number): boolean {
  return Number.isInteger(z) && z >= 0 && z <= 19 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

/** Tile bytes from cache, refreshed from the provider when older than its max-age (≥ 7 days). */
export async function getTile(cacheDir: string, z: number, x: number, y: number): Promise<Buffer> {
  const file = join(cacheDir, 'tiles', sourceKey, String(z), String(x), `${y}.png`);
  const meta = `${file}.json`;
  if (existsSync(file)) {
    const expires = existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')).expires as number) : statSync(file).mtimeMs + MIN_AGE_MS;
    if (Date.now() < expires) return readFileSync(file);
  }
  const key = `${z}/${x}/${y}`;
  if (!inflight.has(key)) {
    inflight.set(key, limited(async () => {
      try {
        const res = await fetch(SOURCE.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), {
          headers: { 'User-Agent': USER_AGENT, Referer: 'http://localhost/' },
        });
        if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0) * 1000;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, buf);
        writeFileSync(meta, JSON.stringify({ expires: Date.now() + Math.max(MIN_AGE_MS, maxAge), fetched: new Date().toISOString() }));
        return buf;
      } catch (e) {
        // Serve a stale tile rather than nothing if the provider is unreachable.
        if (existsSync(file)) return readFileSync(file);
        throw e;
      }
    }).finally(() => inflight.delete(key)));
  }
  return inflight.get(key)!;
}

export const tileAttribution = SOURCE.includes('openstreetmap.org') ? '© OpenStreetMap contributors' : (process.env.STUDIO_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors');
