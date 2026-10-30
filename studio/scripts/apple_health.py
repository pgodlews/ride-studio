"""Import Apple Watch workouts from a native Apple Health export (export.xml + workout-routes/).

Read-only towards the export. `scan` streams export.xml once for workouts and once for the
samples recorded by each route workout's own source (so Garmin Connect or iPhone copies in
Health are not double counted) and caches a private index. `import` projects one workout
onto its route's 1 Hz time axis as studio ride JSON.

Channels and their provenance:
- lat/lon/altitude: workout-route GPX (WGS-84; Apple's elevation, vertical datum unverified)
- speed: the route's recorded GPS speed extension (m/s); negative/invalid values are missing
- distance: cumulative Apple Watch distance samples (DistanceCycling / DistanceWalkingRunning),
  linear within each sample interval; GPS-derived only when the workout has no such samples
- heartRate, cadence (CyclingCadence), power (CyclingPower / RunningPower): the preceding
  recorded sample, held for at most HOLD_SEC; never interpolated or invented
- stepCadence (foot sports): each StepCount interval's average rate, labelled as derived
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import html
import json
import math
import re
import statistics
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

INDEX_VERSION = 2  # bump when the cached index/sample format changes
HOLD_SEC = 15.0
BREAK_GAP_SEC = 30.0
ATTR = re.compile(r'(\w+)="([^"]*)"')
SPORTS = {'Cycling': 'cycling', 'HandCycling': 'cycling', 'Running': 'running', 'Walking': 'walking', 'Hiking': 'hiking'}
FOOT = {'running', 'walking', 'hiking'}
# HealthKit quantity → (sample key, unit conversion to SI/studio units)
SAMPLE_TYPES = {
    'HKQuantityTypeIdentifierHeartRate': 'heartRate',
    'HKQuantityTypeIdentifierCyclingCadence': 'cadence',
    'HKQuantityTypeIdentifierCyclingPower': 'power',
    'HKQuantityTypeIdentifierRunningPower': 'power',
    'HKQuantityTypeIdentifierStepCount': 'steps',
    'HKQuantityTypeIdentifierDistanceCycling': 'distance',
    'HKQuantityTypeIdentifierDistanceWalkingRunning': 'distance',
}
DISTANCE_UNITS = {'km': 1000.0, 'm': 1.0, 'mi': 1609.344, 'ft': 0.3048, 'yd': 0.9144}
GPX = '{http://www.topografix.com/GPX/1/1}'


def parse_date(text: str) -> datetime:
    """Apple Health date, e.g. '2026-10-03 12:48:34 +0100' (offset retained)."""
    return datetime.strptime(text, '%Y-%m-%d %H:%M:%S %z')


def utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def attrs(line: str) -> dict:
    return {k: html.unescape(v) for k, v in ATTR.findall(line)}


def export_key(export: Path) -> str:
    xml = export / 'export.xml'
    st = xml.stat()
    return hashlib.sha1(f'{xml.resolve()}|{st.st_size}|{int(st.st_mtime)}|v{INDEX_VERSION}'.encode()).hexdigest()[:16]


def device_model(device: str | None) -> str | None:
    """'Apple Watch (Watch7,5)' from HealthKit's device description, or None."""
    # Values may contain commas ("hardware:Watch7,5"), so each runs up to the next ", key:".
    fields = dict(re.findall(r'(\w[\w ]*?):(.*?)(?=, \w[\w ]*?:|>\s*$|$)', device or ''))
    name, hardware = fields.get('name', '').strip(), fields.get('hardware', '').strip()
    return (f'{name} ({hardware})' if name and hardware else name or hardware) or None


def check_export(export: Path) -> Path:
    xml = export / 'export.xml'
    if not xml.is_file():
        raise ValueError(f'{export} has no export.xml; choose the unzipped apple_health_export folder')
    with xml.open('rb') as f:
        head = f.read(4096)
    if b'<!DOCTYPE HealthData' not in head and b'<HealthData' not in head:
        raise ValueError('export.xml is not an Apple Health export')
    return xml


