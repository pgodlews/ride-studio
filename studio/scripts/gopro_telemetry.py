"""Read GoPro GPS5/GPS9 from timed GPMF packets without decoding video.

Independent implementation of https://github.com/gopro/gpmf-parser's published
KLV/schema specification. Unknown keys are inventoried; the original retains their
exact bytes. Container PTS/duration place grouped samples on playback; this is an
approximation, not a subsecond GPS-to-frame calibration.
"""
from __future__ import annotations

from tool_runtime import run_tool

import hashlib
import json
import math
import struct
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_METADATA = 256 * 1024 * 1024
FORMATS = {'b': 'b', 'B': 'B', 's': 'h', 'S': 'H', 'l': 'i', 'L': 'I',
           'j': 'q', 'J': 'Q', 'f': 'f', 'd': 'd'}
KNOWN = {'DEVC', 'DVID', 'DVNM', 'STRM', 'STNM', 'SCAL', 'SIUN', 'UNIT',
         'TYPE', 'TSMP', 'STMP', 'TIMO', 'GPS5', 'GPS9', 'GPSU', 'GPSF', 'GPSP', 'GPSA'}


def finite(value):
    try:
        out = float(value)
        return out if math.isfinite(out) else None
    except (ValueError, TypeError):
        return None


def entries(raw, depth=0):
    if depth > 8:
        raise ValueError('GPMF nesting exceeds limit')
    pos = 0
    while pos < len(raw):
        if len(raw) - pos < 8:
            raise ValueError('Truncated GPMF header')
        key, typ, size, count = struct.unpack_from('>4sBBH', raw, pos)
        length = size * count
        end = pos + 8 + length
        padded = pos + 8 + (length + 3) // 4 * 4
        if end > len(raw) or padded > len(raw) or (count and not size):
            raise ValueError('Truncated or invalid GPMF value')
        key = key.decode('ascii')
        body = raw[pos + 8:end]
        yield key, chr(typ), size, count, list(entries(body, depth + 1)) if typ == 0 else body
        pos = padded


