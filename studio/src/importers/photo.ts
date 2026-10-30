/**
 * Still-photo metadata: the TypeScript twin of `metadata()` in `scripts/photo_metadata.py`, plus
 * the oriented pixel size that its `prepare()` reports. Pixel work (the orientation transform
 * itself, the metadata-free PNG, HEIC decoding) stays in Python for now, so this module only reads
 * headers and runs unchanged in Node, Electron and a browser.
 *
 * The reference is fed the JSON of
 * `exiftool -j -n -GPSLatitude -GPSLongitude -GPSAltitude -GPSDateTime -DateTimeOriginal
 * -SubSecDateTimeOriginal -OffsetTimeOriginal`, and three of those are ExifTool composites that
 * `exifr` does not produce. They are rebuilt here with ExifTool's own rules (cited per helper)
 * before the port of `metadata()` runs on them, which keeps the two implementations comparable.
 *
 * Multi-frame input is not rejected here: exifr surfaces no frame count (it has no WebP parser at
 * all, and PNG `acTL`/extra TIFF IFDs stay inside the library), so the "Import a single still
 * image" check stays with the Python pixel step instead of being faked.
 */
import exifr from 'exifr';
import type { PhotoFile } from '../core/project';
import { formatUtcIso, parseExifInstant } from './exifTime';
import { duplicateGpsTags } from './gpsIfd';
import { readContainer, type ContainerInfo } from './imageContainer';

/** What `prepare()` prints, plus the orientation that decided the reported size. */
export type PhotoMetadata = Omit<PhotoFile, 'id' | 'rideId' | 'label'> & { orientation: number | null };

/** ExifTool's `-j -n` view of the seven tags the Python reference asks for. */
export interface PhotoTags {
  GPSLatitude?: number | string;
  GPSLongitude?: number | string;
  GPSAltitude?: number | string;
  GPSDateTime?: string;
  DateTimeOriginal?: string;
  SubSecDateTimeOriginal?: string;
  OffsetTimeOriginal?: string;
}

/** The result of `metadata()`. */
export interface PhotoInfo {
  gps: PhotoFile['gps'];
  captureTime: string | null;
  capturedUtc: string | null;
  clockSource: string | null;
  warnings: string[];
}

type RawTags = Record<string, unknown>;

// Pillow and a few other writers put the EXIF time tags in IFD0, where exifr's IFD0 dictionary has
// no names for them, so they are picked by number. ExifTool reports such a copy ahead of the one in
// the Exif IFD (measured with `-G1` on a file carrying both), hence the numeric key wins below.
const IFD0_DATE_TIME_ORIGINAL = 0x9003;
const IFD0_SUB_SEC_TIME_ORIGINAL = 0x9292;
const IFD0_OFFSET_TIME_ORIGINAL = 0x9011;
const IFD0_TIME_TAGS = [IFD0_DATE_TIME_ORIGINAL, IFD0_SUB_SEC_TIME_ORIGINAL, IFD0_OFFSET_TIME_ORIGINAL];

// Raw values only: the reference compares against ExifTool text ('2026:10:04 13:10:01', '+01:00',
// Orientation 6), so nothing may be revived into a Date or run through a value dictionary.
const EXIFR_OPTIONS = {
  translateValues: false,
  reviveValues: false,
  mergeOutput: true,
  silentErrors: true,
  ifd0: { pick: ['Orientation', 'ImageWidth', 'ImageHeight', ...IFD0_TIME_TAGS] },
  exif: { pick: ['DateTimeOriginal', 'SubSecTimeOriginal', 'OffsetTimeOriginal'] },
  gps: {
    pick: ['GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef',
      'GPSAltitude', 'GPSAltitudeRef', 'GPSDateStamp', 'GPSTimeStamp'],
  },
};

/** macOS `sips` turns a HEIF `irot` angle into these EXIF orientations, ignoring the EXIF one. */
const IROT_TO_ORIENTATION = [1, 8, 3, 6];

/**
 * Read a still's EXIF/GPS tags, the oriented pixel size and the warnings the Python importer
 * produces, without touching the input. Throws when the container is not a recognisable still.
 */
export async function readPhotoMetadata(input: Uint8Array): Promise<PhotoMetadata> {
  const container = readContainer(input);
  if (container.kind === 'unknown') throw new Error('Cannot identify image file: unsupported photo container');
  const tags = await readTags(input, container);
  // A GPS tag stored twice in the same IFD is read back as its last entry, the way ExifTool reads
  // it; exifr keeps the first. Files without duplicates are left exactly as exifr reported them.
  const raw = { ...tags, ...duplicateGpsTags(container.exifBlock) };
  const { gps, captureTime, capturedUtc, clockSource, warnings } = photoMetadata(exifToolTags(raw));
  const orientation = orientationOf(container, raw);
  const { width, height } = storedSize(container, raw);
  // Pillow's `ImageOps.exif_transpose` swaps the stored size for orientations 5-8.
  const swapped = orientation !== null && orientation >= 5 && orientation <= 8;
  return {
    gps,
    captureTime,
    capturedUtc,
    clockSource,
    warnings,
    width: swapped ? height : width,
    height: swapped ? width : height,
    orientation,
  };
}

