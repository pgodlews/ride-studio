"""Recording clocks must remain explicit and unambiguous across FFprobe versions."""
import unittest

from media_metadata import recorded_clock


class RecordedClockTest(unittest.TestCase):
    def test_container_utc(self):
        self.assertEqual(recorded_clock({}, '2026-10-04T09:00:20.000Z')[0],
                         '2026-10-04T09:00:20.000Z')

    def test_duplicate_tag_values(self):
        self.assertEqual(recorded_clock({}, '2026-10-04T09:00:20.000000Z;2026-10-04T09:00:20.000Z')[0],
                         '2026-10-04T09:00:20.000Z')

    def test_equivalent_offsets(self):
        self.assertEqual(recorded_clock({}, '2026-10-04T10:00:20+01:00;2026-10-04T09:00:20Z')[0],
                         '2026-10-04T09:00:20.000Z')

    def test_conflicts_and_missing_values_stay_missing(self):
        for text in ('2026-10-04T09:00:20Z;2026-10-04T09:00:21Z',
                     '2026-10-04T09:00:20.000001Z;2026-10-04T09:00:20Z',
                     '2026-10-04T09:00:20Z;invalid', '2026-10-04T09:00:20Z;',
                     '1904-01-01T00:00:00Z', '1970-01-01T00:00:00Z',
                     '2026-10-04T09:00:20', None):
            with self.subTest(text=text):
                self.assertEqual(recorded_clock({}, text), (None, None))

    def test_explicit_exif_offset_retains_priority(self):
        clock, source = recorded_clock({'CreationDate': '2026:10:04 10:00:20+01:00'},
                                       '2026-10-04T09:00:21Z')
        self.assertEqual(clock, '2026-10-04T09:00:20.000Z')
        self.assertIn('CreationDate with UTC offset', source)


if __name__ == '__main__':
    unittest.main()