def read_workouts(xml: Path) -> list[dict]:
    """Pass 1: workouts with statistics, events, metadata and route file references.

    Apple writes one element per line (attributes on the opening line), which keeps this
    streaming pass fast on very large exports; an unexpected layout raises."""
    workouts, cur = [], None
    with xml.open(encoding='utf-8') as f:
        for line in f:
            s = line.lstrip()
            if s.startswith('<Workout '):
                if not s.rstrip().endswith('>'):
                    raise ValueError('Unexpected export.xml layout: Workout attributes span lines')
                a = attrs(s)
                cur = {'type': a['workoutActivityType'].replace('HKWorkoutActivityType', ''), 'source': a.get('sourceName', ''),
                       'sourceVersion': a.get('sourceVersion'), 'device': device_model(a.get('device')),
                       'start': a['startDate'], 'end': a['endDate'], 'durationMin': float(a.get('duration') or 'nan'),
                       'routes': [], 'stats': {}, 'events': [], 'metadata': {}}
                if s.rstrip().endswith('/>'):
                    workouts.append(cur)
                    cur = None
            elif cur is not None:
                if s.startswith('<FileReference'):
                    cur['routes'].append(attrs(s).get('path', '').lstrip('/'))
                elif s.startswith('<WorkoutStatistics'):
                    a = attrs(s)
                    cur['stats'][a['type'].replace('HKQuantityTypeIdentifier', '')] = {k: a[k] for k in ('sum', 'average', 'minimum', 'maximum', 'unit') if k in a}
                elif s.startswith('<WorkoutEvent'):
                    a = attrs(s)
                    cur['events'].append({'type': a.get('type', '').replace('HKWorkoutEventType', ''), 'date': a.get('date')})
                elif s.startswith('<MetadataEntry'):
                    a = attrs(s)
                    if 'key' in a:
                        cur['metadata'][a['key']] = a.get('value')
                elif s.startswith('</Workout>'):
                    workouts.append(cur)
                    cur = None
    for w in workouts:
        start, end = parse_date(w['start']), parse_date(w['end'])
        w['id'] = hashlib.sha1(f"{w['type']}|{w['source']}|{w['start']}|{w['end']}".encode()).hexdigest()[:16]
        w['startUtc'], w['endUtc'] = utc_iso(start), utc_iso(end)
        w['tzOffsetSec'] = int(start.utcoffset().total_seconds())
        w['sport'] = SPORTS.get(w['type'], w['type'].lower())
        dist = next((v for k, v in w['stats'].items() if k.startswith('Distance') and 'sum' in v), None)
        w['distanceM'] = float(dist['sum']) * DISTANCE_UNITS.get(dist.get('unit', 'km'), float('nan')) if dist else None
        hr = w['stats'].get('HeartRate', {})
        w['avgHeartRate'] = float(hr['average']) if 'average' in hr else None
        w['indoor'] = w['metadata'].get('HKIndoorWorkout') == '1'
    return workouts


def read_samples(xml: Path, workouts: list[dict]) -> dict[str, dict[str, list]]:
    """Pass 2: samples inside each route workout's window, from that workout's own source."""
    windows = sorted(((datetime.fromisoformat(w['startUtc'].replace('Z', '+00:00')).timestamp(),
                       datetime.fromisoformat(w['endUtc'].replace('Z', '+00:00')).timestamp(), w) for w in workouts if w['routes']),
                     key=lambda x: x[0])
    starts = [x[0] for x in windows]
    samples: dict[str, dict[str, list]] = {w['id']: {} for _, _, w in windows}
    if not windows:
        return samples
    wanted = tuple(f'type="{t}"' for t in SAMPLE_TYPES)
    with xml.open(encoding='utf-8') as f:
        for line in f:
            if not line.lstrip().startswith('<Record ') or not any(t in line for t in wanted):
                continue
            a = attrs(line)
            try:
                t0 = parse_date(a['startDate']).timestamp()
                t1 = parse_date(a['endDate']).timestamp()
                value = float(a['value'])
            except (KeyError, ValueError):
                continue
            if not math.isfinite(value):
                continue
            i = bisect.bisect_right(starts, t0) - 1
            # Overlapping workouts are rare; check the few windows that start before t0.
            for j in range(max(0, i - 3), i + 1):
                ws, we, w = windows[j]
                if ws <= t0 <= we and a.get('sourceName') == w['source']:
                    key = SAMPLE_TYPES[a['type']]
                    if key == 'distance':
                        value *= DISTANCE_UNITS.get(a.get('unit', 'km'), float('nan'))
                    samples[w['id']].setdefault(key, []).append([round(t0, 3), round(t1, 3), value])
    for per in samples.values():
        for rows in per.values():
            rows.sort(key=lambda r: (r[0], r[1]))
    return samples


