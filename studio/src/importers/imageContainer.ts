/**
 * Container headers of a still image: stored pixel size, the container's EXIF block, and the HEIF
 * `irot` rotation that macOS `sips` turns into an EXIF orientation. Only headers are read; no
 * pixels are decoded.
 */

export type ContainerKind = 'jpeg' | 'png' | 'webp' | 'tiff' | 'heif' | 'unknown';

export interface ContainerInfo {
  kind: ContainerKind;
  /** Stored pixel size, before any orientation transform; null when the container omits it. */
  width: number | null;
  height: number | null;
  /** HEIF `irot` angle (0-3) of the primary item; null for other containers or when absent. */
  irot: number | null;
  /**
   * The bare TIFF payload of the EXIF block `exifr` reads: a JPEG APP1 segment, a PNG `eXIf`
   * chunk, a WebP `EXIF` chunk (exifr 7.1.3 has no WebP parser, so this is also what it is handed
   * to parse), a HEIF `Exif` item, or the TIFF file itself. Null when the container has none.
   */
  exifBlock: Uint8Array | null;
}

const UNKNOWN: ContainerInfo = { kind: 'unknown', width: null, height: null, irot: null, exifBlock: null };

function u16be(bytes: Uint8Array, at: number): number {
  return at + 2 <= bytes.length ? (bytes[at] << 8) | bytes[at + 1] : NaN;
}

function u16le(bytes: Uint8Array, at: number): number {
  return at + 2 <= bytes.length ? bytes[at] | (bytes[at + 1] << 8) : NaN;
}

function u32be(bytes: Uint8Array, at: number): number {
  return at + 4 <= bytes.length
    ? bytes[at] * 16_777_216 + bytes[at + 1] * 65_536 + bytes[at + 2] * 256 + bytes[at + 3]
    : NaN;
}

function u32le(bytes: Uint8Array, at: number): number {
  return at + 4 <= bytes.length
    ? bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65_536 + bytes[at + 3] * 16_777_216
    : NaN;
}

/** 24-bit little-endian value used by the WebP canvas size. */
function u24le(bytes: Uint8Array, at: number): number {
  return at + 3 <= bytes.length ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) : NaN;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = '';
  for (let i = at; i < at + length && i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

export function readContainer(bytes: Uint8Array): ContainerInfo {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegContainer(bytes);
  if (bytes.length >= 8 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) return pngContainer(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpContainer(bytes);
  if (bytes.length >= 4 && (ascii(bytes, 0, 2) === 'II' || ascii(bytes, 0, 2) === 'MM')) {
    // IFD0 carries the size, and exifr already parses it for TIFF.
    return { kind: 'tiff', width: null, height: null, irot: null, exifBlock: bytes };
  }
  return heifContainer(bytes) ?? UNKNOWN;
}

/** Frame header (SOFn) of a baseline, progressive or lossless JPEG. */
function jpegContainer(bytes: Uint8Array): ContainerInfo {
  let exifBlock: Uint8Array | null = null;
  const incomplete = (): ContainerInfo => ({ kind: 'jpeg', width: null, height: null, irot: null, exifBlock });
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return incomplete();
    let marker = at + 1;
    while (marker < bytes.length && bytes[marker] === 0xff) marker++;
    const code = bytes[marker];
    // TEM and RSTn/SOI/EOI carry no payload; SOS and EOI end the header section.
    if (code === undefined || code === 0x01 || (code >= 0xd0 && code <= 0xd9) || code === 0xda) return incomplete();
    const length = u16be(bytes, marker + 1);
    if (!(length >= 2)) return incomplete();
    if (code === 0xe1 && exifBlock === null) exifBlock = jpegExifBlock(bytes, marker, length);
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      // SOFn payload: sample precision, then height and width.
      const height = u16be(bytes, marker + 4);
      const width = u16be(bytes, marker + 6);
      if (Number.isNaN(height) || Number.isNaN(width)) return incomplete();
      return { kind: 'jpeg', width, height, irot: null, exifBlock };
    }
    at = marker + 1 + length;
  }
  return incomplete();
}

