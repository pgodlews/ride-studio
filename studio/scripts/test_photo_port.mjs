// Parity for the TypeScript still-photo metadata port: the same generated files run through
// exifr and through the Python reference (ExifTool JSON + Pillow), compared key by key.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'photo port test ')));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 1 << 24 });
const file = (name) => join(temp, name);
// exiftool exits nonzero when one of the files is unreadable, which is a case under test here.
const exiftoolJson = (args, paths) => {
  try {
    return JSON.parse(run('exiftool', [...args, ...paths]));
  } catch (error) {
    return JSON.parse(error.stdout);
  }
};

// Capture-time texts the port has to read exactly like Python's datetime.fromisoformat: EXIF
// colons, ISO colons, basic formats, arbitrary separators, sub-second truncation, zones, and the
// dates that must stay missing rather than become an invented instant.
const TIME_TEXTS = [
  '2026:10:04 13:10:01', '2026-10-04T13:10:01', '2026-10-04T13:10:01.125+01:00',
  '2026-10-04T13:10:01.1234567', '2026-10-04T13:10:01.9999999', '2026-10-04T13:10:01,5',
  '2026-10-04T13:10:01Z', '2026-10-04T13:10:01+0100', '2026-10-04T13:10:01+01',
  '2026-10-04T13:10:01+01:00:00', '2026-10-04T13:10:01+01:0000', '2026-10-04T13:10:01-00:30',
  '2026-10-04T13:10:01.', '20261004T131001', '20261004T1310', '20261004T13:10:01',
  '2026-10-04 13:10', '2026-10-04X13:10:01', '2026-10-04', '2026-10-04T23:59:59+23:59',
  '1970-01-01T00:00:00Z', '1969-12-31T23:59:59.5Z', '0001-01-01T00:00:00Z',
  '2024-02-29T12:00:00', '1900-02-29T12:00:00', '0000-00-00T00:00:00', '2026-02-30T00:00:00',
  '2026-13-01T00:00:00', '2026-12-31T23:59:60', '9999-12-31T23:59:59-01:00',
  '0001-01-01T00:00:00+01:00', '', 'not a time',
];

try {
  run('exiftool', ['-ver']);
} catch {
  throw new Error('exiftool is required: it produces the tag JSON the Python reference reads');
}

// ---------------------------------------------------------------- fixtures

// Pillow builds the base images. Non-square, so an orientation swap shows up in width/height.
const MAKE_IMAGES = `
import os, sys
from PIL import Image
root = sys.argv[1]

def photo(width, height):
    image = Image.new('RGB', (width, height), 'red')
    image.paste('blue', (width // 2, 0, width, height))
    return image

def save(name, image, **options):
    image.save(os.path.join(root, name), **options)

for name in ['gps-ne.jpg', 'gps-sw.jpg', 'gps-zero.jpg', 'gps-partial.jpg', 'gps-invalid.jpg',
             'gps-precise.jpg', 'gps-broken.jpg', 'time-offset.jpg', 'time-plain.jpg',
             'time-subsec.jpg', 'time-subsec7.jpg', 'time-subsec-only.jpg', 'time-gps.jpg',
             'time-gps-date.jpg', 'time-none.jpg', 'plain.jpg', 'fmt.jpg']:
    save(name, photo(60, 40), quality=92)
for index in range(1, 9):
    save('or%d.jpg' % index, photo(60, 40), quality=92)
save('fmt.png', Image.new('RGBA', (20, 10), (0, 255, 0, 128)))
save('plain.png', Image.new('RGB', (20, 10), 'green'))
save('tiny.png', Image.new('RGB', (1, 1), 'red'))
save('progressive.jpg', photo(60, 40), quality=90, progressive=True)
save('fmt.webp', photo(60, 40))
save('lossless.webp', photo(60, 40), lossless=True)
save('fmt.tif', photo(60, 40))
second = Image.new('RGB', (20, 10), 'blue')
save('anim.png', photo(20, 10), save_all=True, append_images=[second], duration=100)
save('anim.webp', photo(20, 10), save_all=True, append_images=[second], duration=100)
save('multi.tif', photo(20, 10), save_all=True, append_images=[second])
# Writers that put the time tags where the spec does not: IFD0 instead of the Exif IFD.
dashed = Image.Exif()
dashed[36867] = '2026-10-04 13:10:01'
save('time-dash.jpg', photo(30, 20), exif=dashed, quality=92)
embedded = Image.Exif()
embedded[36867] = '2026:10:04 13:10:01+02:00'
save('time-embedded.jpg', photo(30, 20), exif=embedded, quality=92)
both = Image.Exif()
both[36867] = '2026:10:04 13:10:01'
both.get_ifd(34665)[36867] = '2020:01:02 03:04:05'
save('time-duplicate.jpg', photo(30, 20), exif=both, quality=92)
`;

// A zero denominator in a GPS rational: ExifTool reports an empty value, so it must stay missing.
const BREAK_RATIONAL = `
import sys
path = sys.argv[1]
data = bytearray(open(path, 'rb').read())
needle = bytes.fromhex('33000000010000000f000000010000000000000001000000')
start = data.find(needle)
assert start > 0, 'latitude rationals not found'
data[start + 4:start + 8] = bytes(4)
open(path, 'wb').write(bytes(data))
`;

