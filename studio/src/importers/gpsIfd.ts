/**
 * A second look at the GPS IFD of a photo's EXIF block, for the tags `photo.ts` reads.
 *
 * `exifr` reads a picked tag once and then drops it from its pick list (tiff-exif.mjs `parseTags`),
 * so a writer that stores the same GPS tag twice leaves exifr with the FIRST entry. ExifTool keeps
 * the LAST one: `FoundTag` gives the new value the same priority as the stored one and replaces it
 * when `$priority >= $oldPriority` (ExifTool.pm:9540-9542), and `ProcessExif` walks the directory
 * in file order. Two Xiaomi Mi-4c JPEGs store GPSAltitudeRef twice - rational64u 200/100 at entry
 * 0, then the int8u 0 the spec asks for at entry 5 - which put a photo taken at +2031 m at -2031 m.
 *
 * Only tags that really are duplicated come back, each decoded from the format its own entry
 * declares and in the value shape exifr reports, so a file without duplicates keeps exifr's values
 * untouched and a duplicate reads as if exifr had picked the last entry. An entry that cannot be
 * read is passed over rather than guessed at, which is what ExifTool does with one too: a format
 * code outside 1-13 is skipped (Exif.pm:6376-6380), and a value that does not fit inside the EXIF
 * data is refused as a 'Bad offset for GPS GPSAltitudeRef' (Exif.pm:6456, warned at :6565) even
 * when the file goes on past the block. Either way the entry before it still decides the tag.
 * Anything that is not a readable TIFF block is ignored whole, keeping exifr's values; that
 * includes a block whose byte-order marker is neither 'II' nor 'MM', which exifr reads as
 * big-endian.
 */

/** The GPS tags `photo.ts` reads, by the number their IFD entry carries. */
const GPS_TAGS = new Map<number, string>([
  [0x0001, 'GPSLatitudeRef'],
  [0x0002, 'GPSLatitude'],
  [0x0003, 'GPSLongitudeRef'],
  [0x0004, 'GPSLongitude'],
  [0x0005, 'GPSAltitudeRef'],
  [0x0006, 'GPSAltitude'],
  [0x0007, 'GPSTimeStamp'],
  [0x001d, 'GPSDateStamp'],
]);

/** The IFD0 tag that points at the GPS IFD. */
const TAG_GPS_IFD = 0x8825;

const LITTLE_ENDIAN = 0x4949;
const BIG_ENDIAN = 0x4d4d;
const HEADER_SIZE = 8;
const ENTRY_SIZE = 12;

