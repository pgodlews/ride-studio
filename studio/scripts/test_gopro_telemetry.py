"""Generated, public-coordinate GPMF fixtures; no private GPS is committed."""
import json
import math
import struct
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from camera_telemetry import camera_ride, detect_family, inspect_camera, write_sample_evidence
from dji_telemetry import boxes
from gopro_telemetry import decode_packet, entries, read_gopro


def box(key, body):
    return struct.pack('>I4s', 8 + len(body), key) + body


def klv(key, typ, size, count, body):
    return struct.pack('>4sBBH', key.encode(), ord(typ), size, count) + body + b'\0' * (-len(body) % 4)


def numeric(key, typ, values, width=None):
    fmts = {'l': 'i', 'L': 'I', 's': 'h', 'S': 'H', 'J': 'Q', 'f': 'f'}
    item = struct.calcsize(fmts[typ])
    width = width or len(values)
    body = struct.pack('>' + fmts[typ] * len(values), *values)
    return klv(key, typ, item * width, len(values) // width, body)


def packet(*, schema='GPS5', fix=3, dop=100, speed=1000, lon=0, alt=10000, count=2):
    stream = klv('STNM', 'c', 3, 1, b'GPS')
    if schema == 'GPS5':
        stream += numeric('GPSF', 'L', [fix]) + numeric('GPSP', 'S', [dop])
        stream += klv('GPSU', 'U', 16, 1, b'261004120000.125')
        stream += numeric('SCAL', 'l', [10**7, 10**7, 1000, 1000, 100])
        stream += klv('GPSA', 'F', 4, 1, b'MSLV')
        stream += numeric('GPS5', 'l', [0, lon, alt, speed, 200] * count, 5)
    else:
        days = (datetime(2026, 10, 4) - datetime(2000, 1, 1)).days
        stream += klv('TYPE', 'c', 9, 1, b'lllllllSS')
        stream += numeric('SCAL', 'l', [10**7, 10**7, 1000, 1000, 100, 1, 1000, 100, 1])
        body = b''.join(struct.pack('>7i2H', 0, lon, alt, speed, 200, days, 43200125 + i * 500, dop, fix) for i in range(count))
        stream += klv('GPS9', '?', 32, count, body)
    stream += klv('ZZZZ', 'c', 4, 1, b'keep')
    device = klv('DVNM', 'c', 11, 1, b'Test Camera') + klv('STRM', '\0', 1, len(stream), stream)
    return klv('DEVC', '\0', 1, len(device), device)


def append_gpmf(source, payloads):
    """Append a valid metadata track to a tiny generated MP4 (moov at EOF).

    Video/audio chunk offsets stay unchanged. ffprobe reads the actual generated
    track, so packet timing/offset traversal is exercised independently of mocks.
    """
    raw = source.read_bytes()
    with source.open('rb') as f:
        top = list(boxes(f, 0, len(raw)))
    moov = next((s, e) for k, s, e in top if k == b'moov')
    assert moov[1] == len(raw), 'fixture must have moov at EOF'
    prefix = raw[:moov[0] - 8]
    offset = len(prefix) + 8
    mdhd = b'\0' * 4 + struct.pack('>IIIIHH', 0, 0, 1000, 1000 * len(payloads), 0, 0)
    hdlr = b'\0' * 8 + b'meta' + b'\0' * 12 + b'GoPro MET\0'
    stsd = b'\0' * 4 + struct.pack('>I', 1) + box(b'gpmd', b'\0' * 6 + b'\0\x01')
    stsz = b'\0' * 4 + struct.pack('>II', 0, len(payloads)) + b''.join(struct.pack('>I', len(p)) for p in payloads)
    stsc = b'\0' * 4 + struct.pack('>IIII', 1, 1, len(payloads), 1)
    stco = b'\0' * 4 + struct.pack('>II', 1, offset)
    stts = b'\0' * 4 + struct.pack('>III', 1, len(payloads), 1000)
    stbl = box(b'stbl', box(b'stsd', stsd) + box(b'stsz', stsz) + box(b'stsc', stsc) + box(b'stco', stco) + box(b'stts', stts))
    tkhd = b'\0\0\0\x03' + struct.pack('>IIIII', 0, 0, 3, 0, 1000 * len(payloads)) + b'\0' * 60
    track = box(b'trak', box(b'tkhd', tkhd) + box(b'mdia', box(b'mdhd', mdhd) + box(b'hdlr', hdlr) + box(b'minf', stbl)))
    source.write_bytes(prefix + box(b'mdat', b''.join(payloads)) + box(b'moov', raw[moov[0]:moov[1]] + track))


class GoPro(unittest.TestCase):
    def test_gps5_scale_zero_horizontal_speed_and_unknown_keys(self):
        rows, keys, models = decode_packet(packet(speed=0, alt=-2000), 2.5, 1)
        self.assertEqual([r['t'] for r in rows], [2.5, 3])
        self.assertEqual(rows[0]['lat'], 0)
        self.assertEqual(rows[0]['altitude'], -2)
        self.assertEqual(rows[0]['speed'], 0)
        self.assertEqual(rows[0]['rawSpeed3dMps'], 2)
        self.assertEqual(rows[0]['altitudeSystem'], 'MSLV')
        self.assertIn('ZZZZ', keys)
        self.assertEqual(models, {'Test Camera'})

    def test_gps9_per_sample_utc_dop_fix_and_mixed_types(self):
        rows, _, _ = decode_packet(packet(schema='GPS9', lon=10**7, speed=5000), 0, 1)
        self.assertEqual(rows[0]['lon'], 1)
        self.assertEqual(rows[0]['speed'], 5)
        self.assertEqual(rows[0]['dop'], 1)
        self.assertEqual(rows[0]['gpsUtc'], '2026-10-04T12:00:00.125000Z')
        self.assertEqual(rows[1]['gpsUtc'], '2026-10-04T12:00:00.625000Z')

    def test_no_fix_dop_two_dimensional_and_speed_filter(self):
        for schema in ('GPS5', 'GPS9'):
            row = decode_packet(packet(schema=schema, fix=0), 0, 1)[0][0]
            self.assertIsNone(row['lat'])
            self.assertIsNone(row['speed'])
            self.assertEqual(row['rawPosition'][0], 0)
            row = decode_packet(packet(schema=schema, dop=501), 0, 1)[0][0]
            self.assertIsNone(row['lat'])
            row = decode_packet(packet(schema=schema, fix=2), 0, 1)[0][0]
            self.assertEqual(row['lat'], 0)
            self.assertIsNone(row['altitude'])
            row = decode_packet(packet(schema=schema, speed=40000), 0, 1)[0][0]
            self.assertIsNone(row['speed'])
            self.assertEqual(row['rawSpeedMps'], 40)
            self.assertTrue(row['speedRejected'])

    def test_nonfinite_values_serialize_as_null(self):
        stream = numeric('GPSF', 'L', [3]) + numeric('SCAL', 'l', [1, 1, 1, 1, 1])
        stream += numeric('GPS5', 'f', [math.nan, 0, math.inf, math.nan, math.nan], 5)
        nested = klv('STRM', '\0', 1, len(stream), stream)
        raw = klv('DEVC', '\0', 1, len(nested), nested)
        rows, _, _ = decode_packet(raw, 0, 1)
        self.assertIsNone(rows[0]['lat'])
        self.assertIsNone(rows[0]['rawPosition'][2])
        self.assertIsNone(rows[0]['rawSpeedMps'])
        json.dumps(rows, allow_nan=False)

    def test_scal_type_and_truncation_fail(self):
        raw = packet()
        for bad in (raw[:-1], b'GPS5', raw.replace(b'SCAL', b'NONE'), raw.replace(b'GPS5l\x14', b'GPS5l\x13')):
            with self.assertRaises(ValueError):
                decode_packet(bad, 0, 1)
        bad = packet(schema='GPS9').replace(b'lllllllSS', b'lllllllXX')
        with self.assertRaisesRegex(ValueError, 'TYPE'):
            decode_packet(bad, 0, 1)

    def test_route_breaks_never_bridge_no_lock_or_packet_gap(self):
        rows = [decode_packet(packet(lon=n, fix=fix), t, 1)[0][0] for t, n, fix in [(0, 0, 3), (1, 100, 0), (2, 10000, 3), (20, 20000, 3)]]
        info = {'kind': 'gopro', 'usableGpsSamples': 3}
        out = camera_ride(rows, info, {'recordedUtc': '2026-10-04T12:00:00Z', 'duration': 21, 'warnings': []}, 'test', 'fixture', 'Europe/London')
        self.assertEqual(out['channels']['distance'], [0, None, 0, 0, None])
        self.assertEqual(out['tzOffsetSec'], 3600)
        self.assertEqual(out['breaks'], [1, 2, 3, 4])
        self.assertNotIn('heartRate', out['channels'])
        self.assertNotIn('cadence', out['channels'])
        json.dumps(out, allow_nan=False)

    def test_timezone_transition_and_missing_clock_rejected(self):
        with self.assertRaisesRegex(ValueError, 'recording UTC'):
            camera_ride([], {'usableGpsSamples': 0}, {'recordedUtc': None}, 'test', 'source')
        with self.assertRaisesRegex(ValueError, 'transition'):
            camera_ride([], {'kind': 'gopro', 'usableGpsSamples': 0}, {'recordedUtc': '2026-10-25T00:59:59Z', 'duration': 2, 'warnings': []}, 'test', 'source', 'Europe/London')
        out = camera_ride([], {'kind': 'exif', 'usableGpsSamples': 0, 'recordedTimezoneOffsetSec': 7200},
                          {'recordedUtc': '2026-10-04T12:00:00Z', 'duration': 2, 'warnings': []}, 'test', 'source')
        self.assertEqual(out['tzOffsetSec'], 7200, 'preserve recorded offset instead of using the host timezone')

    def test_detection_uses_content_not_hero_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'Hero13.MP4'
            path.write_bytes(box(b'ftyp', b'isom0000'))
            self.assertEqual(detect_family({'streams': []}, {}, path)[0], 'exif')
            self.assertEqual(detect_family({'streams': [{'codec_tag_string': 'gpmd'}]}, {}, path)[0], 'gopro')
            self.assertEqual(detect_family({'streams': [{'codec_tag_string': 'djmd'}]}, {}, path)[0], 'dji')
            path.write_bytes(box(b'ftyp', b'isom0000') + box(b'camd', b''))
            self.assertEqual(detect_family({'streams': []}, {}, path)[0], 'dji')

    def test_real_mp4_packet_offsets_and_gps9_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'fixture.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(p)], check=True)
            append_gpmf(p, [packet() + packet(schema='GPS9'), packet(schema='GPS9', fix=0)])
            before = p.read_bytes()
            rows, info = read_gopro(p)
            self.assertEqual(info['metadataPackets'], 2)
            self.assertEqual(info['schemas'], ['GPS9'])
            self.assertEqual(len(rows), 4)
            self.assertEqual([r['t'] for r in rows], [0, .5, 1, 1.5])
            self.assertIn('ZZZZ', info['unknownKeys'])
            self.assertEqual(p.read_bytes(), before)

    def test_incompatible_gps_utc_rate_requires_time_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'fixture.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(p)], check=True)
            # GPS UTC frozen across > 5 s of playback is a clock/time-map error.
            append_gpmf(p, [packet()] * 8)
            with self.assertRaisesRegex(ValueError, 'time map'):
                read_gopro(p)

    def test_exif_geotag_cannot_become_route_and_explicit_clock(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'generic.mp4'
            p.write_bytes(box(b'ftyp', b'isom0000'))
            with patch('camera_telemetry.container_probe', return_value={'streams': []}), patch('camera_telemetry.exif_tags', return_value={}), patch('camera_telemetry.read_metadata', return_value=([], {'locationMode': 'clip-geotag', 'clipLocation': {'lat': 0, 'lon': 0}})):
                rows, info, meta = inspect_camera(p, geometry={'duration': 1}, start_utc='2026-10-04T12:00:00Z', clock_correction_sec=2)
            out = camera_ride(rows, info, meta, 'test', 'generic')
            self.assertEqual(out['channels'], {})
            self.assertEqual(info['clipLocation']['lat'], 0)
            self.assertEqual(out['startUtc'], '2026-10-04T12:00:02.000000Z')

    def test_unsupported_dji_keeps_media_but_never_exif_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'generic.mp4'
            p.write_bytes(box(b'ftyp', b'isom0000'))
            with patch('camera_telemetry.container_probe', return_value={'streams': [{'codec_tag_string': 'djmd'}]}), patch('camera_telemetry.exif_tags', return_value={}), patch('camera_telemetry.embedded_rows', side_effect=ValueError('Unsupported schema')):
                with self.assertRaisesRegex(ValueError, 'Unsupported schema'):
                    inspect_camera(p, geometry={'duration': 1})
                rows, info, meta = inspect_camera(p, geometry={'duration': 1}, tolerate_errors=True)
                self.assertEqual(meta['detection']['gpsStatus'], 'unsupported')
                self.assertEqual(rows, [])
                self.assertIn('decodeError', info)


    def test_telemetry_outside_playback_only_fails_strict_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'trimmed.mp4'
            p.write_bytes(box(b'ftyp', b'isom0000'))
            outside = ([{'t': 5, 'lat': 0, 'lon': 0}, {'t': 6, 'lat': 0, 'lon': 100}], {'locationMode': 'timed'})
            with patch('camera_telemetry.container_probe', return_value={'streams': []}), patch('camera_telemetry.exif_tags', return_value={}), patch('camera_telemetry.read_metadata', return_value=outside):
                with self.assertRaisesRegex(ValueError, 'outside video playback'):
                    inspect_camera(p, geometry={'duration': 1})
                rows, info, meta = inspect_camera(p, geometry={'duration': 1}, tolerate_errors=True)
            self.assertEqual(rows, [], 'misplaced telemetry is discarded, never shifted or zero-filled')
            self.assertEqual(info['usableGpsSamples'], 0)
            self.assertEqual(meta['detection']['gpsStatus'], 'no-usable-fix')
            self.assertTrue(any('playback range' in w for w in meta['warnings']))

    def test_generic_exif_decode_errors_follow_the_tolerated_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'generic.mp4'
            p.write_bytes(box(b'ftyp', b'isom0000'))
            with patch('camera_telemetry.container_probe', return_value={'streams': []}), patch('camera_telemetry.exif_tags', return_value={}), patch('camera_telemetry.read_metadata', side_effect=ValueError('Conflicting GPS fixes at one playback time')):
                with self.assertRaisesRegex(ValueError, 'Conflicting GPS fixes'):
                    inspect_camera(p, geometry={'duration': 1})
                rows, info, meta = inspect_camera(p, geometry={'duration': 1}, tolerate_errors=True)
            self.assertEqual(rows, [])
            self.assertEqual(info['kind'], 'exif')
            self.assertEqual(info['decodeError'], 'Conflicting GPS fixes at one playback time')
            self.assertEqual(meta['detection']['gpsStatus'], 'unsupported')

    def test_sample_evidence_stays_out_of_the_ride_json(self):
        info = {'kind': 'gopro', 'usableGpsSamples': 1, 'metadataSha256': 'deadbeef',
                'sampleEvidence': [{'t': 0, 'fix': 3, 'rawPosition': [0, 0, 10], 'speedRejected': False}]}
        out = camera_ride([{'t': 0, 'lat': 0, 'lon': 0}], info,
                          {'recordedUtc': '2026-10-04T12:00:00Z', 'duration': 1, 'warnings': []}, 'test', 'fixture')
        self.assertNotIn('sampleEvidence', out['meta']['telemetry'])
        self.assertEqual(out['meta']['telemetry']['metadataSha256'], 'deadbeef')
        json.dumps(out, allow_nan=False)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'media/telemetry-evidence.json'
            self.assertEqual(write_sample_evidence(info, target), target)
            saved = json.loads(target.read_text())
            self.assertEqual(saved['sampleEvidence'], info['sampleEvidence'])
            self.assertEqual(saved['kind'], 'gopro')
            self.assertIsNone(write_sample_evidence({'kind': 'exif'}, Path(tmp) / 'none.json'))
            self.assertFalse((Path(tmp) / 'none.json').exists())


if __name__ == '__main__':
    unittest.main()