// Shared by the two EXIF builders below: a TIFF block laid out from three IFDs, the two IFD0
// variants (a metadata-only one and one Pillow can open as a TIFF file), the GPS IFD every fixture
// starts from, and a JPEG whose APP1 segment carries such a block.
const TIFF_BUILDER = `
import io, json, struct, sys
from pathlib import Path
from PIL import Image

FORMATS = {'byte': 1, 'ascii': 2, 'int16u': 3, 'int32u': 4, 'rational64u': 5, 'undefined': 7}
SIZES = {'byte': 1, 'ascii': 1, 'int16u': 2, 'int32u': 4, 'rational64u': 8, 'undefined': 1}
EXIF_IFD, GPS_IFD = b'EXIF', b'GPS!'
LATITUDE_REF, LONGITUDE_REF, ALTITUDE_REF, ALTITUDE = 0x0001, 0x0003, 0x0005, 0x0006
WIDTH, HEIGHT = 60, 40
XIAOMI_ALTITUDE_REF = bytes.fromhex('000000c800000064')

def rational(*pairs, order='>'):
    return b''.join(struct.pack(order + 'II', numerator, denominator) for numerator, denominator in pairs)

def blob(ifd0, gps, exif, order='>', pixels=None):
    '''A TIFF block: the three IFDs, then the out-of-line values.

    GPS entries keep the order they are given, because which of two entries for one tag ExifTool
    reads last depends on it. Pixels, when given, sit right after the header, which is what the
    complete TIFF files need for Pillow to open them.
    '''
    pixels = pixels or b''
    blocks = [list(ifd0), sorted(exif), list(gps)]
    pos = 8 + len(pixels)
    starts, targets, values = [], {EXIF_IFD: 0, GPS_IFD: 0}, []
    for entries in blocks:
        starts.append(pos)
        pos += 2 + 12 * len(entries) + 4
    targets[EXIF_IFD], targets[GPS_IFD] = starts[1], starts[2]

    def directory(entries):
        nonlocal pos
        out = struct.pack(order + 'H', len(entries))
        for tag, fmt, count, value in entries:
            if value in targets:
                payload = struct.pack(order + 'I', targets[value])
            elif count * SIZES[fmt] > 4:
                payload = struct.pack(order + 'I', pos)
                values.append((pos, value))
                pos += len(value) + (len(value) & 1)
            else:
                payload = value.ljust(4, b'\\0')
            out += struct.pack(order + 'HHI', tag, FORMATS[fmt], count) + payload
        return out + struct.pack(order + 'I', 0)

    directories = [directory(entries) for entries in blocks]
    out = bytearray(pos)
    out[0:8] = (b'MM' if order == '>' else b'II') + struct.pack(order + 'HI', 42, starts[0])
    out[8:8 + len(pixels)] = pixels
    for start, data in zip(starts, directories):
        out[start:start + len(data)] = data
    for offset, value in values:
        out[offset:offset + len(value)] = value
    return bytes(out)

def header_ifd0(order='>'):
    '''IFD0 of a metadata-only block: the stored size, plus the Exif and GPS pointers.'''
    return [(0x0100, 'int32u', 1, struct.pack(order + 'I', WIDTH)),
            (0x0101, 'int32u', 1, struct.pack(order + 'I', HEIGHT)),
            (0x8769, 'int32u', 1, EXIF_IFD),
            (0x8825, 'int32u', 1, GPS_IFD)]

def image_ifd0(order='>'):
    '''IFD0 of a complete uncompressed RGB TIFF: the strip tags Pillow needs to open it.'''
    return [(0x0100, 'int32u', 1, struct.pack(order + 'I', WIDTH)),
            (0x0101, 'int32u', 1, struct.pack(order + 'I', HEIGHT)),
            (0x0102, 'int16u', 3, struct.pack(order + 'HHH', 8, 8, 8)),
            (0x0103, 'int16u', 1, struct.pack(order + 'H', 1)),
            (0x0106, 'int16u', 1, struct.pack(order + 'H', 2)),
            (0x0111, 'int32u', 1, struct.pack(order + 'I', 8)),
            (0x0115, 'int16u', 1, struct.pack(order + 'H', 3)),
            (0x0116, 'int32u', 1, struct.pack(order + 'I', HEIGHT)),
            (0x0117, 'int32u', 1, struct.pack(order + 'I', WIDTH * HEIGHT * 3)),
            (0x8769, 'int32u', 1, EXIF_IFD),
            (0x8825, 'int32u', 1, GPS_IFD)]

def gps_base(order='>'):
    '''The GPS IFD the fixtures share: 51 deg 15 min N, 0 deg 59 min E, 2031 m, no altitude ref.'''
    return [(0x0000, 'undefined', 4, b'\\x02\\x03\\x00\\x00'),
            (LATITUDE_REF, 'ascii', 2, b'N\\0'),
            (0x0002, 'rational64u', 3, rational((51, 1), (15, 1), (0, 1), order=order)),
            (LONGITUDE_REF, 'ascii', 2, b'E\\0'),
            (0x0004, 'rational64u', 3, rational((0, 1), (59, 1), (0, 1), order=order)),
            (ALTITUDE, 'rational64u', 1, rational((2031, 1), order=order))]

EXIF_TIME_ENTRIES = [(0x9003, 'ascii', 20, b'2026:10:04 13:10:01\\0'),
                     (0x9011, 'ascii', 7, b'+01:00\\0')]

_JPEG_BASE = None

def jpeg_base():
    '''A plain Pillow JPEG of the same size, which the fixtures splice their EXIF block into.'''
    global _JPEG_BASE
    if _JPEG_BASE is None:
        buffer = io.BytesIO()
        Image.new('RGB', (WIDTH, HEIGHT), 'red').save(buffer, 'JPEG', quality=92)
        _JPEG_BASE = buffer.getvalue()
    return _JPEG_BASE

def app1(payload):
    '''A JPEG whose only APP1 segment carries the given payload as its EXIF block.'''
    base = jpeg_base()
    segment = b'\\xff\\xe1' + struct.pack('>H', len(payload) + 8) + b'Exif\\0\\0' + payload
    return base[:2] + segment + base[2:]
`;

