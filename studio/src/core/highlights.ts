/**
 * Moment detectors: each scans a ride and returns scored candidate moments. Like widgets,
 * detectors live in a registry — add one with `defineDetector` and it appears in the editor
 * and the auto-edit. Detectors needing absent channels (e.g. power) are skipped.
 *
 * Values are computed from recorded or derived channels only; labels state what was measured.
 */
import { CHANNELS, type ChannelId } from './channels';
import type { Ride } from './ride';
import { display, type UnitSystem } from './units';

export type MomentCategory = 'effort' | 'terrain' | 'story';

export interface Moment {
  id: string;
  detector: string;
  label: string;
  detail: string;
  /** Ride time of the defining instant (peak, summit, apex). */
  peakT: number;
  /** Suggested clip window. */
  start: number;
  end: number;
  /** Rank within its detector: 1 = best. */
  rank: number;
  /** 0–1, relative to the detector's best moment in this ride. */
  strength: number;
}

interface Candidate {
  i: number; // record index of the defining instant
  score: number;
  detail: string;
  /** Optional explicit window (ride seconds); default places the peak 60 % into the clip. */
  window?: [number, number];
  label?: string;
}

export interface Detector {
  id: string;
  label: string;
  icon: string;
  category: MomentCategory;
  requires: ChannelId[];
  /** Minimum spacing between this detector's moments (s). */
  separation?: number;
  detect: (ride: Ride, units: UnitSystem) => Candidate[];
}

const defineDetector = (d: Detector) => d;

// ---------- helpers over 1 Hz record arrays ----------

function col(ride: Ride, id: ChannelId): Float64Array {
  return ride.raw(id) ?? new Float64Array(ride.t.length).fill(NaN);
}

/** Centred moving average over ±half samples, ignoring NaN. */
function smooth(a: Float64Array, half: number): Float64Array {
  const out = new Float64Array(a.length).fill(NaN);
  for (let i = 0; i < a.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(a.length - 1, i + half); j++) {
      if (Number.isFinite(a[j])) {
        s += a[j];
        n++;
      }
    }
    if (n > half) out[i] = s / n;
  }
  return out;
}

/** Index at ride time t + dt (records are ~1 Hz but may have gaps). */
function shift(ride: Ride, i: number, dt: number): number {
  return ride.index(ride.t[i] + dt);
}

/** Every sample as a candidate; selection does the non-max suppression. */
function everySample(score: Float64Array, detail: (i: number) => string, min = -Infinity): Candidate[] {
  const out: Candidate[] = [];
  score.forEach((s, i) => {
    if (Number.isFinite(s) && s > min) out.push({ i, score: s, detail: '' });
  });
  return out.map((c) => ({ ...c, detail: detail(c.i) }));
}

const fmt = (ride: Ride, id: ChannelId, i: number, units: UnitSystem, d?: number) => {
  const v = display(CHANNELS[id].quantity, col(ride, id)[i], units, d);
  return `${v.text} ${v.unit}`;
};

// ---------- detectors ----------

