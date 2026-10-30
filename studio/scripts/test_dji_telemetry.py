"""Decoder regression tests; all fixtures are generated, with no private GPS data."""
import io
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from dji_telemetry import boxes, embedded_rows, fields, srt_rows
from prepare_dji import ride_json, utc


def vi(n):
    n &= (1 << 64) - 1
    out = bytearray()
    while n >= 128:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def pb(n, value, wire=2):
    prefix = vi(n * 8 + wire)
    if wire == 0:
        return prefix + vi(value)
    if wire == 2:
        return prefix + vi(len(value)) + value
    return prefix + struct.pack('<d' if wire == 1 else '<f', value)


def box(kind, data, extended=False):
    return (struct.pack('>I4sQ', 1, kind, len(data) + 16) if extended else struct.pack('>I4s', len(data) + 8, kind)) + data


def header(schema='dvtm_AVATA360.proto'):
    return pb(1, pb(1, pb(1, schema.encode()) + pb(10, b'Test camera')))


def record(t=5000000, seq=0, lat=0.0, lon=0.0, status=None, unit=None, altitude=-2500, speed=True, osmo=False):
    coord = pb(2, lat, 1) + pb(3, lon, 1)
    if unit is not None:
        coord += pb(1, unit, 0)
    gps = pb(1, coord) + (pb(2, altitude, 0) if altitude is not None else b'')
    if status is not None:
        gps += pb(3, status, 0)
    velocity = pb(2, pb(1, 3.0, 5) + pb(2, 4.0, 5) + pb(3, 12.0, 5)) if speed else b''
    relative = pb(5, pb(1, 1250.0, 5) + pb(2, 1, 0))
    frame = pb(1, seq, 0) if seq else b''  # protobuf omits zero sequence
    device = pb(2, gps) if osmo else velocity + pb(4, gps) + relative
    return pb(3, pb(1, frame + pb(2, t, 0)) + pb(4, device))


def tracked(kind, samples, co64=False, fixed=False):
    """Build a minimal metadata track with two samples/chunk, then one/chunk."""
    data = b''.join(samples)
    prefix = box(b'ftyp', b'isom0000')
    start = len(prefix) + 8
    per_chunk = 2 if len(samples) >= 2 else 1
    offsets = [start]
    if len(samples) > per_chunk:
        offsets += [start + sum(map(len, samples[:per_chunk]))]
    desc = b'\0' * 4 + struct.pack('>I', 1) + box(kind, b'\0' * 8)
    sizes = b'\0' * 4 + struct.pack('>II', len(samples[0]) if fixed else 0, len(samples))
    if not fixed:
        sizes += b''.join(struct.pack('>I', len(s)) for s in samples)
    offs = b'\0' * 4 + struct.pack('>I', len(offsets)) + b''.join(struct.pack('>Q' if co64 else '>I', o) for o in offsets)
    runs = [(1, per_chunk, 1)] + ([(2, len(samples) - per_chunk, 1)] if len(offsets) > 1 else [])
    sc = b'\0' * 4 + struct.pack('>I', len(runs)) + b''.join(struct.pack('>III', *r) for r in runs)
    stbl = box(b'stbl', box(b'stsd', desc) + box(b'stsz', sizes) + box(b'co64' if co64 else b'stco', offs) + box(b'stsc', sc))
    return prefix + box(b'mdat', data) + box(b'moov', box(b'trak', box(b'mdia', box(b'minf', stbl))))