// GPS ref tags stored with the wrong EXIF type. ExifTool reads a tag in the format its own
// directory entry declares (Exif.pm:6385, sized at :6407) and replaces that format only when the
// tag table declares a `Format` of its own (Exif.pm:6634-6648). GPSLatitudeRef, GPSLongitudeRef
// and GPSAltitudeRef declare `Writable` alone (GPS.pm:65, :83, :100), so a rational, SHORT, LONG
// or string ref is converted as that type rather than truncated to a byte or rejected, and the
// composites test that converted value: /^S/i (GPS.pm:381), /^W/i (GPS.pm:402) and Perl
// truthiness (GPS.pm:419), which is false only for '' and '0'. Two real Xiaomi Mi-4c JPEGs store
// GPSAltitudeRef as rational64u 200/100, the XIAOMI_ALTITUDE_REF bytes below, where int8u belongs.
const BUILD_REFS = TIFF_BUILDER + `
root = Path(sys.argv[1])
names = []

def gps_ifd(ref):
    '''The shared GPS IFD in tag order, with the given ref as the only entry for its own tag.'''
    return sorted([entry for entry in gps_base() if entry[0] != ref[0]] + [ref])

def build(name, ref):
    (root / name).write_bytes(app1(blob(header_ifd0(), gps_ifd(ref), EXIF_TIME_ENTRIES)))
    names.append(name)

# A byte is expected, so every one of these is the wrong type for GPSAltitudeRef.
for value in (0, 1, 2):
    build('ref-altitude-rational-%d.jpg' % value,
          (ALTITUDE_REF, 'rational64u', 1, rational((value * 100, 100))))
    build('ref-altitude-int16u-%d.jpg' % value, (ALTITUDE_REF, 'int16u', 1, struct.pack('>H', value)))
    build('ref-altitude-int32u-%d.jpg' % value, (ALTITUDE_REF, 'int32u', 1, struct.pack('>I', value)))
    build('ref-altitude-string-%d.jpg' % value,
          (ALTITUDE_REF, 'ascii', 2, ('%d\\0' % value).encode('ascii')))
build('ref-altitude-xiaomi.jpg', (ALTITUDE_REF, 'rational64u', 1, XIAOMI_ALTITUDE_REF))
# The same eight bytes as eight BYTEs and as two SHORTs: ExifTool keeps every element.
build('ref-altitude-bytes8.jpg', (ALTITUDE_REF, 'byte', 8, XIAOMI_ALTITUDE_REF))
build('ref-altitude-int16u-pair.jpg', (ALTITUDE_REF, 'int16u', 2, struct.pack('>HH', 0, 200)))

# A string is expected here, so a numeric ref is the wrong type. 83 and 87 are the byte codes of
# the 'S' and 'W' the ref should have held: they must not be read back as those letters.
for tag, short, letter in ((LATITUDE_REF, 'latitude', 'S'), (LONGITUDE_REF, 'longitude', 'W')):
    for value in (0, 1, 2):
        build('ref-%s-byte-%d.jpg' % (short, value), (tag, 'byte', 1, bytes([value])))
    build('ref-%s-byte-%d.jpg' % (short, ord(letter)), (tag, 'byte', 1, bytes([ord(letter)])))
    build('ref-%s-int16u-%d.jpg' % (short, ord(letter)), (tag, 'int16u', 1, struct.pack('>H', ord(letter))))
    build('ref-%s-rational.jpg' % short, (tag, 'rational64u', 1, XIAOMI_ALTITUDE_REF))

print(json.dumps(names))
`;

