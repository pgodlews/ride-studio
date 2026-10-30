/**
 * Read a GPX 1.0/1.1 track into studio ride JSON. TypeScript port of
 * `studio/scripts/gpx_activity.py read_gpx()`; the Python function is the
 * specification and stays byte-for-byte the reference for output values.
 */
import type { RideJson } from '../core/ride';
import { pyRound, sha256Hex } from './util';
import { find, findall, findtext, iter, parseXml, type XmlNode } from './xml';

const GPX_NAMESPACES = new Set(['http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1', '']);
const TPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/';
const FOOT_SPORTS = new Set(['running', 'walking', 'hiking']);
const EARTH_RADIUS_M = 6371008.8;

export interface GpxReadOptions {
  track?: number;
  sport?: string;
  timezone?: string;
  /** GPX filename used for evidence.source / meta.source; Python reads it from the path. */
  sourceName?: string;
}

/** Python `read_gpx` can return `startUtc: None` when no timestamped points exist. */
export type GpxRide = Omit<RideJson, 'startUtc'> & { startUtc: string | null };

export interface GpxEvidence {
  source: string;
  sha256: string;
  bytes: number;
  integrity: string;
  creator: string | null;
  version: string | null;
  tracks: number;
  selectedTrack: number | null;
  waypoints: number;
  routes: number;
  extensionTags: Record<string, number>;
  segments: number;
  untimedPoints: number;
  duplicateTimes: number;
  derivedSpeedSamples: number;
  derivedSpeedIndices: number[];
  recordedSpeedSamples: number;
  discontinuities: number;
  displayTimezone: string | null;
}

type RowChannel = 'lat' | 'lon' | 'altitude' | 'speed' | 'distance' | 'heartRate' | 'temperature' | 'cadence';

interface Row {
  utc: number; // integer microseconds since the Unix epoch
  segment: number;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speed: number | null;
  heartRate: number | null;
  cadence: number | null;
  temperature: number | null;
  speedPresent: boolean;
  break: boolean;
  distance: number | null;
}

function rowValue(row: Row, channel: string): number | null {
  return row[channel as RowChannel] ?? null;
}

/** Python `float(text)` with the finite/range/integer guards of gpx_activity.number. */
function number(text: string | null | undefined, minimum?: number | null, maximum?: number | null, integer = false): number | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  if (minimum !== undefined && minimum !== null && value < minimum) return null;
  if (maximum !== undefined && maximum !== null && value > maximum) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

/** Parse an ISO-8601 timestamp with a mandatory offset (Z or ±HH:MM); integer micros since the epoch. */
function parseUtcMicros(text: string): number {
  const m = ISO_UTC.exec(text.trim());
  if (!m) throw new Error('invalid');
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  const hour = +m[4];
  const minute = +m[5];
  const second = +m[6];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error('invalid');
  if (hour > 23 || minute > 59 || second > 59) throw new Error('invalid');
  let micro = 0;
  const frac = m[7];
  if (frac) micro = parseInt((frac + '000000').slice(0, 6), 10);
  const tz = m[8];
  if (!tz) throw new Error('missing timezone');
  let offset = 0;
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1);
    let h = 0;
    let mi = 0;
    if (digits.includes(':')) {
      const [a, b] = digits.split(':');
      h = +a;
      mi = +b;
    } else if (digits.length === 4) {
      h = +digits.slice(0, 2);
      mi = +digits.slice(2);
    } else {
      h = +digits;
    }
    offset = sign * (h * 3600 + mi * 60);
  }
  return (Date.UTC(year, month - 1, day, hour, minute, second, 0) / 1000 - offset) * 1e6 + micro;
}

