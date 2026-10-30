"""Import embedded DJI GPS telemetry or a DJI GPS SRT sidecar into the studio."""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dji_telemetry import embedded_rows, srt_rows
from studio_media import registration

STUDIO = Path(__file__).resolve().parent.parent


def utc(text):
    dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('UTC anchor needs Z or an explicit timezone offset')
    return dt.astimezone(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec='microseconds').replace('+00:00', 'Z')


def separation(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    dlat = lat2 - lat1
    dlon = math.radians(b['lon'] - a['lon'])
    h = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2)**2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, h)))


def ride_json(rows, start, ride_id, info, source, tz_name=None):
    warnings = []
    merged = {}
    duplicates = 0
    for row in sorted(rows, key=lambda r: r['t']):
        t = round(row['t'], 6)
        if t in merged:
            duplicates += 1
            # Rich/light lens records share a clock. Fill absent values only;
            # never count the two tracks as two sequential positions.
            for key, value in row.items():
                if merged[t].get(key) is None and value is not None:
                    merged[t][key] = value
        else:
            merged[t] = dict(row, t=t)
    rows = list(merged.values())
    if not any(r['lat'] is not None and r['lon'] is not None for r in rows):
        raise ValueError('No valid GPS fixes found; camera identity alone does not establish GPS')
    if duplicates:
        warnings.append(f'{duplicates} duplicate/lens timestamps merged (first finite values kept)')
    cols = {key: [r.get(key) for r in rows] for key in ('lat', 'lon', 'altitude', 'speed', 'relativeAltitude')}
    distance, total, previous, breaks = [], 0.0, None, 0
    for row in rows:
        if row['lat'] is None or row['lon'] is None:
            distance.append(None)
            previous = None
            breaks += 1
            continue
        if previous is not None and row['t'] - previous['t'] <= 5:
            total += separation(previous, row)
        elif previous is not None:
            breaks += 1
        distance.append(round(total, 3))
        previous = row
    cols['distance'] = distance
    if breaks:
        warnings.append('GPS distance is partial: invalid fixes and gaps longer than 5 s are not bridged')
    channels = {c: values for c, values in cols.items() if any(v is not None for v in values)}
    offset = None
    if tz_name:
        zone = ZoneInfo(tz_name)
        offset = int(start.astimezone(zone).utcoffset().total_seconds())
        end_offset = int((start + timedelta(seconds=rows[-1]['t'])).astimezone(zone).utcoffset().total_seconds())
        if offset != end_offset:
            raise ValueError('Clip crosses a timezone offset transition; split it before importing')
    else:
        warnings.append('No display timezone supplied; clock widgets show UTC')
    warnings.append('UTC anchor and telemetry offset must be verified against footage; boot time is not UTC')
    return {
        'schema': 1, 'id': ride_id, 'startUtc': iso(start), 'tzOffsetSec': offset,
        't': [r['t'] for r in rows], 'channels': channels,
        'meta': {'hrZones': None, 'laps': [], 'climbs': [], 'summary': {}, 'sensors': [],
                 'warnings': warnings, 'source': source, 'telemetry': info,
                 'channelSources': {
                     'lat': 'DJI WGS-84 GPS degrees', 'lon': 'DJI WGS-84 GPS degrees',
                     'altitude': 'DJI absolute altitude; Avata GPS/barometer fusion uses ellipsoidal height',
                     'relativeAltitude': 'DJI relative altitude (m), distinct from absolute altitude',
                     'speed': 'Horizontal speed from recorded North/East velocity (m/s)',
                     'distance': 'Derived cumulative horizontal GPS distance; no gap bridging',
                 }},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('telemetry', type=Path, help='OSV/LRF/MP4 with supported embedded metadata, or GPS SRT')
    p.add_argument('--start-utc', required=True, help='UTC at video playback zero, including Z or timezone offset')
    p.add_argument('--telemetry-offset-sec', type=float, default=0,
                   help='playback seconds of first embedded frame (added to normalized boot clock); SRT timestamps already use playback')
    p.add_argument('--clock-correction-sec', type=float, default=0, help='seconds added to the supplied UTC anchor')
    p.add_argument('--timezone', help='IANA display timezone, e.g. Europe/London (date-aware)')
    p.add_argument('--id', help='ride id (default: input stem)')
    p.add_argument('--out-dir', type=Path, default=STUDIO / 'public/data/rides')
    p.add_argument('--register', action='store_true', help='register MP4 in the editor without copying camera footage')
    p.add_argument('--video', type=Path, help='reframed MP4 matching the telemetry playback timeline')
    p.add_argument('--preview', type=Path, help='optional full-length H.264 MP4 preview matching video timing/framing')
    p.add_argument('--camera', choices=['front', 'rear'], default='front')
    p.add_argument('--bottom-strip', type=float, default=0, help='fraction of video height cropped to hide burned-in text')
    args = p.parse_args()
    try:
        if not all(math.isfinite(v) for v in (args.telemetry_offset_sec, args.clock_correction_sec, args.bottom_strip)):
            raise ValueError('Offsets and crop must be finite')
        if not 0 <= args.bottom_strip < 1:
            raise ValueError('--bottom-strip must be in [0, 1)')
        if args.preview and not args.register:
            raise ValueError('--preview requires --register')
        ride_id = args.id or args.telemetry.stem
        if not re.fullmatch(r'[A-Za-z0-9_-]+', ride_id):
            raise ValueError('Ride id must use letters, numbers, underscores or hyphens')
        start = utc(args.start_utc) + timedelta(seconds=args.clock_correction_sec)
        rows, info = srt_rows(args.telemetry) if args.telemetry.suffix.lower() == '.srt' else embedded_rows(args.telemetry)
        for row in rows:
            row['t'] += args.telemetry_offset_sec
        info.update(telemetryOffsetSec=args.telemetry_offset_sec, clockCorrectionSec=args.clock_correction_sec,
                    utcAnchor=args.start_utc, displayTimezone=args.timezone)
        out = ride_json(rows, start, ride_id, info, args.telemetry.name, args.timezone)
        entry = None
        if args.register:
            video = args.video or args.telemetry
            entry = registration(video, args.preview, start, args.camera, args.bottom_strip)
            if out['t'][0] < 0 or out['t'][-1] > entry['duration'] + 0.1:
                raise ValueError('Telemetry falls outside registered video; check the playback offset and video trim')
        # Validate everything before writing output. Existing rides/registrations
        # are preserved; choose a fresh id when revising an import.
        args.out_dir.mkdir(parents=True, exist_ok=True)
        target = args.out_dir / f'{ride_id}.json'
        if target.exists():
            raise ValueError('Ride already exists; use --id to retain it and write a new version')
        manifest_path = STUDIO / '.cache/dji-footage.json'
        manifest = json.loads(manifest_path.read_text()) if args.register and manifest_path.exists() else []
        if entry and any(e['name'] == entry['name'] and e['camera'] == entry['camera'] for e in manifest):
            raise ValueError('Video already registered; retain or edit its existing registration explicitly')
        target.write_text(json.dumps(out, separators=(',', ':'), allow_nan=False))
        if entry:
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(json.dumps([*manifest, entry], indent=2, allow_nan=False))
        print(f'Wrote {target}: {len(out["t"])} samples, channels={sorted(out["channels"])}')
        if args.out_dir.resolve() == (STUDIO / 'public/data/rides').resolve():
            print(f'Open http://localhost:5178/?ride={ride_id}')
        for warning in out['meta']['warnings']:
            print('warning:', warning)
    except (ValueError, OSError, ZoneInfoNotFoundError, subprocess.CalledProcessError) as error:
        p.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