/**
 * The TIFF payload of an APP1 segment, which exifr accepts only with the `Exif\0\0` wrapper
 * (tiff-exif.mjs `canHandle`). Like exifr, the first such segment of the file is the one read.
 */
function jpegExifBlock(bytes: Uint8Array, marker: number, length: number): Uint8Array | null {
  const payload = marker + 3;
  const end = marker + 1 + length;
  if (end > bytes.length) return null;
  if (ascii(bytes, payload, 4) !== 'Exif' || u16be(bytes, payload + 4) !== 0) return null;
  return payload + 6 < end ? bytes.subarray(payload + 6, end) : null;
}

function pngContainer(bytes: Uint8Array): ContainerInfo {
  // IHDR is always the first chunk, so the stored size sits at a fixed offset.
  const valid = ascii(bytes, 12, 4) === 'IHDR' && bytes.length >= 24;
  return {
    kind: 'png',
    width: valid ? u32be(bytes, 16) : null,
    height: valid ? u32be(bytes, 20) : null,
    irot: null,
    exifBlock: pngExifBlock(bytes),
  };
}

/** The payload of the first `eXIf` chunk, which is the TIFF block itself. */
function pngExifBlock(bytes: Uint8Array): Uint8Array | null {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const size = u32be(bytes, at);
    const payload = at + 8;
    // exifr compares chunk names case-insensitively, so an `EXIF` chunk is read as `eXIf` too.
    if (!(size >= 0) || payload + size + 4 > bytes.length) return null;
    if (ascii(bytes, at + 4, 4).toLowerCase() === 'exif') return bytes.subarray(payload, payload + size);
    at = payload + size + 4;
  }
  return null;
}

/** Lossy WebP frames start with a three-byte tag followed by the 9D 01 2A start code. */
function hasVp8StartCode(bytes: Uint8Array, payload: number): boolean {
  return bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a;
}

function webpContainer(bytes: Uint8Array): ContainerInfo {
  const info: ContainerInfo = { kind: 'webp', width: null, height: null, irot: null, exifBlock: null };
  let at = 12;
  while (at + 8 <= bytes.length) {
    const fourcc = ascii(bytes, at, 4);
    const size = u32le(bytes, at + 4);
    const payload = at + 8;
    if (!Number.isFinite(size) || size < 0 || payload + size > bytes.length) return info;
    if (fourcc === 'VP8X') {
      info.width = u24le(bytes, payload + 4) + 1;
      info.height = u24le(bytes, payload + 7) + 1;
    } else if (fourcc === 'VP8 ' && info.width === null && hasVp8StartCode(bytes, payload)) {
      info.width = u16le(bytes, payload + 6) & 0x3fff;
      info.height = u16le(bytes, payload + 8) & 0x3fff;
    } else if (fourcc === 'VP8L' && info.width === null && bytes[payload] === 0x2f) {
      const [b1, b2, b3, b4] = [bytes[payload + 1], bytes[payload + 2], bytes[payload + 3], bytes[payload + 4]];
      info.width = 1 + (b1 | ((b2 & 0x3f) << 8));
      info.height = 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    } else if (fourcc === 'EXIF' && info.exifBlock === null) {
      const chunk = bytes.subarray(payload, payload + size);
      // Some encoders keep the JPEG 'Exif\0\0' wrapper inside the chunk.
      info.exifBlock = ascii(chunk, 0, 4) === 'Exif' ? chunk.subarray(6) : chunk;
    }
    at = payload + size + (size & 1);
  }
  return info;
}

interface Box {
  /** Payload start, after the box header (but not after a full box's version/flags). */
  start: number;
  end: number;
}