/**
 * Port of `photo_metadata.py:metadata()`. Same keys, same warning texts, and the same rule that a
 * missing, empty or nonfinite reading stays missing instead of becoming zero.
 */
export function photoMetadata(tags: PhotoTags): PhotoInfo {
  const warnings: string[] = [];
  // ExifTool Composite coordinates include hemisphere and altitude-ref signs.
  const lat = finite(tags.GPSLatitude);
  const lon = finite(tags.GPSLongitude);
  const gps = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    ? { lat, lon, altitude: finite(tags.GPSAltitude) }
    : null;
  if (gps === null) warnings.push('No valid EXIF GPS location; location stays missing.');

  const capture = truthy(tags.SubSecDateTimeOriginal) ? tags.SubSecDateTimeOriginal
    : truthy(tags.DateTimeOriginal) ? tags.DateTimeOriginal : null;
  let capturedUtc: string | null = null;
  let clockSource: string | null = null;
  if (truthy(capture)) {
    let text = exifDate(String(capture));
    if (!/[+-]\d\d:\d\d$/.test(text) && truthy(tags.OffsetTimeOriginal)) text += String(tags.OffsetTimeOriginal);
    const instant = parseExifInstant(text);
    // An unzoned capture time is not assumed to be local, so it stays missing.
    if (instant !== null && instant.offsetSeconds !== null) {
      capturedUtc = formatUtcIso(instant.utcMicros);
      clockSource = 'EXIF original capture time with timezone offset';
    }
  }
  if (capturedUtc === null && truthy(tags.GPSDateTime)) {
    const instant = parseExifInstant(exifDate(String(tags.GPSDateTime)));
    if (instant !== null) {
      // A GPS fix time carries no zone of its own; ExifTool stamps it UTC.
      capturedUtc = formatUtcIso(instant.utcMicros);
      clockSource = 'EXIF GPS UTC (GPS fix time, approximate capture time)';
    }
  }
  if (capturedUtc === null) warnings.push('No timezone-bearing capture time or GPS UTC; choose the ride time manually.');
  return { gps, captureTime: capture === null ? null : String(capture), capturedUtc, clockSource, warnings };
}

/**
 * Read the TIFF/EXIF tags. exifr 7.1.3 has no WebP file parser, so WebP EXIF is handed over as the
 * bare TIFF payload of its RIFF `EXIF` chunk. A container exifr cannot open contributes no tags,
 * which is what ExifTool does for a file whose metadata block is broken.
 */
async function readTags(input: Uint8Array, container: ContainerInfo): Promise<RawTags> {
  const source = container.kind === 'webp' ? container.exifBlock : input;
  if (source === null) return {};
  try {
    return (await exifr.parse(source, EXIFR_OPTIONS)) ?? {};
  } catch {
    return {};
  }
}

/** Rebuild the seven tags `exiftool -j -n` would have printed for the same file. */
function exifToolTags(raw: RawTags): PhotoTags {
  const tags: PhotoTags = {};
  const latitude = signedDegrees(raw.GPSLatitude, raw.GPSLatitudeRef, /^S/i);
  if (latitude !== null) tags.GPSLatitude = latitude;
  const longitude = signedDegrees(raw.GPSLongitude, raw.GPSLongitudeRef, /^W/i);
  if (longitude !== null) tags.GPSLongitude = longitude;
  const altitude = signedAltitude(raw.GPSAltitude, raw.GPSAltitudeRef);
  if (altitude !== null) tags.GPSAltitude = altitude;
  const gpsTime = gpsDateTime(raw.GPSDateStamp, raw.GPSTimeStamp);
  if (gpsTime !== null) tags.GPSDateTime = gpsTime;
  const dateTime = textOf(ifd0First(raw, IFD0_DATE_TIME_ORIGINAL, 'DateTimeOriginal'));
  if (dateTime !== null) tags.DateTimeOriginal = dateTime;
  const offset = textOf(ifd0First(raw, IFD0_OFFSET_TIME_ORIGINAL, 'OffsetTimeOriginal'));
  if (offset !== null) tags.OffsetTimeOriginal = offset;
  const subSec = textOf(ifd0First(raw, IFD0_SUB_SEC_TIME_ORIGINAL, 'SubSecTimeOriginal'));
  const composite = dateTime === null ? null : subSecDateTimeOriginal(dateTime, subSec, offset);
  if (composite !== null) tags.SubSecDateTimeOriginal = composite;
  return tags;
}