// TIFF format codes, and the bytes per element of each. Index 0 and anything above 13 is invalid.
const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const SBYTE = 6;
const UNDEFINED = 7;
const SSHORT = 8;
const SLONG = 9;
const SRATIONAL = 10;
const FLOAT = 11;
const DOUBLE = 12;
const FORMAT_SIZES: (number | undefined)[] = [undefined, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/** A multi-element numeric value, in the array type exifr picks for the format. */
type NumericList =
  | number[] | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

/** One IFD entry read successfully. `value` is undefined for an ASCII entry of nothing but nulls. */
interface Decoded {
  value: unknown;
}

interface Tiff {
  bytes: Uint8Array;
  view: DataView;
  littleEndian: boolean;
}

/**
 * The values ExifTool would have read for the GPS tags stored more than once in `exifBlock`, keyed
 * by exifr's tag name. Empty for a block that is missing, unreadable or free of duplicates.
 */
export function duplicateGpsTags(exifBlock: Uint8Array | null): Record<string, unknown> {
  const tiff = openTiff(exifBlock);
  if (tiff === null) return {};
  const pointer = firstEntry(tiff, tiff.view.getUint32(4, tiff.littleEndian), TAG_GPS_IFD);
  if (pointer === null || typeof pointer.value !== 'number' || !Number.isFinite(pointer.value)) return {};
  const gpsEntries = ifdEntries(tiff, pointer.value);
  if (gpsEntries === null) return {};

  const byTag = new Map<number, number[]>();
  for (const entry of gpsEntries) {
    const tag = tiff.view.getUint16(entry, tiff.littleEndian);
    if (!GPS_TAGS.has(tag)) continue;
    const seen = byTag.get(tag);
    if (seen === undefined) byTag.set(tag, [entry]);
    else seen.push(entry);
  }

  const last: Record<string, unknown> = {};
  for (const [tag, seen] of byTag) {
    const name = GPS_TAGS.get(tag);
    if (name === undefined || seen.length < 2) continue;
    for (let index = seen.length - 1; index >= 0; index--) {
      const decoded = decode(tiff, seen[index]);
      if (decoded !== null) {
        last[name] = decoded.value;
        break;
      }
    }
  }
  return last;
}

/** The EXIF block as a TIFF reader, or null when it is too short or has no byte-order marker. */
function openTiff(bytes: Uint8Array | null): Tiff | null {
  if (bytes === null || bytes.length < HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(0, false);
  if (order !== LITTLE_ENDIAN && order !== BIG_ENDIAN) return null;
  return { bytes, view, littleEndian: order === LITTLE_ENDIAN };
}

/** The first entry of `tag` in the IFD at `at`, which is the one exifr reads. */
function firstEntry(tiff: Tiff, at: number, tag: number): Decoded | null {
  const entries = ifdEntries(tiff, at);
  if (entries === null) return null;
  for (const entry of entries) {
    if (tiff.view.getUint16(entry, tiff.littleEndian) === tag) return decode(tiff, entry);
  }
  return null;
}

/** The offsets of every entry of the IFD at `at`, in file order, or null if it does not fit. */
function ifdEntries(tiff: Tiff, at: number): number[] | null {
  const { bytes, view, littleEndian } = tiff;
  if (!(at >= HEADER_SIZE) || at + 2 > bytes.length) return null;
  const count = view.getUint16(at, littleEndian);
  const end = at + 2 + count * ENTRY_SIZE;
  if (end > bytes.length) return null;
  const entries: number[] = [];
  for (let entry = at + 2; entry < end; entry += ENTRY_SIZE) entries.push(entry);
  return entries;
}

/**
 * One IFD entry, decoded from the format it declares: bytes for BYTE and UNDEFINED, normalized text
 * for ASCII, a single number for one element of anything else and exifr's array type for several.
 * A value that does not fit inside the EXIF block is null, not a truncated read.
 */
function decode(tiff: Tiff, entry: number): Decoded | null {
  const { bytes, view, littleEndian } = tiff;
  const format = view.getUint16(entry + 2, littleEndian);
  const count = view.getUint32(entry + 4, littleEndian);
  const size = FORMAT_SIZES[format];
  if (size === undefined) return null;
  const total = size * count;
  // Up to four bytes sit in the entry itself; anything longer is stored where the entry points.
  const at = total <= 4 ? entry + 8 : view.getUint32(entry + 8, littleEndian);
  if (!(at >= 0) || at + total > bytes.length) return null;
  if (format === BYTE || format === UNDEFINED) return { value: bytes.subarray(at, at + total) };
  if (format === ASCII) return { value: asciiText(bytes.subarray(at, at + total)) };
  if (count === 1) return { value: element(tiff, format, at) };
  return { value: elements(tiff, format, at, count, size) };
}

/** One element of a numeric format, read the way exifr's `parseTagValue` reads it. */
function element(tiff: Tiff, format: number, at: number): number {
  const { view, littleEndian } = tiff;
  switch (format) {
    case SHORT: return view.getUint16(at, littleEndian);
    case LONG: return view.getUint32(at, littleEndian);
    case RATIONAL: return view.getUint32(at, littleEndian) / view.getUint32(at + 4, littleEndian);
    case SBYTE: return view.getInt8(at);
    case SSHORT: return view.getInt16(at, littleEndian);
    case SLONG: return view.getInt32(at, littleEndian);
    case SRATIONAL: return view.getInt32(at, littleEndian) / view.getInt32(at + 4, littleEndian);
    case FLOAT: return view.getFloat32(at, littleEndian);
    case DOUBLE: return view.getFloat64(at, littleEndian);
    // IFD, which exifr reads as a 32-bit offset.
    default: return view.getUint32(at, littleEndian);
  }
}

/** Several elements, in the array type exifr's `getTypedArray` picks for the format. */
function elements(tiff: Tiff, format: number, at: number, count: number, size: number): NumericList {
  const list: number[] = [];
  for (let index = 0; index < count; index++) list.push(element(tiff, format, at + index * size));
  switch (format) {
    case SHORT: return Uint16Array.from(list);
    case LONG: return Uint32Array.from(list);
    case SBYTE: return Int8Array.from(list);
    case SSHORT: return Int16Array.from(list);
    case SLONG: return Int32Array.from(list);
    case FLOAT: return Float32Array.from(list);
    case DOUBLE: return Float64Array.from(list);
    // RATIONAL, SRATIONAL and IFD come back as plain arrays.
    default: return list;
  }
}

/** exifr's `normalizeString`: nulls stripped from the end, trimmed, and empty text left undefined. */
function asciiText(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '').trim();
  return text === '' ? undefined : text;
}