/** UTC wall-clock ISO `YYYY-MM-DDTHH:MM:SS(.ffffff)Z` for a micros instant. */
function formatUtc(micros: number): string {
  const wholeSec = Math.floor(micros / 1e6);
  const micro = micros - wholeSec * 1e6;
  const d = new Date(wholeSec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  let out = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  if (micro !== 0) out += `.${p(micro, 6)}`;
  return `${out}Z`;
}

/** Whole-second UTC offset of an IANA timezone at a UTC instant (via Intl). */
function tzOffsetSeconds(timeZone: string, micros: number): number {
  const epochMs = Math.floor(micros / 1000);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((wall - epochMs) / 1000);
}

/** Horizontal geodesic distance in metres, matching prepare_dji.separation. */
function separation(a: Row, b: Row): number {
  const rad = Math.PI / 180;
  const lat1 = a.lat! * rad;
  const lat2 = b.lat! * rad;
  const dlon = (b.lon! - a.lon!) * rad;
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export async function readGpx(
  input: string | Uint8Array,
  activityId: string,
  opts: GpxReadOptions = {},
): Promise<{ ride: GpxRide; evidence: GpxEvidence }> {
  const track = opts.track;
  const sport = opts.sport;
  const timezoneName = opts.timezone;
  const source = opts.sourceName ?? 'gpx';
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const raw = new TextDecoder('utf-8').decode(bytes);

  if (upperNoNul(raw).includes('<!DOCTYPE') || upperNoNul(raw).includes('<!ENTITY')) {
    throw new Error('GPX DTD/entity declarations are unsupported');
  }

  let root: XmlNode;
  try {
    root = parseXml(raw);
  } catch (error) {
    throw new Error(`Invalid GPX XML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const namespace = root.tag.startsWith('{') ? root.tag.slice(1).split('}')[0] : '';
  const q = (name: string) => (namespace ? `{${namespace}}${name}` : name);
  if (root.tag !== q('gpx') || !GPX_NAMESPACES.has(namespace)) {
    throw new Error('Expected a GPX 1.0/1.1 document');
  }

  const tracks = findall(root, q('trk'));
  if (track === undefined && tracks.length > 1) {
    throw new Error(`GPX contains ${tracks.length} tracks; select one with --track (1-based)`);
  }
  if (track !== undefined && !(track >= 1 && track <= tracks.length)) {
    throw new Error(`--track must be between 1 and ${tracks.length}`);
  }
  const selected = tracks.length ? tracks[(track ?? 1) - 1] : null;

  const extensionCounts: Record<string, number> = {};
  for (const extensions of iter(root, q('extensions'))) {
    for (const e of iter(extensions)) {
      if (e === extensions) continue;
      extensionCounts[e.tag] = (extensionCounts[e.tag] ?? 0) + 1;
    }
  }

  const evidence: GpxEvidence = {
    source,
    sha256: await sha256Hex(bytes),
    bytes: bytes.length,
    integrity: 'XML parsed (GPX has no FIT CRC)',
    creator: root.attrs['creator'] ?? null,
    version: root.attrs['version'] ?? null,
    tracks: tracks.length,
    selectedTrack: tracks.length ? track ?? 1 : null,
    waypoints: findall(root, q('wpt')).length,
    routes: findall(root, q('rte')).length,
    extensionTags: extensionCounts,
    segments: 0,
    untimedPoints: 0,
    duplicateTimes: 0,
    derivedSpeedSamples: 0,
    derivedSpeedIndices: [],
    recordedSpeedSamples: 0,
    discontinuities: 0,
    displayTimezone: timezoneName ?? null,
  };

  const rows: Row[] = [];
  const warnings: string[] = [];
  let untimed = 0;
  let duplicates = 0;
  let pendingBreak = false;

  const segments = selected ? findall(selected, q('trkseg')) : [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    pendingBreak = rows.length > 0;
    for (const point of findall(segment, q('trkpt'))) {
      const text = findtext(point, q('time'));
      if (!text) {
        untimed += 1;
        pendingBreak = true;
        continue;
      }
      let timestamp: number;
      try {
        timestamp = parseUtcMicros(text.trim());
      } catch {
        throw new Error('GPX point time must be valid and include Z or a timezone offset');
      }
      const last = rows.length ? rows[rows.length - 1].utc : null;
      if (last !== null && timestamp < last) {
        throw new Error('GPX point times go backwards; split or repair the track before importing');
      }
      if (last !== null && timestamp === last) {
        duplicates += 1;
        pendingBreak = true;
        continue;
      }
      let lat = number(point.attrs['lat'], -90, 90);
      let lon = number(point.attrs['lon'], -180, 180);
      if (lat === null || lon === null || findtext(point, q('fix')) === 'none') {
        lat = null;
        lon = null;
      }
      const row: Row = {
        utc: timestamp,
        segment: segmentIndex,
        lat,
        lon,
        altitude: number(findtext(point, q('ele'))),
        speed: null,
        heartRate: null,
        cadence: null,
        temperature: null,
        speedPresent: false,
        break: pendingBreak,
        distance: null,
      };
      const speedEl = namespace.endsWith('/1/0') ? find(point, q('speed')) : null;
      if (speedEl) {
        row.speed = number(speedEl.text || null, 0);
        row.speedPresent = true;
      }
      const ext = find(point, q('extensions'));
      if (ext) {
        for (const version of ['v2', 'v1']) {
          const tpx = find(ext, `{${TPX}${version}}TrackPointExtension`);
          if (!tpx) continue;
          const fields: Array<[string, 'heartRate' | 'cadence' | 'temperature' | 'speed', number | null, number | null, boolean]> = [
            ['hr', 'heartRate', 1, 255, true],
            ['cad', 'cadence', 0, 254, true],
            ['atemp', 'temperature', null, null, false],
          ];
          if (version === 'v2') fields.push(['speed', 'speed', 0, null, false]);
          for (const [field, channel, low, high, integer] of fields) {
            const el = find(tpx, `{${TPX}${version}}${field}`);
            if (el) {
              row[channel] = number(el.text || null, low, high, integer);
              if (channel === 'speed') row.speedPresent = true;
            }
          }
          break;
        }
      }
      rows.push(row);
      pendingBreak = false;
    }
  }

  evidence.segments = segments.length;
  evidence.untimedPoints = untimed;
  evidence.duplicateTimes = duplicates;
  if (untimed) warnings.push(`${untimed} untimed track points skipped; no timestamp or motion invented`);
  if (duplicates) warnings.push(`${duplicates} duplicate point timestamps dropped (first kept)`);

  const start = rows.length ? rows[0].utc : null;
  const times = rows.map((r) => pyRound((r.utc - start!) / 1e6, 6));
  const breaks: number[] = [];
  let total = 0;
  let derivedCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prev = i ? rows[i - 1] : null;
    const dt = i ? times[i] - times[i - 1] : null;
    const connected = prev !== null && !row.break && dt !== null && dt <= 5 && row.lat !== null && prev.lat !== null;
    if (i && !connected) breaks.push(i);
    if (connected) {
      const delta = separation(prev!, row);
      total += delta;
      if (!row.speedPresent) {
        row.speed = delta / dt!;
        derivedCount += 1;
      }
    }
    row.distance = row.lat !== null ? total : null;
  }

  const channelIds = ['lat', 'lon', 'altitude', 'speed', 'distance', 'heartRate', 'temperature'];
  const foot = sport !== undefined && FOOT_SPORTS.has(sport);
  if (!foot) channelIds.push('cadence');
  else if (rows.some((r) => r.cadence !== null)) {
    warnings.push('GPX cadence is rpm with unverified foot cadence semantics; not converted to steps/strides');
  }

  const channels: Record<string, (number | null)[]> = {};
  for (const c of channelIds) {
    if (rows.some((r) => rowValue(r, c) !== null)) {
      channels[c] = rows.map((r) => {
        const v = rowValue(r, c);
        return v === null ? null : pyRound(v, 6);
      });
    }
  }

  const notes: Record<string, string> = {
    lat: 'GPX WGS-84 latitude (degrees)',
    lon: 'GPX WGS-84 longitude (degrees)',
    altitude: 'GPX ele (metres); vertical datum unverified',
    heartRate: 'Garmin TrackPointExtension hr (bpm)',
    cadence: 'Garmin TrackPointExtension cad (rpm); genuine zero retained',
    temperature: 'Garmin TrackPointExtension atemp (C), device/sensor reading',
    speed: 'GPX recorded speed (m/s); where absent, adjacent-fix horizontal distance / UTC interval',
    distance: 'Derived cumulative horizontal GPS distance; excludes segments/invalid fixes/gaps over 5 s',
  };
  const sources: Record<string, string> = {};
  for (const [c, note] of Object.entries(notes)) if (channels[c]) sources[c] = note;

  if (derivedCount) {
    warnings.push('Speed includes GPS-derived interval estimates; sparse sampling and position jitter limit accuracy');
  }

  evidence.derivedSpeedSamples = derivedCount;
  evidence.derivedSpeedIndices = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.speed !== null && !r.speedPresent).map(({ i }) => i);
  evidence.recordedSpeedSamples = rows.reduce((n, r) => n + (r.speedPresent && r.speed !== null ? 1 : 0), 0);
  evidence.discontinuities = breaks.length;

  if (breaks.length) {
    warnings.push('Distance is partial; segments, invalid fixes, untimed points and gaps over 5 s are not joined');
  }

  if (foot && channels['speed']) {
    const pace = channels['speed'].map((v) => (v !== null && v > 0 ? pyRound(1 / v, 6) : null));
    if (pace.some((v) => v !== null)) {
      channels['pace'] = pace;
      sources['pace'] = 'Derived 1 / GPX speed, seconds/metre; absent when stopped/invalid';
    }
  }

  let offset: number | null = null;
  if (timezoneName) {
    const offsets = new Set<number>();
    for (const r of rows) offsets.add(tzOffsetSeconds(timezoneName, r.utc));
    if (offsets.size > 1) {
      throw new Error('Track crosses a timezone offset transition; split it before importing');
    }
    offset = offsets.values().next().value ?? null;
  } else {
    warnings.push('No display timezone supplied; clock widgets show UTC');
  }

  const gpsCount = rows.reduce((n, r) => n + (r.lat !== null ? 1 : 0), 0);
  const eligible = gpsCount >= 2;
  const reason = eligible
    ? null
    : rows.length === 0
      ? 'no timestamped track points (waypoints/routes are not recordings)'
      : 'fewer than two timestamped GPS fixes';
  if (reason) warnings.push(`Excluded from route activity import: ${reason}`);

  const ride: GpxRide = {
    schema: 1,
    id: activityId,
    startUtc: start !== null ? formatUtc(start) : null,
    tzOffsetSec: offset,
    t: times,
    breaks,
    channels,
    meta: {
      hrZones: null,
      laps: [],
      climbs: [],
      summary: {},
      sensors: [],
      source,
      warnings,
      channelSources: sources,
      telemetry: { kind: 'gpx', gpx: evidence },
      activity: {
        sport: sport ?? null,
        subSport: null,
        name: selected ? findtext(selected, q('name')) : null,
        primaryMetric: foot ? 'pace' : 'speed',
        indoor: false,
        gpsSamples: gpsCount,
        recordSamples: rows.length,
        routeUsable: eligible,
        routeImportEligible: eligible,
        exclusionReason: reason,
      },
    },
  };

  return { ride, evidence };
}

function upperNoNul(text: string): string {
  return text.replace(/\u0000/g, '').toUpperCase();
}