// GPS tags stored twice in the same IFD. exifr reads a picked tag once and drops it from its pick
// list, so it keeps the FIRST entry; ExifTool gives a later value the same priority as the stored
// one and replaces it on `$priority >= $oldPriority` (ExifTool.pm:9540-9542), walking the directory
// in file order, so the LAST entry wins. The two Xiaomi Mi-4c JPEGs store GPSAltitudeRef twice -
// XIAOMI_ALTITUDE_REF at entry 0, then the int8u 0 the spec asks for at entry 5 - which is the
// first fixture below. Every container the port reads the block from is covered, in both byte
// orders, plus an entry ExifTool cannot read at all and so passes over.
const BUILD_DUPLICATES = TIFF_BUILDER + `
root = Path(sys.argv[1])
names = []

def build(name, extra, order='>'):
    '''The shared GPS IFD plus extra entries, which duplicate tags the IFD already carries.'''
    (root / name).write_bytes(app1(blob(header_ifd0(order), gps_base(order) + extra,
                                        EXIF_TIME_ENTRIES, order)))
    names.append(name)

def build_tiff(name, extra, order='>'):
    '''A complete TIFF file, because prepare() has to open it with Pillow.'''
    (root / name).write_bytes(blob(image_ifd0(order), gps_base(order) + extra,
                                   EXIF_TIME_ENTRIES, order, bytes(WIDTH * HEIGHT * 3)))
    names.append(name)

def build_chunk(name, extra):
    '''The same block in the container chunk exifr cannot reach on its own.'''
    Image.new('RGB', (WIDTH, HEIGHT), 'red').save(
        root / name, exif=blob(header_ifd0(), gps_base() + extra, EXIF_TIME_ENTRIES))
    names.append(name)

def patch_app1(name, needle, at, replacement):
    '''Replace bytes inside the APP1 EXIF block, the only place the needle is looked for.'''
    data = bytearray((root / name).read_bytes())
    end = 4 + struct.unpack('>H', bytes(data[4:6]))[0]
    start = data.find(needle, 12, end)
    assert start > 0, '%s: %s not found in the EXIF block' % (name, needle.hex())
    data[start + at:start + at + len(replacement)] = replacement
    (root / name).write_bytes(bytes(data))

XIAOMI_DUP = [(ALTITUDE_REF, 'rational64u', 1, XIAOMI_ALTITUDE_REF),
              (ALTITUDE_REF, 'byte', 1, b'\\0')]
LITTLE_DUP = [(ALTITUDE_REF, 'rational64u', 1, rational((200, 100), order='<')),
              (ALTITUDE_REF, 'byte', 1, b'\\0')]

build('dup-altref-rational-then-byte.jpg', XIAOMI_DUP)
build('dup-altref-byte-then-rational.jpg', list(reversed(XIAOMI_DUP)))
build('dup-triple-altref.jpg', XIAOMI_DUP[:1]
      + [(ALTITUDE_REF, 'byte', 1, b'\\x01'), (ALTITUDE_REF, 'int16u', 1, struct.pack('>H', 0))])
# The middle entry of these would give the opposite hemisphere to the last one.
build('dup-latref-n-then-s.jpg', [(LATITUDE_REF, 'ascii', 2, b'S\\0')])
build('dup-triple-latref.jpg', [(LATITUDE_REF, 'ascii', 2, b'S\\0'),
                                (LATITUDE_REF, 'ascii', 2, b'N\\0'),
                                (LATITUDE_REF, 'ascii', 2, b'S\\0')])
# A duplicated reading rather than a duplicated ref, and the same block in every byte order and
# container the port locates one in.
build('dup-altitude.jpg', [(ALTITUDE, 'rational64u', 1, rational((7, 2)))])
build('dup-altref-le.jpg', LITTLE_DUP, '<')
build_tiff('dup-be.tif', XIAOMI_DUP)
build_tiff('dup-le.tif', LITTLE_DUP, '<')
build_chunk('dup-altref.png', XIAOMI_DUP)
build_chunk('dup-altref.webp', XIAOMI_DUP)

# An entry ExifTool cannot read is passed over, which leaves the previous one in place: a value
# offset beyond the end of the file ('Bad offset for GPS GPSAltitudeRef') and a format code of 0.
build('dup-altref-beyond-eof.jpg', XIAOMI_DUP[:1] + [(ALTITUDE_REF, 'byte', 8, bytes(8))])
patch_app1('dup-altref-beyond-eof.jpg', struct.pack('>HHI', ALTITUDE_REF, FORMATS['byte'], 8),
           8, struct.pack('>I', 0xffffff00))
build('dup-altref-badformat.jpg', XIAOMI_DUP[:1] + [(ALTITUDE_REF, 'int32u', 1, bytes(4))])
patch_app1('dup-altref-badformat.jpg', struct.pack('>HHI', ALTITUDE_REF, FORMATS['int32u'], 1),
           2, struct.pack('>H', 0))

# The block spliced into the HEIC fixture: sips normalizes a duplicate away when it writes one, so
# the Exif item is rebuilt around the smallest IFD0 that still points at the GPS IFD. The entries go
# in the opposite order to the JPEG this HEIC is converted from, so a splice that quietly did not
# happen cannot leave the fixture reporting the altitude it was converted with.
(root / 'dup-heic-block.bin').write_bytes(blob([(0x8825, 'int32u', 1, GPS_IFD)],
                                               gps_base() + list(reversed(XIAOMI_DUP)), []))

print(json.dumps(names))
`;

// Splices that block into a sips-written HEIC, replacing the start of the Exif item's own TIFF
// block and leaving the rest of the item alone. The item is found by its `Exif\0\0` wrapper, so the
// port's HEIF locator has to agree with exiftool about which block the duplicate sits in.
const SPLICE_HEIC = TIFF_BUILDER + `
# Bytes per element of each TIFF format code, for the extent walk below.
FORMAT_BYTES = dict(enumerate([0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4]))

def tiff_extent(block):
    '''The highest byte the block's own directories and out-of-line values reach.'''
    order = '<' if block[0:2] == b'II' else '>'
    end = 8
    pending, seen = [struct.unpack(order + 'I', block[4:8])[0]], set()
    while pending:
        at = pending.pop()
        if at in seen or at + 2 > len(block):
            continue
        seen.add(at)
        count = struct.unpack(order + 'H', block[at:at + 2])[0]
        end = max(end, at + 2 + 12 * count + 4)
        for index in range(count):
            entry = at + 2 + 12 * index
            if entry + 12 > len(block):
                break
            tag, fmt, size = struct.unpack(order + 'HHI', block[entry:entry + 8])
            payload = struct.unpack(order + 'I', block[entry + 8:entry + 12])[0]
            if tag in (0x8769, 0x8825, 0xa005):
                pending.append(payload)
            elif size * FORMAT_BYTES.get(fmt, 0) > 4:
                end = max(end, payload + size * FORMAT_BYTES[fmt])
    return end

heic, block = Path(sys.argv[1]), Path(sys.argv[2]).read_bytes()
data = bytearray(heic.read_bytes())
starts = []
for order in (b'MM' + struct.pack('>H', 42), b'II' + struct.pack('<H', 42)):
    needle = b'Exif\\0\\0' + order
    at = data.find(needle)
    while at >= 0:
        # The TIFF header of the item starts right after its 'Exif\\0\\0' wrapper.
        starts.append(at + 6)
        at = data.find(needle, at + 1)
assert len(starts) == 1, 'expected one Exif item TIFF header, found %d' % len(starts)
start = starts[0]
room = tiff_extent(bytes(data[start:]))
assert len(block) <= room, 'the %d byte block does not fit the %d byte Exif item' % (len(block), room)
data[start:start + len(block)] = block
heic.write_bytes(bytes(data))
`;