/** The IFD0 copy of a tag when a writer put it there, otherwise its Exif IFD copy. */
function ifd0First(raw: RawTags, ifd0Tag: number, exifName: string): unknown {
  return raw[ifd0Tag] ?? raw[exifName];
}

/**
 * ExifTool's Composite GPSLatitude/GPSLongitude: `$val[1] =~ /^S/i ? -$val[0] : $val[0]`
 * (GPS.pm:381) and its `/^W/i` twin (GPS.pm:402). The regex sees the *decoded* ref, so a ref stored
 * with the wrong type never matches a hemisphere letter: a BYTE 83 reads as '83', not 'S'. Without
 * the ref tag the composite is not built and ExifTool prints the plain, unsigned GPS tag instead.
 */
function signedDegrees(value: unknown, ref: unknown, negative: RegExp): number | null {
  const degrees = toDegrees(value);
  if (degrees === null) return null;
  const refText = exifToolText(ref);
  const signed = refText !== null && negative.test(refText) ? -degrees : degrees;
  return printedNumber(noNegativeZero(signed));
}

/**
 * ExifTool's Composite GPSAltitude: `return $val[$_+1] ? -abs($val[$_]) : $val[$_];` (GPS.pm:419).
 * That is Perl truthiness on the decoded ref, false only for an empty value or exactly '0', so any
 * other ref of any stored type puts the photo below sea level. Without any altitude ref the
 * composite is dropped (GPS.pm:415) and ExifTool prints the plain, unsigned GPS tag instead.
 */
function signedAltitude(value: unknown, ref: unknown): number | null {
  const parts = rationalParts(value);
  // A multi-value altitude is not a float: ExifTool joins it with spaces, which is no number.
  if (parts === null || parts.length !== 1) return null;
  const refText = exifToolText(ref);
  const metres = refText !== null && refText !== '' && refText !== '0' ? -Math.abs(parts[0]) : parts[0];
  return printedNumber(noNegativeZero(metres));
}

/** ExifTool's `GPS::ToDegrees`: deg + ((min + sec/60)/60) over the rounded rationals. */
function toDegrees(value: unknown): number | null {
  const parts = rationalParts(value);
  if (parts === null || parts.length === 0) return null;
  const [degrees, minutes = 0, seconds = 0] = parts;
  return degrees + ((minutes + seconds / 60) / 60);
}

/** ExifTool's Composite GPSDateTime: both parts required, `"$date $time" . 'Z'`. */
function gpsDateTime(dateStamp: unknown, timeStamp: unknown): string | null {
  const date = exifDateStamp(dateStamp);
  const time = gpsTimeStamp(timeStamp);
  return date === null || time === null ? null : `${date} ${time}Z`;
}

/** ExifTool's `Exif::ExifDate`: nulls stripped, then any separators between the digits become ':'. */
function exifDateStamp(value: unknown): string | null {
  const text = textOf(value);
  return text === null ? null : text.replace(/(\d{4})\D*(\d{2})\D*(\d{2})$/, '$1:$2:$3');
}

/** ExifTool's `GPS::ConvertTimeStamp`: re-split the total seconds, then trim trailing zeros. */
function gpsTimeStamp(value: unknown): string | null {
  const parts = rationalParts(value);
  if (parts === null) return null;
  const [totalHours = 0, totalMinutes = 0, totalSeconds = 0] = parts;
  let rest = (totalHours * 60 + totalMinutes) * 60 + totalSeconds;
  let hours = Math.trunc(rest / 3600);
  rest -= hours * 3600;
  let minutes = Math.trunc(rest / 60);
  rest -= minutes * 60;
  let seconds = rest.toFixed(9).padStart(12, '0');
  if (Number(seconds) >= 60) {
    seconds = '00';
    minutes += 1;
    if (minutes >= 60) {
      minutes -= 60;
      hours += 1;
    }
  } else {
    seconds = seconds.replace(/\.?0+$/, '');
  }
  return `${pad(hours)}:${pad(minutes)}:${seconds}`;
}

/**
 * ExifTool's Composite SubSecDateTimeOriginal (`%subSecConv` in Exif.pm): sub-seconds are spliced
 * into the first ` HH:MM:SS` that has none yet, and the offset is appended (normalized to two
 * digits) unless the date/time text already carries a sign. DateTimeOriginal is required.
 */
