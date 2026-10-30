/**
 * Ride telemetry: columnar channels on a shared, strictly increasing time axis.
 *
 * Time `t` is seconds since startUtc (first FIT record or imported video playback zero). Missing readings are NaN (never 0),
 * so widgets can show a "no data" state. Interpolation follows each channel's
 * definition: continuous quantities are linear, discrete sensor readings (HR, cadence)
 * hold the preceding recorded sample, matching the original renderer.
 */
import { CHANNELS, type ChannelId } from './channels';

export interface HrZones {
  /** Upper bpm boundary of zone 0 (rest) … zone 5, as written by the Edge. */
  highBoundaries: number[];
  calcType?: string;
  maxHeartRate?: number;
  thresholdHeartRate?: number;
  source?: string;
}

export interface Climb {
  number: number;
  startT: number;
  endT: number;
  startDistance: number;
  endDistance: number;
  category?: number;
}

export interface RideJson {
  schema: 1;
  id: string;
  startUtc: string;
  tzOffsetSec: number | null;
  t: number[];
  /** Indices starting a new recorded segment; no interpolation across the boundary. */
  breaks?: number[];
  channels: Partial<Record<string, (number | null)[]>>;
  meta: {
    hrZones: HrZones | null;
    laps: { startT: number; endT: number; distance?: number }[];
    climbs: Climb[];
    summary: Record<string, number | string | null>;
    sensors: string[];
    warnings: string[];
    source?: string;
    telemetry?: Record<string, unknown>;
    channelSources?: Record<string, string>;
    activity?: {
      sport: string | number | null;
      subSport: string | number | null;
      name: string | null;
      primaryMetric: 'pace' | 'speed';
      indoor: boolean;
      gpsSamples: number;
      recordSamples: number;
      routeUsable: boolean;
      routeImportEligible: boolean;
      exclusionReason: string | null;
    };
  };
}

export class Ride {
  readonly id: string;
  readonly startMs: number;
  readonly tzOffsetSec: number | null;
  readonly t: Float64Array;
  readonly meta: RideJson['meta'];
  /**
   * Longest record interval bridged by interpolation and by integrals such as steps and
   * moving time: the 90th-percentile interval within segments, clamped to 5–30 s, and 5 s
   * until there are at least 10 intervals to measure. Edge 1 Hz rides keep 5 s; watches
   * and handhelds with smart recording (6–20 s between records) are bridged at their own
   * cadence instead of blanking between records, while rarer longer gaps stay missing.
   */
  readonly gapSec: number;
  private readonly segments: Uint32Array;
  private readonly data = new Map<ChannelId, Float64Array>();

  constructor(json: RideJson) {
    this.id = json.id;
    this.startMs = Date.parse(json.startUtc);
    this.tzOffsetSec = json.tzOffsetSec;
    this.meta = json.meta;
    this.t = Float64Array.from(json.t);
    const breaks = new Set(json.breaks ?? []);
    let segment = 0;
    this.segments = Uint32Array.from(json.t, (_, i) => (segment += breaks.has(i) ? 1 : 0));
    this.gapSec = recordGapTolerance(this.t, this.segments);
    for (const [id, values] of Object.entries(json.channels)) {
      if (values) this.data.set(id as ChannelId, Float64Array.from(values, (v) => (v == null ? NaN : v)));
    }
    // Derived channels are computed in dependency order from the channel registry.
    for (const def of Object.values(CHANNELS)) {
      if (def.derive && !this.data.has(def.id) && def.dependsOn!.every((d) => this.has(d))) {
        this.data.set(def.id, def.derive(this));
      }
    }
  }

  get duration(): number {
    return this.t[this.t.length - 1] ?? 0;
  }

  /** Ride seconds for an absolute UTC instant (ms since epoch). */
  rideTimeAt(utcMs: number): number {
    return (utcMs - this.startMs) / 1000;
  }

  has(id: ChannelId): boolean {
    const a = this.data.get(id);
    return !!a && a.some(Number.isFinite);
  }

  raw(id: ChannelId): Float64Array | undefined {
    return this.data.get(id);
  }

  /** Whether two sample indices belong to the same uninterrupted segment. */
  continuous(a: number, b: number): boolean {
    return this.segments[a] === this.segments[b];
  }

