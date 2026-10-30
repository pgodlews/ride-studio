"""Import an iPhone or other MOV/MP4/M4V phone clip without requiring FIT."""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from phone_telemetry import read_metadata
from phone_fit import read_fit, synchronized_ride, synchronize_projection
from gpx_activity import read_gpx
from prepare_dji import iso, ride_json as gps_ride_json, utc
from studio_media import probe_video, registration

STUDIO = Path(__file__).resolve().parent.parent


def creation_date(text):
    if not text:
        return None
    # ExifTool's date format preserves the offset from Apple's CreationDate.
    return datetime.fromisoformat(re.sub(r'^(\d{4}):(\d{2}):(\d{2}) ', r'\1-\2-\3T', text).replace('Z', '+00:00'))


def resolve_clock(info, start_override=None, container_start=None):
    try:
        recorded = creation_date(info.get('clockCreationDate'))
    except ValueError:
        recorded = None
    if start_override:
        return utc(start_override), recorded, 'explicit playback-zero override'
    if recorded is None or recorded.utcoffset() is None:
        if container_start:
            return utc(container_start), None, 'container creation UTC (approximate playback zero)'
        raise ValueError('No creation date with explicit timezone; supply --start-utc for playback zero')
    return utc(recorded.isoformat()), recorded, 'offset-bearing container CreationDate (unverified playback zero)'


