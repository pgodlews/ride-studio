"""Sport semantics, GPS filtering and read-only activity import regressions."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fit_activity import clean, read_fit
from prepare_activity import main
from prepare_ride import build_ride


def messages(sport='running', sub_sport='generic'):
    return {'session_mesgs': [{'sport': sport, 'sub_sport': sub_sport}], 'record_mesgs': [
        {'timestamp': '2026-10-04T09:23:07Z', 'position_lat': 0, 'position_long': 0,
         'enhanced_speed': 0, 'speed': 9, 'cadence': 0, 'fractional_cadence': 0, 'heart_rate': 85},
        {'timestamp': '2026-10-04T09:23:08Z', 'position_lat': 1000, 'position_long': 1000,
         'enhanced_speed': 2, 'cadence': 80, 'fractional_cadence': .5, 'heart_rate': 86},
        {'timestamp': '2026-10-04T09:23:16Z', 'position_lat': None, 'position_long': 1001,
         'enhanced_speed': None, 'cadence': None, 'fractional_cadence': .5, 'heart_rate': None},
    ], '999': [{'107': float('inf')} ]}


class Activity(unittest.TestCase):
    def test_running_pace_steps_zero_missing_and_fraction(self):
        ride = build_ride(messages(), 'run', 'generated')
        self.assertEqual(ride['channels']['pace'], [None, .5, None])
        self.assertEqual(ride['channels']['stepCadence'], [0, 161, None])
        self.assertEqual(ride['channels']['strideCadence'], [0, 80.5, None])
        self.assertNotIn('cadence', ride['channels'])
        self.assertEqual(ride['t'], [0, 1, 9])
        self.assertTrue(ride['meta']['activity']['routeImportEligible'])
        self.assertEqual(ride['meta']['activity']['primaryMetric'], 'pace')
        self.assertEqual(clean(messages())['999'], [{'107': None}])
        json.dumps(ride, allow_nan=False)

    def test_walk_and_cycling_have_distinct_cadence_semantics(self):
        walk = build_ride(messages('walking'), 'walk', 'fixture')
        self.assertEqual(walk['channels']['stepCadence'][1], 161)
        cycling = build_ride(messages('cycling'), 'bike', 'fixture')
        self.assertEqual(cycling['channels']['cadence'], [0, 80.5, None])
        self.assertNotIn('stepCadence', cycling['channels'])
        self.assertNotIn('pace', cycling['channels'])
        hiking = build_ride(messages('hiking'), 'hike', 'fixture')
        self.assertTrue(hiking['meta']['activity']['routeImportEligible'])
        self.assertEqual(hiking['meta']['activity']['primaryMetric'], 'pace')
        self.assertNotIn('cadence', hiking['channels'])

    def test_route_filter_uses_paired_valid_record_gps_not_summary(self):
        msgs = messages()
        msgs['record_mesgs'][1]['position_lat'] = 0x7fffffff
        msgs['session_mesgs'][0]['start_position_lat'] = 1000
        ride = build_ride(msgs, 'invalid', 'fixture')
        self.assertEqual(ride['channels']['lat'], [0, None, None])
        self.assertEqual(ride['channels']['lon'], [0, None, None])
        self.assertEqual(ride['meta']['activity']['gpsSamples'], 1)
        self.assertFalse(ride['meta']['activity']['routeImportEligible'])
        msgs['record_mesgs'][0]['position_long'] = float('nan')
        ride = build_ride(msgs, 'invalid', 'fixture')
        self.assertNotIn('lat', ride['channels'])
        self.assertNotIn('lon', ride['channels'])

    def test_indoor_retains_sensors_but_is_excluded_even_with_gps(self):
        indoor = build_ride(messages('walking', 'indoor_walking'), 'indoor', 'fixture')
        self.assertTrue(indoor['meta']['activity']['indoor'])
        self.assertFalse(indoor['meta']['activity']['routeImportEligible'])
        self.assertEqual(indoor['meta']['activity']['exclusionReason'], 'indoor activity')
        self.assertIn('heartRate', indoor['channels'])

    def test_multisport_rejected_instead_of_scaling_wrong_session(self):
        msgs = messages()
        msgs['session_mesgs'].append({'sport': 'cycling'})
        with self.assertRaisesRegex(ValueError, 'Multiple FIT sessions'):
            build_ride(msgs, 'multi', 'fixture')

    def test_invalid_fraction_and_negative_speed_are_missing(self):
        msgs = messages()
        msgs['record_mesgs'][1].update(enhanced_speed=-1, fractional_cadence=float('nan'))
        ride = build_ride(msgs, 'invalid', 'fixture')
        self.assertEqual(ride['channels']['stepCadence'], [0, None, None])
        self.assertEqual(ride['channels']['speed'], [0, None, None])
        self.assertNotIn('pace', ride['channels'])

    def test_cli_import_inspect_exclusion_and_preservation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'fixture.json'
            source.write_text(json.dumps(clean(messages())))
            original = source.read_bytes()
            out = root / 'rides'
            args = ['prepare_activity.py', str(source), '--out-dir', str(out), '--id', 'test-run']
            with patch('sys.argv', args), patch('prepare_activity.STUDIO', root), contextlib.redirect_stdout(io.StringIO()):
                main()
            self.assertEqual(source.read_bytes(), original)
            target = out / 'test-run.json'
            before = target.read_bytes()
            with patch('sys.argv', args), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                main()
            self.assertEqual(target.read_bytes(), before)
            source.write_text(json.dumps(clean(messages('walking', 'indoor_walking'))))
            with patch('sys.argv', args[:-1] + ['indoor']), contextlib.redirect_stdout(io.StringIO()):
                main()
            self.assertFalse((out / 'indoor.json').exists())
            with patch('sys.argv', args[:-1] + ['inspect-only', '--inspect']), contextlib.redirect_stdout(io.StringIO()):
                main()
            self.assertFalse((out / 'inspect-only.json').exists())

    def test_legacy_14_byte_header_with_zero_header_crc_integrity(self):
        from garmin_fit_sdk.crc_calculator import CrcCalculator
        def_msg = bytes([0x40, 0x00, 0x00, 20, 0, 1, 253, 4, 0x86])
        data_msg = bytes([0x00]) + (1000000000).to_bytes(4, 'little')
        payload = def_msg + data_msg
        hdr = bytearray([14, 0x10, 100, 0] + list(len(payload).to_bytes(4, 'little')) + list(b'.FIT') + [0, 0])
        file_bytes = hdr + payload
        file_crc = CrcCalculator.calculate_crc(file_bytes, 0, len(file_bytes))
        file_bytes += file_crc.to_bytes(2, 'little')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'test.fit'
            path.write_bytes(bytes(file_bytes))
            msgs, ev = read_fit(path)
            self.assertEqual(len(msgs['record_mesgs']), 1)
            self.assertEqual(ev['integrity'], 'passed')
            # Corrupted payload must fail integrity
            corrupted = bytearray(file_bytes)
            corrupted[16] ^= 0xff
            path.write_bytes(bytes(corrupted))
            with self.assertRaisesRegex(ValueError, 'FIT integrity check failed'):
                read_fit(path)

    def test_cadence256_fallback_for_walking_and_hybrid_watches(self):
        msgs = {
            'session_mesgs': [{'sport': 'walking', 'sub_sport': 'generic'}],
            'record_mesgs': [
                {'timestamp': '2026-10-04T09:23:07Z', 'position_lat': 1000, 'position_long': 1000, 'cadence256': 60.5},
                {'timestamp': '2026-10-04T09:23:08Z', 'position_lat': 1001, 'position_long': 1001, 'cadence256': 0.0},
            ]
        }
        walk = build_ride(msgs, 'walk256', 'fixture')
        self.assertEqual(walk['channels']['strideCadence'], [60.5, 0])
        self.assertEqual(walk['channels']['stepCadence'], [121, 0])
        self.assertNotIn('cadence', walk['channels'])

        msgs['session_mesgs'][0]['sport'] = 'cycling'
        bike = build_ride(msgs, 'bike256', 'fixture')
        self.assertEqual(bike['channels']['cadence'], [60.5, 0])
        self.assertNotIn('stepCadence', bike['channels'])

    def test_developer_field_power_and_cadence(self):
        # Garmin SDK output: developer_fields keyed by field_description key
        msgs = {
            'session_mesgs': [{'sport': 'cycling', 'sub_sport': 'generic'}],
            'field_description_mesgs': [
                {'field_name': 'Power', 'native_mesg_num': 20, 'native_field_num': 7, 'key': 0},
                {'field_name': 'Cadence', 'native_mesg_num': 20, 'native_field_num': 4, 'key': 1},
            ],
            'record_mesgs': [
                {'timestamp': '2026-10-04T09:23:07Z', 'position_lat': 1000, 'position_long': 1000,
                 'developer_fields': {0: 250, 1: 90}},
                {'timestamp': '2026-10-04T09:23:08Z', 'position_lat': 1001, 'position_long': 1001,
                 'developer_fields': {0: 275, 1: 92}},
            ]
        }
        ride = build_ride(msgs, 'dev_fields', 'fixture')
        self.assertEqual(ride['channels']['power'], [250, 275])
        self.assertEqual(ride['channels']['cadence'], [90, 92])
        self.assertIn('developer field Power', ride['meta']['channelSources']['power'])
        self.assertIn('developer field Cadence', ride['meta']['channelSources']['cadence'])
        self.assertNotIn('power', msgs['record_mesgs'][0], 'decoded records are not modified')

        # Native power/cadence takes precedence over developer fields
        msgs['record_mesgs'][0]['power'] = 199
        msgs['record_mesgs'][0]['cadence'] = 75
        ride_pref = build_ride(msgs, 'dev_pref', 'fixture')
        self.assertEqual(ride_pref['channels']['power'], [199, 275])
        self.assertEqual(ride_pref['channels']['cadence'], [75, 92])

    def test_summary_speed_fallback_when_enhanced_omitted(self):
        msgs = {
            'session_mesgs': [{
                'sport': 'cycling', 'sub_sport': 'generic',
                'avg_speed': 8.5, 'max_speed': 12.0
            }],
            'record_mesgs': [
                {'timestamp': '2026-10-04T09:23:07Z', 'position_lat': 1000, 'position_long': 1000, 'speed': 8.5},
                {'timestamp': '2026-10-04T09:23:08Z', 'position_lat': 1001, 'position_long': 1001, 'speed': 9.0},
            ]
        }
        ride = build_ride(msgs, 'speed_fallback', 'fixture')
        self.assertEqual(ride['meta']['summary']['enhanced_avg_speed'], 8.5)
        self.assertEqual(ride['meta']['summary']['enhanced_max_speed'], 12.0)

    def test_nonpositive_heart_rate_treated_as_invalid_sentinel(self):
        msgs = {
            'session_mesgs': [{'sport': 'cycling', 'sub_sport': 'generic'}],
            'record_mesgs': [
                {'timestamp': '2026-10-04T09:23:07Z', 'position_lat': 1000, 'position_long': 1000, 'heart_rate': 0},
                {'timestamp': '2026-10-04T09:23:08Z', 'position_lat': 1001, 'position_long': 1001, 'heart_rate': 142},
                {'timestamp': '2026-10-04T09:23:09Z', 'position_lat': 1002, 'position_long': 1002, 'heart_rate': -1},
            ]
        }
        ride = build_ride(msgs, 'hr_sentinel', 'fixture')
        self.assertEqual(ride['channels']['heartRate'], [None, 142, None])


if __name__ == '__main__':
    unittest.main()