def scan(export: Path, cache: Path) -> dict:
    xml = check_export(export)
    key = export_key(export)
    out = cache / key
    index_path = out / 'index.json'
    if index_path.exists():
        return json.loads(index_path.read_text())
    workouts = read_workouts(xml)
    samples = read_samples(xml, workouts)
    (out / 'samples').mkdir(parents=True, exist_ok=True)
    for wid, per in samples.items():
        (out / 'samples' / f'{wid}.json').write_text(json.dumps(per, separators=(',', ':'), allow_nan=False))
        w = next(w for w in workouts if w['id'] == wid)
        w['sampleCounts'] = {k: len(v) for k, v in per.items()}
    export_date = None
    with xml.open(encoding='utf-8') as f:
        for _, line in zip(range(400), f):
            if '<ExportDate' in line:
                export_date = attrs(line).get('value')
                break
    index = {'key': key, 'export': str(export.resolve()), 'exportDate': export_date,
             'xmlBytes': xml.stat().st_size, 'workouts': workouts}
    index_path.write_text(json.dumps(index, indent=1, allow_nan=False))
    return index


def read_route(path: Path) -> list[dict]:
    root = ET.parse(path).getroot()
    rows = []
    for pt in root.iter(f'{GPX}trkpt'):
        text = pt.findtext(f'{GPX}time')
        if not text:
            continue
        t = datetime.fromisoformat(text.strip().replace('Z', '+00:00')).timestamp()
        if rows and t <= rows[-1]['t']:
            continue
        ext = pt.find(f'{GPX}extensions')
        num = lambda el, name: float(el.findtext(f'{GPX}{name}')) if el is not None and el.findtext(f'{GPX}{name}') not in (None, '') else None
        speed = num(ext, 'speed')
        lat, lon = float(pt.get('lat')), float(pt.get('lon'))
        rows.append({'t': t, 'lat': lat if -90 <= lat <= 90 else None, 'lon': lon if -180 <= lon <= 180 else None,
                     'altitude': num(pt, 'ele'), 'speed': speed if speed is not None and speed >= 0 else None,
                     'hAcc': num(ext, 'hAcc')})
    return rows


def held(samples: list, starts: list[float], t: float, limit: float = HOLD_SEC):
    """Value of the latest sample at or before t, if no older than `limit` seconds."""
    i = bisect.bisect_right(starts, t) - 1
    return samples[i][2] if i >= 0 and t - samples[i][0] <= limit else None


def cumulative(samples: list, times: list[float]) -> list[float]:
    """Recorded distance up to each time: whole earlier samples plus the elapsed part of the current one."""
    out, total, k = [], 0.0, 0
    for t in times:
        while k < len(samples) and samples[k][1] <= t:
            total += samples[k][2]
            k += 1
        partial = 0.0
        if k < len(samples) and samples[k][0] < t < samples[k][1]:
            s0, s1, v = samples[k]
            partial = v * (t - s0) / (s1 - s0)
        out.append(total + partial)
    return out


