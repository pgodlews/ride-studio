"""GPX semantics, discontinuities, sensor namespaces and preservation regressions."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gpx_activity import read_gpx
from phone_fit import synchronize_projection
from prepare_activity import main
from prepare_dji import utc

NS = 'http://www.topografix.com/GPX/1/1'
TPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v2'


def point(second, lon='0', extra='', lat='0', time=None):
    time = f'<time>2026-08-22T16:31:{second:02}Z</time>' if time is None else time
    return f'<trkpt lat="{lat}" lon="{lon}">{time}<ele>-10</ele>{extra}</trkpt>'


def document(body=None, namespace=NS):
    if body is None:
        body = '<trk><name>Generated track</name><trkseg>' + point(20) + point(21, '0.00001') + '</trkseg></trk>'
    return f'<gpx xmlns="{namespace}" xmlns:tpx="{TPX}" version="1.1" creator="fixture">{body}</gpx>'


def fixture_ride():
    """Shared with the browser evaluator test; two segments separated by only 1 s."""
    ext = '<extensions><tpx:TrackPointExtension><tpx:hr>120</tpx:hr><tpx:cad>0</tpx:cad></tpx:TrackPointExtension></extensions>'
    body = '<trk><trkseg>' + point(20, extra=ext) + point(21, '0.00001', ext) + '</trkseg><trkseg>' + point(22, '0.01', ext) + point(23, '0.01001', ext) + '</trkseg></trk>'
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'fixture.gpx'
        path.write_text(document(body))
        return read_gpx(path, 'fixture', timezone_name='Europe/London')[0]


class GPX(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / 'fixture.GPX'

    def read(self, body=None, namespace=NS, **options):
        self.path.write_text(document(body, namespace))
        return read_gpx(self.path, 'fixture', **options)

    def test_positions_utc_distance_speed_and_source_preservation(self):
        ride, evidence = self.read(timezone_name='Europe/London', sport='hiking')
        before = self.path.read_bytes()
        self.assertEqual(ride['startUtc'], '2026-08-22T16:31:20Z')
        self.assertEqual(ride['t'], [0, 1])
        self.assertEqual(ride['channels']['lat'], [0, 0])
        self.assertEqual(ride['channels']['altitude'], [-10, -10])
        self.assertIsNone(ride['channels']['speed'][0])
        self.assertAlmostEqual(ride['channels']['speed'][1], 1.111951, places=5)
        self.assertEqual(ride['channels']['distance'], [0, 1.111951])
        self.assertEqual(evidence['derivedSpeedSamples'], 1)
        self.assertEqual(ride['tzOffsetSec'], 3600)
        self.assertIn('pace', ride['channels'])
        self.assertNotIn('heartRate', ride['channels'])
        self.assertEqual(read_gpx(self.path, 'again')[1]['bytes'], len(before))
        self.assertEqual(self.path.read_bytes(), before)
        json.dumps(ride, allow_nan=False)

    def test_garmin_sensor_namespaces_recorded_zero_and_invalid_speed(self):
        ext = '<extensions><tpx:TrackPointExtension><tpx:hr>130</tpx:hr><tpx:cad>0</tpx:cad><tpx:atemp>12.5</tpx:atemp><tpx:speed>0</tpx:speed></tpx:TrackPointExtension></extensions>'
        invalid = ext.replace('<tpx:speed>0', '<tpx:speed>NaN').replace('<tpx:hr>130', '<tpx:hr>0').replace('<tpx:cad>0', '<tpx:cad>255')
        ride, evidence = self.read('<trk><trkseg>' + point(20, extra=ext) + point(21, '.00001', invalid) + '</trkseg></trk>')
        self.assertEqual(ride['channels']['speed'], [0, None])
        self.assertEqual(ride['channels']['heartRate'], [130, None])
        self.assertEqual(ride['channels']['cadence'], [0, None])
        self.assertEqual(ride['channels']['temperature'], [12.5, 12.5])
        self.assertEqual(evidence['derivedSpeedSamples'], 0)
        self.path.write_text(self.path.read_text().replace(TPX, TPX[:-1] + '1'))
        ride, _ = read_gpx(self.path, 'v1')
        self.assertEqual(ride['channels']['cadence'][0], 0)
        self.assertIsNone(ride['channels']['speed'][0]) # v1 has no speed mapping

    def test_foreign_extension_same_names_are_not_sensor_channels(self):
        ext = '<extensions><TrackPointExtension xmlns="urn:unknown"><hr>150</hr><speed>99</speed></TrackPointExtension></extensions>'
        ride, evidence = self.read('<trk><trkseg>' + point(20, extra=ext) + point(21, '.00001', ext) + '</trkseg></trk>')
        self.assertNotIn('heartRate', ride['channels'])
        self.assertLess(ride['channels']['speed'][1], 2)
        self.assertIn('{urn:unknown}hr', evidence['extensionTags'])

    def test_segments_and_long_gaps_do_not_generate_motion(self):
        ride = fixture_ride()
        self.assertEqual(ride['breaks'], [2])
        self.assertEqual(ride['channels']['speed'][2], None)
        self.assertEqual(ride['channels']['distance'][2], ride['channels']['distance'][1])
        ride, _ = self.read('<trk><trkseg>' + point(20) + point(30, '.01') + '</trkseg></trk>')
        self.assertEqual(ride['breaks'], [1])
        self.assertNotIn('speed', ride['channels'])
        self.assertEqual(ride['channels']['distance'], [0, 0])

    def test_invalid_fix_nulls_and_untimed_points_break_adjacency(self):
        body = '<trk><trkseg>' + point(20) + point(21, '.00001', lat='NaN') + point(22, '.00002') + point(23, '.00003', time='') + point(24, '.00004') + '</trkseg></trk>'
        ride, evidence = self.read(body)
        self.assertEqual(ride['channels']['lat'], [0, None, 0, 0])
        self.assertEqual(ride['channels']['lon'], [0, None, .00002, .00004])
        self.assertEqual(ride['channels']['distance'], [0, None, 0, 0])
        self.assertNotIn('speed', ride['channels'])
        self.assertEqual(ride['breaks'], [1, 2, 3])
        self.assertEqual(evidence['untimedPoints'], 1)

    def test_waypoints_routes_and_untimed_tracks_are_excluded(self):
        for body in ('<wpt lat="0" lon="0"><time>2026-08-22T12:00:00Z</time></wpt>',
                     '<rte><rtept lat="0" lon="0"/><rtept lat="0" lon="1"/></rte>',
                     '<trk><trkseg>' + point(0, time='') + point(0, '1', time='') + '</trkseg></trk>'):
            ride, _ = self.read(body)
            self.assertFalse(ride['meta']['activity']['routeImportEligible'])
            self.assertEqual(ride['t'], [])
            self.assertIsNone(ride['startUtc'])

    def test_duplicates_first_kept_and_backwards_time_rejected(self):
        ride, evidence = self.read('<trk><trkseg>' + point(20) + point(20, '1') + point(21, '.00001') + '</trkseg></trk>')
        self.assertEqual(evidence['duplicateTimes'], 1)
        self.assertEqual(ride['channels']['lon'][0], 0)
        self.assertEqual(ride['t'], [0, 1])
        with self.assertRaisesRegex(ValueError, 'backwards'):
            self.read('<trk><trkseg>' + point(21) + point(20) + '</trkseg></trk>')

    def test_multiple_tracks_require_explicit_selection(self):
        body = '<trk><trkseg>' + point(20) + point(21) + '</trkseg></trk>'
        with self.assertRaisesRegex(ValueError, '--track'):
            self.read(body * 2)
        self.assertEqual(self.read(body * 2, track=2)[1]['selectedTrack'], 2)
        with self.assertRaises(ValueError):
            self.read(body, track=0)

    def test_timezone_offsets_missing_timezone_and_dst(self):
        ride, _ = self.read('<trk><trkseg>' + point(20, time='<time>2026-08-22T18:31:20+02:00</time>') + point(21) + '</trkseg></trk>')
        self.assertEqual(ride['startUtc'], '2026-08-22T16:31:20Z')
        self.assertIsNone(ride['tzOffsetSec'])
        with self.assertRaisesRegex(ValueError, 'timezone offset'):
            self.read('<trk><trkseg>' + point(20, time='<time>2026-08-22T16:31:20</time>') + '</trkseg></trk>')
        body = '<trk><trkseg>' + point(20, time='<time>2026-10-25T00:59:59Z</time>') + point(21, time='<time>2026-10-25T01:00:00Z</time>') + '</trkseg></trk>'
        with self.assertRaisesRegex(ValueError, 'transition'):
            self.read(body, timezone_name='Europe/London')
        self.path.write_text(document().replace('2026-08-22', '2026-12-22'))
        self.assertEqual(read_gpx(self.path, 'winter', timezone_name='Europe/London')[0]['tzOffsetSec'], 0)

    def test_gpx_10_speed_and_no_namespace(self):
        body = '<trk><trkseg>' + point(20, extra='<speed>3</speed>') + point(21, extra='<speed>-1</speed>') + '</trkseg></trk>'
        self.assertEqual(self.read(body, namespace='http://www.topografix.com/GPX/1/0')[0]['channels']['speed'], [3, None])
        self.assertTrue(self.read(namespace='')[0]['meta']['activity']['routeUsable'])

    def test_foot_cadence_not_guessed_from_gpx_rpm(self):
        ext = '<extensions><tpx:TrackPointExtension><tpx:cad>80</tpx:cad></tpx:TrackPointExtension></extensions>'
        ride, _ = self.read('<trk><trkseg>' + point(20, extra=ext) + point(21, '.00001', ext) + '</trkseg></trk>', sport='hiking')
        for c in ('cadence', 'stepCadence', 'strideCadence'):
            self.assertNotIn(c, ride['channels'])
        self.assertTrue(any('semantics' in w for w in ride['meta']['warnings']))

    def test_malformed_xml_root_and_entities_rejected(self):
        for text in ('<gpx>', '<other/>', '<!DOCTYPE gpx [<!ENTITY x "text">]>' + document()):
            self.path.write_text(text)
            with self.assertRaises(ValueError):
                read_gpx(self.path, 'bad')

    def test_phone_projection_absolute_utc_nonoverlap_and_partial(self):
        ride, evidence = self.read()
        info = {'kind': 'phone', 'clipLocation': {'lat': 0, 'lon': 0}}
        joined = synchronize_projection(ride, utc('2026-08-22T16:31:20.5Z'), 1, info, evidence, 'gpx')
        self.assertEqual(joined['meta']['telemetry']['synchronization']['clipStartRideSec'], .5)
        self.assertIn('phone/GPX', info['synchronization']['notice'])
        self.assertEqual(joined['t'], [0, 1])
        self.assertTrue(any('part of' in w for w in joined['meta']['warnings']))
        with self.assertRaisesRegex(ValueError, 'does not overlap'):
            synchronize_projection(ride, utc('2026-08-23T00:00:00Z'), 1, {}, evidence, 'gpx')

    def test_cli_recursive_exclusion_errors_and_preserves_existing_import(self):
        root = Path(self.folder.name)
        nested = root / 'device/Current'
        nested.mkdir(parents=True)
        source = nested / 'my track.GPX'
        source.write_text(document())
        (root / 'device/Waypoints.gpx').write_text(document('<wpt lat="0" lon="0"/>'))
        out = root / 'rides'
        args = ['prepare_activity.py', str(root / 'device'), '--recursive', '--out-dir', str(out)]
        original = source.read_bytes()
        with patch('sys.argv', args), patch('prepare_activity.STUDIO', root), contextlib.redirect_stdout(io.StringIO()):
            main()
        target = out / 'my-track.json'
        self.assertTrue(target.exists())
        self.assertFalse((out / 'Waypoints.json').exists())
        before = target.read_bytes()
        with patch('sys.argv', args), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            main()
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(next((root / '.cache/activity-gpx').glob('*.gpx')).read_bytes(), original)
        (nested / 'bad.gpx').write_text('<gpx>')
        report = root / 'inventory.json'
        with patch('sys.argv', args + ['--inspect', '--report', str(report)]), contextlib.redirect_stdout(io.StringIO()):
            main()
        self.assertTrue(any('error' in r for r in json.loads(report.read_text())))


if __name__ == '__main__':
    unittest.main()
