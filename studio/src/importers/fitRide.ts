/**
 * Platform-neutral ride builder and activity inspector for decoded FIT messages.
 *
 * Line-by-line port of studio/scripts/prepare_ride.py build_ride() and the FIT
 * inspection logic of studio/scripts/prepare_activity.py inspect_activity().
 */
import type { Climb, HrZones, RideJson } from '../core/ride';
import { pyRound } from './util';
import { decodeFit } from './fit';

export const FIT_EPOCH_UNIX = 631065600; // 1989-12-31T00:00:00Z
const SEMICIRCLE = 180 / 2147483648; // 180 / 2^31
const FOOT_SPORTS = new Set(['running', 'walking', 'hiking']);

// channel id -> [candidate FIT record fields in preference order, decimals]
export const CHANNELS: Record<string, readonly [readonly string[], number]> = {
  speed: [['enhanced_speed', 'speed'], 3],
  altitude: [['enhanced_altitude', 'altitude'], 2],
  heartRate: [['heart_rate'], 0],
  cadence: [['cadence', 'cadence256'], 2],
  distance: [['distance'], 2],
  temperature: [['temperature'], 1],
  respiration: [['enhanced_respiration_rate', 'respiration_rate'], 2],
  power: [['power'], 0],
  lat: [['position_lat'], 6],
  lon: [['position_long'], 6],
  strideCadence: [['cadence', 'cadence256'], 4],
  stepCadence: [['cadence', 'cadence256'], 4],
};

export function parseUtc(text: string): { ms: number; date: Date } {
  if (typeof text !== 'string') {
    throw new Error('FIT timestamp must include UTC or an explicit timezone offset');
  }
  if (!text.endsWith('Z') && !/[+-]\d{2}(?::?\d{2})?$/.test(text)) {
    throw new Error('FIT timestamp must include UTC or an explicit timezone offset');
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error('FIT timestamp must include UTC or an explicit timezone offset');
  }
  return { ms, date: new Date(ms) };
}

