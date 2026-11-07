"""Read a still's EXIF and write an oriented, metadata-free PNG for preview/export.

The input is never modified. A geotag is a single location, not ride telemetry.
"""
from tool_runtime import run_tool
import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


def finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def exif_date(value):
    return re.sub(r"^(\d{4}):(\d{2}):(\d{2}) ", r"\1-\2-\3T", str(value)).replace("Z", "+00:00")


def metadata(tags):
    warnings = []
    # ExifTool Composite coordinates include hemisphere and altitude-ref signs.
    lat, lon = finite(tags.get('GPSLatitude')), finite(tags.get('GPSLongitude'))
    gps = None
    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
        gps = {'lat': lat, 'lon': lon, 'altitude': finite(tags.get('GPSAltitude'))}
    else:
        warnings.append('No valid EXIF GPS location; location stays missing.')
    capture = tags.get('SubSecDateTimeOriginal') or tags.get('DateTimeOriginal')
    captured_utc = clock_source = None
    if capture:
        try:
            text = exif_date(capture)
            if not re.search(r'[+-]\d\d:\d\d$', text) and tags.get('OffsetTimeOriginal'):
                text += str(tags['OffsetTimeOriginal'])
            dt = datetime.fromisoformat(text)
            if dt.utcoffset() is not None:
                captured_utc = dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
                clock_source = 'EXIF original capture time with timezone offset'
        except ValueError:
            pass
    if captured_utc is None and tags.get('GPSDateTime'):
        try:
            dt = datetime.fromisoformat(exif_date(tags['GPSDateTime']))
            dt = dt.replace(tzinfo=timezone.utc) if dt.utcoffset() is None else dt
            captured_utc = dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
            clock_source = 'EXIF GPS UTC (GPS fix time, approximate capture time)'
        except ValueError:
            pass
    if captured_utc is None:
        warnings.append('No timezone-bearing capture time or GPS UTC; choose the ride time manually.')
    return {'gps': gps, 'captureTime': str(capture) if capture else None,
            'capturedUtc': captured_utc, 'clockSource': clock_source, 'warnings': warnings}


def prepare(source, output):
    result = run_tool('exiftool', ['-j', '-n', '-GPSLatitude', '-GPSLongitude',
                             '-GPSAltitude', '-GPSDateTime', '-DateTimeOriginal',
                             '-SubSecDateTimeOriginal', '-OffsetTimeOriginal', str(source)],
                            check=True, capture_output=True, text=True)
    info = metadata(json.loads(result.stdout)[0])
    with tempfile.TemporaryDirectory() as temp:
        raster = source
        if source.suffix.lower() in {'.heic', '.heif'}:
            if sys.platform != 'darwin':
                raise ValueError('HEIC/HEIF import currently requires macOS; convert to JPEG or PNG first')
            raster = Path(temp) / 'decoded.png'
            subprocess.run(['sips', '-s', 'format', 'png', str(source), '--out', str(raster)],
                           check=True, capture_output=True)
        with Image.open(raster) as image:
            # MPO (multi-picture JPEG: iPhone HDR gain maps, camera previews, stereo pairs)
            # stores the photo itself as the first image; Pillow opens on that frame.
            if getattr(image, 'n_frames', 1) != 1 and image.format != 'MPO':
                raise ValueError('Import a single still image; animated/multipage images are unsupported')
            # Mirror/rotate all eight EXIF orientations before either client uses it.
            oriented = ImageOps.exif_transpose(image).convert('RGBA')
            # Transparent stills composite against black, just like the stage.
            background = Image.new('RGB', oriented.size, 'black')
            background.paste(oriented, mask=oriented.getchannel('A'))
            # No original EXIF/GPS tags leak into the served PNG.
            background.save(output, 'PNG')
            info.update(width=background.width, height=background.height)
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.source, args.output), allow_nan=False))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Photo import failed: {error}\n')


if __name__ == '__main__':
    main()