export const DETECTORS: Detector[] = [
  defineDetector({
    id: 'topSpeed', label: 'Top speed', icon: '⚡', category: 'effort', requires: ['speed'], separation: 60,
    detect: (r, u) => everySample(smooth(col(r, 'speed'), 1), (i) => `${fmt(r, 'speed', i, u)} peak`),
  }),
  defineDetector({
    id: 'maxHeartRate', label: 'Max heart rate', icon: '♥', category: 'effort', requires: ['heartRate'], separation: 90,
    detect: (r, u) => {
      const hr = col(r, 'heartRate');
      // Sustained: rank by 20 s mean so a single spike does not win; report the recorded peak.
      return everySample(smooth(hr, 10), (i) => {
        const z = r.hrZone(hr[i]);
        return `${fmt(r, 'heartRate', i, u)}${z ? ` · zone ${z.zone}` : ''}`;
      });
    },
  }),
  defineDetector({
    id: 'power', label: 'Top power', icon: '⚙', category: 'effort', requires: ['power'], separation: 60,
    detect: (r, u) => everySample(smooth(col(r, 'power'), 2), (i) => `${fmt(r, 'power', i, u)} (5 s)`),
  }),
  defineDetector({
    id: 'corner', label: 'Fast corner', icon: '↪', category: 'terrain', requires: ['speed', 'heading'], separation: 30,
    detect: (r, u) => {
      const v = smooth(col(r, 'speed'), 1);
      const h = col(r, 'heading');
      const g = new Float64Array(v.length).fill(NaN);
      for (let i = 0; i < v.length; i++) {
        const a = shift(r, i, -2);
        const b = shift(r, i, 2);
        const dt = r.t[b] - r.t[a];
        if (dt < 2 || !(v[i] > 5.5) || !Number.isFinite(h[a]) || !Number.isFinite(h[b])) continue; // > 20 km/h
        const dh = ((((h[b] - h[a]) % 360) + 540) % 360) - 180;
        g[i] = (Math.abs(dh) * Math.PI) / 180 / dt * v[i] / 9.81; // lateral g = v·ω
      }
      const gs = smooth(g, 1);
      return everySample(gs, (i) => `${gs[i].toFixed(2)} g at ${fmt(r, 'speed', i, u, 0)}`, 0.12)
        .map((c) => ({ ...c, window: [r.t[c.i] - 4, r.t[c.i] + 4] as [number, number] }));
    },
  }),
  defineDetector({
    id: 'sprint', label: 'Hardest acceleration', icon: '⇡', category: 'effort', requires: ['speed'], separation: 60,
    detect: (r, u) => {
      const v = col(r, 'speed');
      const s = new Float64Array(v.length).fill(NaN);
      for (let i = 0; i < v.length; i++) s[i] = v[shift(r, i, 6)] - v[i];
      return everySample(s, (i) => `+${display('speed', s[i], u, 0).text} ${display('speed', 0, u).unit} in 6 s`, 1.5)
        .map((c) => ({ ...c, window: [r.t[c.i] - 1, r.t[c.i] + 8] as [number, number] }));
    },
  }),
  defineDetector({
    id: 'braking', label: 'Hard braking', icon: '⏹', category: 'story', requires: ['speed'], separation: 60,
    detect: (r, u) => {
      const v = col(r, 'speed');
      const s = new Float64Array(v.length).fill(NaN);
      for (let i = 0; i < v.length; i++) s[i] = v[i] - v[shift(r, i, 4)];
      return everySample(s, (i) => `−${display('speed', s[i], u, 0).text} ${display('speed', 0, u).unit} in 4 s · check rear camera`, 2.5)
        .map((c) => ({ ...c, window: [r.t[c.i] - 3, r.t[c.i] + 6] as [number, number] }));
    },
  }),
  defineDetector({
    id: 'climb', label: 'Climb summit', icon: '▲', category: 'terrain', requires: ['altitude', 'distance'], separation: 120,
    detect: (r, u) => {
      const alt = col(r, 'altitude');
      const dist = col(r, 'distance');
      const climbs = r.meta.climbs.length ? r.meta.climbs : detectRuns(r, 'up');
      return climbs.map((c, k) => {
        const i0 = r.index(c.startT);
        const i1 = r.index(c.endT);
        let top = i0;
        for (let i = i0; i <= i1; i++) if (alt[i] > alt[top]) top = i;
        const gain = alt[top] - alt[i0];
        const len = dist[top] - dist[i0];
        const avg = len > 0 ? (gain / len) * 100 : NaN;
        return {
          i: top, score: gain * Math.max(1, avg),
          label: `${r.meta.climbs.length ? 'ClimbPro climb' : 'Climb'} ${k + 1}`,
          detail: `+${display('altitude', gain, u).text} ${display('altitude', 0, u).unit} over ${display('distance', len, u, 1).text} ${display('distance', 0, u).unit} · avg ${avg.toFixed(1)} %`,
          window: [r.t[top] - 7, r.t[top] + 3] as [number, number],
        };
      });
    },
  }),
  defineDetector({
    id: 'steepest', label: 'Steepest pitch', icon: '◢', category: 'terrain', requires: ['gradient', 'speed'], separation: 120,
    detect: (r) => {
      const g = col(r, 'gradient');
      const v = col(r, 'speed');
      const s = g.map((x, i) => (v[i] > 1.5 ? x : NaN));
      return everySample(s, (i) => `${g[i].toFixed(1)} % gradient`, 4);
    },
  }),
  defineDetector({
    id: 'descent', label: 'Fast descent', icon: '▼', category: 'terrain', requires: ['altitude', 'speed', 'distance'], separation: 120,
    detect: (r, u) => {
      const alt = col(r, 'altitude');
      const v = col(r, 'speed');
      return detectRuns(r, 'down').map((c) => {
        const i0 = r.index(c.startT);
        const i1 = r.index(c.endT);
        let fast = i0;
        for (let i = i0; i <= i1; i++) if (v[i] > v[fast]) fast = i;
        const drop = alt[i0] - alt[i1];
        return {
          i: fast, score: drop * v[fast],
          detail: `−${display('altitude', drop, u).text} ${display('altitude', 0, u).unit} · ${fmt(r, 'speed', fast, u, 0)} max`,
        };
      });
    },
  }),
  defineDetector({
    id: 'freewheel', label: 'Freewheeling fast', icon: '〰', category: 'story', requires: ['speed', 'cadence'], separation: 90,
    detect: (r, u) => {
      const v = col(r, 'speed');
      const cad = col(r, 'cadence');
      // Recorded zero cadence (real coasting) for ≥ 5 s, ranked by speed.
      const s = new Float64Array(v.length).fill(NaN);
      for (let i = 0; i < v.length; i++) {
        let ok = true;
        for (let j = shift(r, i, -2); j <= shift(r, i, 2); j++) if (cad[j] !== 0) ok = false;
        if (ok && v[i] > 6) s[i] = v[i];
      }
      return everySample(s, (i) => `coasting at ${fmt(r, 'speed', i, u, 0)}`);
    },
  }),
  defineDetector({
    id: 'highCadence', label: 'Spin-up', icon: '⟳', category: 'effort', requires: ['cadence'], separation: 90,
    detect: (r, u) => everySample(smooth(col(r, 'cadence'), 1), (i) => fmt(r, 'cadence', i, u), 100),
  }),
  defineDetector({
    id: 'highPoint', label: 'Highest point', icon: '⛰', category: 'terrain', requires: ['altitude'],
    detect: (r, u) => {
      const alt = col(r, 'altitude');
      let top = 0;
      alt.forEach((a, i) => { if (a > alt[top]) top = i; });
      return [{ i: top, score: 1, detail: fmt(r, 'altitude', top, u) }];
    },
  }),
  defineDetector({
    id: 'milestone', label: 'Distance milestone', icon: '⚑', category: 'story', requires: ['distance'], separation: 30,
    detect: (r, u) => {
      const d = col(r, 'distance');
      const step = u === 'metric' ? 10_000 : 16_093.4;
      const out: Candidate[] = [];
      for (let m = step, i = 0; i < d.length; i++) {
        if (d[i] >= m) {
          out.push({ i, score: m, detail: `${display('distance', m, u, 0).text} ${display('distance', 0, u).unit} mark` });
          m += step;
        }
      }
      return out;
    },
  }),
];