function subSecDateTimeOriginal(dateTime: string, subSec: string | null, offset: string | null): string | null {
  let value: string | null = null;
  const digits = subSec === null ? null : /^(\d+)/.exec(subSec);
  const splicable = / \d{2}:\d{2}:\d{2}(?!\.\d+)/;
  if (digits !== null && splicable.test(dateTime)) {
    value = dateTime.replace(splicable, (match) => `${match}.${digits[1]}`);
  }
  if (offset !== null && !/[-+]/.test(dateTime)) {
    const zoned = /^([-+])(\d{1,2}):(\d{2})/.exec(offset);
    if (zoned !== null) value = `${value ?? dateTime}${zoned[1]}${zoned[2].padStart(2, '0')}:${zoned[3]}`;
  }
  return value;
}

/** HEIF rotation wins (that is what `sips` reports); everywhere else it is the EXIF tag. */
function orientationOf(container: ContainerInfo, raw: RawTags): number | null {
  if (container.irot !== null) return IROT_TO_ORIENTATION[container.irot] ?? null;
  return finite(raw.Orientation);
}

/** The stored, unoriented pixel size: from the container, or from IFD0 for TIFF. */
function storedSize(container: ContainerInfo, raw: RawTags): { width: number; height: number } {
  const width = container.width ?? positiveInteger(raw.ImageWidth);
  const height = container.height ?? positiveInteger(raw.ImageHeight);
  if (width === null || height === null) {
    throw new Error(`Cannot identify image file: no pixel size in the ${container.kind} container`);
  }
  return { width, height };
}

/**
 * The rational components of a tag, each rounded the way ExifTool rounds it. Null when a component
 * is not a finite number: ExifTool turns a zero denominator into 'inf'/'undef' and `ToDegrees` then
 * yields an empty value, so such a reading is missing rather than zero.
 */
function rationalParts(value: unknown): number[] | null {
  const list = typeof value === 'number' ? [value]
    : Array.isArray(value) ? value
      : value instanceof Uint8Array ? Array.from(value)
        : null;
  if (list === null) return null;
  const parts: number[] = [];
  for (const entry of list) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    // ExifTool reads every rational through RoundFloat($num/$den, 10).
    parts.push(Number(entry.toPrecision(10)));
  }
  return parts;
}

/** ExifTool prints results with `%.15g`, which is the precision the reference then parses. */
function printedNumber(value: number): number {
  return Number(value.toPrecision(15));
}

/** ExifTool prints a signed zero as `0`, and Python's JSON reads that back as +0. */
function noNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Python's `finite()`: a missing, empty, non-numeric or nonfinite reading is null, never zero. */
function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

/** Python truthiness of a JSON value, for `tags.get(a) or tags.get(b)` and `if tags.get(x)`. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  return typeof value === 'number' ? value !== 0 : true;
}

/** ASCII text from exifr, which gives strings for ASCII tags and bytes for `undef` ones. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (value instanceof Uint8Array) {
    let text = '';
    for (const byte of value) text += String.fromCharCode(byte);
    text = text.replace(/\0+$/, '').trim();
    return text === '' ? null : text;
  }
  return null;
}

/**
 * A tag value as ExifTool decodes it, in text. ExifTool reads a tag in the format its own directory
 * entry declares (Exif.pm:6385, sized at Exif.pm:6407) and replaces that format only when the tag
 * table declares a `Format` of its own (Exif.pm:6634-6648). GPSLatitudeRef, GPSLongitudeRef and
 * GPSAltitudeRef declare `Writable` alone (GPS.pm:65, GPS.pm:83, GPS.pm:100), which is a writing
 * hint, so a ref stored as a rational, a SHORT, a LONG or a string is *converted* as that type,
 * neither truncated to its first byte nor rejected. `ReadValue` then joins every element with
 * single spaces, which is the text the composites above test.
 */
function exifToolText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(noNegativeZero(value)) : null;
  if (typeof value === 'string') return value.replace(/\0+$/, '');
  // ExifTool reads a one-byte `undef` as int8u (Exif.pm:6587), so bytes print as decimal elements.
  if (value instanceof Uint8Array) return Array.from(value, (byte) => String(byte)).join(' ');
  if (Array.isArray(value)) return joinedText(value);
  // exifr hands back a multi-value SHORT/LONG/RATIONAL tag as an index-keyed object, not an array.
  if (typeof value === 'object') {
    const elements = value as Record<string, unknown>;
    return joinedText(Object.keys(elements).sort((a, b) => Number(a) - Number(b)).map((key) => elements[key]));
  }
  return null;
}

function joinedText(list: unknown[]): string | null {
  const texts: string[] = [];
  for (const entry of list) {
    const text = exifToolText(entry);
    if (text === null) return null;
    texts.push(text);
  }
  return texts.join(' ');
}

/** Python's `exif_date()`: EXIF colons become an ISO date, and every 'Z' becomes a UTC offset. */
function exifDate(value: string): string {
  return value.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T').replaceAll('Z', '+00:00');
}

function pad(value: number): string {
  return String(Math.trunc(value)).padStart(2, '0');
}
