/**
 * Channel registry. Recorded channels come from prepare_ride.py; derived channels are
 * computed once per ride from recorded ones. Add a channel here and any widget can
 * request it by id. Values are SI (m/s, m, °C) and converted only for display.
 */
import type { Ride } from './ride';

export type Interpolation = 'linear' | 'hold' | 'angle';
export type Quantity =
  | 'speed' | 'distance' | 'altitude' | 'temperature' | 'heartRate' | 'cadence'
  | 'percent' | 'breathRate' | 'power' | 'degrees' | 'count' | 'pace' | 'stepCadence' | 'strideCadence' | 'verticalSpeed';

export interface ChannelDef {
  id: ChannelId;
  label: string;
  quantity: Quantity;
  interpolate: Interpolation;
  /** Longest record gap (s) bridged by interpolation. */
  maxGapSec?: number;
  /** Derived channels: compute a full column aligned to ride.t. */
  dependsOn?: ChannelId[];
  derive?: (ride: Ride) => Float64Array;
  note?: string;
}

export type ChannelId =
  | 'speed' | 'heartRate' | 'cadence' | 'altitude' | 'distance' | 'temperature'
  | 'respiration' | 'power' | 'lat' | 'lon' | 'relativeAltitude'
  | 'pace' | 'stepCadence' | 'strideCadence'
  | 'gradient' | 'ascent' | 'climbRate' | 'heading' | 'heartBeats' | 'crankRevs' | 'breaths' | 'steps';

/**
 * Cumulative integral of a per-minute rate (bpm, rpm, brpm, spm) → count. Each record
 * interval uses the reading at its start, as displayed (hold); intervals longer than the
 * ride's gap tolerance, across segment breaks or after a missing reading add nothing.
 */
function cumulativeFromRate(ride: Ride, id: ChannelId): Float64Array {
  const rate = ride.raw(id)!;
  const out = new Float64Array(ride.t.length);
  for (let i = 1; i < out.length; i++) {
    const dt = ride.t[i] - ride.t[i - 1];
    const r = rate[i - 1];
    out[i] = out[i - 1] + (Number.isFinite(r) && dt <= ride.gapSec && ride.continuous(i - 1, i) ? (r / 60) * dt : 0);
  }
  return out;
}

/** Grade (%) over a centred distance window, then lightly smoothed. */
function deriveGradient(ride: Ride): Float64Array {
  const alt = ride.raw('altitude')!;
  const dist = ride.raw('distance')!;
  const n = ride.t.length;
  const half = 30; // metres either side
  const raw = new Float64Array(n).fill(NaN);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && !ride.continuous(i - 1, i)) lo = hi = i;
    const d = dist[i];
    if (!Number.isFinite(d)) continue;
    while (lo < i && !(dist[lo] >= d - half)) lo++;
    if (hi < i) hi = i;
    while (hi < n - 1 && ride.continuous(i, hi + 1) && Number.isFinite(dist[hi + 1]) && dist[hi + 1] <= d + half) hi++;
    const run = dist[hi] - dist[lo];
    const rise = alt[hi] - alt[lo];
    if (run >= 15 && Number.isFinite(rise)) raw[i] = (rise / run) * 100;
  }
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let k = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      if (ride.continuous(i, j) && Number.isFinite(raw[j])) {
        sum += raw[j];
        k++;
      }
    }
    out[i] = k ? sum / k : NaN;
  }
  return out;
}

/** Cumulative elevation gain with a 1 m hysteresis to ignore barometric jitter. */
function deriveAscent(ride: Ride): Float64Array {
  const alt = ride.raw('altitude')!;
  const out = new Float64Array(alt.length);
  let ref = NaN;
  let gain = 0;
  for (let i = 0; i < alt.length; i++) {
    if (i > 0 && !ride.continuous(i - 1, i)) ref = NaN;
    const a = alt[i];
    if (Number.isFinite(a)) {
      if (!Number.isFinite(ref) || a < ref) ref = a;
      else if (a - ref >= 1) {
        gain += a - ref;
        ref = a;
      }
    }
    out[i] = gain;
  }
  return out;
}

/**
 * Vertical speed (m/s): least-squares slope of altitude over a centred 60 s window
 * within one recorded segment, so a single noisy GPS altitude at either end cannot
 * dominate. Needs 30 s of span and 4 samples; windows stretched past 90 s by long
 * recording gaps are left missing rather than averaged over a pause.
 */
function deriveClimbRate(ride: Ride): Float64Array {
  const alt = ride.raw('altitude')!;
  const t = ride.t;
  const out = new Float64Array(t.length).fill(NaN);
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(alt[i])) continue;
    let a = ride.index(t[i] - 30);
    let b = ride.index(t[i] + 30);
    while (a < i && !ride.continuous(a, i)) a++;
    while (b > i && !ride.continuous(i, b)) b--;
    if (t[b] - t[a] < 30 || t[b] - t[a] > 90) continue;
    let n = 0, st = 0, sa = 0, stt = 0, sta = 0;
    for (let j = a; j <= b; j++) {
      if (!Number.isFinite(alt[j])) continue;
      const x = t[j] - t[i];
      n++; st += x; sa += alt[j]; stt += x * x; sta += x * alt[j];
    }
    const den = n * stt - st * st;
    if (n >= 4 && den > 0) out[i] = (n * sta - st * sa) / den;
  }
  return out;
}