  /** Index i with t[i] <= time < t[i+1], clamped to the record range. */
  index(time: number): number {
    const t = this.t;
    if (time <= t[0]) return 0;
    let lo = 0;
    let hi = t.length - 1;
    if (time >= t[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= time) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Channel value at ride time. NaN when missing, outside the ride, or across a gap. */
  at(id: ChannelId, time: number): number {
    const a = this.data.get(id);
    if (!a || time < this.t[0] || time > this.duration) return NaN;
    if (id === 'pace' && this.data.has('speed')) {
      // Invert AFTER interpolating speed: linear interpolation of reciprocals
      // would misstate pace during acceleration and across zero-speed samples.
      const speed = this.at('speed', time);
      return Number.isFinite(speed) && speed > 0 ? 1 / speed : NaN;
    }
    const i = this.index(time);
    const def = CHANNELS[id];
    if (time === this.t[i] || i >= this.t.length - 1) return a[i];
    if (!this.continuous(i, i + 1)) return NaN;
    const t0 = this.t[i];
    const t1 = this.t[i + 1];
    // Do not bridge recording gaps longer than the channel or this ride's recording tolerates.
    if (t1 - t0 > (def.maxGapSec ?? this.gapSec)) return time - t0 < 1 ? a[i] : NaN;
    if (def.interpolate === 'hold') return a[i];
    const v0 = a[i];
    const v1 = a[i + 1];
    if (!Number.isFinite(v0) || !Number.isFinite(v1)) return NaN;
    const f = (time - t0) / (t1 - t0);
    if (def.interpolate === 'angle') return (v0 + ((((v1 - v0) % 360) + 540) % 360 - 180) * f + 360) % 360;
    return v0 + (v1 - v0) * f;
  }

  /** `count` evenly spaced samples over [from, to]; NaN where missing. */
  series(id: ChannelId, from: number, to: number, count: number): Float64Array {
    const out = new Float64Array(count);
    for (let k = 0; k < count; k++) out[k] = this.at(id, from + ((to - from) * k) / Math.max(1, count - 1));
    return out;
  }

  /** Finite min/max of a channel over the whole ride (cached). */
  extent(id: ChannelId): [number, number] {
    const key = `extent:${id}`;
    const cached = this.cache.get(key) as [number, number] | undefined;
    if (cached) return cached;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.data.get(id) ?? []) {
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const result: [number, number] = Number.isFinite(lo) ? [lo, hi] : [NaN, NaN];
    this.cache.set(key, result);
    return result;
  }

  /** Memo for expensive per-ride geometry (profiles, projected routes). */
  memo<T>(key: string, build: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, build());
    return this.cache.get(key) as T;
  }
  private readonly cache = new Map<string, unknown>();

  /** Heart-rate zone (1–5, fractional position within the zone) or NaN. */
  hrZone(bpm: number): { zone: number; position: number } | null {
    const b = this.meta.hrZones?.highBoundaries;
    if (!b || !Number.isFinite(bpm)) return null;
    for (let z = 0; z < b.length; z++) {
      if (bpm < b[z] || z === b.length - 1) {
        const lo = z === 0 ? 0 : b[z - 1];
        return { zone: z, position: Math.min(1, Math.max(0, (bpm - lo) / (b[z] - lo))) };
      }
    }
    return null;
  }

  /** Climb (from Garmin ClimbPro) active at ride time, if any. */
  climbAt(time: number): Climb | undefined {
    return this.meta.climbs.find((c) => time >= c.startT && time <= c.endT);
  }

  /** Local wall-clock Date parts for display, using the ride's recorded offset. */
  localTime(time: number): { h: number; m: number; s: number; label: string } {
    const offset = this.tzOffsetSec ?? 0;
    const d = new Date(this.startMs + time * 1000 + offset * 1000);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const s = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
    return { h, m, s, label: this.tzOffsetSec == null ? 'UTC' : 'LOCAL' };
  }
}

/** 90th-percentile record interval within segments, clamped to [5, 30] s; 5 s below 10 intervals. */
export function recordGapTolerance(t: ArrayLike<number>, segments: ArrayLike<number>): number {
  const dts: number[] = [];
  for (let i = 1; i < t.length; i++) if (segments[i] === segments[i - 1] && t[i] > t[i - 1]) dts.push(t[i] - t[i - 1]);
  if (dts.length < 10) return 5;
  dts.sort((a, b) => a - b);
  return Math.min(30, Math.max(5, Math.ceil(dts[Math.floor(dts.length * 0.9)])));
}

export async function loadRide(url: string): Promise<Ride> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ride ${url}: HTTP ${res.status}`);
  const json = (await res.json()) as RideJson;
  if (json.schema !== 1) throw new Error(`Unsupported ride schema ${json.schema}`);
  return new Ride(json);
}
