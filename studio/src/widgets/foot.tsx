/** Helpers shared by the running, walking and hiking widgets of every family. */
import { averagePaceAt, typicalTopSpeed, type SplitState } from '../core/activity';
import { clamp, frac } from '../core/geometry';
import { display, formatDuration, MISSING, pad2, type Display } from '../core/units';
import type { WidgetFrame } from '../core/widget';
import { trailing } from './shared';

const SOLE = 'M-2 -38C14 -40 20 -22 17 -4C15 10 12 18 13 30C14 42 6 48 -2 48C-12 48 -16 40 -14 28C-12 16 -20 4 -20 -12C-20 -28 -14 -37 -2 -38Z';
const TOES: [number, number, number][] = [[-12, -50, 5], [-2, -55, 5.5], [8, -53, 5], [16, -47, 4.4], [21, -39, 3.6]];

/** Footprint centred on (x, y), about 100·s tall; `flip` mirrors it into a left foot. */
export function Foot({ x, y, s, fill, opacity = 1, flip, filter }: { x: number; y: number; s: number; fill: string; opacity?: number; flip?: boolean; filter?: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`} fill={fill} opacity={opacity} filter={filter}>
      <path d={SOLE} />
      {TOES.map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} />)}
    </g>
  );
}

/**
 * Footprint brightness from the integrated step phase: the foot of the current step is
 * lit and fades toward the next step. Both stay dim when cadence is zero or missing.
 */
export function footfall(f: WidgetFrame, dim = 0.22): { left: number; right: number; stepping: boolean } {
  const phase = f.ride.at('steps', f.t);
  const spm = f.ride.at('stepCadence', f.t);
  if (!Number.isFinite(phase) || !(spm > 0)) return { left: dim, right: dim, stepping: false };
  const lit = 1 - 0.45 * frac(phase);
  const leftStep = Math.floor(phase) % 2 === 0;
  return { left: leftStep ? lit : dim, right: leftStep ? dim : lit, stepping: true };
}

/** Pace trail as 0–1 heights (faster is higher), scaled by the activity's typical top speed. */
export function paceTrail(f: WidgetFrame, seconds: number, n: number): number[] {
  const top = typicalTopSpeed(f.ride);
  return Array.from(trailing(f, 'speed', seconds, n), (s) => (Number.isFinite(s) && top > 0 ? clamp(s / top, 0, 1) : NaN));
}

/** Estimated step count; held through recording gaps, which add no steps. */
export function stepsAt(f: WidgetFrame): number {
  const v = f.ride.at('steps', f.t);
  if (Number.isFinite(v) || !f.ride.has('steps') || f.t < f.ride.t[0]) return v;
  return f.ride.raw('steps')![f.ride.index(f.t)];
}

export const avgPace = (f: WidgetFrame): Display => display('pace', averagePaceAt(f.ride, f.t), f.units);

/** Split durations as m:ss (or h:mm:ss past an hour). */
export function splitText(sec: number): string {
  if (!Number.isFinite(sec)) return MISSING;
  return sec >= 3600 ? formatDuration(sec) : `${Math.floor(sec / 60)}:${pad2(Math.floor(sec % 60))}`;
}

/** Signed split delta, "−0:05" / "+0:12", or empty when there is nothing to compare. */
export function splitDelta(sec: number, prev?: number): string {
  if (prev === undefined || !Number.isFinite(sec) || !Number.isFinite(prev)) return '';
  const d = Math.round(sec - prev);
  return `${d < 0 ? '−' : '+'}${Math.floor(Math.abs(d) / 60)}:${pad2(Math.abs(d) % 60)}`;
}

export interface SplitView {
  n: number;
  /** Duration text, or –– when the split's timing is unknown. */
  text: string;
  /** Delta against the previous split when both are comparable, e.g. "−0:05". */
  delta: string;
  faster: boolean;
  /** Fastest of the comparable rows shown (only when at least two are comparable). */
  best: boolean;
  /** 0 (slowest shown) … 1 (fastest shown); NaN for partial or unknown splits. */
  rel: number;
}

/** The last `count` completed splits, ranked only among comparable (full, timed) splits. */
export function splitRows(s: SplitState | null, count = 3): SplitView[] {
  if (!s) return [];
  const start = Math.max(0, s.done.length - count);
  const rows = s.done.slice(start);
  const cmp = rows.filter((r) => r.comparable).map((r) => r.sec);
  const best = Math.min(...cmp);
  const slow = Math.max(...cmp);
  return rows.map((r, k) => {
    const prev = s.done[start + k - 1];
    const delta = r.comparable && prev?.comparable ? splitDelta(r.sec, prev.sec) : '';
    return {
      n: r.n,
      text: splitText(r.sec),
      delta,
      faster: delta.startsWith('−'),
      best: r.comparable && cmp.length > 1 && r.sec === best,
      rel: !r.comparable ? NaN : slow > best ? (slow - r.sec) / (slow - best) : 1,
    };
  });
}

/** Cardinal label for a heading in degrees. */
export function cardinal(deg: number): string {
  if (!Number.isFinite(deg)) return MISSING;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Compass ticks visible within ±span° of the heading, for ribbon widgets. */
export function ribbonTicks(heading: number, span: number, step = 5): { d: number; hdg: number; name?: string; major: boolean }[] {
  if (!Number.isFinite(heading)) return [];
  const out: { d: number; hdg: number; name?: string; major: boolean }[] = [];
  const first = Math.ceil((heading - span) / step) * step;
  for (let a = first; a <= heading + span; a += step) {
    const hdg = ((a % 360) + 360) % 360;
    const name = hdg % 45 === 0 ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][hdg / 45] : undefined;
    out.push({ d: a - heading, hdg, name, major: hdg % 15 === 0 });
  }
  return out;
}

export const MOVING_SETTINGS = [{ key: 'stoppedBelow', label: 'Stopped below (m/s)', type: 'number' as const, min: 0.1, max: 3, step: 0.1 }];
export const STEP_SETTINGS = [{ key: 'goal', label: 'Step goal', type: 'number' as const, min: 1000, max: 50000, step: 500 }];