/** Direction of travel (° from north) from positions ~2 s either side (the neighbouring records when sparser). */
function deriveHeading(ride: Ride): Float64Array {
  const lat = ride.raw('lat')!;
  const lon = ride.raw('lon')!;
  const n = lat.length;
  const out = new Float64Array(n).fill(NaN);
  const rad = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const a = ride.index(ride.t[i] - 2);
    const b = ride.index(ride.t[i] + 2);
    if (!ride.continuous(a, b) || ride.t[b] - ride.t[a] > ride.gapSec + 4 || !Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) continue;
    const dy = (lat[b] - lat[a]) * 111_320;
    const dx = (lon[b] - lon[a]) * 111_320 * Math.cos(lat[i] * rad);
    if (Math.hypot(dx, dy) >= 3) out[i] = (Math.atan2(dx, dy) / rad + 360) % 360;
    else if (i > 0) out[i] = out[i - 1];
  }
  return out;
}

const def = (d: ChannelDef) => d;

export const CHANNELS: Record<ChannelId, ChannelDef> = {
  speed: def({ id: 'speed', label: 'Speed', quantity: 'speed', interpolate: 'linear' }),
  heartRate: def({ id: 'heartRate', label: 'Heart rate', quantity: 'heartRate', interpolate: 'hold' }),
  cadence: def({ id: 'cadence', label: 'Cadence', quantity: 'cadence', interpolate: 'hold' }),
  pace: def({ id: 'pace', label: 'Pace', quantity: 'pace', interpolate: 'linear',
    note: 'Seconds per metre, inverse of interpolated activity speed; missing when stopped or speed is missing.' }),
  stepCadence: def({ id: 'stepCadence', label: 'Step cadence', quantity: 'stepCadence', interpolate: 'hold',
    note: 'Running/walking steps per minute: 2 × (FIT cadence + fractional cadence).' }),
  strideCadence: def({ id: 'strideCadence', label: 'Stride cadence', quantity: 'strideCadence', interpolate: 'hold',
    note: 'Original FIT cadence plus fraction, strides/min; distinct from crank rpm.' }),
  altitude: def({ id: 'altitude', label: 'Elevation', quantity: 'altitude', interpolate: 'linear' }),
  relativeAltitude: def({ id: 'relativeAltitude', label: 'Relative altitude', quantity: 'altitude', interpolate: 'linear',
    note: 'DJI relative altitude, distinct from absolute/ellipsoidal altitude.' }),
  distance: def({ id: 'distance', label: 'Distance', quantity: 'distance', interpolate: 'linear' }),
  temperature: def({ id: 'temperature', label: 'Temperature', quantity: 'temperature', interpolate: 'hold',
    note: 'Device/sensor reading, not necessarily air temperature.' }),
  respiration: def({ id: 'respiration', label: 'Respiration', quantity: 'breathRate', interpolate: 'linear',
    note: 'Garmin estimate.' }),
  power: def({ id: 'power', label: 'Power', quantity: 'power', interpolate: 'hold' }),
  lat: def({ id: 'lat', label: 'Latitude', quantity: 'degrees', interpolate: 'linear' }),
  lon: def({ id: 'lon', label: 'Longitude', quantity: 'degrees', interpolate: 'linear' }),
  // Derived (order matters only through dependsOn).
  gradient: def({ id: 'gradient', label: 'Gradient', quantity: 'percent', interpolate: 'linear',
    dependsOn: ['altitude', 'distance'], derive: deriveGradient,
    note: 'Derived: altitude change over a centred 60 m distance window.' }),
  ascent: def({ id: 'ascent', label: 'Elevation gain', quantity: 'altitude', interpolate: 'linear',
    dependsOn: ['altitude'], derive: deriveAscent, note: 'Derived with 1 m hysteresis.' }),
  climbRate: def({ id: 'climbRate', label: 'Climb rate', quantity: 'verticalSpeed', interpolate: 'linear',
    dependsOn: ['altitude'], derive: deriveClimbRate,
    note: 'Derived: least-squares altitude slope over a centred 60 s window (m/h); missing across long gaps.' }),
  heading: def({ id: 'heading', label: 'Heading', quantity: 'degrees', interpolate: 'angle',
    dependsOn: ['lat', 'lon'], derive: deriveHeading, note: 'Derived from GPS track.' }),
  heartBeats: def({ id: 'heartBeats', label: 'Beat phase', quantity: 'count', interpolate: 'linear',
    dependsOn: ['heartRate'], derive: (r) => cumulativeFromRate(r, 'heartRate'),
    note: 'Animation phase paced by recorded HR; not an ECG.' }),
  crankRevs: def({ id: 'crankRevs', label: 'Crank phase', quantity: 'count', interpolate: 'linear',
    dependsOn: ['cadence'], derive: (r) => cumulativeFromRate(r, 'cadence') }),
  breaths: def({ id: 'breaths', label: 'Breath phase', quantity: 'count', interpolate: 'linear',
    dependsOn: ['respiration'], derive: (r) => cumulativeFromRate(r, 'respiration') }),
  steps: def({ id: 'steps', label: 'Steps (estimated)', quantity: 'count', interpolate: 'linear',
    dependsOn: ['stepCadence'], derive: (r) => cumulativeFromRate(r, 'stepCadence'),
    note: 'Estimated by integrating recorded step cadence within the ride gap tolerance; not the watch step counter.' }),
};