def numbers(entry, complex_type=None):
    _, typ, size, count, body = entry
    if typ == '?':
        if not complex_type or any(t not in FORMATS for t in complex_type):
            raise ValueError('Unsupported GPMF complex TYPE')
        fmt = '>' + ''.join(FORMATS[t] for t in complex_type)
    elif typ in FORMATS:
        width = struct.calcsize(FORMATS[typ])
        if size % width:
            raise ValueError('Invalid GPMF numeric width')
        fmt = '>' + FORMATS[typ] * (size // width)
    else:
        raise ValueError(f'Unsupported GPMF numeric type {typ!r}')
    if struct.calcsize(fmt) != size or len(body) != size * count:
        raise ValueError('GPMF TYPE/size mismatch')
    return list(struct.iter_unpack(fmt, body))


def text(entry):
    return entry[4].decode('utf-8', errors='replace').rstrip('\0')


def scalar(entry):
    samples = numbers(entry)
    if len(samples) != 1 or len(samples[0]) != 1:
        raise ValueError('Invalid GPMF scalar field')
    return finite(samples[0][0])


def gps_utc(body):
    try:
        dt = datetime.strptime(body.decode('ascii').rstrip('\0'), '%y%m%d%H%M%S.%f')
        return dt.replace(tzinfo=timezone.utc)
    except (ValueError, UnicodeError):
        return None


def decode_packet(raw, t, duration, max_dop=5.0, max_speed_mps=100 / 3.6):
    roots = list(entries(raw))
    keys = set()
    models = set()
    streams = []

    def walk(items):
        for entry in items:
            key = entry[0]
            keys.add(key)
            if key == 'DVNM':
                models.add(text(entry))
            if key == 'STRM':
                if entry[1] != '\0':
                    raise ValueError('Invalid GPMF STRM nesting')
                streams.append(entry[4])
            if entry[1] == '\0':
                walk(entry[4])
    walk(roots)
    rows = []
    for stream in streams:
        # GPS9 is preferred when the camera carries both formats in a stream.
        preferred = 'GPS9' if any(e[0] == 'GPS9' for e in stream) else 'GPS5'
        context = {}
        for entry in stream:
            key = entry[0]
            if key not in ('GPS5', 'GPS9'):
                context[key] = entry
                continue
            if key != preferred:
                continue
            scales = [v for sample in numbers(context['SCAL']) for v in sample] if 'SCAL' in context else None
            kind = text(context['TYPE']) if 'TYPE' in context else None
            samples = numbers(entry, kind)
            width = 9 if key == 'GPS9' else 5
            if any(len(sample) != width for sample in samples):
                raise ValueError(f'Unsupported {key} sample shape')
            if scales is None or len(scales) not in (1, width) or any(not finite(s) or s == 0 for s in scales):
                raise ValueError(f'Invalid or missing {key} SCAL')
            if len(scales) == 1:
                scales *= width
            if 'SIUN' in context or 'UNIT' in context:
                unit = context.get('SIUN', context.get('UNIT'))
                raw_units = unit[4]
                units = [raw_units[i:i + unit[2]].decode('utf-8', errors='replace').strip('\0 ') for i in range(0, len(raw_units), unit[2])]
                if units[:5] != ['deg', 'deg', 'm', 'm/s', 'm/s']:
                    raise ValueError(f'Unsupported {key} units: {units!r}')
            fix = scalar(context['GPSF']) if 'GPSF' in context else None
            precision = scalar(context['GPSP']) if 'GPSP' in context else None
            dop = precision / 100 if precision is not None else None
            packet_utc = gps_utc(context['GPSU'][4]) if 'GPSU' in context else None
            altitude_system = text(context['GPSA']) if 'GPSA' in context else None
            for i, sample in enumerate(samples):
                values = [finite(v / s) for v, s in zip(sample, scales)]
                lat, lon, alt, speed, speed3d = values[:5]
                stamp = packet_utc if i == 0 else None
                if key == 'GPS9':
                    days, seconds, dop, fix = values[5:]
                    stamp = None
                    if days is not None and seconds is not None and days.is_integer() and 0 <= days <= 73049 and 0 <= seconds < 86400:
                        stamp = datetime(2000, 1, 1, tzinfo=timezone.utc) + timedelta(days=days, seconds=seconds)
                valid = fix in (2, 3) and lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180
                valid = valid and (dop is None or 0 <= dop <= max_dop)
                speed_rejected = speed is not None and not 0 <= speed <= max_speed_mps
                reason = 'no-fix' if fix not in (2, 3) else 'bad-position' if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180 else 'poor-dop' if not valid else None
                rows.append({'t': round(t + i * duration / max(1, len(samples)), 6),
                             'lat': lat if valid else None, 'lon': lon if valid else None,
                             'altitude': alt if valid and fix == 3 else None,
                             'speed': speed if valid and not speed_rejected else None,
                             'gpsUtc': stamp.isoformat().replace('+00:00', 'Z') if stamp else None,
                             'fix': fix, 'dop': dop, 'gpsSchema': key, 'altitudeSystem': altitude_system,
                             'rejection': reason, 'speedRejected': speed_rejected,
                             'rawPosition': [lat, lon, alt], 'rawSpeedMps': speed, 'rawSpeed3dMps': speed3d})
    return rows, keys, models


def read_gopro(path: Path, probe=None, max_dop=5.0, max_speed_mps=100 / 3.6):
    if not all(math.isfinite(v) and v > 0 for v in (max_dop, max_speed_mps)):
        raise ValueError('GoPro quality limits must be finite and positive')
    if probe is None:
        probe = json.loads(run_tool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], check=True, capture_output=True, text=True).stdout)
    tracks = [s for s in probe['streams'] if s.get('codec_tag_string') == 'gpmd']
    if len(tracks) != 1:
        raise ValueError('GoPro import requires exactly one gpmd telemetry track')
    track = tracks[0]
    packets = json.loads(run_tool('ffprobe', ['-v', 'error', '-select_streams', str(track['index']), '-show_packets',
                                        '-show_entries', 'packet=pts_time,duration_time,pos,size', '-of', 'json', str(path)],
                                       check=True, capture_output=True, text=True).stdout)['packets']
    size = path.stat().st_size
    rows, keys, models, total, previous_end = [], set(), set(), 0, None
    metadata_hash = hashlib.sha256()
    duration = finite(probe['format'].get('duration'))
    if duration is None or duration <= 0:
        raise ValueError('Invalid GoPro duration')
    with path.open('rb') as stream:
        for packet in packets:
            offset, length = int(packet['pos']), int(packet['size'])
            t, span = finite(packet.get('pts_time')), finite(packet.get('duration_time'))
            if t is None or span is None or t < 0 or span <= 0 or t + span > duration + 0.1:
                raise ValueError('Unsupported GoPro packet timing; normal playback is required')
            if previous_end is not None and t < previous_end - 0.00001:
                raise ValueError('Overlapping GoPro metadata packets')
            previous_end = t + span
            total += length
            if length <= 0 or offset < 0 or offset + length > size or total > MAX_METADATA:
                raise ValueError('Invalid or oversized GoPro metadata packets')
            stream.seek(offset)
            raw = stream.read(length)
            if len(raw) != length:
                raise ValueError('Truncated GoPro metadata packet')
            metadata_hash.update(raw)
            decoded, found, names = decode_packet(raw, t, min(span, duration - t), max_dop, max_speed_mps)
            rows.extend(decoded)
            keys.update(found)
            models.update(names)
    # GPS9 wins globally when separate streams carry old/new representations.
    if any(r['gpsSchema'] == 'GPS9' for r in rows):
        rows = [r for r in rows if r['gpsSchema'] == 'GPS9']
    rows.sort(key=lambda r: r['t'])
    if any(b['t'] <= a['t'] for a, b in zip(rows, rows[1:])):
        raise ValueError('Conflicting GoPro GPS streams at the same playback time')
    timed = [(r['t'], datetime.fromisoformat(r['gpsUtc'].replace('Z', '+00:00')).timestamp())
             for r in rows if r['lat'] is not None and r['gpsUtc']]
    anchors = [stamp - t for t, stamp in timed]
    utc_rate = None
    if len(timed) > 1 and timed[-1][0] - timed[0][0] > 5:
        utc_rate = (timed[-1][1] - timed[0][1]) / (timed[-1][0] - timed[0][0])
        if not 0.9 <= utc_rate <= 1.1:
            raise ValueError('GoPro GPS UTC and playback rates disagree; slow motion/TimeWarp or clock discontinuity needs an explicit time map')
    anchor = anchors[0] if anchors else None
    info = {'kind': 'gopro', 'model': ', '.join(sorted(models)) or None, 'schemas': sorted({r['gpsSchema'] for r in rows}),
            'metadataPackets': len(packets), 'gpsSamples': len(rows), 'usableGpsSamples': sum(r['lat'] is not None for r in rows),
            'fixSamples': dict(Counter(str(r['fix']) for r in rows)), 'rejections': dict(Counter(r['rejection'] for r in rows if r['rejection'])),
            'speedRejectedSamples': sum(r['speedRejected'] for r in rows), 'keys': sorted(keys), 'unknownKeys': sorted(keys - KNOWN),
            'metadataSha256': metadata_hash.hexdigest(), 'maxDop': max_dop, 'maxSpeedMps': max_speed_mps,
            'altitudeSystems': sorted({r['altitudeSystem'] for r in rows if r['altitudeSystem']}),
            'gpsPlaybackZeroUtc': datetime.fromtimestamp(anchor, timezone.utc).isoformat().replace('+00:00', 'Z') if anchor else None,
            'utcAnchorSpreadSec': round(max(anchors) - min(anchors), 6) if anchors else None,
            'gpsUtcToPlaybackRate': utc_rate,
            'timing': 'samples evenly distributed within each container metadata packet; GPS UTC anchors playback approximately',
            # Keep exact UTC, quality and rejected raw readings locally; no sensor meanings are assigned to unknown keys.
            'sampleEvidence': [{k: v for k, v in r.items() if k not in ('lat', 'lon', 'altitude', 'speed')} for r in rows]}
    return rows, info