// The Python reference: ExifTool's own JSON through metadata(), and prepare() for the size.
const REFERENCE = `
import json, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from photo_metadata import metadata, prepare

TAGS = ['-j', '-n', '-GPSLatitude', '-GPSLongitude', '-GPSAltitude', '-GPSDateTime',
        '-DateTimeOriginal', '-SubSecDateTimeOriginal', '-OffsetTimeOriginal']
results = []
output = Path(tempfile.mkdtemp())
for entry in json.loads(Path(sys.argv[2]).read_text()):
    source = Path(entry['path'])
    result = {'name': entry['name']}
    try:
        found = subprocess.run(['exiftool'] + TAGS + [str(source)], check=True,
                               capture_output=True, text=True)
        tags = json.loads(found.stdout)[0]
        result['tags'] = tags
        result['metadata'] = metadata(tags)
    except BaseException as error:
        result['tagError'] = '%s: %s' % (type(error).__name__, error)
    try:
        result['prepared'] = prepare(source, output / (entry['name'] + '.png'))
    except BaseException as error:
        result['error'] = '%s: %s' % (type(error).__name__, error)
    try:
        from PIL import Image
        with Image.open(source) as image:
            result['frames'] = getattr(image, 'n_frames', 1)
    except BaseException as error:
        result['frames'] = 'unreadable: %s' % type(error).__name__
    results.append(result)
print(json.dumps(results, allow_nan=False))
`;

// Python's own parser, for the capture-time texts.
const REFERENCE_TIMES = `
import json, sys
from datetime import datetime, timezone
results = []
for text in json.loads(sys.argv[1]):
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        results.append(None)
        continue
    offset = moment.utcoffset()
    if offset is None:
        utc = moment.replace(tzinfo=timezone.utc)
        results.append({'offset': None, 'utc': utc.isoformat().replace('+00:00', 'Z')})
        continue
    try:
        utc = moment.astimezone(timezone.utc)
    except OverflowError:
        results.append('OVERFLOW')
        continue
    results.append({'offset': int(offset.total_seconds()),
                    'utc': utc.isoformat().replace('+00:00', 'Z')})
print(json.dumps(results, allow_nan=False))
`;

const RICH = ['-Orientation#=6', '-GPSLatitude=51.234567890123', '-GPSLatitudeRef=S',
  '-GPSLongitude=0.987654321', '-GPSLongitudeRef=W', '-GPSAltitude=7.5', '-GPSAltitudeRef#=1',
  '-GPSDateStamp=2026:10:04', '-GPSTimeStamp=11:10:01.25', '-DateTimeOriginal=2026:10:04 13:10:01',
  '-OffsetTimeOriginal=+01:00', '-SubSecTimeOriginal=125'];
const ZONED = ['-DateTimeOriginal=2026:10:04 13:10:01', '-OffsetTimeOriginal=+01:00'];

run(python, ['-c', MAKE_IMAGES, temp]);
const refNames = JSON.parse(run(python, ['-c', BUILD_REFS, temp]));
const dupNames = JSON.parse(run(python, ['-c', BUILD_DUPLICATES, temp]));
// The HEIC duplicate is converted and spliced below; a builder that quietly wrote nothing would
// otherwise take the whole duplicate case out of the comparison without failing anything.
assert.equal(dupNames.length, 13, 'BUILD_DUPLICATES should have written every duplicate fixture');
const tag = (args, ...names) => run('exiftool', ['-overwrite_original', ...args, ...names.map(file)]);
tag(['-GPSLatitude=51.25', '-GPSLatitudeRef=N', '-GPSLongitude=0.5', '-GPSLongitudeRef=E',
  '-GPSAltitude=120', '-GPSAltitudeRef#=0', ...ZONED], 'gps-ne.jpg');
tag(['-GPSLatitude=51.25', '-GPSLatitudeRef=S', '-GPSLongitude=0.5', '-GPSLongitudeRef=W',
  '-GPSAltitude=12', '-GPSAltitudeRef#=1', ...ZONED], 'gps-sw.jpg');
tag(['-GPSLatitude=0', '-GPSLatitudeRef=S', '-GPSLongitude=0', '-GPSLongitudeRef=W',
  '-GPSAltitude=0', '-GPSAltitudeRef#=1'], 'gps-zero.jpg');
