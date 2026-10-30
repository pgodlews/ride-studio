/**
 * Import Apple Watch workouts from a native Apple Health export
 * (export.xml + workout-routes/*.gpx). TypeScript port of
 * `studio/scripts/apple_health.py`; output matches the Python functions byte
 * for byte. File access goes through an injected Vfs so the same module runs
 * under Node, Electron and browsers.
 */
import type { RideJson } from '../core/ride';
import { pyRound, pythonFloat, sha1Hex, sha256Hex, textEncoder } from './util';
import { find, findtext, iter, parseXml } from './xml';

const INDEX_VERSION = 2;
const HOLD_SEC = 15.0;
const BREAK_GAP_SEC = 30.0;

const SPORTS: Record<string, string> = {
  Cycling: 'cycling',
  HandCycling: 'cycling',
  Running: 'running',
  Walking: 'walking',
  Hiking: 'hiking',
};
const FOOT = new Set(['running', 'walking', 'hiking']);

const SAMPLE_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: 'heartRate',
  HKQuantityTypeIdentifierCyclingCadence: 'cadence',
  HKQuantityTypeIdentifierCyclingPower: 'power',
  HKQuantityTypeIdentifierRunningPower: 'power',
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierDistanceCycling: 'distance',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distance',
};

const DISTANCE_UNITS: Record<string, number> = { km: 1000.0, m: 1.0, mi: 1609.344, ft: 0.3048, yd: 0.9144 };
const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const gpxElem = (name: string): string => `{${GPX_NS}}${name}`;

/** File-access surface supplied by the caller (Node, Electron or browsers). */
export interface AppleHealthVfs {
  /**
   * Lines of `path`, one element per line, without line terminators and with
   * `\r\n` / `\r` treated as a single break (Python's universal-newline file
   * iteration). This MUST stream — real Apple Health exports approach 1 GB and
   * exceed V8's maximum string length, so reading the whole file into memory
   * and splitting is not an option. Node callers should use
   * `readline.createInterface` over a `createReadStream` with
   * `crlfDelay: Infinity`; browsers/Electron need an equivalent streaming reader.
   */
  readLines(path: string): AsyncIterable<string>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Size in bytes and mtime in (possibly fractional) seconds — see apple_health.export_key. */
  stat(path: string): Promise<{ size: number; mtime: number }>;
  exists(path: string): Promise<boolean>;
  /** Join a directory and a child name (or a route path). */
  join(dir: string, name: string): string;
  /** Final path segment. */
  basename(path: string): string;
  /** Absolute/canonical path used for the cache key and index `export` field. */
  absolute(path: string): string;
  /** Whether `file` resolves inside directory `dir` (Python `is_relative_to`). */
  isWithin(dir: string, file: string): boolean;
}

interface WorkoutStat {
  sum?: string;
  average?: string;
  minimum?: string;
  maximum?: string;
  unit?: string;
}

export interface Workout {
  type: string;
  source: string;
  sourceVersion: string | null;
  device: string | null;
  start: string;
  end: string;
  durationMin: number;
  routes: string[];
  stats: Record<string, WorkoutStat>;
  events: { type: string; date: string | null }[];
  metadata: Record<string, string | null>;
  id: string;
  startUtc: string;
  endUtc: string;
  tzOffsetSec: number;
  sport: string;
  distanceM: number | null;
  avgHeartRate: number | null;
  indoor: boolean;
  sampleCounts?: Record<string, number>;
}

export interface WorkoutIndex {
  key: string;
  export: string;
  exportDate: string | null;
  xmlBytes: number;
  workouts: Workout[];
}

type Sample = [number, number, number];
type SampleChannels = Record<string, Sample[]>;
/** Per-workout sample rows (`{workoutId: {channel: [[t0, t1, value], ...]}}`). */
export type Samples = Record<string, SampleChannels>;

/** A full scan: the workout index plus the per-workout samples Python caches for `build_ride`. */
export interface AppleHealthScan {
  index: WorkoutIndex;
  samples: Samples;
}

interface RouteRow {
  t: number;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speed: number | null;
  hAcc: number | null;
}

// --- date helpers -----------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{2}:?\d{2})$/;

