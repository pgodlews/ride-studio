"""Phone/FIT regressions using generated metadata and activity samples."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from phone_fit import read_fit, synchronized_ride
from phone_telemetry import decode_metadata
from prepare_dji import utc
from prepare_phone import phone_ride, resolve_clock


def messages():
    return {'record_mesgs': [
        {'timestamp': '2026-08-22T16:31:20Z', 'heart_rate': 120, 'cadence': 80, 'enhanced_speed': 5, 'speed': 99, 'enhanced_altitude': 10},
        {'timestamp': '2026-08-22T16:31:23Z', 'heart_rate': 130, 'cadence': 0, 'enhanced_speed': 6, 'enhanced_altitude': 11},
        {'timestamp': '2026-08-22T16:31:24Z', 'heart_rate': None, 'cadence': None, 'enhanced_speed': None},
        {'timestamp': '2026-08-22T16:31:30Z', 'heart_rate': 140, 'cadence': 90, 'enhanced_speed': 7},
    ], 'activity_mesgs': [], 'session_mesgs': [{'total_timer_time': 2}],
        '999': [{'107': float('nan')}]}  # unknown fields are retained as numbered fields


def info():
    return {'kind': 'phone', 'locationMode': 'clip-geotag', 'clipLocation': {'lat': 0, 'lon': 0, 'horizontalAccuracyM': 51}}


class Phone(unittest.TestCase):
    def test_static_geotag_is_not_livephoto_track_or_sensor_data(self):
        data = {'Main:GPSCoordinates': '0 0 10', 'Main:LocationAccuracyHorizontal': 51,
                'Main:CreationDate': '2026:08:22 18:31:23+02:00'}
        for i in range(1, 101):
            data[f'Doc{i}:SampleTime'] = i / 60
            data[f'Doc{i}:LivePhotoInfo'] = 'unknown metadata'
        rows, meta = decode_metadata(data, 17)
        self.assertEqual(rows, [])
        self.assertEqual(meta['timedGpsSamples'], 0)
        self.assertEqual(meta['locationMode'], 'clip-geotag')
        start, recorded, _ = resolve_clock(meta)
        ride = phone_ride(rows, start, 17, 'test', meta, 'clip.mov', recorded=recorded)
        self.assertEqual(ride['startUtc'], '2026-08-22T16:31:23.000000Z')
        self.assertEqual(ride['tzOffsetSec'], 7200)
        self.assertEqual(ride['t'], [0, 17])
        self.assertEqual(ride['channels'], {})

    def test_timed_gps_density_invalid_fix_gaps_and_endpoint_order(self):
        data = {'Doc1:SampleTime': 1, 'Doc1:GPSCoordinates': '0 0 -10',
                'Doc2:SampleTime': 2, 'Doc2:GPSCoordinates': 'nan 0',
                'Doc3:SampleTime': 3, 'Doc3:GPSCoordinates': '0 0.0001 -9',
                'Doc4:SampleTime': 10, 'Doc4:GPSCoordinates': '0 0.0002 -8'}
        rows, meta = decode_metadata(data, 12)
        self.assertEqual(meta['timedGpsSamples'], 3)
        self.assertEqual(meta['medianGpsIntervalSec'], 4.5)
        ride = phone_ride(rows, utc('2026-08-22T12:00:00Z'), 12, 'test', meta, 'clip.mp4')
        self.assertEqual(ride['t'], [0, 1, 2, 3, 10, 12])
        self.assertEqual(ride['channels']['distance'], [None, 0, None, 0, 0, None])
        self.assertNotIn('speed', ride['channels'])
        self.assertEqual(ride['channels']['altitude'][1], -10)
        json.dumps(ride, allow_nan=False)

    def test_conflicting_timed_tracks_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            decode_metadata({'Doc1:SampleTime': 0, 'Doc1:GPSCoordinates': '0 0',
                             'Doc2:SampleTime': 0, 'Doc2:GPSCoordinates': '1 0'}, 1)

    def test_fit_clock_join_preserves_zero_missing_and_absolute_time(self):
        ride = synchronized_ride(messages(), utc('2026-08-22T18:31:23+02:00'), 3, 'test', info(), {'source': 'fixture.json'})
        self.assertEqual(ride['meta']['telemetry']['synchronization']['clipStartRideSec'], 3)
        self.assertEqual(ride['t'], [0, 3, 4, 10]) # pauses are not compressed to timer time
        self.assertEqual(ride['channels']['cadence'], [80, 0, None, 90])
        self.assertEqual(ride['channels']['speed'], [5, 6, None, 7])
        self.assertNotIn('lat', ride['channels']) # geotag does not backfill FIT GPS
        self.assertFalse(ride['meta']['telemetry']['synchronization']['visualVerificationRequired'])
        json.dumps(ride, allow_nan=False)

    def test_nonoverlap_rejected_partial_fit_explained(self):
        with self.assertRaisesRegex(ValueError, 'does not overlap'):
            synchronized_ride(messages(), utc('2026-08-23T12:00:00Z'), 1, 'test', info(), {'source': 'fixture.json'})
        ride = synchronized_ride(messages(), utc('2026-08-22T16:31:18Z'), 4, 'test', info(), {'source': 'fixture.json'})
        self.assertTrue(any('part of' in w for w in ride['meta']['warnings']))

    def test_timezone_required_or_explicit_container_utc(self):
        with self.assertRaises(ValueError):
            resolve_clock({'clockCreationDate': '2026:08:22 18:31:23'})
        start, recorded, _ = resolve_clock({}, None, '2026-08-22T16:31:23Z')
        self.assertIsNone(recorded)
        self.assertEqual(start, utc('2026-08-22T16:31:23Z'))
        summer = phone_ride([], start, 1, 'test', info(), 'clip.mov', 'Europe/London')
        winter = phone_ride([], utc('2026-12-22T16:31:23Z'), 1, 'test', info(), 'clip.mov', 'Europe/London')
        self.assertEqual(summer['tzOffsetSec'], 3600)
        self.assertEqual(winter['tzOffsetSec'], 0)

    def test_decoded_evidence_preserves_unknowns_and_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'decoded.json'
            path.write_text(json.dumps(messages()))
            raw = path.read_bytes()
            decoded, evidence = read_fit(path)
            self.assertEqual(decoded['999'], [{'107': None}])
            self.assertEqual(evidence['bytes'], len(raw))
            self.assertEqual(len(evidence['sha256']), 64)
            self.assertEqual(path.read_bytes(), raw)

    def test_raw_fit_integrity_and_fresh_stream(self):
        try:
            from garmin_fit_sdk import Encoder
        except ImportError:
            self.skipTest('garmin-fit-sdk not installed')
        encoder = Encoder()
        encoder.write_mesg({'mesg_num': 0, 'type': 'activity', 'manufacturer': 'garmin', 'product': 0})
        encoder.write_mesg({'mesg_num': 20, 'timestamp': datetime(2026, 8, 22, 16, 31, 23, tzinfo=timezone.utc),
                            'heart_rate': 130, 'cadence': 0, 'enhanced_speed': 6})
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'generated.fit'
            path.write_bytes(encoder.close())
            raw = path.read_bytes()
            decoded, evidence = read_fit(path)
            self.assertEqual(evidence['integrity'], 'passed')
            self.assertEqual(decoded['record_mesgs'][0]['cadence'], 0)
            self.assertEqual(decoded['record_mesgs'][0]['timestamp'], '2026-08-22T16:31:23Z')
            self.assertEqual(path.read_bytes(), raw)
            path.write_bytes(raw[:-1])
            with self.assertRaisesRegex(ValueError, 'integrity'):
                read_fit(path)


if __name__ == '__main__':
    unittest.main()
