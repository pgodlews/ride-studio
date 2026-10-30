import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageOps
from photo_metadata import metadata, prepare


class PhotoMetadataTests(unittest.TestCase):
    def test_offset_time(self):
        result = metadata({'DateTimeOriginal': '2026:10:04 13:10:01', 'OffsetTimeOriginal': '+01:00'})
        self.assertEqual(result['capturedUtc'], '2026-10-04T12:10:01Z')
        self.assertIsNone(result['gps'])

    def test_subsecond_offset_time(self):
        result = metadata({'SubSecDateTimeOriginal': '2026:10:04 13:10:01.125+01:00'})
        self.assertEqual(result['capturedUtc'], '2026-10-04T12:10:01.125000Z')

    def test_unzoned_time_is_not_assumed_local(self):
        result = metadata({'DateTimeOriginal': '2026:10:04 13:10:01'})
        self.assertIsNone(result['capturedUtc'])
        self.assertIn('choose the ride time', ' '.join(result['warnings']))

    def test_gps_utc_fallback_and_capture_precedence(self):
        tags = {'GPSDateTime': '2026:10:04 12:10:00Z'}
        self.assertEqual(metadata(tags)['capturedUtc'], '2026-10-04T12:10:00Z')
        tags.update(DateTimeOriginal='2026:10:04 13:10:01', OffsetTimeOriginal='+01:00')
        self.assertEqual(metadata(tags)['capturedUtc'], '2026-10-04T12:10:01Z')

    def test_zero_invalid_and_partial_gps(self):
        self.assertEqual(metadata({'GPSLatitude': 0, 'GPSLongitude': 0})['gps'], {'lat': 0, 'lon': 0, 'altitude': None})
        for tags in [{'GPSLatitude': 91, 'GPSLongitude': 0}, {'GPSLatitude': float('nan'), 'GPSLongitude': 0}, {'GPSLatitude': 0}]:
            self.assertIsNone(metadata(tags)['gps'])
        self.assertIsNone(metadata({'GPSLatitude': 0, 'GPSLongitude': 0, 'GPSAltitude': float('inf')})['gps']['altitude'])

    def test_real_exif_signed_gps_orientation_and_preserved_input(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'test.jpg', Path(temp) / 'image.png'
            image = Image.new('RGB', (60, 40), 'red')
            image.paste('blue', (30, 0, 60, 40))
            image.save(source, quality=95)
            subprocess.run(['exiftool', '-overwrite_original', '-Orientation#=6', '-GPSLatitude=51.25', '-GPSLatitudeRef=S',
                            '-GPSLongitude=0.5', '-GPSLongitudeRef=W', '-GPSAltitude=12', '-GPSAltitudeRef#=1',
                            '-DateTimeOriginal=2026:10:04 13:10:01', '-OffsetTimeOriginal=+01:00', str(source)],
                           check=True, capture_output=True)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            result = prepare(source, output)
            self.assertEqual(result['gps'], {'lat': -51.25, 'lon': -0.5, 'altitude': -12})
            self.assertEqual((result['width'], result['height']), (40, 60))
            self.assertEqual(result['capturedUtc'], '2026-10-04T12:10:01Z')
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            with Image.open(source) as original, Image.open(output) as normalized:
                self.assertEqual(normalized.tobytes(), ImageOps.exif_transpose(original).convert('RGB').tobytes())
                self.assertFalse(normalized.getexif())

    def test_all_eight_exif_orientations(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'test.png', Path(temp) / 'image.png'
            image = Image.new('RGB', (6, 4), 'red')
            image.paste('blue', (3, 0, 6, 4))
            for orientation in range(1, 9):
                exif = Image.Exif()
                exif[274] = orientation
                image.save(source, exif=exif)
                prepare(source, output)
                with Image.open(source) as original, Image.open(output) as normalized:
                    self.assertEqual(normalized.tobytes(), ImageOps.exif_transpose(original).convert('RGB').tobytes())

    def test_animation_rejected_and_transparency_black(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'test.png', Path(temp) / 'image.png'
            image = Image.new('RGBA', (10, 10), (255, 0, 0, 0))
            image.save(source)
            prepare(source, output)
            with Image.open(output) as normalized:
                self.assertEqual(normalized.getpixel((0, 0)), (0, 0, 0))
            image.save(source, save_all=True, append_images=[Image.new('RGBA', image.size, 'blue')], duration=100)
            with self.assertRaisesRegex(ValueError, 'single still'):
                prepare(source, output)

    def test_multi_picture_jpeg_uses_primary_image(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'test.jpg', Path(temp) / 'image.png'
            primary = Image.new('RGB', (60, 40), 'red')
            exif = Image.Exif()
            exif[274] = 6
            primary.save(source, 'MPO', save_all=True, append_images=[Image.new('RGB', (30, 20), 'blue')], exif=exif, quality=95)
            with Image.open(source) as check:
                self.assertEqual((check.format, check.n_frames), ('MPO', 2))
            result = prepare(source, output)
            self.assertEqual((result['width'], result['height']), (40, 60))
            with Image.open(output) as normalized:
                self.assertGreater(normalized.getpixel((20, 30))[0], 240)

    @unittest.skipUnless(sys.platform == 'darwin', 'HEIC decoding uses macOS sips')
    def test_heic_orientation(self):
        with tempfile.TemporaryDirectory() as temp:
            source, heic, output = Path(temp) / 'test.jpg', Path(temp) / 'test.heic', Path(temp) / 'image.png'
            image = Image.new('RGB', (80, 40), 'red')
            image.paste('blue', (40, 0, 80, 40))
            exif = Image.Exif()
            exif[274] = 6
            image.save(source, exif=exif, quality=95)
            subprocess.run(['sips', '-s', 'format', 'heic', str(source), '--out', str(heic)], check=True, capture_output=True)
            result = prepare(heic, output)
            self.assertEqual((result['width'], result['height']), (40, 80))
            with Image.open(output) as normalized:
                self.assertGreater(normalized.getpixel((20, 10))[0], 240)
                self.assertGreater(normalized.getpixel((20, 70))[2], 240)


if __name__ == '__main__':
    unittest.main()