def haversine(a, b) -> float:
    r = math.radians
    dlat, dlon = r(b['lat'] - a['lat']), r(b['lon'] - a['lon'])
    h = math.sin(dlat / 2) ** 2 + math.cos(r(a['lat'])) * math.cos(r(b['lat'])) * math.sin(dlon / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def build_ride(export: Path, cache: Path, workout_id: str, ride_id: str) -> tuple[dict, dict]:
    index = scan(export, cache)
    w = next((w for w in index['workouts'] if w['id'] == workout_id), None)
    if w is None:
        raise ValueError('Unknown workout id; scan the export again')
    if not w['routes']:
        raise ValueError('This workout has no route in the export (indoor, or written by another app); nothing to place clips on')
    per = json.loads((cache / index['key'] / 'samples' / f'{workout_id}.json').read_text())
    route_paths = [export / r for r in w['routes']]
    rows, evidence_routes = [], []
    for path in route_paths:
        if not path.resolve().is_relative_to(export.resolve()) or not path.is_file():
            raise ValueError(f'Route file missing from the export: {path.name}')
        raw = path.read_bytes()
        evidence_routes.append({'file': path.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        rows.extend(read_route(path))
    rows.sort(key=lambda r: r['t'])
    if sum(r['lat'] is not None for r in rows) < 2:
        raise ValueError('The workout route has fewer than two GPS fixes')
    t0 = rows[0]['t']
    times = [r['t'] for r in rows]
    pauses = [parse_date(e['date']).timestamp() for e in w['events'] if e['type'] in ('Pause', 'MotionPaused') and e.get('date')]
    breaks = [i for i in range(1, len(rows)) if times[i] - times[i - 1] > BREAK_GAP_SEC
              or any(times[i - 1] <= p < times[i] for p in pauses)]
    sport = w['sport']
    foot = sport in FOOT
    channels = {'lat': [r['lat'] for r in rows], 'lon': [r['lon'] for r in rows],
                'altitude': [r['altitude'] for r in rows], 'speed': [r['speed'] for r in rows]}
    sources = {'lat': 'Apple Watch workout route latitude (WGS-84)', 'lon': 'Apple Watch workout route longitude (WGS-84)',
               'altitude': 'Apple Watch workout route elevation (m); vertical datum unverified',
               'speed': 'Apple Watch recorded GPS speed from the route (m/s); not a wheel-speed sensor'}
    warnings = []
    if per.get('distance'):
        channels['distance'] = [round(v, 3) for v in cumulative(per['distance'], times)]
        sources['distance'] = 'Cumulative Apple Watch distance samples (m), linear within each sample interval'
    else:
        total, dist = 0.0, []
        for i, r in enumerate(rows):
            if i and i not in breaks and r['lat'] is not None and rows[i - 1]['lat'] is not None:
                total += haversine(rows[i - 1], r)
            dist.append(round(total, 3))
        channels['distance'] = dist
        sources['distance'] = 'Derived cumulative horizontal GPS distance from the route (no Watch distance samples)'
        warnings.append('No Apple Watch distance samples; distance is derived from route positions')
    for key, channel, note in (('heartRate', 'heartRate', 'Apple Watch heart-rate samples (bpm)'),
                               ('cadence', 'cadence', 'Apple Health cycling cadence samples (rpm)'),
                               ('power', 'power', 'Apple Health power samples (W)')):
        if key == 'cadence' and foot:
            continue
        data = per.get(key)
        if not data:
            continue
        starts = [s[0] for s in data]
        values = [held(data, starts, t) for t in times]
        if any(v is not None for v in values):
            channels[channel] = [round(v, 3) if v is not None else None for v in values]
            gaps = [b[0] - a[0] for a, b in zip(data, data[1:])]
            median = statistics.median(gaps) if gaps else None
            sources[channel] = f'{note}; preceding sample held up to {HOLD_SEC:.0f} s' + (f' (median interval {median:.1f} s)' if median else '')
    if foot and per.get('steps'):
        steps = per['steps']
        starts = [s[0] for s in steps]
        spm = []
        for t in times:
            i = bisect.bisect_right(starts, t) - 1
            s = steps[i] if i >= 0 else None
            spm.append(round(s[2] / (s[1] - s[0]) * 60, 2) if s and s[1] > s[0] and s[0] <= t <= s[1] else None)
        if any(v is not None for v in spm):
            channels['stepCadence'] = spm
            sources['stepCadence'] = 'Derived average steps/min of each Apple Watch step-count interval (not per-step cadence)'
    if foot:
        channels['pace'] = [round(1 / v, 6) if v else None for v in channels['speed']]
        sources['pace'] = 'Derived 1 / recorded GPS speed, seconds/metre; absent when stopped/invalid'
    channels = {k: v for k, v in channels.items() if any(x is not None for x in v)}
    stats = w['stats']
    def stat(name, field):
        v = stats.get(name, {}).get(field)
        return float(v) if v is not None else None
    summary = {'sport': sport, 'total_elapsed_time': (datetime.fromisoformat(w['endUtc'].replace('Z', '+00:00')) - datetime.fromisoformat(w['startUtc'].replace('Z', '+00:00'))).total_seconds(),
               'total_timer_time': w['durationMin'] * 60 if math.isfinite(w['durationMin']) else None,
               'total_distance': w['distanceM'], 'avg_heart_rate': stat('HeartRate', 'average'), 'max_heart_rate': stat('HeartRate', 'maximum'),
               'total_calories': stat('ActiveEnergyBurned', 'sum')}
    evidence = {'workoutId': w['id'], 'type': w['type'], 'source': w['source'], 'sourceVersion': w['sourceVersion'], 'device': w['device'],
                'startUtc': w['startUtc'], 'endUtc': w['endUtc'], 'exportDate': index['exportDate'], 'export': export.name,
                'routes': evidence_routes, 'sampleCounts': {k: len(v) for k, v in per.items()}, 'events': w['events'],
                'holdSec': HOLD_SEC, 'breakGapSec': BREAK_GAP_SEC, 'routePoints': len(rows)}
    if breaks:
        warnings.append(f'{len(breaks)} route gap(s)/pause(s) kept as breaks; nothing is bridged across them')
    others = [x for x in index['workouts'] if x['id'] != w['id'] and x['startUtc'] < w['endUtc'] and x['endUtc'] > w['startUtc']]
    if others:
        warnings.append('Overlapping workouts from ' + ', '.join(sorted({x['source'] for x in others})) + ' were not merged')
    local = datetime.fromisoformat(w['startUtc'].replace('Z', '+00:00')).astimezone(timezone.utc).timestamp() + w['tzOffsetSec']
    name = f"Apple Watch {w['type'].lower()} {datetime.fromtimestamp(local, timezone.utc):%Y-%m-%d %H:%M}"
    ride = {
        'schema': 1, 'id': ride_id, 'startUtc': utc_iso(datetime.fromtimestamp(t0, timezone.utc)), 'tzOffsetSec': w['tzOffsetSec'],
        't': [round(t - t0, 3) for t in times], 'breaks': breaks, 'channels': channels,
        'meta': {'hrZones': None, 'laps': [], 'climbs': [], 'summary': summary, 'sensors': [w['device'] or w['source']],
                 'source': evidence_routes[0]['file'], 'warnings': warnings, 'channelSources': sources,
                 'telemetry': {'kind': 'apple-health', 'appleHealth': evidence},
                 'activity': {'sport': sport, 'subSport': None, 'name': name, 'primaryMetric': 'pace' if foot else 'speed',
                              'indoor': w['indoor'], 'gpsSamples': sum(r['lat'] is not None for r in rows), 'recordSamples': len(rows),
                              'routeUsable': True, 'routeImportEligible': True, 'exclusionReason': None}},
    }
    return ride, evidence


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    for name in ('scan', 'import'):
        s = sub.add_parser(name)
        s.add_argument('export', type=Path, help='unzipped apple_health_export folder (export.xml + workout-routes/)')
        s.add_argument('--cache', type=Path, default=Path(__file__).resolve().parent.parent / '.cache/apple-health')
        if name == 'scan':
            s.add_argument('--json', action='store_true', help='print the workout index as JSON')
        else:
            s.add_argument('workout', help='workout id from scan')
            s.add_argument('--id', required=True, help='ride id')
            s.add_argument('--out-dir', type=Path, default=Path(__file__).resolve().parent.parent / 'public/data/rides')
    args = p.parse_args()
    try:
        export = args.export.resolve(strict=True)
        if args.command == 'scan':
            index = scan(export, args.cache)
            if args.json:
                print(json.dumps(index, allow_nan=False))
            else:
                routes = [w for w in index['workouts'] if w['routes']]
                print(f"{len(index['workouts'])} workouts, {len(routes)} with routes (export {index['exportDate']})")
                for w in routes[-20:]:
                    print(f"{w['id']}  {w['startUtc']}  {w['type']:<14} {w['durationMin']:6.1f} min  {w['source']}")
            return
        if not re.fullmatch(r'[A-Za-z0-9_-]+', args.id):
            raise ValueError('Ride id must use letters, numbers, underscores or hyphens')
        target = args.out_dir / f'{args.id}.json'
        if target.exists():
            raise ValueError(f'Activity already exists: {target}')
        ride, evidence = build_ride(export, args.cache, args.workout, args.id)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(ride, separators=(',', ':'), allow_nan=False))
        print(f"Wrote {target}: {evidence['routePoints']} route points, channels={sorted(ride['channels'])}")
        for warning in ride['meta']['warnings']:
            print('warning:', warning)
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        p.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