tag(['-GPSLatitude=51.25', '-GPSLatitudeRef=N'], 'gps-partial.jpg');
tag(['-GPSLatitude=91', '-GPSLatitudeRef=N', '-GPSLongitude=0.5', '-GPSLongitudeRef=E'], 'gps-invalid.jpg');
tag(['-GPSLatitude=51.234567890123', '-GPSLatitudeRef=S', '-GPSLongitude=0.987654321',
  '-GPSLongitudeRef=W', '-GPSAltitude=0.33333333333333', '-GPSAltitudeRef#=0'], 'gps-precise.jpg');
tag(['-GPSLatitude=51.25', '-GPSLatitudeRef=N', '-GPSLongitude=0.5', '-GPSLongitudeRef=E'], 'gps-broken.jpg');
tag(ZONED, 'time-offset.jpg');
tag(['-DateTimeOriginal=2026:10:04 13:10:01'], 'time-plain.jpg');
tag([...ZONED, '-SubSecTimeOriginal=125'], 'time-subsec.jpg');
tag([...ZONED, '-SubSecTimeOriginal=1234567'], 'time-subsec7.jpg');
tag(['-SubSecTimeOriginal=123'], 'time-subsec-only.jpg');
tag(['-GPSDateStamp=2026:10:04', '-GPSTimeStamp=11:10:01.25'], 'time-gps.jpg');
tag(['-GPSDateStamp=2026:10:04'], 'time-gps-date.jpg');
// Only the offset is written here: ExifTool would normalise the dashed Pillow date, and the point
// of this file is the branch where metadata() appends OffsetTimeOriginal to an unzoned time itself.
tag(['-OffsetTimeOriginal=+01:00'], 'time-dash.jpg');
tag(RICH, 'fmt.jpg', 'fmt.png', 'fmt.webp', 'fmt.tif', 'progressive.jpg');
tag(ZONED, 'anim.png', 'anim.webp', 'multi.tif');
for (let orientation = 1; orientation <= 8; orientation++) tag([`-Orientation#=${orientation}`], `or${orientation}.jpg`);
run(python, ['-c', BREAK_RATIONAL, file('gps-broken.jpg')]);
writeFileSync(file('garbage.jpg'), 'not a photo');
writeFileSync(file('empty.jpg'), '');

// HEIC needs macOS sips for the Python half, so those cases are skipped cleanly elsewhere.
const heic = [];
if (process.platform === 'darwin') {
  for (const name of ['fmt', 'time-dash', 'or6']) {
    try {
      run('sips', ['-s', 'format', 'heic', file(`${name}.jpg`), '--out', file(`${name}.heic`)]);
      heic.push(`${name}.heic`);
    } catch {
      heic.length = 0;
      break;
    }
  }
  // sips derives the orientation from the HEIF irot box; or6.heic keeps only that one, fmt.heic
  // keeps EXIF and irot (which agree) and time-dash.heic has neither.
  if (heic.includes('or6.heic')) run('exiftool', ['-overwrite_original', '-Orientation#=', file('or6.heic')]);
  // sips also normalizes a duplicated GPS entry away, so the duplicate goes back into the Exif item
  // by hand: this is the only HEIF case where the port's own locator has to find the same block
  // exiftool reads the duplicate from.
  try {
    run('sips', ['-s', 'format', 'heic', file('dup-altref-rational-then-byte.jpg'),
      '--out', file('dup-altref.heic')]);
    run(python, ['-c', SPLICE_HEIC, file('dup-altref.heic'), file('dup-heic-block.bin')]);
    heic.push('dup-altref.heic');
  } catch (error) {
    // No sips is a clean skip, but a splice that fails while the HEIC cases above built is not.
    if (heic.length > 0) throw error;
  }
}

const names = ['gps-ne.jpg', 'gps-sw.jpg', 'gps-zero.jpg', 'gps-partial.jpg', 'gps-invalid.jpg',
  'gps-precise.jpg', 'gps-broken.jpg', 'time-offset.jpg', 'time-plain.jpg', 'time-subsec.jpg',
  'time-subsec7.jpg', 'time-subsec-only.jpg', 'time-gps.jpg', 'time-gps-date.jpg', 'time-none.jpg',
  'time-dash.jpg', 'time-embedded.jpg', 'time-duplicate.jpg', 'plain.jpg', 'plain.png', 'tiny.png',
  'fmt.jpg', 'fmt.png', 'fmt.webp', 'fmt.tif', 'lossless.webp', 'progressive.jpg',
  'garbage.jpg', 'empty.jpg',
  'anim.png', 'anim.webp', 'multi.tif',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `or${n}.jpg`), ...refNames, ...dupNames, ...heic];
const manifest = file('manifest.json');
writeFileSync(manifest, JSON.stringify(names.map((name) => ({ name, path: file(name) }))));

const expected = JSON.parse(run(python, ['-c', REFERENCE, join(studio, 'scripts'), manifest]));
const expectedTimes = JSON.parse(run(python, ['-c', REFERENCE_TIMES, JSON.stringify(TIME_TEXTS)]));

// The orientation prepare() applies to a HEIC is the one sips writes into its decoded PNG.
const orientationSource = (name) => {
  if (!name.endsWith('.heic')) return file(name);
  const decoded = file(`${name}.decoded.png`);
  run('sips', ['-s', 'format', 'png', file(name), '--out', decoded]);
  return decoded;
};
const sources = new Map(names.map((name) => [name, orientationSource(name)]));
const orientationOf = new Map(exiftoolJson(['-j', '-n', '-Orientation'], [...sources.values()])
  .map((entry) => [normalize(entry.SourceFile), entry.Orientation ?? null]));