function findBox(bytes: Uint8Array, from: number, to: number, kind: string): Box | null {
  let at = from;
  while (at + 8 <= to) {
    let size = u32be(bytes, at);
    let header = 8;
    if (size === 1) {
      size = u32be(bytes, at + 8) * 2 ** 32 + u32be(bytes, at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (!(size >= header) || at + size > to) return null;
    if (ascii(bytes, at + 4, 4) === kind) return { start: at + header, end: at + size };
    at += size;
  }
  return null;
}

/**
 * HEIC/HEIF: `meta/iprp/ipco` holds the item properties (`ispe` size, `irot` rotation),
 * `meta/iprp/ipma` says which of them belong to the primary item named by `meta/pitm`, and
 * `meta/iinf` plus `meta/iloc` say where the `Exif` item's TIFF block is stored.
 */
function heifContainer(bytes: Uint8Array): ContainerInfo | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null;
  const meta = findBox(bytes, 0, bytes.length, 'meta');
  if (!meta) return null;
  // 'meta' is a full box: version and flags come before its children.
  const children = { from: meta.start + 4, to: meta.end };
  const info: ContainerInfo = {
    kind: 'heif', width: null, height: null, irot: null, exifBlock: heifExifBlock(bytes, children),
  };
  const iprp = findBox(bytes, children.from, children.to, 'iprp');
  const ipco = iprp && findBox(bytes, iprp.start, iprp.end, 'ipco');
  if (!ipco) return info;

  const properties: (Box & { kind: string })[] = [];
  for (let at = ipco.start; at + 8 <= ipco.end;) {
    const size = u32be(bytes, at);
    if (!(size >= 8) || at + size > ipco.end) break;
    properties.push({ kind: ascii(bytes, at + 4, 4), start: at + 8, end: at + size });
    at += size;
  }
  const owned = primaryProperties(bytes, findBox(bytes, children.from, children.to, 'pitm'),
    iprp && findBox(bytes, iprp.start, iprp.end, 'ipma'), properties.length);
  for (const index of owned) {
    const property = properties[index - 1];
    if (!property) continue;
    // 'ispe' is a full box: version and flags, then width and height.
    if (property.kind === 'ispe' && info.width === null) {
      info.width = u32be(bytes, property.start + 4);
      info.height = u32be(bytes, property.start + 8);
    } else if (property.kind === 'irot' && info.irot === null && property.start < property.end) {
      info.irot = bytes[property.start] & 0x03;
    }
  }
  return info;
}

/** 1-based indices of the properties of the primary item, or every property when unknown. */
function primaryProperties(bytes: Uint8Array, pitm: Box | null, ipma: Box | null, total: number): number[] {
  const fallback = Array.from({ length: total }, (_unused, i) => i + 1);
  if (!pitm || !ipma) return fallback;
  const version = bytes[pitm.start];
  const primaryId = version < 1 ? u16be(bytes, pitm.start + 4) : u32be(bytes, pitm.start + 4);
  const associationVersion = bytes[ipma.start];
  const associationFlags = bytes[ipma.start + 1] * 65_536 + bytes[ipma.start + 2] * 256 + bytes[ipma.start + 3];
  const wideIndices = (associationFlags & 1) !== 0;
  const entries = u32be(bytes, ipma.start + 4);
  let at = ipma.start + 8;
  for (let entry = 0; entry < entries; entry++) {
    let itemId: number;
    if (associationVersion < 1) {
      itemId = u16be(bytes, at);
      at += 2;
    } else {
      itemId = u32be(bytes, at);
      at += 4;
    }
    const associations = bytes[at];
    at += 1;
    const indices: number[] = [];
    for (let i = 0; i < associations; i++) {
      if (wideIndices) {
        indices.push(u16be(bytes, at) & 0x7fff);
        at += 2;
      } else {
        indices.push(bytes[at] & 0x7f);
        at += 1;
      }
    }
    if (itemId === primaryId) return indices;
  }
  return fallback;
}

/**
 * The TIFF block of a HEIF `Exif` item: `iinf` names the item, `iloc` says where its first extent
 * lives, and that extent starts with a four-byte offset of the TIFF header inside it
 * (ISO/IEC 23008-12). This is the block exifr hands to its own TIFF parser (heif.mjs `findExif`).
 */
function heifExifBlock(bytes: Uint8Array, children: { from: number; to: number }): Uint8Array | null {
  const iinf = findBox(bytes, children.from, children.to, 'iinf');
  const iloc = findBox(bytes, children.from, children.to, 'iloc');
  if (!iinf || !iloc) return null;
  const itemId = exifItemId(bytes, iinf);
  if (itemId === null) return null;
  const extent = itemExtent(bytes, iloc, itemId);
  if (extent === null) return null;
  const [start, end] = extent;
  if (end - start < 4) return null;
  const header = start + 4 + u32be(bytes, start);
  return header < end ? bytes.subarray(header, end) : null;
}

/** The ID of the first item info entry of type `Exif`; only `infe` versions 2 and 3 carry a type. */
function exifItemId(bytes: Uint8Array, iinf: Box): number | null {
  const version = bytes[iinf.start];
  const countSize = version < 1 ? 2 : 4;
  const count = uint(bytes, iinf.start + 4, countSize);
  let at = iinf.start + 4 + countSize;
  for (let entry = 0; entry < count; entry++) {
    const size = u32be(bytes, at);
    if (!(size >= 8) || at + size > iinf.end) return null;
    if (ascii(bytes, at + 4, 4) === 'infe') {
      // 'infe' is a full box, so version and flags come before the ID, protection index and type.
      const infeVersion = bytes[at + 8];
      const idSize = infeVersion === 3 ? 4 : 2;
      const payload = at + 12;
      if (infeVersion >= 2 && payload + idSize + 6 <= at + size
        && ascii(bytes, payload + idSize + 2, 4) === 'Exif') return uint(bytes, payload, idSize);
    }
    at += size;
  }
  return null;
}

/** The first extent of `itemId` as file offsets, or null for a layout this reader does not follow. */
function itemExtent(bytes: Uint8Array, iloc: Box, itemId: number): [number, number] | null {
  const version = bytes[iloc.start];
  const offsetSize = bytes[iloc.start + 4] >> 4;
  const lengthSize = bytes[iloc.start + 4] & 0x0f;
  const baseOffsetSize = bytes[iloc.start + 5] >> 4;
  const indexed = version === 1 || version === 2;
  const indexSize = indexed ? bytes[iloc.start + 5] & 0x0f : 0;
  const widths = [offsetSize, lengthSize, baseOffsetSize, indexSize];
  if (widths.some((width) => width !== 0 && width !== 2 && width !== 4)) return null;
  // item_count and item_ID are 16 bits wide, or both 32 bits in iloc version 2.
  const idSize = version === 2 ? 4 : 2;
  let at = iloc.start + 6;
  const count = uint(bytes, at, idSize);
  at += idSize;
  for (let item = 0; item < count; item++) {
    if (at + idSize + 4 > iloc.end) return null;
    const id = uint(bytes, at, idSize);
    at += idSize;
    // Only construction method 0 counts offsets from the start of the file.
    if (indexed && u16be(bytes, at) !== 0) return null;
    at += indexed ? 2 : 0;
    const baseOffset = uint(bytes, at + 2, baseOffsetSize);
    at += 2 + baseOffsetSize;
    const extents = u16be(bytes, at);
    at += 2;
    if (id === itemId && extents >= 1) {
      const offset = baseOffset + uint(bytes, at + indexSize, offsetSize);
      const length = uint(bytes, at + indexSize + offsetSize, lengthSize);
      if (!(offset >= 0) || !(length >= 0) || offset + length > bytes.length) return null;
      return [offset, offset + length];
    }
    at += extents * (indexSize + offsetSize + lengthSize);
  }
  return null;
}

/** A big-endian unsigned integer of 0, 2 or 4 bytes; absent fields read as zero. */
function uint(bytes: Uint8Array, at: number, size: number): number {
  if (size === 0) return 0;
  return size === 2 ? u16be(bytes, at) : u32be(bytes, at);
}
