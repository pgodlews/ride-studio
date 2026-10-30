/**
 * Activity summaries that need more than one channel sample: distance splits, moving
 * time, average pace so far and the activity high point. Every result is a pure function
 * of (ride, t, settings), so widgets stay frame-exact in preview and export. Record
 * intervals are bridged up to the ride's own gap tolerance (`ride.gapSec`).
 */
import { buildProfile } from './geometry';
import type { Ride } from './ride';
import type { UnitSystem } from './units';

export const SPLIT_METRES: Record<UnitSystem, number> = { metric: 1000, imperial: 1609.344 };

/** Index of the first finite sample of a channel, or -1. */
function firstFinite(ride: Ride, id: 'distance'): number {
  return ride.memo(`first:${id}`, () => ride.raw(id)?.findIndex(Number.isFinite) ?? -1);
}

interface SplitTable {
  /** Ride time of the first finite distance sample. */
  start: number;
  /** Number of the first split (km 3 when distance starts at 2.4 km). */
  firstN: number;
  /** Whether distance starts on a whole mark, so the first split is a full unit. */
  startOnMark: boolean;
  /** Ride time at which each whole split distance was first reached. */
  crossings: number[];
  /** Whether that time was interpolated inside a bridged interval (otherwise only bounded). */
  exact: boolean[];
}

function splitTable(ride: Ride, unitMetres: number): SplitTable | null {
  return ride.memo(`splits:${unitMetres}`, () => {
    const dist = ride.raw('distance');
    const first = firstFinite(ride, 'distance');
    if (!dist || first < 0) return null;
    const t = ride.t;
    const crossings: number[] = [];
    const exact: boolean[] = [];
    const d0 = dist[first];
    let next = (Math.floor(d0 / unitMetres) + 1) * unitMetres;
    let prev = first;
    for (let i = first + 1; i < dist.length; i++) {
      const d = dist[i];
      if (!Number.isFinite(d)) continue;
      while (d >= next) {
        const dp = dist[prev];
        // Distance is cumulative, so interpolate inside a continuous interval of up to three
        // gap tolerances that passes at most one mark. Otherwise (pause, segment break, GPS
        // jump) the first sample at or beyond the mark only bounds when it was reached.
        const known = ride.continuous(prev, i) && t[i] - t[prev] <= 3 * ride.gapSec && d > dp && d - dp < unitMetres;
        crossings.push(known ? t[prev] + ((next - dp) / (d - dp)) * (t[i] - t[prev]) : t[i]);
        exact.push(known);
        next += unitMetres;
      }
      prev = i;
    }
    const offMark = d0 - Math.floor(d0 / unitMetres) * unitMetres;
    return { start: t[first], firstN: Math.floor(d0 / unitMetres) + 1, startOnMark: offMark < 1, crossings, exact };
  });
}

export interface SplitRow {
  /** Split number (km 8 → 8). */
  n: number;
  /** Duration in seconds; NaN when either boundary was only bounded by a gap. */
  sec: number;
  /** A full-unit split with known duration, fit for best/delta comparison. */
  comparable: boolean;
}

export interface SplitState {
  /** Split currently in progress. */
  current: number;
  /** Seconds spent in the current split; NaN when its start time is not known. */
  elapsed: number;
  /** Distance fraction of the current split, 0–1; NaN when distance is missing at t. */
  progress: number;
  /** Completed splits, oldest first. */
  done: SplitRow[];
}

/**
 * Whole-unit splits (1 km or 1 mile) derived from the distance channel. Completed
 * splits stay available during recording gaps; only live progress needs distance at t.
 */
export function splitAt(ride: Ride, t: number, units: UnitSystem): SplitState | null {
  const unit = SPLIT_METRES[units];
  const table = splitTable(ride, unit);
  if (!table || t < table.start || t > ride.duration) return null;
  const done: SplitRow[] = [];
  let last = table.start;
  let lastExact = true;
  for (let k = 0; k < table.crossings.length && table.crossings[k] <= t; k++) {
    const c = table.crossings[k];
    const sec = lastExact && table.exact[k] ? c - last : NaN;
    const n = table.firstN + k;
    done.push({ n, sec, comparable: Number.isFinite(sec) && (k > 0 || table.startOnMark) });
    last = c;
    lastExact = table.exact[k];
  }
  const d = ride.at('distance', t);
  return {
    current: table.firstN + done.length,
    elapsed: lastExact ? t - last : NaN,
    progress: Number.isFinite(d) ? Math.min(1, Math.max(0, (d % unit) / unit)) : NaN,
    done,
  };
}

