/** Web Mercator helpers (256 px tiles) shared by map widgets and the editor map view. */
import type { Ride } from './ride';
import { publicRouteRange } from './routePrivacy';

export const TILE = 256;

/** World pixel coordinates at integer zoom z. */
export function project(lat: number, lon: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function unproject(x: number, y: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lat, lon];
}

/** Tiles covering a world-pixel box at zoom z. */
export function tilesIn(x0: number, y0: number, x1: number, y1: number, z: number): { x: number; y: number }[] {
  const max = 2 ** z - 1;
  const out: { x: number; y: number }[] = [];
  for (let ty = Math.max(0, Math.floor(y0 / TILE)); ty <= Math.min(max, Math.floor(y1 / TILE)); ty++) {
    for (let tx = Math.max(0, Math.floor(x0 / TILE)); tx <= Math.min(max, Math.floor(x1 / TILE)); tx++) out.push({ x: tx, y: ty });
  }
  return out;
}

export interface RouteWorld {
  /** Projected points at zoom 0 (multiply by 2^z for zoom z). */
  pts: [number, number][];
  t: number[];
  breakBefore: boolean[];
  /** Index range outside the private start/finish zone. */
  from: number;
  to: number;
}

/** Route projected at zoom 0 (cheap to rescale), sampled every `step` records. */
export function routeWorld(ride: Ride, trimMetres: number, step = 2): RouteWorld | null {
  return ride.memo(`routeWorld:${trimMetres}:${step}`, () => {
    const lat = ride.raw('lat');
    const lon = ride.raw('lon');
    if (!lat || !lon) return null;
    const pts: [number, number][] = [];
    const t: number[] = [];
    const indices: number[] = [];
    const breakBefore: boolean[] = [];
    let previous = 0;
    for (let i = 0; i < lat.length; i += step) {
      if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) continue;
      pts.push(project(lat[i], lon[i], 0));
      breakBefore.push(pts.length > 1 && !ride.continuous(previous, i));
      previous = i;
      t.push(ride.t[i]);
      indices.push(i);
    }
    if (pts.length < 2) return null;
    const visible = publicRouteRange(ride, indices, trimMetres);
    if (!visible) return null;
    const { from, to } = visible;
    return { pts, t, breakBefore, from, to };
  });
}

/** Rider position (zoom-0 world px) at ride time; null if missing or inside the private zone. */
export function positionAt(ride: Ride, route: RouteWorld, t: number): { p: [number, number]; index: number; hidden: boolean } | null {
  const lat = ride.at('lat', t);
  const lon = ride.at('lon', t);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let i = 0;
  while (i < route.t.length - 1 && route.t[i + 1] <= t) i++;
  const hidden = t < route.t[route.from] || t > route.t[route.to];
  if (hidden) {
    // Park the view at the edge of the visible route; never show the private part.
    const k = i < route.from ? route.from : route.to;
    return { p: route.pts[k], index: k, hidden };
  }
  return { p: project(lat, lon, 0), index: i, hidden };
}
