"""Automatically import DJI, GoPro GPMF or generic EXIF video as a studio ride."""
from __future__ import annotations

from tool_runtime import run_tool

import argparse
import json
import re
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfoNotFoundError

from camera_telemetry import PHOTO_EXTENSIONS, camera_ride, inspect_camera, write_sample_evidence
from prepare_dji import utc
from studio_media import browser_preview, registration

STUDIO = Path(__file__).resolve().parent.parent


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('video', type=Path)
    p.add_argument('--inspect', action='store_true', help='print detection/quality JSON without writing output')
    p.add_argument('--start-utc', help='override approximate recording UTC at playback zero')
    p.add_argument('--clock-correction-sec', type=float, default=0)
    p.add_argument('--timezone', help='IANA display timezone, e.g. Europe/London')
    p.add_argument('--sidecar', type=Path, help='explicit DJI named-GPS SRT; matching sibling SRT is otherwise detected')
    p.add_argument('--max-dop', type=float, default=5.0, help='maximum GoPro DOP (default 5)')
    p.add_argument('--max-speed-kmh', type=float, default=100, help='maximum GoPro recorded speed (default 100 km/h); rejected raw values retained')
    p.add_argument('--id', help='new ride ID; defaults to sanitized file stem')
    p.add_argument('--out-dir', type=Path, default=STUDIO / 'public/data/rides')
    p.add_argument('--register', action='store_true', help='register original footage read-only without copying it')
    p.add_argument('--preview', type=Path, help='use an existing full-length matching preview; incompatible originals otherwise get an automatic H.264 proxy')
    p.add_argument('--camera', choices=['front', 'rear'], default='front')
    args = p.parse_args()
    try:
        source = args.video.resolve(strict=True)
        if source.suffix.lower() in PHOTO_EXTENSIONS:
            if not args.inspect:
                raise ValueError('Import still photos through Editor → Videos & photos; --inspect reads EXIF here')
            from photo_metadata import metadata
            raw = run_tool('exiftool', ['-j', '-n', '-GPS*', '-DateTimeOriginal', '-SubSecDateTimeOriginal', '-OffsetTimeOriginal', str(source)], check=True, capture_output=True, text=True)
            print(json.dumps({'detection': {'kind': 'exif-photo'}, **metadata(json.loads(raw.stdout)[0])}, allow_nan=False))
            return
        rows, info, meta = inspect_camera(source, start_utc=args.start_utc, sidecar=args.sidecar, timezone_name=args.timezone,
                                          clock_correction_sec=args.clock_correction_sec, max_dop=args.max_dop,
                                          max_speed_mps=args.max_speed_kmh / 3.6)
        if args.inspect:
            print(json.dumps({**meta, 'telemetry': {k: v for k, v in info.items() if k != 'sampleEvidence'}}, allow_nan=False))
            return
        ride_id = args.id or re.sub(r'[^A-Za-z0-9_-]+', '-', source.stem).strip('-')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', ride_id):
            raise ValueError('Ride ID must use letters, numbers, underscores or hyphens')
        if args.preview and not args.register:
            raise ValueError('--preview requires --register')
        if args.register and args.out_dir.resolve() != (STUDIO / 'public/data/rides').resolve():
            raise ValueError('--register requires studio public/data/rides output folder')
        target = args.out_dir / f'{ride_id}.json'
        if target.exists():
            raise ValueError('Ride already exists; use a new --id to preserve the previous import')
        out = camera_ride(rows, info, meta, ride_id, source.name, args.timezone)
        preview = args.preview
        if args.register and preview is None:
            from media_metadata import BROWSER_CODECS, BROWSER_CONTAINERS
            if meta['codec'] not in BROWSER_CODECS or source.suffix.lower() not in BROWSER_CONTAINERS:
                preview = browser_preview(source, STUDIO / '.cache/camera-previews' / f'{ride_id}.mp4')
        entry = registration(source, preview, utc(meta['recordedUtc']), args.camera, 0,
                             brand=info['kind'], registration_id=ride_id) if args.register else None
        if entry:
            entry.update(rideId=ride_id, label=source.name, syncNotice='Camera telemetry auto-detected; UTC and frame alignment are approximate.')
        manifest_path = STUDIO / '.cache/camera-footage.json'
        manifest = json.loads(manifest_path.read_text()) if args.register and manifest_path.exists() else []
        if entry and any(e['name'] == entry['name'] for e in manifest):
            raise ValueError('Video already registered')
        args.out_dir.mkdir(parents=True, exist_ok=True)
        with target.open('x') as stream:
            stream.write(json.dumps(out, separators=(',', ':'), allow_nan=False))
        write_sample_evidence(info, STUDIO / '.cache/camera-evidence' / f'{ride_id}.json')
        if entry:
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(json.dumps([*manifest, entry], indent=2, allow_nan=False))
        print(json.dumps({'rideId': ride_id, 'detection': meta['detection'], 'warnings': out['meta']['warnings']}, allow_nan=False))
    except (ValueError, OSError, KeyError, UnicodeError, ZoneInfoNotFoundError, subprocess.CalledProcessError) as error:
        p.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