/** Contiguous climbs or descents: ≥ 3 % (or ≤ −3 %) sustained for ≥ 250 m. */
function detectRuns(r: Ride, dir: 'up' | 'down'): { startT: number; endT: number }[] {
  const g = col(r, 'gradient');
  const d = col(r, 'distance');
  const runs: { startT: number; endT: number }[] = [];
  let s = -1;
  let calm = 0;
  for (let i = 0; i <= g.length; i++) {
    const on = i < g.length && (dir === 'up' ? g[i] >= 3 : g[i] <= -3);
    if (on) {
      if (s < 0) s = i;
      calm = 0;
    } else if (s >= 0 && (++calm > 15 || i === g.length)) {
      const e = i - calm;
      if (d[e] - d[s] >= 250) runs.push({ startT: r.t[s], endT: r.t[e] });
      s = -1;
      calm = 0;
    }
  }
  return runs;
}

export interface DetectOptions {
  units: UnitSystem;
  /** Default clip length when a detector gives only a peak. */
  clipSeconds?: number;
  perDetector?: number;
}

/** Ranked moments per detector, with non-max suppression and clip windows. */
export function detectMoments(ride: Ride, opts: DetectOptions): Moment[] {
  const L = opts.clipSeconds ?? 8;
  const K = opts.perDetector ?? 5;
  const out: Moment[] = [];
  for (const det of DETECTORS) {
    if (!det.requires.every((c) => ride.has(c))) continue;
    const cands = det.detect(ride, opts.units).sort((a, b) => b.score - a.score);
    const picked: Candidate[] = [];
    for (const c of cands) {
      if (picked.length >= K) break;
      if (picked.every((p) => Math.abs(ride.t[p.i] - ride.t[c.i]) >= (det.separation ?? 60))) picked.push(c);
    }
    const best = picked[0]?.score || 1;
    picked.forEach((c, k) => {
      const peakT = ride.t[c.i];
      let [start, end] = c.window ?? [peakT - L * 0.6, peakT + L * 0.4];
      start = Math.max(0, start);
      end = Math.min(ride.duration, end);
      out.push({
        id: `${det.id}-${k + 1}`, detector: det.id, label: c.label ?? (k === 0 ? det.label : `${det.label} #${k + 1}`),
        detail: c.detail, peakT, start, end, rank: k + 1, strength: Math.max(0, Math.min(1, c.score / best)),
      });
    });
  }
  return out;
}

/** Priority order for the auto-edit: one of each kind first, then second-best, and so on. */
const AUTO_ORDER = ['topSpeed', 'maxHeartRate', 'power', 'climb', 'descent', 'corner', 'sprint', 'steepest', 'freewheel', 'braking', 'highCadence', 'highPoint', 'milestone'];

/**
 * Pick `count` non-overlapping moments for an automatic edit, round-robin across
 * detectors, keeping only moments `isUsable` accepts (e.g. covered by footage).
 * Returned in ride order.
 */
export function autoPick(moments: Moment[], count: number, isUsable: (m: Moment) => boolean = () => true, gap = 20): Moment[] {
  const chosen: Moment[] = [];
  const pools = AUTO_ORDER.map((id) => moments.filter((m) => m.detector === id && isUsable(m)));
  for (let round = 0; chosen.length < count && pools.some((p) => p.length > round); round++) {
    for (const pool of pools) {
      const m = pool[round];
      if (!m || chosen.length >= count) continue;
      if (chosen.every((c) => m.end + gap <= c.start || m.start >= c.end + gap)) chosen.push(m);
    }
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export const detectorById = (id: string) => DETECTORS.find((d) => d.id === id);
