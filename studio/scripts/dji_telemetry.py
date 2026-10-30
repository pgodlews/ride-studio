"""Read DJI GPS telemetry without decoding video or modifying camera files.

Container traversal is based on OSVplat's MIT-licensed scripts/osv_meta.py
(29622647b3ebde814836bce5dd16926f600b4375). See OSVPLAT-LICENSE.
Field mappings: OSVplat docs/avata360-telemetry.md and telemetry-parser's
dvtm_library.proto. Unknown schemas are rejected rather than guessed.
"""
from __future__ import annotations

import io
import math
import re
import struct
from pathlib import Path

MAX_METADATA = 256 * 1024 * 1024
# Camera-family schemas place the same GpsBasic message at different paths.
# Osmo mapping: telemetry-parser/src/dji/dvtm_oq101.proto FrameMetaOfGimbal.
# Its GPS-remote variant has not yet been validated against a real recording.
LAYOUTS = {
    'dvtm_AVATA360.proto': {'gps': (4, 4), 'velocity': (4, 2), 'relative': (4, 5), 'defaultUnit': 1},
    'dvtm_oq101.proto': {'gps': (4, 2), 'velocity': None, 'relative': None, 'defaultUnit': 0},
}


def varint(buf: bytes, pos: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if pos >= len(buf):
            raise ValueError('Truncated protobuf varint')
        byte = buf[pos]
        pos += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            if value >= 1 << 64:
                break
            return value, pos
    raise ValueError('Invalid protobuf varint')


def fields(buf: bytes):
    pos = 0
    while pos < len(buf):
        key, pos = varint(buf, pos)
        number, wire = key >> 3, key & 7
        if not number:
            raise ValueError('Invalid protobuf field number')
        if wire == 0:
            value, pos = varint(buf, pos)
        else:
            if wire == 2:
                size, pos = varint(buf, pos)
            elif wire in (1, 5):
                size = 8 if wire == 1 else 4
            else:
                raise ValueError(f'Unsupported protobuf wire type {wire}')
            if pos + size > len(buf):
                raise ValueError('Truncated protobuf field')
            value = buf[pos:pos + size]
            pos += size
        yield number, wire, value


def get(buf: bytes | None, *path: int):
    current = buf
    for number in path:
        if not isinstance(current, bytes) or not current:
            return None
        current = next((v for n, _, v in fields(current) if n == number), None)
    return current


def number(value, fmt: str):
    if not isinstance(value, bytes) or len(value) != struct.calcsize(fmt):
        return None
    out = struct.unpack(fmt, value)[0]
    return out if math.isfinite(out) else None


def boxes(stream, start: int, end: int):
    pos = start
    while pos < end:
        if end - pos < 8:
            raise ValueError('Truncated MP4 box header')
        stream.seek(pos)
        header = stream.read(8)
        if len(header) != 8:
            raise ValueError('Truncated MP4 box header')
        size, kind = struct.unpack('>I4s', header)
        header_size = 8
        if size == 1:
            extended = stream.read(8)
            if len(extended) != 8:
                raise ValueError('Truncated extended MP4 box')
            size = struct.unpack('>Q', extended)[0]
            header_size = 16
        elif size == 0:
            size = end - pos
        if size < header_size or pos + size > end:
            raise ValueError('Invalid MP4 box size')
        yield kind, pos + header_size, pos + size
        pos += size


def child(stream, region, kind):
    if region is None:
        return None
    return next(((s, e) for k, s, e in boxes(stream, *region) if k == kind), None)


def read_region(stream, region):
    if region is None:
        raise ValueError('Missing MP4 metadata box')
    start, end = region
    if end - start > MAX_METADATA:
        raise ValueError('DJI metadata exceeds 256 MiB limit')
    stream.seek(start)
    data = stream.read(end - start)
    if len(data) != end - start:
        raise ValueError('Truncated MP4 metadata')
    return data


def table(data, fmt, offset=8):
    width = struct.calcsize(fmt)
    if len(data) < offset:
        raise ValueError('Truncated MP4 sample table')
    count = struct.unpack_from('>I', data, offset - 4)[0]
    if len(data) != offset + width * count:
        raise ValueError('Invalid MP4 sample table length')
    return list(struct.iter_unpack(fmt, data[offset:]))


def track_samples(stream, track, file_size):
    mdia = child(stream, track, b'mdia')
    stbl = child(stream, child(stream, mdia, b'minf'), b'stbl')
    if stbl is None:
        return None, []
    desc = read_region(stream, child(stream, stbl, b'stsd'))
    if len(desc) < 16:
        raise ValueError('Invalid MP4 sample description')
    kind = desc[12:16]
    if kind not in (b'camd', b'djmd'):
        return kind, []
    sizes_raw = read_region(stream, child(stream, stbl, b'stsz'))
    if len(sizes_raw) < 12:
        raise ValueError('Truncated MP4 sample sizes')
    size, count = struct.unpack_from('>II', sizes_raw, 4)
    if count > MAX_METADATA // 4:
        raise ValueError('Too many metadata samples')
    if size:
        sizes = [size] * count
    else:
        if len(sizes_raw) != 12 + count * 4:
            raise ValueError('Invalid MP4 sample sizes')
        sizes = [v[0] for v in struct.iter_unpack('>I', sizes_raw[12:])]
    offsets = child(stream, stbl, b'stco')
    fmt = '>I'
    if offsets is None:
        offsets, fmt = child(stream, stbl, b'co64'), '>Q'
    chunks = table(read_region(stream, offsets), fmt)
    runs = table(read_region(stream, child(stream, stbl, b'stsc')), '>III')
    if not runs or runs[0][0] != 1 or any(b[0] <= a[0] for a, b in zip(runs, runs[1:])):
        raise ValueError('Invalid MP4 chunk map')
    samples, index, run = [], 0, 0
    for chunk, (offset,) in enumerate(chunks, 1):
        while run + 1 < len(runs) and runs[run + 1][0] <= chunk:
            run += 1
        per_chunk = runs[run][1]
        if per_chunk == 0 or index + per_chunk > count:
            raise ValueError('Invalid metadata samples per chunk')
        for _ in range(per_chunk):
            size = sizes[index]
            if offset + size > file_size:
                raise ValueError('Metadata sample outside file')
            samples.append((offset, offset + size))
            offset += size
            index += 1
    if index != count or sum(e - s for s, e in samples) > MAX_METADATA:
        raise ValueError('Incomplete or oversized metadata sample table')
    return kind, samples


def nested_payload(data):
    stream = io.BytesIO(data)
    payloads = [read_region(stream, (s, e)) for k, s, e in boxes(stream, 0, len(data)) if k == b'mdat']
    if not payloads:
        raise ValueError('No mdat in DJI camd metadata')
    return b''.join(payloads)


def payload(path: Path) -> bytes:
    size = path.stat().st_size
    with path.open('rb') as stream:
        top = list(boxes(stream, 0, size))
        for kind, start, end in top:
            if kind == b'camd':
                return nested_payload(read_region(stream, (start, end)))
        moov = next(((s, e) for k, s, e in top if k == b'moov'), None)
        tracks = []
        if moov:
            for kind, start, end in boxes(stream, *moov):
                if kind == b'trak':
                    tracks.append(track_samples(stream, (start, end), size))
        for kind, samples in tracks:
            if kind == b'camd' and samples:
                return nested_payload(b''.join(read_region(stream, r) for r in samples))
        # LRF / MP4 can have djmd tracks without the redundant camd copy.
        samples = [r for kind, regions in tracks if kind == b'djmd' for r in regions]
        if samples:
            if sum(e - s for s, e in samples) > MAX_METADATA:
                raise ValueError('Combined DJI metadata exceeds 256 MiB limit')
            return b''.join(read_region(stream, r) for r in samples)
    raise ValueError('No DJI camd or djmd metadata found; supply a GPS SRT sidecar instead')


def embedded_rows(path: Path):
    raw = payload(path)
    schema = model = None
    records = []
    for field, wire, body in fields(raw):
        if wire != 2:
            raise ValueError('Invalid DJI telemetry framing')
        if field == 1:
            name = get(body, 1, 1)
            if name:
                found = name.decode('utf-8')
                if schema and found != schema:
                    raise ValueError('Conflicting DJI telemetry schemas')
                schema = found
            identity = get(body, 1, 10)
            if identity:
                model = identity.decode('utf-8')
        elif field == 3:
            records.append(body)
    if schema not in LAYOUTS:
        raise ValueError(f'Unsupported DJI telemetry schema: {schema!r}')
    layout = LAYOUTS[schema]
    if not records:
        raise ValueError('No DJI frame records found')
    rows = []
    for body in records:
        ts = get(body, 1, 2)
        if not isinstance(ts, int):
            continue
        gps = get(body, *layout['gps'])
        lat = number(get(gps, 1, 2), '<d')
        lon = number(get(gps, 1, 3), '<d')
        # Avata's observed unset unit is degrees; other schemas follow the
        # proto3 PositionCoord default (radians). Respect any explicit enum.
        unit = get(gps, 1, 1)
        if unit is None:
            unit = layout['defaultUnit']
        if unit == 0:
            lat = math.degrees(lat) if lat is not None else None
            lon = math.degrees(lon) if lon is not None else None
        valid = get(gps, 3) in (None, 0, 2) and unit in (0, 1)
        valid = valid and lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180
        alt = get(gps, 2)
        if isinstance(alt, int):
            # protobuf int32 encodes negative values as sign-extended varints.
            alt &= 0xffffffff
            if alt & 0x80000000:
                alt -= 1 << 32
            alt /= 1000
        else:
            alt = None
        velocity = [number(get(body, *layout['velocity'], axis), '<f') for axis in (1, 2)] if layout['velocity'] else [None, None]
        speed = math.hypot(*velocity) if all(v is not None for v in velocity) else None
        rel = number(get(body, *layout['relative'], 1), '<f') if layout['relative'] else None
        rel = rel / 1000 if rel is not None and get(body, *layout['relative'], 2) == 1 else None
        rows.append({'clockUs': ts, 'frame': get(body, 1, 1), 'lat': lat if valid else None, 'lon': lon if valid else None,
                     'altitude': alt if valid else None, 'speed': speed, 'relativeAltitude': rel})
    if not rows:
        raise ValueError('No timestamped DJI records found')
    frame_clocks = {}
    for row in rows:
        # Protobuf can omit sequence zero on the first frame. Group absent IDs
        # too, but only align when the entire group's clock span is <= 1 ms.
        frame_clocks.setdefault(row['frame'], []).append(row['clockUs'])
    # Two Avata lenses can differ by a few microseconds while representing the
    # same video frame. Align only matching frame IDs within 1 ms, not distinct
    # frames or reused IDs far apart on the camera clock.
    aligned = 0
    for row in rows:
        clocks = frame_clocks.get(row.pop('frame'), [])
        if clocks and max(clocks) - min(clocks) <= 1000:
            aligned += row['clockUs'] != min(clocks)
            row['clockUs'] = min(clocks)
    first = min(r['clockUs'] for r in rows)
    for row in rows:
        row['t'] = (row.pop('clockUs') - first) / 1e6
    return rows, {'schema': schema, 'model': model, 'firstFrameClockUs': first, 'lensRecordsAligned': aligned,
                  'gpsMappingValidation': 'real Avata clip' if schema == 'dvtm_AVATA360.proto' else 'schema + synthetic fixtures; GPS-remote recording pending',
                  'timing': 'first frame boot clock subtracted; anchor to playback explicitly'}


SRT_TIME = re.compile(r'(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->')
SRT_VALUE = re.compile(r'\b(latitude|longitude|abs_alt|rel_alt)\s*:\s*([^\s\]\[<]+)', re.I)


def srt_rows(path: Path):
    rows = []
    for block in re.split(r'\n\s*\n', path.read_text(encoding='utf-8-sig').replace('\r\n', '\n')):
        time = SRT_TIME.search(block)
        if not time:
            continue
        h, m, s, ms = map(int, time.groups())
        values = {}
        for key, text in SRT_VALUE.findall(block):
            try:
                value = float(text)
                values[key.lower()] = value if math.isfinite(value) else None
            except ValueError:
                values[key.lower()] = None
        lat, lon = values.get('latitude'), values.get('longitude')
        valid = lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180
        rows.append({'t': h * 3600 + m * 60 + s + ms / 1000,
                     'lat': lat if valid else None, 'lon': lon if valid else None,
                     'altitude': values.get('abs_alt') if valid else None,
                     'relativeAltitude': values.get('rel_alt'), 'speed': None})
    if not rows:
        raise ValueError('No DJI SRT timestamps found')
    return rows, {'schema': 'DJI GPS SRT (latitude/longitude/abs_alt/rel_alt)',
                  'model': None, 'timing': 'subtitle playback timestamps; printed wall clock ignored'}
