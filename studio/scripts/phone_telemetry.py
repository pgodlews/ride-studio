"""Read named QuickTime GPS metadata through ExifTool, keeping geotags separate."""
from __future__ import annotations

import json
import math
import re
import statistics
from tool_runtime import run_tool


def finite(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def position(tags):
    lat, lon = finite(tags.get('GPSLatitude')), finite(tags.get('GPSLongitude'))
    altitude = finite(tags.get('GPSAltitude'))
    if lat is None or lon is None:
        # ExifTool -n decodes ISO6709 / QuickTime GPSCoordinates to degrees/metres.
        parts = str(tags.get('GPSCoordinates', '')).split()
        if len(parts) in (2, 3):
            lat, lon = map(finite, parts[:2])
            altitude = finite(parts[2]) if len(parts) == 3 else None
    else:
        if tags.get('GPSLatitudeRef') == 'S':
            lat = -abs(lat)
        if tags.get('GPSLongitudeRef') == 'W':
            lon = -abs(lon)
        if str(tags.get('GPSAltitudeRef')) == '1' and altitude is not None:
            altitude = -abs(altitude)
    if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return None
    return {'lat': lat, 'lon': lon, 'altitude': altitude}


def decode_metadata(data, duration):
    groups = {}
    for key, value in data.items():
        group, _, tag = key.partition(':')
        if tag:
            groups.setdefault(group, {})[tag] = value
    main = groups.get('Main', {})
    rows, gps_documents, duplicates = {}, 0, 0
    for group, tags in groups.items():
        if not re.fullmatch(r'Doc\d+', group):
            continue
        # LivePhotoInfo / orientation metadata can be frame-rate samples. They
        # are not GPS fixes and must never be counted as coordinate sampling.
        if not any(k in tags for k in ('GPSCoordinates', 'GPSLatitude', 'GPSLongitude')):
            continue
        t = finite(tags.get('SampleTime'))
        if t is None or not 0 <= t <= duration:
            continue
        gps_documents += 1
        row = dict(position(tags) or {'lat': None, 'lon': None, 'altitude': None}, t=round(t, 6))
        if row['t'] in rows:
            duplicates += 1
            if (rows[row['t']]['lat'], rows[row['t']]['lon']) != (row['lat'], row['lon']):
                raise ValueError('Conflicting GPS fixes at one playback time; track mapping needs inspection')
        else:
            rows[row['t']] = row
    ordered = sorted(rows.values(), key=lambda r: r['t'])
    valid = [r for r in ordered if r['lat'] is not None and r['lon'] is not None]
    intervals = [b['t'] - a['t'] for a, b in zip(valid, valid[1:])]
    location = position(main)
    if location:
        accuracy = finite(main.get('LocationAccuracyHorizontal'))
        location['horizontalAccuracyM'] = accuracy if accuracy is not None and accuracy >= 0 else None
    info = {
        'kind': 'phone', 'make': main.get('Make'), 'model': main.get('Model'),
        'locationMode': 'timed' if valid else 'clip-geotag' if location else 'none',
        'clipLocation': location, 'timedGpsSamples': len(valid),
        'gpsDocuments': gps_documents, 'duplicateTimestamps': duplicates,
        'medianGpsIntervalSec': statistics.median(intervals) if intervals else None,
        'maxGpsIntervalSec': max(intervals) if intervals else None,
        'sampleGroups': sum(bool(re.fullmatch(r'Doc\d+', g)) for g in groups),
        'clockCreationDate': main.get('CreationDate'),
    }
    return ordered, info


def read_metadata(path, duration):
    result = run_tool('exiftool', [ '-ee3', '-G3', '-a', '-s', '-n', '-j', '-GPS*',
        '-SampleTime', '-SampleDuration', '-LocationAccuracyHorizontal',
        '-CreationDate', '-Make', '-Model', str(path),
    ], check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    if not data or not isinstance(data[0], dict):
        raise ValueError('ExifTool returned no metadata')
    return decode_metadata(data[0], duration)