// ---------------------------------------------------------------- comparison

// The location every wrong-typed ref and duplicate fixture carries: 51 deg 15 min N, 0 deg 59 min E.
const refGps = (altitude) => ({ gps: { lat: 51.25, lon: 0.983333333333333, altitude } });
const southGps = (altitude) => ({ gps: { lat: -51.25, lon: 0.983333333333333, altitude } });

// Spot checks: agreeing with the reference is the point of the test, but these are the values the
// studio relies on, so a change in either implementation has to be a deliberate one.
const SPOT_CHECKS = {
  'gps-sw.jpg': { gps: { lat: -51.25, lon: -0.5, altitude: -12 }, capturedUtc: '2026-10-04T12:10:01Z', width: 60, height: 40 },
  'gps-zero.jpg': { gps: { lat: 0, lon: 0, altitude: 0 }, capturedUtc: null },
  'gps-invalid.jpg': { gps: null, warnings: ['No valid EXIF GPS location; location stays missing.',
    'No timezone-bearing capture time or GPS UTC; choose the ride time manually.'] },
  'gps-precise.jpg': { gps: { lat: -51.2345678901283, lon: -0.987654320988889, altitude: 0.3333333333 } },
  'gps-broken.jpg': { gps: null },
  'time-subsec.jpg': { captureTime: '2026:10:04 13:10:01.125+01:00', capturedUtc: '2026-10-04T12:10:01.125000Z',
    clockSource: 'EXIF original capture time with timezone offset' },
  'time-subsec7.jpg': { captureTime: '2026:10:04 13:10:01.1234567+01:00', capturedUtc: '2026-10-04T12:10:01.123456Z' },
  'time-offset.jpg': { captureTime: '2026:10:04 13:10:01+01:00', capturedUtc: '2026-10-04T12:10:01Z' },
  'time-plain.jpg': { capturedUtc: null, clockSource: null },
  'time-gps.jpg': { captureTime: null, capturedUtc: '2026-10-04T11:10:01.250000Z',
    clockSource: 'EXIF GPS UTC (GPS fix time, approximate capture time)' },
  'time-gps-date.jpg': { capturedUtc: null },
  'time-dash.jpg': { captureTime: '2026-10-04 13:10:01', capturedUtc: '2026-10-04T12:10:01Z' },
  'time-embedded.jpg': { captureTime: '2026:10:04 13:10:01+02:00', capturedUtc: '2026-10-04T11:10:01Z' },
  'time-duplicate.jpg': { captureTime: '2026:10:04 13:10:01', capturedUtc: null },
  'or6.jpg': { orientation: 6, width: 40, height: 60 },
  'or8.jpg': { orientation: 8, width: 40, height: 60 },
  'or3.jpg': { orientation: 3, width: 60, height: 40 },
  'fmt.jpg': { orientation: 6, width: 40, height: 60, gps: { lat: -51.2345678901283, lon: -0.987654320988889, altitude: -7.5 } },
  'fmt.png': { orientation: 6, width: 10, height: 20 },
  'fmt.webp': { orientation: 6, width: 40, height: 60 },
  'fmt.tif': { orientation: 6, width: 40, height: 60 },
  'fmt.heic': { orientation: 6, width: 40, height: 60 },
  'or6.heic': { orientation: 6, width: 40, height: 60 },
  'lossless.webp': { orientation: null, width: 60, height: 40 },
  'progressive.jpg': { orientation: 6, width: 40, height: 60 },
  'tiny.png': { width: 1, height: 1 },
  // Wrong-typed refs. Every one of these fixtures sits at 51 deg 15 min N, 0 deg 59 min E with a
  // stored altitude of 2031 m, so only the sign of the altitude can differ. ExifTool converts the
  // stored type instead of re-reading it as the expected int8u, and Perl truthiness is false only
  // for '' and '0', so every other ref puts the photo below sea level.
  'ref-altitude-rational-0.jpg': refGps(2031),
  'ref-altitude-rational-2.jpg': refGps(-2031),
  'ref-altitude-int16u-0.jpg': refGps(2031),
  'ref-altitude-int32u-2.jpg': refGps(-2031),
  'ref-altitude-string-0.jpg': refGps(2031),
  'ref-altitude-string-1.jpg': refGps(-2031),
  // The two Xiaomi Mi-4c bytes: rational64u 200/100 converts to 2, which is below sea level.
  'ref-altitude-xiaomi.jpg': refGps(-2031),
  'ref-altitude-bytes8.jpg': refGps(-2031),
  'ref-altitude-int16u-pair.jpg': refGps(-2031),
  // 83 and 87 are the byte codes of 'S' and 'W', but the composite regexes the decoded ref, so a
  // numeric ref of that value is a number and never a hemisphere.
  'ref-latitude-byte-1.jpg': refGps(2031),
  'ref-latitude-byte-83.jpg': refGps(2031),
  'ref-latitude-int16u-83.jpg': refGps(2031),
  'ref-latitude-rational.jpg': refGps(2031),
  'ref-longitude-byte-87.jpg': refGps(2031),
  'ref-longitude-int16u-87.jpg': refGps(2031),
  'ref-longitude-rational.jpg': refGps(2031),
  // Duplicated GPS entries, at the same location and the same stored 2031 m. Only the last entry
  // of a tag decides anything, which is ExifTool's rule and the opposite of exifr's: the two
  // Xiaomi Mi-4c bytes as a rational then as the int8u 0 the spec asks for read as above sea
  // level, and the same two entries the other way round read as below it.
  'dup-altref-rational-then-byte.jpg': { ...refGps(2031), capturedUtc: '2026-10-04T12:10:01Z' },
  'dup-altref-byte-then-rational.jpg': refGps(-2031),
  'dup-triple-altref.jpg': refGps(2031),
  'dup-latref-n-then-s.jpg': southGps(2031),
  'dup-triple-latref.jpg': southGps(2031),
  'dup-altitude.jpg': refGps(3.5),
  // Both byte orders, and every container the port locates an EXIF block in. The TIFF file has no
  // container header to take its size from, so it is the IFD0 one that has to be read.
  'dup-altref-le.jpg': refGps(2031),
  'dup-be.tif': { ...refGps(2031), width: 60, height: 40 },
  'dup-le.tif': refGps(2031),
  'dup-altref.png': refGps(2031),
  'dup-altref.webp': refGps(2031),
  // The spliced HEIF Exif item carries the same two entries the other way round, so it reads below
  // sea level; sips' own conversion of that JPEG keeps a single int8u 0 and would read +2031. Its
  // compact block has no Exif IFD, so the capture time stays missing.
  'dup-altref.heic': { ...refGps(-2031), orientation: 1, width: 60, height: 40, captureTime: null },
  // An entry ExifTool cannot read is passed over, so the readable entry before it still decides.
  'dup-altref-beyond-eof.jpg': refGps(-2031),
  'dup-altref-badformat.jpg': refGps(-2031),
};

