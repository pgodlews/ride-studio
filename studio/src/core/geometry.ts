/** Shared drawing and ride-geometry helpers for widgets (pure, SVG path strings). */
import type { Ride } from './ride';
import { publicRouteRange } from './routePrivacy';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
export const frac = (v: number) => v - Math.floor(v);
export const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** Point on a circle; 0° is 12 o'clock, angles increase clockwise. */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

export function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (to - from >= 359.99) to = from + 359.99;
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

type Pt = [number, number];

export function linePath(pts: Pt[]): string {
  let d = '';
  let pen = false;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
    pen = true;
  }
  return d;
}

/** Closed area under a line down to `baseY` (for profile fills). */
export function areaPath(pts: Pt[], baseY: number): string {
  const good = pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (good.length < 2) return '';
  return `${linePath(good)}L${good[good.length - 1][0].toFixed(2)} ${baseY}L${good[0][0].toFixed(2)} ${baseY}Z`;
}

export interface ProfilePoint {
  d: number; // metres
  alt: number; // metres
  grade: number; // %
  t: number;
}

/** Altitude against distance, bucketed to ~`n` points (memoised per ride). */
export function buildProfile(ride: Ride, n = 320): ProfilePoint[] {
  return ride.memo(`profile:${n}`, () => {
    const dist = ride.raw('distance');
    const alt = ride.raw('altitude');
    const grade = ride.raw('gradient');
    if (!dist || !alt) return [];
    const [d0, d1] = ride.extent('distance');
    const step = (d1 - d0) / (n - 1);
    const out: ProfilePoint[] = [];
    let i = 0;
    for (let k = 0; k < n; k++) {
      const target = d0 + step * k;
      while (i < dist.length - 1 && !(dist[i + 1] > target)) i++;
      out.push({ d: target, alt: alt[i], grade: grade ? grade[i] : NaN, t: ride.t[i] });
    }
    return out;
  });
}

export interface ProjectedRoute {
  /** Points normalised to the unit box [0,1]² (y down), aspect-preserved and centred. */
  pts: Pt[];
  /** Ride time for each point. */
  times: number[];
  breakBefore: boolean[];
  /** Metres per unit of the normalised box. */
  metresPerUnit: number;
  /** First/last index shown after privacy trimming. */
  shownFrom: number;
  shownTo: number;
}

/**
 * Equirectangular projection of the GPS track into a unit box. `trimMetres` hides
 * the first and last part of the route so home/work locations are not published.
 */
export function projectRoute(ride: Ride, trimMetres: number, n = 600): ProjectedRoute | null {
  return ride.memo(`route:${trimMetres}:${n}`, () => {
    const lat = ride.raw('lat');
    const lon = ride.raw('lon');
    if (!lat || !lon) return null;
    const idx: number[] = [];
    const stride = Math.max(1, Math.floor(lat.length / n));
    for (let i = 0; i < lat.length; i += stride) {
      if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) continue;
      idx.push(i);
    }
    if (idx.length < 2) return null;
    const visible = publicRouteRange(ride, idx, trimMetres);
    if (!visible) return null;
    const { from: shownFrom, to: shownTo } = visible;
    const lat0 = lat[idx[0]] * (Math.PI / 180);
    const xs = idx.map((i) => lon[i] * Math.cos(lat0) * 111_320);
    const ys = idx.map((i) => -lat[i] * 111_320);
    const minX = Math.min(...xs.slice(shownFrom, shownTo + 1));
    const maxX = Math.max(...xs.slice(shownFrom, shownTo + 1));
    const minY = Math.min(...ys.slice(shownFrom, shownTo + 1));
    const maxY = Math.max(...ys.slice(shownFrom, shownTo + 1));
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const ox = (span - (maxX - minX)) / 2;
    const oy = (span - (maxY - minY)) / 2;
    const pts: Pt[] = xs.map((x, k) => [(x - minX + ox) / span, (ys[k] - minY + oy) / span]);
    const breakBefore = idx.map((i, k) => k > 0 && !ride.continuous(idx[k - 1], i));
    return { pts, times: idx.map((i) => ride.t[i]), breakBefore, metresPerUnit: span, shownFrom, shownTo };
  });
}

/** Position on a projected route at ride time (linear between kept points). */
export function routePosition(route: ProjectedRoute, t: number): { pt: Pt; index: number } | null {
  const { times, pts } = route;
  if (t < times[route.shownFrom] || t > times[route.shownTo]) return null;
  let k = route.shownFrom;
  while (k < route.shownTo && times[k + 1] <= t) k++;
  if (t !== times[k] && route.breakBefore[k + 1]) return null;
  const f = k < route.shownTo ? (t - times[k]) / (times[k + 1] - times[k]) : 0;
  const a = pts[k];
  const b = pts[Math.min(k + 1, pts.length - 1)];
  return { pt: [lerp(a[0], b[0], f), lerp(a[1], b[1], f)], index: k };
}

/** Drawing points with pen lifts at explicit track breaks. */
export function routePoints(route: ProjectedRoute, from: number, to: number): Pt[] {
  const out: Pt[] = [];
  for (let i = from; i <= to; i++) {
    if (i > from && route.breakBefore[i]) out.push([NaN, NaN]);
    out.push(route.pts[i]);
  }
  return out;
}

/** HR zone palette shared by all families (Z0 rest … Z5), sequential cool → hot. */
export const ZONE_COLORS = ['#7d8794', '#8a96a8', '#3b8cff', '#22c55e', '#ff9f1a', '#ff3b3b'];
export const ZONE_NAMES = ['Rest', 'Recovery', 'Endurance', 'Tempo', 'Threshold', 'Maximum'];

/** Gradient category colours (Tour-style): flat, 3–6, 6–9, 9+ and descents. */
export function gradeColor(g: number): string {
  if (!Number.isFinite(g)) return '#8a96a8';
  if (g < -2) return '#5ec8ff';
  if (g < 3) return '#3ccf7a';
  if (g < 6) return '#ffd400';
  if (g < 9) return '#ff8a00';
  return '#ff2d2d';
}