def phone_ride(rows, start, duration, ride_id, info, source, tz_name=None, recorded=None):
    valid_count = sum(r['lat'] is not None and r['lon'] is not None for r in rows)
    if valid_count:
        out = gps_ride_json(rows, start, ride_id, info, source, tz_name)
        # That helper's warning and altitude descriptions belong to DJI.
        out['meta']['warnings'] = [w for w in out['meta']['warnings'] if not w.startswith('UTC anchor')]
        out['meta']['channelSources'] = {
            'lat': 'Named timed QuickTime GPS latitude (degrees)',
            'lon': 'Named timed QuickTime GPS longitude (degrees)',
            'altitude': 'Named timed GPS altitude (m); vertical datum unverified',
            'distance': 'Derived horizontal GPS distance, excluding invalid fixes/gaps over 5 s',
        }
        if valid_count < 2:
            out['channels'].pop('distance', None)
        # Endpoint rows describe the video span, without extending sensor data.
        for t in (0, duration):
            index = 0 if t == 0 else len(out['t'])
            if t not in out['t']:
                out['t'].insert(index, t)
                for values in out['channels'].values():
                    values.insert(index, None)
    else:
        out = {
            'schema': 1, 'id': ride_id, 'startUtc': iso(start), 'tzOffsetSec': None,
            't': [0, duration], 'channels': {},
            'meta': {'hrZones': None, 'laps': [], 'climbs': [], 'summary': {}, 'sensors': [],
                     'source': source, 'telemetry': info, 'channelSources': {}, 'warnings': []},
        }
    if tz_name:
        zone = ZoneInfo(tz_name)
        offset = int(start.astimezone(zone).utcoffset().total_seconds())
        if offset != int((start + timedelta(seconds=duration)).astimezone(zone).utcoffset().total_seconds()):
            raise ValueError('Clip crosses a timezone offset transition; split it before importing')
        out['tzOffsetSec'] = offset
    elif recorded and recorded.utcoffset() is not None:
        out['tzOffsetSec'] = int(recorded.utcoffset().total_seconds())
        out['meta']['warnings'] = [w for w in out['meta']['warnings'] if not w.startswith('No display timezone')]
    elif not valid_count:
        out['meta']['warnings'].append('No recorded display timezone; clock widgets show UTC')
    if info['locationMode'] == 'clip-geotag':
        out['meta']['warnings'].append('One clip geotag, not a timed path; its acquisition time is unknown')
    elif not valid_count:
        out['meta']['warnings'].append('No usable GPS track or clip geotag found')
    out['meta']['warnings'].append('No FIT sensors: HR/cadence/power are missing; speed is not inferred from GPS')
    out['meta']['warnings'].append('Recording time is an approximate playback-zero anchor; clock offsets and long-clip drift are possible. Visual verification is optional.')
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('video', type=Path)
    p.add_argument('--start-utc', help='optional playback-zero UTC override; includes Z or timezone offset')
    telemetry = p.add_mutually_exclusive_group()
    telemetry.add_argument('--fit', type=Path, help='matching raw .fit or decoded FIT messages JSON; uses approximate recording-time alignment')
    telemetry.add_argument('--gpx', type=Path, help='matching timestamped GPX track; uses approximate recording-time alignment')
    p.add_argument('--track', type=int, help='GPX track number (1-based) when --gpx contains multiple tracks')
    p.add_argument('--sport', choices=['cycling', 'running', 'walking', 'hiking'], help='GPX sport, e.g. hiking; not inferred')
    p.add_argument('--clock-correction-sec', type=float, default=0, help='seconds added to playback-zero UTC')
    p.add_argument('--timezone', help='IANA display timezone; defaults to recorded creation-date offset')
    p.add_argument('--id', help='ride id, default input stem')
    p.add_argument('--out-dir', type=Path, default=STUDIO / 'public/data/rides')
    p.add_argument('--register', action='store_true', help='register original phone footage read-only without copying it')
    p.add_argument('--preview', type=Path, help='optional full-length H.264 preview with matching timing and orientation')
    p.add_argument('--camera', choices=['front', 'rear'], default='front')
    args = p.parse_args()
    try:
        video = args.video.resolve(strict=True)
        if video.suffix.lower() not in {'.mov', '.mp4', '.m4v'}:
            raise ValueError('Phone import accepts MOV, MP4 or M4V')
        if not math.isfinite(args.clock_correction_sec):
            raise ValueError('Clock correction must be finite')
        if args.preview and not args.register:
            raise ValueError('--preview requires --register')
        if (args.track is not None or args.sport is not None) and not args.gpx:
            raise ValueError('--track and --sport require --gpx')
        ride_id = args.id or video.stem
        if not re.fullmatch(r'[A-Za-z0-9_-]+', ride_id):
            raise ValueError('Ride id must use letters, numbers, underscores or hyphens')
        geometry = probe_video(video)
        rows, info = read_metadata(video, geometry['duration'])
        start, recorded, clock_source = resolve_clock(info, args.start_utc, geometry.get('containerCreatedUtc'))
        recording_start = start
        start += timedelta(seconds=args.clock_correction_sec)
        info.update(suppliedStartUtc=args.start_utc, recordingStartUtc=iso(recording_start), clockSource=clock_source, utcAnchor=iso(start),
                    clockCorrectionSec=args.clock_correction_sec, displayTimezone=args.timezone,
                    videoDurationSec=geometry['duration'])
        phone = phone_ride(rows, start, geometry['duration'], ride_id, info, video.name, args.timezone, recorded)
        messages = evidence = None
        if args.fit:
            messages, evidence = read_fit(args.fit)
            out = synchronized_ride(messages, start, geometry['duration'], ride_id, info, evidence)
            if args.timezone or (recorded and recorded.utcoffset() is not None):
                out['tzOffsetSec'] = phone['tzOffsetSec']
                out['meta']['warnings'] = [w for w in out['meta']['warnings'] if not w.startswith('No activity local_timestamp')]
        elif args.gpx:
            projection, evidence = read_gpx(args.gpx, ride_id, track=args.track, sport=args.sport,
                                            timezone_name=args.timezone)
            if not projection['meta']['activity']['routeImportEligible']:
                raise ValueError('GPX must contain at least two timestamped track fixes; waypoints/routes are not recordings')
            out = synchronize_projection(projection, start, geometry['duration'], info, evidence, 'gpx')
            if args.timezone or (recorded and recorded.utcoffset() is not None):
                out['tzOffsetSec'] = phone['tzOffsetSec']
                out['meta']['warnings'] = [w for w in out['meta']['warnings'] if not w.startswith('No display timezone')]
        else:
            out = phone
        entry = registration(video, args.preview, start, args.camera, 0, brand='phone', registration_id=ride_id) if args.register else None
        if entry:
            notice = out['meta']['telemetry'].get('synchronization', {}).get('notice')
            if notice is None:
                notice = ('Recorded phone GPS is available. Speed and workout sensors require a matching FIT activity.'
                          if info['locationMode'] == 'timed' else
                          'Phone clip without FIT sensors. A location tag does not supply a timed route or speed.')
            entry.update(rideId=ride_id, label=video.name, syncNotice=notice)
        target = args.out_dir / f'{ride_id}.json'
        manifest_path = STUDIO / '.cache/phone-footage.json'
        manifest = json.loads(manifest_path.read_text()) if args.register and manifest_path.exists() else []
        if args.register and args.out_dir.resolve() != (STUDIO / 'public/data/rides').resolve():
            raise ValueError('--register requires the studio public/data/rides output folder')
        if target.exists():
            raise ValueError('Ride already exists; choose a new --id to retain the earlier import')
        if entry and any(e['name'] == entry['name'] and e['camera'] == entry['camera'] for e in manifest):
            raise ValueError('Video already registered; retain or edit its existing registration explicitly')
        args.out_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(out, separators=(',', ':'), allow_nan=False))
        if messages is not None:
            # Cache full strict decoded evidence, including unknown message/field
            # numbers; the browser ride is only a named-channel projection.
            decoded = STUDIO / '.cache/phone-fit' / f'{evidence["sha256"]}.json'
            decoded.parent.mkdir(parents=True, exist_ok=True)
            if not decoded.exists():
                decoded.write_text(json.dumps(messages, separators=(',', ':'), allow_nan=False))
        if args.gpx:
            original = STUDIO / '.cache/phone-gpx' / f'{evidence["sha256"]}.gpx'
            original.parent.mkdir(parents=True, exist_ok=True)
            if not original.exists():
                original.write_bytes(args.gpx.read_bytes())
        if entry:
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(json.dumps([*manifest, entry], indent=2, allow_nan=False))
        print(f'Wrote {target}: {geometry["duration"]:.3f} s, location={info["locationMode"]}, timed GPS fixes={info["timedGpsSamples"]}')
        if info['medianGpsIntervalSec'] is not None:
            print(f'GPS interval median={info["medianGpsIntervalSec"]:.3f} s, max={info["maxGpsIntervalSec"]:.3f} s')
        if args.out_dir.resolve() == (STUDIO / 'public/data/rides').resolve():
            print(f'Open http://localhost:5178/?ride={ride_id}')
        print(f'Channels: {sorted(out["channels"])}' + (' (FIT)' if args.fit else ' (GPX)' if args.gpx else ''))
        for warning in out['meta']['warnings']:
            print('warning:', warning)
    except (ValueError, OSError, ZoneInfoNotFoundError, subprocess.CalledProcessError) as error:
        p.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