const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { readPhotoMetadata, photoMetadata } = await loader.ssrLoadModule('/src/importers/photo.ts');
  const { parseExifInstant, formatUtcIso } = await loader.ssrLoadModule('/src/importers/exifTime.ts');
  const KEYS = ['captureTime', 'capturedUtc', 'clockSource', 'gps', 'height', 'orientation', 'warnings', 'width'];
  let sized = 0;
  let tags = 0;
  let unreadable = 0;
  let multiFrame = 0;
  for (const entry of expected) {
    const bytes = new Uint8Array(readFileSync(file(entry.name)));
    let actual;
    try {
      actual = await readPhotoMetadata(bytes);
    } catch (error) {
      actual = { error: `${error.name}: ${error.message}` };
    }
    // metadata() fed with ExifTool's own JSON must agree before the port's own tag rebuild can.
    if (entry.metadata) {
      assert.deepEqual(photoMetadata(entry.tags), entry.metadata, `${entry.name}: metadata(exiftool json)`);
      tags++;
    }
    if (entry.prepared) {
      assert.equal(actual.error, undefined, `${entry.name}: ${actual.error}`);
      assert.deepEqual(Object.keys(actual).sort(), KEYS, `${entry.name}: result keys`);
      const { gps, captureTime, capturedUtc, clockSource, warnings, width, height } = actual;
      assert.deepEqual({ gps, captureTime, capturedUtc, clockSource, warnings, width, height },
        entry.prepared, `${entry.name}: readPhotoMetadata() vs prepare()`);
      assert.equal(actual.orientation, orientationOf.get(normalize(sources.get(entry.name))), `${entry.name}: orientation`);
      for (const [key, value] of Object.entries(SPOT_CHECKS[entry.name] ?? {})) {
        assert.deepEqual(actual[key], value, `${entry.name}: ${key}`);
      }
      sized++;
      continue;
    }
    if (/single still/.test(entry.error ?? '')) {
      // exifr reports no frame count, so the port cannot reject animated/multipage input; the
      // metadata half still has to match and rejection stays with the Python pixel step.
      assert.ok(entry.frames > 1, `${entry.name}: Pillow should see the extra frames`);
      assert.deepEqual(Object.keys(actual).sort(), KEYS, `${entry.name}: no invented frame field`);
      assert.deepEqual({ gps: actual.gps, captureTime: actual.captureTime, capturedUtc: actual.capturedUtc,
        clockSource: actual.clockSource, warnings: actual.warnings }, entry.metadata, `${entry.name}: metadata`);
      multiFrame++;
      continue;
    }
    assert.match(actual.error ?? '', /Cannot identify image file/, `${entry.name}: ${entry.error}`);
    unreadable++;
  }

  const actualTimes = TIME_TEXTS.map((text) => {
    try {
      const instant = parseExifInstant(text);
      if (instant === null) return null;
      return { offset: instant.offsetSeconds, utc: formatUtcIso(instant.utcMicros) };
    } catch {
      return 'OVERFLOW';
    }
  });
  assert.deepEqual(actualTimes, expectedTimes, 'capture-time texts vs datetime.fromisoformat');

  console.log(`Photo metadata port passed: ${sized} stills matched prepare(), ${tags} matched`
    + ` metadata(exiftool json), ${unreadable} unreadable files failed the same way,`
    + ` ${TIME_TEXTS.length} capture-time texts matched fromisoformat,`
    + ` HEIC ${heic.length ? `included (${heic.join(', ')})` : 'skipped: no sips'}.`);
  console.log(`${multiFrame} animated/multipage files matched metadata() only: exifr exposes no frame`
    + ' count, so prepare()\'s "single still image" rejection stays with the Python pixel step.');
} finally {
  await loader.close();
  rmSync(temp, { recursive: true, force: true });
}
