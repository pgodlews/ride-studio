"""Read GPX tracks without modifying the source or inventing sensor readings."""
from __future__ import annotations

import hashlib
import math
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import timezone
from zoneinfo import ZoneInfo

from prepare_dji import separation
from prepare_ride import FOOT_SPORTS, parse_utc

GPX_NAMESPACES = {'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1', ''}
TPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/'


def number(text, minimum=None, maximum=None, integer=False):
    try:
        value = float(text)
    except (ValueError, TypeError):
        return None
    if (not math.isfinite(value) or minimum is not None and value < minimum
            or maximum is not None and value > maximum or integer and not value.is_integer()):
        return None
    return value


def read_gpx(path, activity_id, *, track=None, sport=None, timezone_name=None):
    """Project one GPX track. Preserve segments, UTC, invalid fixes and recording gaps.

    Garmin TrackPointExtension v1/v2: HR (bpm), cadence (rpm), air temperature
    (C), and v2 speed (m/s). Unknown namespaces/fields are only inventoried.
    Distance/speed estimates connect adjacent valid fixes at most five seconds
    apart within a segment. Explicit invalid speed never gets a GPS backfill.
    """
    raw = path.read_bytes()
    # ElementTree never fetches schemaLocation or external resources. Refuse DTDs
    # including UTF-16/32 encodings rather than expanding custom entities.
    if b'<!DOCTYPE' in raw.replace(b'\x00', b'').upper() or b'<!ENTITY' in raw.replace(b'\x00', b'').upper():
        raise ValueError('GPX DTD/entity declarations are unsupported')
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ValueError(f'Invalid GPX XML: {error}') from error
    namespace = root.tag[1:].split('}')[0] if root.tag.startswith('{') else ''
    q = lambda name: f'{{{namespace}}}{name}' if namespace else name
    if root.tag != q('gpx') or namespace not in GPX_NAMESPACES:
        raise ValueError('Expected a GPX 1.0/1.1 document')
    tracks = root.findall(q('trk'))
    if track is None and len(tracks) > 1:
        raise ValueError(f'GPX contains {len(tracks)} tracks; select one with --track (1-based)')
    if track is not None and not 1 <= track <= len(tracks):
        raise ValueError(f'--track must be between 1 and {len(tracks)}')
    selected = tracks[(track or 1) - 1] if tracks else None
    evidence = {'source': path.name, 'sha256': hashlib.sha256(raw).hexdigest(),
                'bytes': len(raw), 'integrity': 'XML parsed (GPX has no FIT CRC)',
                'creator': root.get('creator'), 'version': root.get('version'),
                'tracks': len(tracks), 'selectedTrack': (track or 1) if tracks else None,
                'waypoints': len(root.findall(q('wpt'))), 'routes': len(root.findall(q('rte'))),
                'extensionTags': dict(Counter(e.tag for ext in root.iter(q('extensions')) for e in ext.iter() if e is not ext))}
    rows, warnings = [], []
    untimed = duplicates = 0
    pending_break = False
    segments = selected.findall(q('trkseg')) if selected is not None else []
    for segment_index, segment in enumerate(segments):
        pending_break = bool(rows)
        for point in segment.findall(q('trkpt')):
            text = point.findtext(q('time'))
            if not text:
                untimed += 1
                pending_break = True
                continue
            try:
                timestamp = parse_utc(text.strip())
            except ValueError as error:
                raise ValueError('GPX point time must be valid and include Z or a timezone offset') from error
            if rows and timestamp < rows[-1]['utc']:
                raise ValueError('GPX point times go backwards; split or repair the track before importing')
            if rows and timestamp == rows[-1]['utc']:
                duplicates += 1
                pending_break = True
                continue
            lat = number(point.get('lat'), -90, 90)
            lon = number(point.get('lon'), -180, 180)
            if lat is None or lon is None or point.findtext(q('fix')) == 'none':
                lat = lon = None
            row = {'utc': timestamp, 'segment': segment_index, 'lat': lat, 'lon': lon,
                   'altitude': number(point.findtext(q('ele'))), 'speed': None,
                   'heartRate': None, 'cadence': None, 'temperature': None,
                   'speedPresent': False, 'break': pending_break}
            # GPX 1.0 defines point speed in m/s; GPX 1.1 does not.
            speed = point.find(q('speed')) if namespace.endswith('/1/0') else None
            if speed is not None:
                row.update(speed=number(speed.text, 0), speedPresent=True)
            ext = point.find(q('extensions'))
            if ext is not None:
                for version in ('v2', 'v1'):
                    tpx = ext.find(f'{{{TPX}{version}}}TrackPointExtension')
                    if tpx is None:
                        continue
                    for field, channel, low, high, integer in (
                        ('hr', 'heartRate', 1, 255, True), ('cad', 'cadence', 0, 254, True),
                        ('atemp', 'temperature', None, None, False),
                        *([('speed', 'speed', 0, None, False)] if version == 'v2' else []),
                    ):
                        element = tpx.find(f'{{{TPX}{version}}}{field}')
                        if element is not None:
                            row[channel] = number(element.text, low, high, integer)
                            if channel == 'speed':
                                row['speedPresent'] = True
                    break
            rows.append(row)
            pending_break = False
    evidence.update(segments=len(segments), untimedPoints=untimed, duplicateTimes=duplicates)
    if untimed:
        warnings.append(f'{untimed} untimed track points skipped; no timestamp or motion invented')
    if duplicates:
        warnings.append(f'{duplicates} duplicate point timestamps dropped (first kept)')
    start = rows[0]['utc'] if rows else None
    times = [round((r['utc'] - start).total_seconds(), 6) for r in rows]
    breaks, total, derived_count = [], 0.0, 0
    for i, row in enumerate(rows):
        prev = rows[i - 1] if i else None
        dt = times[i] - times[i - 1] if i else None
        connected = (prev is not None and not row['break'] and dt <= 5
                     and row['lat'] is not None and prev['lat'] is not None)
        if i and not connected:
            breaks.append(i)
        if connected:
            delta = separation(prev, row)
            total += delta
            if not row['speedPresent']:
                row['speed'] = delta / dt
                derived_count += 1
        row['distance'] = total if row['lat'] is not None else None
    channel_ids = ['lat', 'lon', 'altitude', 'speed', 'distance', 'heartRate', 'temperature']
    foot = sport in FOOT_SPORTS
    if not foot:
        channel_ids.append('cadence')
    elif any(r['cadence'] is not None for r in rows):
        warnings.append('GPX cadence is rpm with unverified foot cadence semantics; not converted to steps/strides')
    channels = {c: [round(r[c], 6) if r[c] is not None else None for r in rows]
                for c in channel_ids if any(r[c] is not None for r in rows)}
    sources = {c: note for c, note in {
        'lat': 'GPX WGS-84 latitude (degrees)', 'lon': 'GPX WGS-84 longitude (degrees)',
        'altitude': 'GPX ele (metres); vertical datum unverified',
        'heartRate': 'Garmin TrackPointExtension hr (bpm)',
        'cadence': 'Garmin TrackPointExtension cad (rpm); genuine zero retained',
        'temperature': 'Garmin TrackPointExtension atemp (C), device/sensor reading',
        'speed': 'GPX recorded speed (m/s); where absent, adjacent-fix horizontal distance / UTC interval',
        'distance': 'Derived cumulative horizontal GPS distance; excludes segments/invalid fixes/gaps over 5 s',
    }.items() if c in channels}
    if derived_count:
        warnings.append('Speed includes GPS-derived interval estimates; sparse sampling and position jitter limit accuracy')
    evidence.update(derivedSpeedSamples=derived_count,
                    derivedSpeedIndices=[i for i, r in enumerate(rows) if r['speed'] is not None and not r['speedPresent']],
                    recordedSpeedSamples=sum(r['speedPresent'] and r['speed'] is not None for r in rows),
                    discontinuities=len(breaks), displayTimezone=timezone_name)
    if breaks:
        warnings.append('Distance is partial; segments, invalid fixes, untimed points and gaps over 5 s are not joined')
    if foot and 'speed' in channels:
        channels['pace'] = [round(1 / v, 6) if v is not None and v > 0 else None for v in channels['speed']]
        if not any(v is not None for v in channels['pace']):
            channels.pop('pace')
        else:
            sources['pace'] = 'Derived 1 / GPX speed, seconds/metre; absent when stopped/invalid'
    offset = None
    if timezone_name:
        zone = ZoneInfo(timezone_name)
        offsets = {int(r['utc'].astimezone(zone).utcoffset().total_seconds()) for r in rows}
        if len(offsets) > 1:
            raise ValueError('Track crosses a timezone offset transition; split it before importing')
        offset = next(iter(offsets), None)
    else:
        warnings.append('No display timezone supplied; clock widgets show UTC')
    gps_count = sum(r['lat'] is not None for r in rows)
    eligible = gps_count >= 2
    reason = None if eligible else ('no timestamped track points (waypoints/routes are not recordings)'
                                   if not rows else 'fewer than two timestamped GPS fixes')
    if reason:
        warnings.append(f'Excluded from route activity import: {reason}')
    return {
        'schema': 1, 'id': activity_id, 'startUtc': start.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z') if start else None,
        'tzOffsetSec': offset, 't': times, 'breaks': breaks, 'channels': channels,
        'meta': {'hrZones': None, 'laps': [], 'climbs': [], 'summary': {}, 'sensors': [],
                 'source': path.name, 'warnings': warnings, 'channelSources': sources,
                 'telemetry': {'kind': 'gpx', 'gpx': evidence},
                 'activity': {'sport': sport, 'subSport': None,
                              'name': selected.findtext(q('name')) if selected is not None else None,
                              'primaryMetric': 'pace' if foot else 'speed', 'indoor': False,
                              'gpsSamples': gps_count, 'recordSamples': len(rows), 'routeUsable': eligible,
                              'routeImportEligible': eligible, 'exclusionReason': reason}},
    }, evidence
