"""Content-based DJI/GPMF/EXIF detection and a shared camera ride projection."""
from __future__ import annotations

from tool_runtime import run_tool

import json
import math
from datetime import timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from dji_telemetry import boxes, embedded_rows, srt_rows
from gopro_telemetry import read_gopro
from media_metadata import device_name, exif_tags, offset_date, recorded_clock
from phone_telemetry import read_metadata
from prepare_dji import iso, separation, utc
from studio_media import probe_video

PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.heif'}


def container_probe(path):
    return json.loads(run_tool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
                                    check=True, capture_output=True, text=True).stdout)


def detect_family(probe, tags, path):
    track_keys = {s.get('codec_tag_string') for s in probe.get('streams', [])}
    if 'gpmd' in track_keys:
        return 'gopro', 'gpmd GPMF track'
    if track_keys & {'camd', 'djmd'}:
        return 'dji', 'camd/djmd track'
    # Some DJI originals put camd outside moov. Seek past video mdat rather than
    # scanning/copying footage; unrelated formats are left to generic EXIF.
    if path.suffix.lower() in {'.mp4', '.mov', '.m4v', '.osv', '.lrf', '.360'}:
        with path.open('rb') as stream:
            if any(k == b'camd' for k, _, _ in boxes(stream, 0, path.stat().st_size)):
                return 'dji', 'top-level camd box'
    identity = (device_name(tags) or '').lower()
    if 'gopro' in identity or 'hero' in identity:
        return 'gopro', 'embedded camera identity; no gpmd track'
    if 'dji' in identity:
        return 'dji', 'embedded camera identity; no mapped metadata track'
    return 'exif', 'generic QuickTime/EXIF metadata'


def sidecar_for(path):
    matches = [p for p in path.parent.iterdir() if p.is_file() and p.suffix.lower() == '.srt' and p.stem.lower() == path.stem.lower()]
    if len(matches) > 1:
        raise ValueError('Several matching SRT sidecars; select one explicitly with --sidecar')
    return matches[0] if matches else None


