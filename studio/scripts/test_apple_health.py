"""Apple Health export importer on a generated export (python3 -m unittest scripts/test_apple_health.py)."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apple_health  # noqa: E402

START = datetime(2026, 10, 3, 11, 0, 0, tzinfo=timezone.utc)
WATCH = 'Test’s Apple Watch'
DEVICE = '&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch7,5, software:11.0, creation date:2026-01-01 10:00:00 +0000&gt;'


def local(dt: datetime) -> str:
    """Apple Health's local date format (+0100, as during BST)."""
    return (dt + timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S') + ' +0100'


def record(kind, value, unit, t0, t1=None, source=WATCH):
    return (f'<Record type="HKQuantityTypeIdentifier{kind}" sourceName="{source}" sourceVersion="11.0" device="{DEVICE}" unit="{unit}" '
            f'creationDate="{local(t0)}" startDate="{local(t0)}" endDate="{local(t1 or t0)}" value="{value}"/>')


def write_export(root: Path) -> Path:
    """Cycling (route with a 40 s gap, a pause and an invalid speed), walking with steps, and a route-less Connect copy."""
    export = root / 'apple_health_export'
    (export / 'workout-routes').mkdir(parents=True)
    ride_end = START + timedelta(seconds=300)
    walk0, walk_end = START + timedelta(hours=2), START + timedelta(hours=2, seconds=120)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE HealthData [', '<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>', ']>',
             '<HealthData locale="en_GB">', ' <ExportDate value="2026-10-05 10:43:07 +0100"/>', ' <Me HKCharacteristicTypeIdentifierDateOfBirth=""/>']
    # Heart rate every 5 s, but nothing between 100 s and 160 s (to check the 15 s hold limit).
    for s in range(0, 301, 5):
        if not 100 < s < 160:
            lines.append(' ' + record('HeartRate', 120 + s // 10, 'count/min', START + timedelta(seconds=s)))
        # A Garmin Connect copy in Health: must never be mixed in.
        lines.append(' ' + record('HeartRate', 60, 'count/min', START + timedelta(seconds=s), source='Connect'))
    for s in range(0, 300, 10):
        lines.append(' ' + record('DistanceCycling', 0.05, 'km', START + timedelta(seconds=s), START + timedelta(seconds=s + 10)))
    lines.append(' ' + record('HeartRate', 200, 'count/min', START - timedelta(minutes=5)))  # outside every workout
    for s in range(0, 120, 30):
        lines.append(' ' + record('StepCount', 55, 'count', walk0 + timedelta(seconds=s), walk0 + timedelta(seconds=s + 30)))
    lines += [
        f' <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="4.5" durationUnit="min" sourceName="{WATCH}" sourceVersion="11.0" device="{DEVICE}" creationDate="{local(ride_end)}" startDate="{local(START)}" endDate="{local(ride_end)}">',
        '  <MetadataEntry key="HKIndoorWorkout" value="0"/>',
        f'  <WorkoutEvent type="HKWorkoutEventTypePause" date="{local(START + timedelta(seconds=200))}"/>',
        f'  <WorkoutEvent type="HKWorkoutEventTypeResume" date="{local(START + timedelta(seconds=230))}"/>',
        f'  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="{local(START)}" endDate="{local(ride_end)}" average="140" minimum="120" maximum="150" unit="count/min"/>',
        f'  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" startDate="{local(START)}" endDate="{local(ride_end)}" sum="1.5" unit="km"/>',
        f'  <WorkoutRoute sourceName="{WATCH}" sourceVersion="11.0" creationDate="{local(ride_end)}" startDate="{local(START)}" endDate="{local(ride_end)}">',
        '   <FileReference path="/workout-routes/route_ride.gpx"/>', '  </WorkoutRoute>', ' </Workout>',
        f' <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="5" durationUnit="min" sourceName="Connect" sourceVersion="3" creationDate="{local(ride_end)}" startDate="{local(START)}" endDate="{local(ride_end)}">',
        ' </Workout>',
        f' <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="2" durationUnit="min" sourceName="{WATCH}" sourceVersion="11.0" device="{DEVICE}" creationDate="{local(walk_end)}" startDate="{local(walk0)}" endDate="{local(walk_end)}">',
        f'  <WorkoutRoute sourceName="{WATCH}" sourceVersion="11.0" creationDate="{local(walk_end)}" startDate="{local(walk0)}" endDate="{local(walk_end)}">',
        '   <FileReference path="/workout-routes/route_walk.gpx"/>', '  </WorkoutRoute>', ' </Workout>',
        '</HealthData>']
    (export / 'export.xml').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def gpx(name, t0, seconds, skip, speed):
        pts = []
        for s in seconds:
            if s in skip:
                continue
            sp = -1 if s == 50 else speed
            pts.append(f'<trkpt lon="{-1.5 + s * 1e-4:.6f}" lat="53.8"><ele>{100 + s * 0.1:.2f}</ele><time>{(t0 + timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%SZ")}</time>'
                       f'<extensions><speed>{sp}</speed><course>90</course><hAcc>2</hAcc><vAcc>2</vAcc></extensions></trkpt>')
        (export / 'workout-routes' / name).write_text('<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>'
                                                       + ''.join(pts) + '</trkseg></trk></gpx>')
    gpx('route_ride.gpx', START, range(0, 301), set(range(121, 161)), 5.0)  # 40 s GPS gap
    gpx('route_walk.gpx', walk0, range(0, 121), set(), 1.4)
    return export


class AppleHealthImport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.export = write_export(root)
        cls.cache = root / 'cache'
        cls.index = apple_health.scan(cls.export, cls.cache)
        cls.ride_w, cls.copy_w, cls.walk_w = cls.index['workouts']
        cls.ride, cls.evidence = apple_health.build_ride(cls.export, cls.cache, cls.ride_w['id'], 'apple-test')
        cls.walk, _ = apple_health.build_ride(cls.export, cls.cache, cls.walk_w['id'], 'apple-walk')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def at(self, ride, channel, second):
        return ride['channels'][channel][ride['t'].index(second)]

    def test_index(self):
        self.assertEqual(len(self.index['workouts']), 3)
        self.assertEqual(self.ride_w['device'], 'Apple Watch (Watch7,5)')
        self.assertEqual(self.ride_w['tzOffsetSec'], 3600)
        self.assertEqual(self.ride_w['startUtc'], '2026-10-03T11:00:00.000Z')
        self.assertEqual(self.ride_w['distanceM'], 1500)
        self.assertEqual(self.copy_w['routes'], [])
        self.assertEqual(self.index['exportDate'], '2026-10-05 10:43:07 +0100')
        self.assertEqual(apple_health.scan(self.export, self.cache), self.index, 'cached index is reused')

    def test_sources_and_hold(self):
        hr = [v for v in self.ride['channels']['heartRate'] if v is not None]
        self.assertTrue(hr and min(hr) >= 120, 'Garmin Connect HR copies (60) and out-of-workout samples (200) excluded')
        self.assertEqual(self.at(self.ride, 'heartRate', 7), 120, 'preceding sample held')
        self.assertEqual(self.at(self.ride, 'heartRate', 114), 130, '14 s after the last sample: still held')
        self.assertIsNone(self.at(self.ride, 'heartRate', 116), 'beyond 15 s: missing, not invented')

    def test_speed_distance_breaks(self):
        self.assertEqual(self.at(self.ride, 'speed', 49), 5.0)
        self.assertIsNone(self.at(self.ride, 'speed', 50), 'negative recorded speed is invalid')
        self.assertAlmostEqual(self.at(self.ride, 'distance', 100), 500, places=6)
        self.assertAlmostEqual(self.at(self.ride, 'distance', 105), 525, places=6, msg='linear inside a sample interval')
        self.assertIn(121, self.ride['breaks'], '40 s GPS gap is a break')
        self.assertIn(self.ride['t'].index(201), self.ride['breaks'], 'pause event is a break')
        self.assertNotIn('pace', self.ride['channels'])
        self.assertEqual(self.ride['tzOffsetSec'], 3600)
        self.assertEqual(self.ride['meta']['activity']['sport'], 'cycling')
        self.assertEqual(self.ride['meta']['summary']['avg_heart_rate'], 140)
        self.assertTrue(any('Connect' in w for w in self.ride['meta']['warnings']))
        self.assertEqual(self.evidence['sampleCounts'], {'heartRate': 50, 'distance': 30})

    def test_walking(self):
        ch = self.walk['channels']
        self.assertEqual(self.at(self.walk, 'stepCadence', 10), 110, '55 steps / 30 s interval average')
        self.assertAlmostEqual(self.at(self.walk, 'pace', 10), 1 / 1.4, places=6)
        self.assertNotIn('cadence', ch)
        self.assertIn('GPS', self.walk['meta']['channelSources']['distance'], 'no Watch distance samples: GPS-derived and labelled')
        self.assertEqual(self.walk['meta']['activity']['primaryMetric'], 'pace')

    def test_refusals_and_cli(self):
        with self.assertRaisesRegex(ValueError, 'no route'):
            apple_health.build_ride(self.export, self.cache, self.copy_w['id'], 'nope')
        out = Path(self.tmp.name) / 'rides'
        cmd = [sys.executable, str(Path(apple_health.__file__)), 'import', str(self.export), self.ride_w['id'], '--id', 'cli-ride',
               '--out-dir', str(out), '--cache', str(self.cache)]
        subprocess.run(cmd, check=True, capture_output=True)
        ride = json.loads((out / 'cli-ride.json').read_text())
        self.assertEqual(ride['meta']['telemetry']['kind'], 'apple-health')
        self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0, 'an existing ride is never overwritten')
        with self.assertRaisesRegex(ValueError, 'export.xml'):
            apple_health.scan(Path(self.tmp.name), self.cache)


if __name__ == '__main__':
    unittest.main()
