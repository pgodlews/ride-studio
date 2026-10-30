"""Convert decoded FIT messages into the studio's compact columnar ride JSON.

Input is the strict JSON written by the FIT decoding workflow (see docs/workflow.md):
a dict of message lists such as ``record_mesgs``. Output is one file per ride under
``studio/public/data/rides/`` (ignored by Git, because it contains GPS positions).

Rules carried over from AGENTS.md:
- missing/invalid readings are written as null, never as zero;
- real zero cadence stays zero;
- enhanced speed/altitude are preferred; speed stays in m/s (SI) and units are
  converted only for display;
- unknown numbered fields are not given meanings here.
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

FIT_EPOCH_UNIX = 631065600  # 1989-12-31T00:00:00Z
STUDIO = Path(__file__).resolve().parent.parent

# channel id -> (candidate FIT record fields in preference order, decimals)
CHANNELS = {
    'speed': (('enhanced_speed', 'speed'), 3),
    'altitude': (('enhanced_altitude', 'altitude'), 2),
    'heartRate': (('heart_rate',), 0),
    'cadence': (('cadence', 'cadence256'), 2),
    'distance': (('distance',), 2),
    'temperature': (('temperature',), 1),
    'respiration': (('enhanced_respiration_rate', 'respiration_rate'), 2),
    'power': (('power',), 0),
    'lat': (('position_lat',), 6),
    'lon': (('position_long',), 6),
    'strideCadence': (('cadence', 'cadence256'), 4),
    'stepCadence': (('cadence', 'cadence256'), 4),
}
SEMICIRCLE = 180 / 2**31
FOOT_SPORTS = {'running', 'walking', 'hiking'}


def parse_utc(text: str) -> datetime:
    dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('FIT timestamp must include UTC or an explicit timezone offset')
    return dt.astimezone(timezone.utc)


def finite(value):
    if value is None or isinstance(value, (list, dict, str, bool)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def read_channel(record: dict, channel: str):
    fields, decimals = CHANNELS[channel]
    for field in fields:
        value = finite(record.get(field))
        if value is None:
            continue
        if channel in ('lat', 'lon'):
            # FIT sint32's invalid sentinel is not a longitude of 180 degrees.
            if value == 0x7fffffff:
                continue
            value *= SEMICIRCLE
            if abs(value) > (90 if channel == 'lat' else 180):
                continue
        if channel in ('cadence', 'strideCadence', 'stepCadence'):
            if value < 0:
                continue
            if field == 'cadence':
                frac = finite(record.get('fractional_cadence'))
                if 'fractional_cadence' in record and frac is None:
                    continue
                if frac is not None:
                    if not 0 <= frac < 1:
                        continue
                    value += frac
            if channel == 'stepCadence':
                value *= 2
        if channel == 'heartRate' and value <= 0:
            continue
        if channel in ('speed', 'distance') and value < 0:
            continue
        return round(value, decimals)
    return None


def build_ride(msgs: dict, ride_id: str, source: str) -> dict:
    """Build a studio ride without writing files; keep the full FIT time axis."""
    warnings: list[str] = []
    sessions = msgs.get('session_mesgs') or []
    if len(sessions) > 1:
        raise ValueError('Multiple FIT sessions require separate sport/time projections; split the activity before importing')
    session = (sessions or [{}])[0]
    sport_message = (msgs.get('sport_mesgs') or [{}])[0]
    sport = session.get('sport', sport_message.get('sport'))
    sub_sport = session.get('sub_sport', sport_message.get('sub_sport'))
    foot = sport in FOOT_SPORTS
    excluded = {'cadence'} if foot else {'strideCadence', 'stepCadence'}
    channel_ids = [c for c in CHANNELS if c not in excluded]

    records = [r for r in msgs.get('record_mesgs', []) if r.get('timestamp')]
    records.sort(key=lambda r: parse_utc(r['timestamp']))
    if not records:
        raise ValueError('No timestamped record messages found')
    start = parse_utc(records[0]['timestamp'])

    # Developer fields (sensor apps) that declare record power/cadence, by native field or name: key -> label.
    dev_fields: dict[str, dict] = {'power': {}, 'cadence': {}}
    for fd in msgs.get('field_description_mesgs') or []:
        key = fd.get('key')
        name = str(fd.get('field_name') or '').lower()
        num = fd.get('native_field_num')
        mesg = fd.get('native_mesg_num')
        if key is not None and mesg in (None, 20):
            label = str(fd.get('field_name') or f'#{key}')
            if num == 7 or name == 'power':
                dev_fields['power'].update({key: label, str(key): label})
            elif num == 4 or name == 'cadence':
                dev_fields['cadence'].update({key: label, str(key): label})
    dev_used: dict[str, set] = {'power': set(), 'cadence': set()}

    times: list[float] = []
    cols: dict[str, list] = {c: [] for c in channel_ids}
    duplicates = 0
    for rec in records:
        t = (parse_utc(rec['timestamp']) - start).total_seconds()
        if times and t <= times[-1]:
            # Interpolation needs strictly increasing time; keep the first sample.
            duplicates += 1
            continue
        devs = rec.get('developer_fields')
        if isinstance(devs, dict) and devs:
            # A record's own field wins; the decoded input is never modified.
            extra = {}
            for field, keys in dev_fields.items():
                if field not in rec:
                    for k, label in keys.items():
                        if k in devs and finite(devs[k]) is not None:
                            extra[field] = devs[k]
                            dev_used[field].add(label)
                            break
            if extra:
                rec = {**rec, **extra}
        times.append(t)
        for c in channel_ids:
            cols[c].append(read_channel(rec, c))
        # A route fix needs both coordinates at the same timestamp.
        if cols['lat'][-1] is None or cols['lon'][-1] is None:
            cols['lat'][-1] = cols['lon'][-1] = None
    if duplicates:
        warnings.append(f'{duplicates} duplicate record timestamps dropped (first kept)')
    gaps = sum(1 for a, b in zip(times, times[1:]) if b - a > 1.5)
    if gaps:
        warnings.append(f'{gaps} gaps longer than 1.5 s between records')

    # Drop channels that never have a value; the UI greys out widgets that need them.
    channels = {c: v for c, v in cols.items() if any(x is not None for x in v)}
    gps_count = sum(v is not None for v in cols['lat'])
    indoor = sub_sport in {'indoor_walking', 'treadmill', 'indoor_running', 'indoor_cycling'}
    route_usable = gps_count >= 2
    eligible = sport in {'cycling', *FOOT_SPORTS} and route_usable and not indoor
    reason = ('indoor activity' if indoor else 'fewer than two timestamped GPS fixes' if not route_usable
              else 'unsupported sport' if sport not in {'cycling', *FOOT_SPORTS} else None)
    activity = {'sport': sport, 'subSport': sub_sport,
                'name': session.get('sport_profile_name', sport_message.get('name')),
                'primaryMetric': 'pace' if foot else 'speed', 'indoor': indoor,
                'gpsSamples': gps_count, 'recordSamples': len(times),
                'routeUsable': route_usable, 'routeImportEligible': eligible, 'exclusionReason': reason}
    channel_sources = {c: 'FIT record: ' + '/'.join(CHANNELS[c][0]) for c in channels}
    if foot:
        if 'speed' in channels:
            pace = [round(1 / v, 6) if v is not None and v > 0 else None for v in channels['speed']]
            if any(v is not None for v in pace):
                channels['pace'] = pace
                channel_sources['pace'] = 'Derived 1 / FIT speed, seconds/metre; missing at zero/invalid speed'
        channel_sources.update({c: note for c, note in {
            'strideCadence': 'FIT cadence + fractional_cadence, strides/min (two steps per stride)',
            'stepCadence': '2 × (FIT cadence + fractional_cadence), steps/min; distinct from cycling cadence',
        }.items() if c in channels})
        warnings.append('Running/walking/hiking pace derives from recorded speed; step cadence is separate from cycling cadence')
    for c in channel_sources:
        used = dev_used['power'] if c == 'power' else dev_used['cadence'] if c in ('cadence', 'strideCadence', 'stepCadence') else None
        if used:
            channel_sources[c] += f"; developer field {', '.join(sorted(used))} where the record has none"
    if reason:
        warnings.append(f'Excluded from route activity import: {reason}; recorded sensors remain available for inspection')

    # Local time offset: activity.local_timestamp (FIT epoch, local) vs its UTC timestamp.
    tz_offset = None
    for act in msgs.get('activity_mesgs', []):
        if act.get('local_timestamp') is not None and act.get('timestamp'):
            utc_unix = parse_utc(act['timestamp']).timestamp()
            tz_offset = int(round((act['local_timestamp'] + FIT_EPOCH_UNIX - utc_unix) / 900) * 900)
    if tz_offset is None:
        warnings.append('No activity local_timestamp; local clock widgets will show UTC')

    def ride_t(ts: str) -> float:
        return round((parse_utc(ts) - start).total_seconds(), 3)

    hr_zones = None
    for z in msgs.get('time_in_zone_mesgs', []):
        if z.get('reference_mesg') == 'session' and z.get('hr_zone_high_boundary'):
            hr_zones = {
                'highBoundaries': z['hr_zone_high_boundary'],
                'calcType': z.get('hr_calc_type'),
                'maxHeartRate': z.get('max_heart_rate'),
                'thresholdHeartRate': z.get('threshold_heart_rate'),
                'source': 'FIT time_in_zone (session)',
            }
            break

    laps = []
    for lap in msgs.get('lap_mesgs', []):
        if lap.get('start_time') and lap.get('total_elapsed_time') is not None:
            t0 = ride_t(lap['start_time'])
            laps.append({'startT': t0, 'endT': round(t0 + lap['total_elapsed_time'], 3),
                         'distance': lap.get('total_distance')})

    climbs, open_climb = [], None
    for ev in msgs.get('climb_pro_mesgs', []):
        kind = ev.get('climb_pro_event')
        if kind == 'start':
            open_climb = {'startT': ride_t(ev['timestamp']), 'startDistance': ev.get('current_dist'),
                          'category': ev.get('climb_category')}
        elif kind == 'complete' and open_climb:
            open_climb.update(endT=ride_t(ev['timestamp']), endDistance=ev.get('current_dist'))
            climbs.append(open_climb)
            open_climb = None
    for i, c in enumerate(climbs):
        c['number'] = i + 1

    summary = {k: session.get(k) for k in (
        'total_distance', 'total_ascent', 'total_descent', 'total_elapsed_time', 'total_timer_time',
        'avg_heart_rate', 'max_heart_rate', 'avg_cadence', 'max_cadence', 'avg_temperature',
        'total_calories', 'sport', 'sub_sport')}
    summary['enhanced_avg_speed'] = session.get('enhanced_avg_speed') if session.get('enhanced_avg_speed') is not None else session.get('avg_speed')
    summary['enhanced_max_speed'] = session.get('enhanced_max_speed') if session.get('enhanced_max_speed') is not None else session.get('max_speed')

    sensors = sorted({
        str(d.get('antplus_device_type') or d.get('product_name') or d.get('garmin_product'))
        for d in msgs.get('device_info_mesgs', [])
        if d.get('antplus_device_type') or d.get('product_name') or d.get('garmin_product')
    })

    out = {
        'schema': 1,
        'id': ride_id,
        'startUtc': start.isoformat(timespec='microseconds').replace('+00:00', 'Z'),
        'tzOffsetSec': tz_offset,
        't': [round(t, 3) for t in times],
        'channels': channels,
        'meta': {'hrZones': hr_zones, 'laps': laps, 'climbs': climbs, 'summary': summary,
                 'sensors': sensors, 'warnings': warnings,
                 'source': source, 'activity': activity, 'channelSources': channel_sources},
    }
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('decoded', type=Path, help='decoded.json with FIT messages')
    parser.add_argument('--id', help='ride id (default: decoded folder name)')
    parser.add_argument('--out-dir', type=Path, default=STUDIO / 'public/data/rides')
    args = parser.parse_args()
    ride_id = args.id or args.decoded.parent.name
    out = build_ride(json.loads(args.decoded.read_text()), ride_id, args.decoded.name)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    path = args.out_dir / f'{ride_id}.json'
    path.write_text(json.dumps(out, separators=(',', ':'), allow_nan=False))
    print(f'Wrote {path} ({path.stat().st_size // 1024} KiB): {len(out["t"])} samples, '
          f'channels={sorted(out["channels"])}, climbs={len(out["meta"]["climbs"])}, tz={out["tzOffsetSec"]}')
    for w in out['meta']['warnings']:
        print('warning:', w)


if __name__ == '__main__':
    main()