def inspect_camera(path, *, start_utc=None, sidecar=None, timezone_name=None, clock_correction_sec=0,
                   max_dop=5.0, max_speed_mps=100 / 3.6, geometry=None, tolerate_errors=False):
    path = Path(path).resolve(strict=True)
    if not math.isfinite(clock_correction_sec) or not all(math.isfinite(v) and v > 0 for v in (max_dop, max_speed_mps)):
        raise ValueError('Clock correction must be finite and GPS quality limits must be finite and positive')
    geometry = geometry or probe_video(path)
    probe = container_probe(path)
    tags = exif_tags(path)
    family, detected_by = detect_family(probe, tags, path)
    clock, clock_source = recorded_clock(tags, geometry.get('containerCreatedUtc'))
    recorded_date = next((dt for key in ('CreationDate', 'DateTimeOriginal') if (dt := offset_date(tags.get(key)))), None)
    rows, info, warnings = [], {}, []

    def decode(reader, *args):
        try:
            return reader(*args)
        except (ValueError, KeyError, UnicodeError) as error:
            if not tolerate_errors:
                raise
            warnings.append(f'Camera GPS could not be decoded: {error}. Imported as footage only.')
            return [], {'kind': family, 'decodeError': str(error)}

    track_keys = {s.get('codec_tag_string') for s in probe.get('streams', [])}
    sidecar = Path(sidecar).resolve(strict=True) if sidecar else sidecar_for(path) if family != 'gopro' else None
    if sidecar and 'gpmd' not in track_keys:
        # Only named DJI latitude/longitude sidecars qualify, never file naming alone.
        candidate, candidate_info = srt_rows(sidecar)
        if not any(r['lat'] is not None for r in candidate):
            raise ValueError('Matching SRT contains no supported named GPS fixes')
        rows, info = candidate, candidate_info
        family, detected_by = 'dji', 'named GPS SRT sidecar'
        info['sidecar'] = sidecar.name
    elif family == 'gopro' and 'gpmd' in track_keys:
        rows, info = decode(read_gopro, path, probe, max_dop, max_speed_mps)
        if info.get('gpsPlaybackZeroUtc'):
            clock, clock_source = info['gpsPlaybackZeroUtc'], 'GoPro GPS UTC minus metadata playback time (approximate)'
        warnings.append('GoPro GPS samples use grouped packet timing; frame alignment and sensor latency are approximate.')
        if info.get('utcAnchorSpreadSec') is not None and info['utcAnchorSpreadSec'] > 0.25:
            warnings.append(f'GoPro GPS UTC/playback anchors vary by {info["utcAnchorSpreadSec"]:.3f} s; no drift correction was applied.')
        if info.get('rejections'):
            warnings.append('GoPro no-fix, invalid-position and poor-DOP samples remain missing; GPS gaps are not bridged.')
        if info.get('speedRejectedSamples'):
            warnings.append(f'{info["speedRejectedSamples"]} GoPro speed samples exceed the configured {max_speed_mps * 3.6:g} km/h limit or are negative; rejected readings are retained in evidence.')
    elif family == 'dji' and (track_keys & {'camd', 'djmd'} or detected_by == 'top-level camd box'):
        # A recognized but unsupported/proprietary schema is an explicit error.
        # Do not silently fall back to a geotag and claim its route was decoded.
        rows, info = decode(embedded_rows, path)
        warnings.append('DJI boot-clock origin and camera UTC are approximate; verify playback-zero alignment or set an explicit playback-zero UTC.')
    elif family == 'exif':
        rows, info = decode(read_metadata, path, geometry['duration'])
        info['kind'] = 'exif'
        if info.get('locationMode') == 'clip-geotag':
            warnings.append('Single EXIF location retained as a geotag; it does not create a route or speed.')
    else:
        info = {'kind': family, 'model': tags.get('Model'), 'schemas': [], 'usableGpsSamples': 0}
    outside_playback = bool(rows) and (rows[0]['t'] < 0 or rows[-1]['t'] > geometry['duration'] + 0.1)
    if outside_playback:
        if not tolerate_errors:
            raise ValueError('Telemetry extends outside video playback; use an untrimmed matching original')
        # A trimmed or re-timed clip keeps metadata times that no longer match playback.
        warnings.append('Camera GPS falls outside the clip playback range and is not used; the file looks trimmed or re-timed.')
        rows = []
    valid = sum(r.get('lat') is not None and r.get('lon') is not None for r in rows)
    gps_status = 'unsupported' if info.get('decodeError') else 'usable' if valid >= 2 else 'no-usable-fix' if rows or outside_playback else 'absent'
    if gps_status != 'usable':
        warnings.append('No usable timed GPS route; pin the clip on a map or use an activity route to place it.')
    if start_utc:
        clock, clock_source = iso(utc(start_utc)), 'explicit playback-zero UTC'
    if clock:
        clock = iso(utc(clock) + timedelta(seconds=clock_correction_sec))
    else:
        warnings.append('No recording UTC found; the clip needs an explicit playback-zero UTC or a map pin.')
    info.update(kind=family, detection=detected_by, gpsStatus=gps_status, usableGpsSamples=valid,
                clockSource=clock_source, utcAnchor=clock, clockCorrectionSec=clock_correction_sec,
                displayTimezone=timezone_name, videoDurationSec=geometry['duration'])
    info['recordedTimezoneOffsetSec'] = int(recorded_date.utcoffset().total_seconds()) if recorded_date else None
    return rows, info, {**geometry, 'recordedUtc': clock, 'clockSource': clock_source,
                        'device': info.get('model') if family == 'gopro' and info.get('model') else device_name(tags) or info.get('model'),
                        'detection': {'kind': family, 'by': detected_by, 'gpsStatus': gps_status, 'gpsSamples': valid},
                        'warnings': warnings}


