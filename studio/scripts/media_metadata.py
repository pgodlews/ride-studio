"""Probe imported video: geometry, clock and automatic DJI/GPMF/EXIF detection.

Read-only towards the input. Prints one metadata JSON object and optionally writes
a private camera-telemetry projection plus its per-sample GPS evidence. Existing activity sensors remain separate;
the clip is placed by its recorded clock or a user pin on the GPS track.
"""
from __future__ import annotations

import json
import argparse
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from studio_media import probe_video

# HEVC availability depends on browser, hardware and profile. Use an H.264 proxy
# for automatic imports so a valid camera ride never opens with a black preview.
BROWSER_CODECS = {'h264', 'vp8', 'vp9', 'av1'}
BROWSER_CONTAINERS = {'.mp4', '.mov', '.m4v', '.webm'}


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def exif_tags(path: Path) -> dict:
    # No -ee: embedded per-frame documents are not needed and are slow on long clips.
    result = subprocess.run(['exiftool', '-j', '-s', '-n',
                             '-CreationDate', '-DateTimeOriginal', '-Make', '-Model',
                             '-AndroidMake', '-AndroidModel', '-AndroidManufacturer', str(path)],
                            capture_output=True, text=True)
    try:
        data = json.loads(result.stdout or '[]')
    except json.JSONDecodeError:
        return {}
    return data[0] if data and isinstance(data[0], dict) else {}


def offset_date(text):
    """ExifTool date with an explicit UTC offset, or None."""
    if not text:
        return None
    m = re.fullmatch(r'(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})', str(text).strip())
    if not m:
        return None
    try:
        return datetime.fromisoformat(f'{m[1]}-{m[2]}-{m[3]}T{m[4]}{m[5].replace("Z", "+00:00")}')
    except ValueError:
        return None


def recorded_clock(tags: dict, container_utc):
    for key in ('CreationDate', 'DateTimeOriginal'):
        dt = offset_date(tags.get(key))
        if dt:
            return iso(dt), f'{key} with UTC offset (unverified camera clock)'
    if container_utc:
        try:
            dt = datetime.fromisoformat(str(container_utc).replace('Z', '+00:00'))
        except ValueError:
            dt = None
        # 1904/1970 epochs mean an unset clock, not a recording time.
        if dt and dt.year >= 2000:
            return iso(dt), 'container creation time (some cameras store local time as UTC)'
    return None, None


def device_name(tags: dict):
    make = tags.get('Make') or tags.get('AndroidMake') or tags.get('AndroidManufacturer')
    model = tags.get('Model') or tags.get('AndroidModel')
    parts = [str(p).strip() for p in (make, model) if p not in (None, '') and str(p).strip()]
    return ' '.join(dict.fromkeys(parts)) or None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--telemetry-out', type=Path, help='optional private camera ride projection')
    parser.add_argument('--id', default='camera')
    parser.add_argument('--timezone')
    args = parser.parse_args()
    path = args.video.resolve(strict=True)
    try:
        geometry = probe_video(path)
    except (ValueError, KeyError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        sys.exit(f'Not a readable single-stream video: {error}')
    from camera_telemetry import camera_ride, inspect_camera, write_sample_evidence
    try:
        rows, info, meta = inspect_camera(path, geometry=geometry, tolerate_errors=True, timezone_name=args.timezone)
        if args.telemetry_out and meta['recordedUtc']:
            ride = camera_ride(rows, info, meta, args.id, path.name, args.timezone)
            # Evidence first: the projection file is the success signal the server checks.
            write_sample_evidence(info, args.telemetry_out.with_name(f'{args.telemetry_out.stem}-evidence.json'))
            args.telemetry_out.write_text(json.dumps(ride, separators=(',', ':'), allow_nan=False))
    except (ValueError, OSError, KeyError, UnicodeError, subprocess.CalledProcessError) as error:
        sys.exit(f'Camera metadata inspection failed: {error}')
    playable = geometry['codec'] in BROWSER_CODECS and path.suffix.lower() in BROWSER_CONTAINERS
    meta.pop('containerCreatedUtc', None)
    if meta['recordedUtc']:
        meta['recordedUtc'] = iso(datetime.fromisoformat(meta['recordedUtc'].replace('Z', '+00:00')))
    print(json.dumps({**meta, 'browserPlayable': playable}, allow_nan=False))


if __name__ == '__main__':
    main()