function formatStartUtc(date: Date): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const prefix = iso.slice(0, 19);
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${prefix}.${ms}000Z`;
}

function finite(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'object'
  ) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readChannel(record: Record<string, unknown>, channel: string): number | null {
  const [fields, decimals] = CHANNELS[channel];
  for (const field of fields) {
    let value = finite(record[field]);
    if (value === null) {
      continue;
    }
    if (channel === 'lat' || channel === 'lon') {
      if (value === 0x7fffffff) {
        continue;
      }
      value *= SEMICIRCLE;
      if (Math.abs(value) > (channel === 'lat' ? 90 : 180)) {
        continue;
      }
    }
    if (channel === 'cadence' || channel === 'strideCadence' || channel === 'stepCadence') {
      if (value < 0) {
        continue;
      }
      if (field === 'cadence') {
        const frac = finite(record.fractional_cadence);
        if ('fractional_cadence' in record && frac === null) {
          continue;
        }
        if (frac !== null) {
          if (frac < 0 || frac >= 1) {
            continue;
          }
          value += frac;
        }
      }
      if (channel === 'stepCadence') {
        value *= 2;
      }
    }
    if (channel === 'heartRate' && value <= 0) {
      continue;
    }
    if ((channel === 'speed' || channel === 'distance') && value < 0) {
      continue;
    }
    return pyRound(value, decimals);
  }
  return null;
}

export function buildRide(
  msgs: Record<string, unknown[]>,
  rideId: string,
  source: string,
): RideJson {
  const warnings: string[] = [];
  const sessions = (msgs.session_mesgs as Record<string, unknown>[] | undefined) ?? [];
  if (sessions.length > 1) {
    throw new Error(
      'Multiple FIT sessions require separate sport/time projections; split the activity before importing',
    );
  }
  const session = sessions[0] ?? {};
  const sportMessages = (msgs.sport_mesgs as Record<string, unknown>[] | undefined) ?? [];
  const sportMessage = sportMessages[0] ?? {};
  const sport = (session.sport ?? sportMessage.sport ?? null) as string | number | null;
  const subSport = (session.sub_sport ?? sportMessage.sub_sport ?? null) as string | number | null;
  const foot = typeof sport === 'string' && FOOT_SPORTS.has(sport);
  const excluded = new Set(foot ? ['cadence'] : ['strideCadence', 'stepCadence']);
  const channelIds = Object.keys(CHANNELS).filter((c) => !excluded.has(c));

  const allRecords = (msgs.record_mesgs as Record<string, unknown>[] | undefined) ?? [];
  const records = allRecords.filter((r) => r && r.timestamp);
  records.sort((a, b) => parseUtc(a.timestamp as string).ms - parseUtc(b.timestamp as string).ms);
  if (records.length === 0) {
    throw new Error('No timestamped record messages found');
  }
  const { ms: startMs, date: startDate } = parseUtc(records[0].timestamp as string);

  // Developer fields (sensor apps) that declare record power/cadence: key -> label
  const devFields: { power: Record<string, string>; cadence: Record<string, string> } = {
    power: {},
    cadence: {},
  };
  const fieldDescriptionMesgs =
    (msgs.field_description_mesgs as Record<string, unknown>[] | undefined) ?? [];
  for (const fd of fieldDescriptionMesgs) {
    const key = fd.key;
    const name = String(fd.field_name ?? '').toLowerCase();
    const num = fd.native_field_num;
    const mesg = fd.native_mesg_num;
    if (
      key !== undefined &&
      key !== null &&
      (mesg === undefined || mesg === null || mesg === 20 || mesg === 'record')
    ) {
      const label = String(fd.field_name || `#${key}`);
      if (num === 7 || name === 'power') {
        devFields.power[String(key)] = label;
      } else if (num === 4 || name === 'cadence') {
        devFields.cadence[String(key)] = label;
      }
    }
  }
  const devUsed: { power: Set<string>; cadence: Set<string> } = {
    power: new Set(),
    cadence: new Set(),
  };

  const times: number[] = [];
  const cols: Record<string, (number | null)[]> = Object.fromEntries(
    channelIds.map((c) => [c, []]),
  );
  let duplicates = 0;

  for (let rec of records) {
    const t = (parseUtc(rec.timestamp as string).ms - startMs) / 1000;
    if (times.length > 0 && t <= times[times.length - 1]) {
      // Interpolation needs strictly increasing time; keep the first sample.
      duplicates++;
      continue;
    }
    const devs = rec.developer_fields as Record<string, unknown> | undefined;
    if (devs && typeof devs === 'object') {
      const extra: Record<string, unknown> = {};
      for (const field of ['power', 'cadence'] as const) {
        if (!(field in rec)) {
          for (const [k, label] of Object.entries(devFields[field])) {
            if (k in devs && finite(devs[k]) !== null) {
              extra[field] = devs[k];
              devUsed[field].add(label);
              break;
            }
          }
        }
      }
      if (Object.keys(extra).length > 0) {
        rec = { ...rec, ...extra };
      }
    }
    times.push(t);
    for (const c of channelIds) {
      cols[c].push(readChannel(rec, c));
    }
    // A route fix needs both coordinates at the same timestamp.
    if (cols.lat[cols.lat.length - 1] === null || cols.lon[cols.lon.length - 1] === null) {
      cols.lat[cols.lat.length - 1] = null;
      cols.lon[cols.lon.length - 1] = null;
    }
  }

  if (duplicates > 0) {
    warnings.push(`${duplicates} duplicate record timestamps dropped (first kept)`);
  }
  let gaps = 0;
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i + 1] - times[i] > 1.5) {
      gaps++;
    }
  }
  if (gaps > 0) {
    warnings.push(`${gaps} gaps longer than 1.5 s between records`);
  }

  // Drop channels that never have a value
  const channels: Partial<Record<string, (number | null)[]>> = {};
  for (const [c, vals] of Object.entries(cols)) {
    if (vals.some((v) => v !== null)) {
      channels[c] = vals;
    }
  }

  const gpsCount = cols.lat ? cols.lat.filter((v) => v !== null).length : 0;
  const indoor =
    typeof subSport === 'string' &&
    new Set(['indoor_walking', 'treadmill', 'indoor_running', 'indoor_cycling']).has(subSport);
  const routeUsable = gpsCount >= 2;
  const eligible =
    typeof sport === 'string' &&
    new Set(['cycling', ...FOOT_SPORTS]).has(sport) &&
    routeUsable &&
    !indoor;
  const reason = indoor
    ? 'indoor activity'
    : !routeUsable
      ? 'fewer than two timestamped GPS fixes'
      : typeof sport !== 'string' || !new Set(['cycling', ...FOOT_SPORTS]).has(sport)
        ? 'unsupported sport'
        : null;

  const activityName =
    'sport_profile_name' in session
      ? (session.sport_profile_name as string | null)
      : (sportMessage.name as string | null) ?? null;

  const activity: NonNullable<RideJson['meta']['activity']> = {
    sport,
    subSport,
    name: activityName,
    primaryMetric: foot ? 'pace' : 'speed',
    indoor,
    gpsSamples: gpsCount,
    recordSamples: times.length,
    routeUsable,
    routeImportEligible: eligible,
    exclusionReason: reason,
  };

  const channelSources: Record<string, string> = Object.fromEntries(
    Object.keys(channels).map((c) => [c, 'FIT record: ' + CHANNELS[c][0].join('/')]),
  );

  if (foot) {
    if (channels.speed) {
      const pace = channels.speed.map((v) =>
        v !== null && v > 0 ? pyRound(1 / v, 6) : null,
      );
      if (pace.some((v) => v !== null)) {
        channels.pace = pace;
        channelSources.pace =
          'Derived 1 / FIT speed, seconds/metre; missing at zero/invalid speed';
      }
    }
    const notes: Record<string, string> = {
      strideCadence: 'FIT cadence + fractional_cadence, strides/min (two steps per stride)',
      stepCadence: '2 × (FIT cadence + fractional_cadence), steps/min; distinct from cycling cadence',
    };
    for (const [c, note] of Object.entries(notes)) {
      if (c in channels) {
        channelSources[c] = note;
      }
    }
    warnings.push(
      'Running/walking/hiking pace derives from recorded speed; step cadence is separate from cycling cadence',
    );
  }

  for (const c of Object.keys(channelSources)) {
    const used =
      c === 'power'
        ? devUsed.power
        : c === 'cadence' || c === 'strideCadence' || c === 'stepCadence'
          ? devUsed.cadence
          : null;
    if (used && used.size > 0) {
      channelSources[c] += `; developer field ${Array.from(used).sort().join(', ')} where the record has none`;
    }
  }

  if (reason) {
    warnings.push(
      `Excluded from route activity import: ${reason}; recorded sensors remain available for inspection`,
    );
  }

  // Local time offset: activity.local_timestamp (FIT epoch, local) vs its UTC timestamp
  let tzOffset: number | null = null;
  const activityMesgs = (msgs.activity_mesgs as Record<string, unknown>[] | undefined) ?? [];
  for (const act of activityMesgs) {
    if (act.local_timestamp !== undefined && act.local_timestamp !== null && act.timestamp) {
      const { ms: utcMs } = parseUtc(act.timestamp as string);
      const utcUnix = utcMs / 1000;
      const localSec = Number(act.local_timestamp);
      const rawOffset = pyRound((localSec + FIT_EPOCH_UNIX - utcUnix) / 900, 0) * 900;
      tzOffset = Object.is(rawOffset, -0) || rawOffset === 0 ? 0 : rawOffset;
    }
  }
  if (tzOffset === null) {
    warnings.push('No activity local_timestamp; local clock widgets will show UTC');
  }

  function rideT(ts: string): number {
    return pyRound((parseUtc(ts).ms - startMs) / 1000, 3);
  }

  let hrZones: HrZones | null = null;
  const timeInZoneMesgs = (msgs.time_in_zone_mesgs as Record<string, unknown>[] | undefined) ?? [];
  for (const z of timeInZoneMesgs) {
    if (z.reference_mesg === 'session' && Array.isArray(z.hr_zone_high_boundary)) {
      hrZones = {
        highBoundaries: z.hr_zone_high_boundary as number[],
        calcType: ((z.hr_calc_type as string | undefined) ?? null) as unknown as string,
        maxHeartRate: ((z.max_heart_rate as number | undefined) ?? null) as unknown as number,
        thresholdHeartRate: ((z.threshold_heart_rate as number | undefined) ?? null) as unknown as number,
        source: 'FIT time_in_zone (session)',
      };
      break;
    }
  }

  const laps: RideJson['meta']['laps'] = [];
  const lapMesgs = (msgs.lap_mesgs as Record<string, unknown>[] | undefined) ?? [];
  for (const lap of lapMesgs) {
    if (lap.start_time && lap.total_elapsed_time !== undefined && lap.total_elapsed_time !== null) {
      const t0 = rideT(lap.start_time as string);
      laps.push({
        startT: t0,
        endT: pyRound(t0 + Number(lap.total_elapsed_time), 3),
        distance: ((lap.total_distance as number | undefined) ?? null) as unknown as number,
      });
    }
  }

  const climbs: Climb[] = [];
  let openClimb: Record<string, unknown> | null = null;
  const climbProMesgs = (msgs.climb_pro_mesgs as Record<string, unknown>[] | undefined) ?? [];
  for (const ev of climbProMesgs) {
    const kind = ev.climb_pro_event;
    if (kind === 'start') {
      openClimb = {
        startT: rideT(ev.timestamp as string),
        startDistance: ev.current_dist ?? null,
        category: ev.climb_category ?? null,
      };
    } else if (kind === 'complete' && openClimb) {
      openClimb.endT = rideT(ev.timestamp as string);
      openClimb.endDistance = ev.current_dist ?? null;
      climbs.push(openClimb as unknown as Climb);
      openClimb = null;
    }
  }
  climbs.forEach((c, i) => {
    c.number = i + 1;
  });

  const summaryKeys = [
    'total_distance',
    'total_ascent',
    'total_descent',
    'total_elapsed_time',
    'total_timer_time',
    'avg_heart_rate',
    'max_heart_rate',
    'avg_cadence',
    'max_cadence',
    'avg_temperature',
    'total_calories',
    'sport',
    'sub_sport',
  ] as const;

  const summary: Record<string, number | string | null> = {};
  for (const k of summaryKeys) {
    summary[k] = (session[k] as number | string | null | undefined) ?? null;
  }
  summary.enhanced_avg_speed =
    (session.enhanced_avg_speed as number | null | undefined) ??
    (session.avg_speed as number | null | undefined) ??
    null;
  summary.enhanced_max_speed =
    (session.enhanced_max_speed as number | null | undefined) ??
    (session.max_speed as number | null | undefined) ??
    null;

  const sensorSet = new Set<string>();
  const deviceInfoMesgs = (msgs.device_info_mesgs as Record<string, unknown>[] | undefined) ?? [];
  for (const d of deviceInfoMesgs) {
    const candidate =
      d.antplus_device_type ||
      d.product_name ||
      (d.garmin_product !== 0 && d.garmin_product !== '0' ? d.garmin_product : undefined);
    if (candidate !== undefined && candidate !== null && candidate !== '' && candidate !== false) {
      sensorSet.add(String(candidate));
    }
  }
  const sensors = Array.from(sensorSet).sort();

  return {
    schema: 1,
    id: rideId,
    startUtc: formatStartUtc(startDate),
    tzOffsetSec: tzOffset,
    t: times.map((t) => pyRound(t, 3)),
    channels,
    meta: {
      hrZones,
      laps,
      climbs,
      summary,
      sensors,
      warnings,
      source,
      activity,
      channelSources,
    },
  };
}

export async function inspectFitActivity(
  input: Uint8Array,
  activityId: string,
  sourceName: string,
  inputPath?: string,
): Promise<{
  messages: Record<string, unknown[]>;
  ride: RideJson;
  report: Record<string, unknown>;
}> {
  const { messages, evidence } = await decodeFit(input, sourceName);
  const ride = buildRide(messages, activityId, sourceName);
  ride.meta.telemetry = { kind: 'fit', fit: evidence };
  const report: Record<string, unknown> = {
    ...evidence,
    ...ride.meta.activity,
    inputPath: inputPath ?? sourceName,
    startUtc: ride.startUtc,
    kind: 'fit',
    durationSec: ride.t.length > 0 ? ride.t[ride.t.length - 1] : 0,
    channels: Object.keys(ride.channels).sort(),
    coverage: Object.fromEntries(
      Object.entries(ride.channels).map(([c, vals]) => [
        c,
        vals ? vals.filter((v) => v !== null).length : 0,
      ]),
    ),
    warnings: ride.meta.warnings,
  };
  return { messages, ride, report };
}