def camera_ride(rows, info, metadata, ride_id, source, timezone_name=None):
    if not metadata['recordedUtc']:
        raise ValueError('No recording UTC; supply --start-utc, or import this clip into an activity for pin sync')
    start = utc(metadata['recordedUtc'])
    duration = metadata['duration']
    ordered = sorted(rows, key=lambda r: r['t'])
    # Frame telemetry can have duplicated lens times; the DJI reader aligns them.
    merged = {}
    for row in ordered:
        t = round(row['t'], 6)
        if t in merged:
            for key, value in row.items():
                if merged[t].get(key) is None and value is not None:
                    merged[t][key] = value
        else:
            merged[t] = dict(row, t=t)
    for t in (0.0, round(duration, 6)):
        if t not in merged:
            merged[t] = {'t': t, 'lat': None, 'lon': None}
    ordered = sorted(merged.values(), key=lambda r: r['t'])
    if any(b['t'] <= a['t'] for a, b in zip(ordered, ordered[1:])):
        raise ValueError('Camera times must be strictly increasing')
    channels = {key: [r.get(key) for r in ordered] for key in ('lat', 'lon', 'altitude', 'speed', 'relativeAltitude')}
    distance, total, previous, breaks = [], 0.0, None, []
    for i, row in enumerate(ordered):
        valid = row.get('lat') is not None and row.get('lon') is not None
        if not valid:
            distance.append(None)
            previous = None
            if i:
                breaks.append(i)
            continue
        if previous is not None and row['t'] - previous['t'] <= 5:
            total += separation(previous, row)
        elif i:
            breaks.append(i)
        distance.append(round(total, 3))
        previous = row
    if info['usableGpsSamples'] >= 2:
        channels['distance'] = distance
    channels = {k: v for k, v in channels.items() if any(x is not None for x in v)}
    warnings = list(metadata['warnings'])
    offset = None
    if timezone_name:
        zone = ZoneInfo(timezone_name)
        offset = int(start.astimezone(zone).utcoffset().total_seconds())
        if offset != int((start + timedelta(seconds=duration)).astimezone(zone).utcoffset().total_seconds()):
            raise ValueError('Clip crosses a timezone transition; split it before importing')
    elif info.get('recordedTimezoneOffsetSec') is not None:
        offset = info['recordedTimezoneOffsetSec']
    else:
        warnings.append('No display timezone supplied; clock widgets show UTC.')
    warnings.append('Camera clock alignment is approximate. HR/cadence/power require a separately selected activity.')
    if breaks and 'distance' in channels:
        warnings.append('GPS distance is partial; invalid fixes and gaps over 5 s are not bridged.')
    kind = info['kind']
    sources = {'lat': f'{kind} recorded GPS latitude (degrees)', 'lon': f'{kind} recorded GPS longitude (degrees)',
               'altitude': 'GoPro recorded altitude; GPSA reference retained; only 3D fixes' if kind == 'gopro' else 'Recorded absolute altitude (m); vertical reference depends on source',
               'speed': 'GoPro recorded horizontal GPS speed (m/s), quality-filtered' if kind == 'gopro' else 'DJI recorded horizontal North/East velocity magnitude (m/s)',
               'relativeAltitude': 'DJI recorded relative altitude (m)', 'distance': 'Derived horizontal GPS distance; gaps excluded'}
    return {'schema': 1, 'id': ride_id, 'startUtc': iso(start), 'tzOffsetSec': offset, 't': [r['t'] for r in ordered],
            'breaks': sorted(set(breaks)), 'channels': channels,
            'meta': {'hrZones': None, 'laps': [], 'climbs': [], 'sensors': [], 'source': source,
                     'telemetry': {k: v for k, v in info.items() if k != 'sampleEvidence'},
                     'summary': {'total_distance': total} if 'distance' in channels else {},
                     'channelSources': {k: v for k, v in sources.items() if k in channels}, 'warnings': warnings}}


def write_sample_evidence(info, target):
    """Retain per-sample GPS evidence in a private JSON file beside the projection."""
    if not info.get('sampleEvidence'):
        return None
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    evidence = {k: info[k] for k in ('kind', 'metadataSha256') if k in info}
    target.write_text(json.dumps({**evidence, 'sampleEvidence': info['sampleEvidence']},
                                 separators=(',', ':'), allow_nan=False))
    return target