class DJI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'test.OSV'

    def trailing(self, data):
        nested = box(b'ftyp', b'isom0000') + box(b'mdat', data, extended=True)
        self.path.write_bytes(box(b'ftyp', b'isom0000') + box(b'camd', nested))
        return embedded_rows(self.path)

    def ride(self, rows, info=None, start='2026-10-04T12:00:00.125Z', tz='Europe/London'):
        return ride_json(rows, utc(start), 'test', info or {}, 'test.OSV', tz)

    def test_trailing_camd_gps_equator_signed_altitude_horizontal_speed(self):
        rows, info = self.trailing(header() + record())
        out = self.ride(rows, info)
        self.assertEqual(out['channels']['lat'], [0])
        self.assertEqual(out['channels']['lon'], [0])
        self.assertEqual(out['channels']['altitude'], [-2.5])
        self.assertEqual(out['channels']['relativeAltitude'], [1.25])
        self.assertEqual(out['channels']['speed'], [5])  # excludes Down velocity
        self.assertNotIn('heartRate', out['channels'])
        self.assertNotIn('cadence', out['channels'])
        self.assertEqual(out['startUtc'], '2026-10-04T12:00:00.125000Z')
        self.assertEqual(out['tzOffsetSec'], 3600)

    def test_camd_track_split_nested_mp4_co64_chunk_runs(self):
        nested = box(b'ftyp', b'isom0000') + box(b'mdat', header() + record())
        self.path.write_bytes(tracked(b'camd', [nested[:20], nested[20:40], nested[40:]], co64=True))
        rows, info = embedded_rows(self.path)
        self.assertEqual(self.ride(rows)['channels']['speed'], [5])
        self.assertEqual(info['schema'], 'dvtm_AVATA360.proto')

    def test_djmd_track_without_camd_fixed_samples(self):
        sample = header() + record()
        self.path.write_bytes(tracked(b'djmd', [sample, sample], fixed=True))
        rows, _ = embedded_rows(self.path)
        self.assertEqual(len(self.ride(rows)['t']), 1)

    def test_skewed_lenses_merge_but_distinct_frames_remain(self):
        rows, info = self.trailing(header() + record() + record(t=5000017) + record(t=5020000, seq=1))
        out = self.ride(rows, info)
        self.assertEqual(out['t'], [0, .02])
        self.assertEqual(info['lensRecordsAligned'], 1)

    def test_invalid_nonfinite_and_missing_remain_null(self):
        rows, info = self.trailing(header() + record() + record(t=6000000, seq=1, status=1, speed=False)
                                   + record(t=7000000, seq=2, lat=math.nan) + record(t=8000000, seq=3, altitude=None))
        out = self.ride(rows, info)
        self.assertEqual(out['channels']['lat'], [0, None, None, 0])
        self.assertEqual(out['channels']['altitude'], [-2.5, None, None, None])
        self.assertEqual(out['channels']['distance'], [0, None, None, 0])
        json.dumps(out, allow_nan=False)

    def test_gap_does_not_invent_distance(self):
        rows, _ = self.trailing(header() + record() + record(t=12000000, seq=1, lon=.001))
        out = self.ride(rows)
        self.assertEqual(out['channels']['distance'], [0, 0])
        self.assertTrue(any('partial' in w for w in out['meta']['warnings']))

    def test_explicit_radians_converted_unset_avata_degrees_preserved(self):
        rows, _ = self.trailing(header() + record(lat=math.pi/4, lon=-math.pi/2, unit=0))
        self.assertAlmostEqual(rows[0]['lat'], 45)
        self.assertAlmostEqual(rows[0]['lon'], -90)

    def test_unknown_schema_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported DJI telemetry schema'):
            self.trailing(header('unknown.proto') + record())

    def test_osmo_identity_does_not_make_gps(self):
        rows, _ = self.trailing(header('dvtm_oq101.proto') + record(osmo=True, status=1))
        with self.assertRaisesRegex(ValueError, 'No valid GPS'):
            self.ride(rows)

    def test_osmo_gps_remote_schema_accepts_valid_fix(self):
        rows, info = self.trailing(header('dvtm_oq101.proto') + record(osmo=True, lat=45, lon=-90, unit=1))
        out = self.ride(rows, info)
        self.assertEqual(out['channels']['lat'], [45])
        self.assertEqual(out['channels']['lon'], [-90])
        self.assertEqual(out['channels']['altitude'], [-2.5])
        self.assertNotIn('speed', out['channels'])  # Osmo velocity axes not verified
        self.assertNotIn('relativeAltitude', out['channels'])
        self.assertIn('pending', info['gpsMappingValidation'])

    def test_osmo_unset_unit_uses_schema_radians_default(self):
        rows, _ = self.trailing(header('dvtm_oq101.proto') + record(osmo=True, lat=math.pi / 4, lon=-math.pi / 2))
        self.assertAlmostEqual(rows[0]['lat'], 45)
        self.assertAlmostEqual(rows[0]['lon'], -90)

    def test_srt_preserves_playback_offset_and_missing_metrics(self):
        path = self.path.with_suffix('.SRT')
        path.write_text('1\n00:00:02,500 --> 00:00:02,533\n2026-10-04 13:00:02\n'
                        '[latitude: 0] [longitude: 0] [rel_alt: 12.5 abs_alt: -2.5]\n\n'
                        '2\n00:00:02,533 --> 00:00:02,566\n[latitude: nan] [longitude: 0]\n')
        rows, info = srt_rows(path)
        out = self.ride(rows, info)
        self.assertEqual(out['t'], [2.5, 2.533])
        self.assertEqual(out['channels']['lat'], [0, None])
        self.assertNotIn('speed', out['channels'])

    def test_utc_requires_zone_and_display_timezone_is_date_aware(self):
        with self.assertRaisesRegex(ValueError, 'timezone offset'):
            utc('2026-10-04T12:00:00')
        rows, _ = self.trailing(header() + record())
        self.assertEqual(self.ride(rows, start='2026-12-04T12:00:00Z')['tzOffsetSec'], 0)

    def test_truncated_inputs_fail_loudly(self):
        for raw in (b'\x80', b'\x1a\x04x', b'\x0dxx', b'\x00'):
            with self.assertRaises(ValueError):
                list(fields(raw))
        with self.assertRaises(ValueError):
            list(boxes(io.BytesIO(b'\0\0\0\x20mdat'), 0, 8))
        self.path.write_bytes(tracked(b'djmd', [header() + record()])[:-2])
        with self.assertRaises(ValueError):
            embedded_rows(self.path)


if __name__ == '__main__':
    unittest.main()