/** Moving vs elapsed seconds; moving needs speed ≥ threshold at both ends of a bridged interval. */
export function movingAt(ride: Ride, t: number, thresholdMps: number): { moving: number; elapsed: number } | null {
  const speed = ride.raw('speed');
  if (!speed || t < ride.t[0]) return null;
  const counts = (i: number) =>
    i + 1 < ride.t.length && ride.continuous(i, i + 1) && ride.t[i + 1] - ride.t[i] <= ride.gapSec &&
    speed[i] >= thresholdMps && speed[i + 1] >= thresholdMps;
  const cum = ride.memo(`moving:${thresholdMps}`, () => {
    const out = new Float64Array(ride.t.length);
    for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + (counts(i - 1) ? ride.t[i] - ride.t[i - 1] : 0);
    return out;
  });
  const i = ride.index(t);
  const partial = counts(i) ? Math.min(t, ride.t[i + 1]) - ride.t[i] : 0;
  return { moving: cum[i] + Math.max(0, partial), elapsed: elapsedAt(ride, t) };
}

/** Seconds since the first record, held at the last record after the activity ends. */
export const elapsedAt = (ride: Ride, t: number) => Math.max(0, Math.min(t, ride.duration) - ride.t[0]);

/** Average pace (s/m) from the first distance sample to t; missing for the first 50 m. */
export function averagePaceAt(ride: Ride, t: number): number {
  const first = firstFinite(ride, 'distance');
  if (first < 0) return NaN;
  const d = ride.at('distance', t) - ride.raw('distance')![first];
  return d >= 50 ? (t - ride.t[first]) / d : NaN;
}

/** Highest point of the whole-activity profile (distance and altitude, metres). */
export function highPoint(ride: Ride): { d: number; alt: number } | null {
  return ride.memo('highPoint', () => {
    let best: { d: number; alt: number } | null = null;
    for (const p of buildProfile(ride)) if (Number.isFinite(p.alt) && (!best || p.alt > best.alt)) best = { d: p.d, alt: p.alt };
    return best;
  });
}

export interface SummitFrame {
  /** Whole-activity profile in box coordinates (NaN y where altitude is missing). */
  pts: [number, number][];
  X: (d: number) => number;
  Y: (alt: number) => number;
  /** Current position in box coordinates, or null when distance/altitude are missing. */
  here: { x: number; y: number } | null;
  /** Clip edge for the part already covered (left edge when distance is missing). */
  cx: number;
  /** High point in metres and box coordinates. */
  high: { d: number; alt: number; x: number; y: number } | null;
  /** Metres still to climb to the high point; NaN once past it or when altitude is missing. */
  toHigh: number;
  /** Total distance in metres. */
  total: number;
}

/** Shared geometry for the summit-profile widgets, laid out in box [x0, x1, y0, y1]. */
export function summitFrame(ride: Ride, t: number, [x0, x1, y0, y1]: [number, number, number, number]): SummitFrame {
  const [d0, d1] = ride.extent('distance');
  const [a0, a1] = ride.extent('altitude');
  const X = (d: number) => x0 + ((x1 - x0) * (d - d0)) / Math.max(1, d1 - d0);
  const Y = (a: number) => y1 - ((y1 - y0) * (a - a0)) / Math.max(1, a1 - a0);
  const pts = buildProfile(ride).map((p) => [X(p.d), Y(p.alt)] as [number, number]);
  const dNow = ride.at('distance', t);
  const aNow = ride.at('altitude', t);
  const hp = highPoint(ride);
  const here = Number.isFinite(dNow) && Number.isFinite(aNow) ? { x: X(dNow), y: Y(aNow) } : null;
  return {
    pts, X, Y, here,
    cx: Number.isFinite(dNow) ? X(dNow) : x0,
    high: hp && { ...hp, x: X(hp.d), y: Y(hp.alt) },
    toHigh: hp && Number.isFinite(aNow) && dNow < hp.d ? Math.max(0, hp.alt - aNow) : NaN,
    total: d1,
  };
}

/** Robust top speed (98th percentile) for scaling traces without GPS spikes. */
export function typicalTopSpeed(ride: Ride): number {
  return ride.memo('speedP98', () => {
    const v = Array.from(ride.raw('speed') ?? []).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.98))] : NaN;
  });
}