/** Apple Health date `'YYYY-MM-DD HH:MM:SS +0100'`; seconds-since-epoch and offset. */
function parseDate(text: unknown): { epochSec: number; offsetSec: number } {
  const m = DATE_RE.exec(String(text));
  if (!m) throw new Error('invalid date');
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  const hour = +m[4];
  const minute = +m[5];
  const second = +m[6];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error('invalid date');
  if (hour > 23 || minute > 59 || second > 59) throw new Error('invalid date');
  const offset = m[7];
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1);
  let oh = 0;
  let om = 0;
  if (digits.includes(':')) {
    const [a, b] = digits.split(':');
    oh = +a;
    om = +b;
  } else {
    oh = +digits.slice(0, 2);
    om = +digits.slice(2);
  }
  const offsetSec = sign * (oh * 3600 + om * 60);
  const epochSec = Date.UTC(year, month - 1, day, hour, minute, second, 0) / 1000 - offsetSec;
  return { epochSec, offsetSec };
}

/** UTC `YYYY-MM-DDTHH:MM:SS.fffZ` for a seconds-since-epoch instant (utc_iso). */
function utcIsoMs(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}Z`;
}

/** `datetime.fromisoformat(...).timestamp()` for a `Z`/offset route timestamp. */
function isoToEpoch(text: string): number {
  return Date.parse(text) / 1000;
}

// --- XML attribute / string helpers ----------------------------------------

function htmlUnescape(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (all, entity: string) => {
    if (entity[0] === '#') {
      const base = entity[1] === 'x' || entity[1] === 'X' ? 16 : 10;
      const cp = parseInt(entity.slice(base === 16 ? 2 : 1), base);
      if (Number.isFinite(cp)) return String.fromCodePoint(cp);
      return all;
    }
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return all;
    }
  });
}

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out[m[1]] = htmlUnescape(m[2]);
  return out;
}

function deviceModel(device: unknown): string | null {
  const re = /(\w[\w ]*?):(.*?)(?=, \w[\w ]*?:|>\s*$|$)/g;
  const fields: Record<string, string> = {};
  let m: RegExpExecArray | null;
  const text = String(device ?? '');
  while ((m = re.exec(text)) !== null) fields[m[1]] = m[2];
  const name = (fields['name'] ?? '').trim();
  const hardware = (fields['hardware'] ?? '').trim();
  if (name && hardware) return `${name} (${hardware})`;
  return name || hardware || null;
}

function bisectRight(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < sorted[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const i = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

/** Python `format(x, '.{ndec}f')`: round-half-even then fixed decimals. */
function pyFormat(value: number, ndec: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  const r = pyRound(value, ndec);
  const neg = Object.is(r, -0) || r < 0;
  return (neg ? '-' : '') + Math.abs(r).toFixed(ndec);
}

// --- pass 1: workouts -------------------------------------------------------

async function readWorkouts(xml: string, vfs: AppleHealthVfs): Promise<Workout[]> {
  const workouts: Workout[] = [];
  let cur: Workout | null = null;
  for await (const line of vfs.readLines(xml)) {
    const s = line.trimStart();
    if (s.startsWith('<Workout ')) {
      if (!s.trimEnd().endsWith('>')) throw new Error('Unexpected export.xml layout: Workout attributes span lines');
      const a = attrs(s);
      cur = {
        type: a['workoutActivityType'].replace('HKWorkoutActivityType', ''),
        source: a['sourceName'] ?? '',
        sourceVersion: a['sourceVersion'] ?? null,
        device: deviceModel(a['device'] ?? null),
        start: a['startDate'],
        end: a['endDate'],
        durationMin: a['duration'] ? Number(a['duration']) : NaN,
        routes: [],
        stats: {},
        events: [],
        metadata: {},
        id: '',
        startUtc: '',
        endUtc: '',
        tzOffsetSec: 0,
        sport: '',
        distanceM: null,
        avgHeartRate: null,
        indoor: false,
      };
      if (s.trimEnd().endsWith('/>')) {
        workouts.push(cur);
        cur = null;
      }
    } else if (cur !== null) {
      if (s.startsWith('<FileReference')) {
        cur.routes.push((attrs(s)['path'] ?? '').replace(/^\//, ''));
      } else if (s.startsWith('<WorkoutStatistics')) {
        const a = attrs(s);
        const stat: WorkoutStat = {};
        for (const k of ['sum', 'average', 'minimum', 'maximum', 'unit'] as const) {
          if (a[k] !== undefined) stat[k] = a[k];
        }
        cur.stats[a['type'].replace('HKQuantityTypeIdentifier', '')] = stat;
      } else if (s.startsWith('<WorkoutEvent')) {
        const a = attrs(s);
        cur.events.push({ type: (a['type'] ?? '').replace('HKWorkoutEventType', ''), date: a['date'] ?? null });
      } else if (s.startsWith('<MetadataEntry')) {
        const a = attrs(s);
        if (a['key'] !== undefined) cur.metadata[a['key']] = a['value'] ?? null;
      } else if (s.startsWith('</Workout>')) {
        workouts.push(cur);
        cur = null;
      }
    }
  }
  for (const w of workouts) {
    const start = parseDate(w.start);
    const end = parseDate(w.end);
    w.id = (await sha1Hex(textEncoder.encode(`${w.type}|${w.source}|${w.start}|${w.end}`))).slice(0, 16);
    w.startUtc = utcIsoMs(start.epochSec);
    w.endUtc = utcIsoMs(end.epochSec);
    w.tzOffsetSec = start.offsetSec;
    w.sport = SPORTS[w.type] ?? w.type.toLowerCase();
    const dist = Object.entries(w.stats).find(([k, v]) => k.startsWith('Distance') && v.sum !== undefined)?.[1] ?? null;
    w.distanceM = dist
      ? Number(dist.sum) * (DISTANCE_UNITS[(dist.unit ?? 'km')] ?? NaN)
      : null;
    const hr = w.stats['HeartRate'] ?? {};
    w.avgHeartRate = hr.average !== undefined ? Number(hr.average) : null;
    w.indoor = w.metadata['HKIndoorWorkout'] === '1';
  }
  return workouts;
}

// --- pass 2: samples per route workout --------------------------------------

async function readSamples(xml: string, workouts: Workout[], vfs: AppleHealthVfs): Promise<Samples> {
  const windows = workouts
    .filter((w) => w.routes.length > 0)
    .map((w) => ({ s: isoToEpoch(w.startUtc), e: isoToEpoch(w.endUtc), w }))
    .sort((a, b) => a.s - b.s);
  const starts = windows.map((x) => x.s);
  const samples: Samples = {};
  for (const win of windows) samples[win.w.id] = {};
  if (windows.length === 0) return samples;

  const wanted = Object.keys(SAMPLE_TYPES).map((t) => `type="${t}"`);
  for await (const line of vfs.readLines(xml)) {
    if (!line.trimStart().startsWith('<Record ') || !wanted.some((t) => line.includes(t))) continue;
    const a = attrs(line);
    let t0: number;
    let t1: number;
    let value: number;
    try {
      t0 = parseDate(a['startDate']).epochSec;
      t1 = parseDate(a['endDate']).epochSec;
      value = pythonFloat(a['value']);
    } catch {
      continue;
    }
    if (!Number.isFinite(value)) continue;
    const i = bisectRight(starts, t0) - 1;
    for (let j = Math.max(0, i - 3); j <= i; j++) {
      const win = windows[j];
      if (win.s <= t0 && t0 <= win.e && (a['sourceName'] ?? null) === win.w.source) {
        const key = SAMPLE_TYPES[a['type']];
        if (key === 'distance') value *= DISTANCE_UNITS[a['unit'] ?? 'km'] ?? NaN;
        (samples[win.w.id][key] ??= []).push([pyRound(t0, 3), pyRound(t1, 3), value]);
      }
    }
  }
  for (const per of Object.values(samples)) {
    for (const rows of Object.values(per)) rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  return samples;
}

// --- route GPX --------------------------------------------------------------

async function readRoute(path: string, vfs: AppleHealthVfs): Promise<RouteRow[]> {
  const root = parseXml(await vfs.readText(path));
  const rows: RouteRow[] = [];
  for (const pt of iter(root, gpxElem('trkpt'))) {
    const text = findtext(pt, gpxElem('time'));
    if (!text) continue;
    const t = isoToEpoch(text.trim());
    if (rows.length && t <= rows[rows.length - 1].t) continue;
    const ext = find(pt, gpxElem('extensions'));
    const num = (el: ReturnType<typeof find>, name: string): number | null => {
      const txt = el ? findtext(el, gpxElem(name)) : null;
      return txt === null ? null : Number(txt);
    };
    const speed = num(ext, 'speed');
    const lat = Number(pt.attrs['lat']);
    const lon = Number(pt.attrs['lon']);
    rows.push({
      t,
      lat: lat >= -90 && lat <= 90 ? lat : null,
      lon: lon >= -180 && lon <= 180 ? lon : null,
      altitude: num(pt, 'ele'),
      speed: speed !== null && speed >= 0 ? speed : null,
      hAcc: num(ext, 'hAcc'),
    });
  }
  return rows;
}

// --- distance / held sample helpers -----------------------------------------

function haversine(a: RouteRow, b: RouteRow): number {
  const rad = Math.PI / 180;
  const dlat = (b.lat! - a.lat!) * rad;
  const dlon = (b.lon! - a.lon!) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat! * rad) * Math.cos(b.lat! * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

function held(samples: Sample[], starts: number[], t: number, limit = HOLD_SEC): number | null {
  const i = bisectRight(starts, t) - 1;
  return i >= 0 && t - samples[i][0] <= limit ? samples[i][2] : null;
}

function cumulative(samples: Sample[], times: number[]): number[] {
  const out: number[] = [];
  let total = 0;
  let k = 0;
  for (const t of times) {
    while (k < samples.length && samples[k][1] <= t) {
      total += samples[k][2];
      k += 1;
    }
    let partial = 0;
    if (k < samples.length && samples[k][0] < t && t < samples[k][1]) {
      const [s0, s1, v] = samples[k];
      partial = (v * (t - s0)) / (s1 - s0);
    }
    out.push(total + partial);
  }
  return out;
}

// --- scan / build_ride ------------------------------------------------------

async function readIndex(exportDir: string, vfs: AppleHealthVfs): Promise<{ index: WorkoutIndex; samples: Samples }> {
  const xml = await checkExport(exportDir, vfs);
  const key = await exportKey(exportDir, vfs);
  const workouts = await readWorkouts(xml, vfs);
  const samples = await readSamples(xml, workouts, vfs);
  for (const [wid, per] of Object.entries(samples)) {
    const w = workouts.find((x) => x.id === wid);
    if (!w) continue;
    w.sampleCounts = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.length]));
  }
  let exportDate: string | null = null;
  let n = 0;
  for await (const line of vfs.readLines(xml)) {
    if (n >= 400) break;
    if (line.includes('<ExportDate')) {
      exportDate = attrs(line)['value'] ?? null;
      break;
    }
    n += 1;
  }
  const stat = await vfs.stat(xml);
  const index: WorkoutIndex = { key, export: vfs.absolute(exportDir), exportDate, xmlBytes: stat.size, workouts };
  return { index, samples };
}

async function checkExport(exportDir: string, vfs: AppleHealthVfs): Promise<string> {
  const xml = vfs.join(exportDir, 'export.xml');
  if (!(await vfs.exists(xml))) {
    throw new Error(`${exportDir} has no export.xml; choose the unzipped apple_health_export folder`);
  }
  const head = new TextDecoder('latin1').decode((await vfs.readBytes(xml)).slice(0, 4096));
  if (!head.includes('<!DOCTYPE HealthData') && !head.includes('<HealthData')) {
    throw new Error('export.xml is not an Apple Health export');
  }
  return xml;
}

async function exportKey(exportDir: string, vfs: AppleHealthVfs): Promise<string> {
  const xml = vfs.join(exportDir, 'export.xml');
  const st = await vfs.stat(xml);
  const text = `${vfs.absolute(xml)}|${st.size}|${Math.trunc(st.mtime)}|v${INDEX_VERSION}`;
  return (await sha1Hex(textEncoder.encode(text))).slice(0, 16);
}

export async function scan(exportDir: string, vfs: AppleHealthVfs): Promise<AppleHealthScan> {
  return readIndex(exportDir, vfs);
}

export async function buildRide(
  exportDir: string,
  workoutId: string,
  rideId: string,
  vfs: AppleHealthVfs,
  cached?: AppleHealthScan,
): Promise<{ ride: RideJson; evidence: Record<string, unknown> }> {
  const { index, samples } = cached ?? (await readIndex(exportDir, vfs));
  const w = index.workouts.find((x) => x.id === workoutId) ?? null;
  if (w === null) throw new Error('Unknown workout id; scan the export again');
  if (w.routes.length === 0) {
    throw new Error('This workout has no route in the export (indoor, or written by another app); nothing to place clips on');
  }
  const per: SampleChannels = samples[workoutId] ?? {};

  const rows: RouteRow[] = [];
  const evidenceRoutes: { file: string; bytes: number; sha256: string }[] = [];
  for (const route of w.routes) {
    const path = vfs.join(exportDir, route);
    if (!vfs.isWithin(exportDir, path) || !(await vfs.exists(path))) {
      throw new Error(`Route file missing from the export: ${vfs.basename(path)}`);
    }
    const raw = await vfs.readBytes(path);
    evidenceRoutes.push({ file: vfs.basename(path), bytes: raw.length, sha256: await sha256Hex(raw) });
    rows.push(...(await readRoute(path, vfs)));
  }
  rows.sort((a, b) => a.t - b.t);
  if (rows.reduce((n, r) => n + (r.lat !== null ? 1 : 0), 0) < 2) {
    throw new Error('The workout route has fewer than two GPS fixes');
  }

  const t0 = rows[0].t;
  const times = rows.map((r) => r.t);
  const pauses = w.events
    .filter((e) => (e.type === 'Pause' || e.type === 'MotionPaused') && e.date)
    .map((e) => parseDate(e.date).epochSec);
  const breaks: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (times[i] - times[i - 1] > BREAK_GAP_SEC || pauses.some((p) => times[i - 1] <= p && p < times[i])) breaks.push(i);
  }

  const sport = w.sport;
  const foot = FOOT.has(sport);
  const channels: Record<string, (number | null)[]> = {
    lat: rows.map((r) => r.lat),
    lon: rows.map((r) => r.lon),
    altitude: rows.map((r) => r.altitude),
    speed: rows.map((r) => r.speed),
  };
  const sources: Record<string, string> = {
    lat: 'Apple Watch workout route latitude (WGS-84)',
    lon: 'Apple Watch workout route longitude (WGS-84)',
    altitude: 'Apple Watch workout route elevation (m); vertical datum unverified',
    speed: 'Apple Watch recorded GPS speed from the route (m/s); not a wheel-speed sensor',
  };
  const warnings: string[] = [];

  if (per['distance'] && per['distance'].length) {
    channels['distance'] = cumulative(per['distance'], times).map((v) => pyRound(v, 3));
    sources['distance'] = 'Cumulative Apple Watch distance samples (m), linear within each sample interval';
  } else {
    let total = 0;
    const dist: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i && !breaks.includes(i) && r.lat !== null && rows[i - 1].lat !== null) {
        total += haversine(rows[i - 1], r);
      }
      dist.push(pyRound(total, 3));
    }
    channels['distance'] = dist;
    sources['distance'] = 'Derived cumulative horizontal GPS distance from the route (no Watch distance samples)';
    warnings.push('No Apple Watch distance samples; distance is derived from route positions');
  }

  const heldChannels: Array<[string, string, string]> = [
    ['heartRate', 'heartRate', 'Apple Watch heart-rate samples (bpm)'],
    ['cadence', 'cadence', 'Apple Health cycling cadence samples (rpm)'],
    ['power', 'power', 'Apple Health power samples (W)'],
  ];
  for (const [key, channel, note] of heldChannels) {
    if (key === 'cadence' && foot) continue;
    const data = per[key];
    if (!data || data.length === 0) continue;
    const starts = data.map((s) => s[0]);
    const values = times.map((t) => held(data, starts, t));
    if (values.some((v) => v !== null)) {
      channels[channel] = values.map((v) => (v === null ? null : pyRound(v, 3)));
      const gaps: number[] = [];
      for (let i = 1; i < data.length; i++) gaps.push(data[i][0] - data[i - 1][0]);
      const med = gaps.length ? median(gaps) : null;
      const suffix = med !== null && med !== 0 ? ` (median interval ${pyFormat(med, 1)} s)` : '';
      sources[channel] = `${note}; preceding sample held up to ${pyFormat(HOLD_SEC, 0)} s${suffix}`;
    }
  }

  if (foot && per['steps'] && per['steps'].length) {
    const steps = per['steps'];
    const starts = steps.map((s) => s[0]);
    const spm: (number | null)[] = times.map((t) => {
      const i = bisectRight(starts, t) - 1;
      const s = i >= 0 ? steps[i] : null;
      return s && s[1] > s[0] && s[0] <= t && t <= s[1] ? pyRound((s[2] / (s[1] - s[0])) * 60, 2) : null;
    });
    if (spm.some((v) => v !== null)) {
      channels['stepCadence'] = spm;
      sources['stepCadence'] = 'Derived average steps/min of each Apple Watch step-count interval (not per-step cadence)';
    }
  }

  if (foot) {
    channels['pace'] = channels['speed'].map((v) => (v ? pyRound(1 / v, 6) : null));
    sources['pace'] = 'Derived 1 / recorded GPS speed, seconds/metre; absent when stopped/invalid';
  }

  for (const key of Object.keys(channels)) {
    if (!channels[key].some((v) => v !== null)) delete channels[key];
  }

  const stats = w.stats;
  const stat = (name: string, field: string): number | null => {
    const v = (stats[name] ?? {})[field as keyof WorkoutStat];
    return v !== undefined ? Number(v) : null;
  };
  const summary: Record<string, number | string | null> = {
    sport,
    total_elapsed_time: isoToEpoch(w.endUtc) - isoToEpoch(w.startUtc),
    total_timer_time: Number.isFinite(w.durationMin) ? w.durationMin * 60 : null,
    total_distance: w.distanceM,
    avg_heart_rate: stat('HeartRate', 'average'),
    max_heart_rate: stat('HeartRate', 'maximum'),
    total_calories: stat('ActiveEnergyBurned', 'sum'),
  };

  const evidence: Record<string, unknown> = {
    workoutId: w.id,
    type: w.type,
    source: w.source,
    sourceVersion: w.sourceVersion,
    device: w.device,
    startUtc: w.startUtc,
    endUtc: w.endUtc,
    exportDate: index.exportDate,
    export: vfs.basename(exportDir),
    routes: evidenceRoutes,
    sampleCounts: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.length])),
    events: w.events,
    holdSec: HOLD_SEC,
    breakGapSec: BREAK_GAP_SEC,
    routePoints: rows.length,
  };

  if (breaks.length) {
    warnings.push(`${breaks.length} route gap(s)/pause(s) kept as breaks; nothing is bridged across them`);
  }
  const others = index.workouts.filter((x) => x.id !== w.id && x.startUtc < w.endUtc && x.endUtc > w.startUtc);
  if (others.length) {
    warnings.push(`Overlapping workouts from ${[...new Set(others.map((x) => x.source))].sort().join(', ')} were not merged`);
  }

  const local = isoToEpoch(w.startUtc) + w.tzOffsetSec;
  const name = `Apple Watch ${w.type.toLowerCase()} ${localName(local)}`;

  const ride: RideJson = {
    schema: 1,
    id: rideId,
    startUtc: utcIsoMs(t0),
    tzOffsetSec: w.tzOffsetSec,
    t: times.map((t) => pyRound(t - t0, 3)),
    breaks,
    channels,
    meta: {
      hrZones: null,
      laps: [],
      climbs: [],
      summary,
      sensors: [w.device || w.source],
      source: evidenceRoutes[0].file,
      warnings,
      channelSources: sources,
      telemetry: { kind: 'apple-health', appleHealth: evidence },
      activity: {
        sport,
        subSport: null,
        name,
        primaryMetric: foot ? 'pace' : 'speed',
        indoor: w.indoor,
        gpsSamples: rows.reduce((n, r) => n + (r.lat !== null ? 1 : 0), 0),
        recordSamples: rows.length,
        routeUsable: true,
        routeImportEligible: true,
        exclusionReason: null,
      },
    },
  };

  return { ride, evidence };
}

/** `strftime('%Y-%m-%d %H:%M')` of a local wall-clock instant (seconds since epoch). */
function localName(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}