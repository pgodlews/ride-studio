/**
 * EXIF date/time text with the semantics of Python's `datetime.fromisoformat`, which is what
 * `scripts/photo_metadata.py` parses capture times with and prints through `isoformat()`.
 * Instants are carried as integer microseconds: a JS `Date` stops at milliseconds and would
 * silently drop the sub-millisecond part of `SubSecTimeOriginal`.
 */

const MICROS_PER_SECOND = 1_000_000;
const MICROS_PER_DAY = 86_400 * MICROS_PER_SECOND;
const MICROS_PER_HOUR = 3_600 * MICROS_PER_SECOND;
const MICROS_PER_MINUTE = 60 * MICROS_PER_SECOND;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface ExifInstant {
  /** Microseconds since the Unix epoch, already shifted to UTC (negative before 1970). */
  utcMicros: number;
  /** Zone offset carried by the text in seconds, or null when it carried none. */
  offsetSeconds: number | null;
}

// `datetime.min`/`datetime.max`; Python raises OverflowError when a zone shift leaves them.
const MIN_MICROS = daysFromCivil(1, 1, 1) * MICROS_PER_DAY;
const MAX_MICROS = daysFromCivil(10_000, 1, 1) * MICROS_PER_DAY;

/** Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of `daysFromCivil`. */
function civilFromDays(days: number): [number, number, number] {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9);
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, '0');
}

const EXTENDED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BASIC_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const EXTENDED_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/;
const BASIC_TIME = /^(\d{2})(?:(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?$/;

/** `Z`/`±HH[:MM[:SS]]`/`±HH[MM[SS]]` in seconds, or null where Python raises ValueError. */
function parseOffset(text: string): number | null {
  if (/^[Zz]$/.test(text)) return 0;
  if (!/^[+-]\d/.test(text)) return null;
  const parts = text.slice(1).split(':');
  const digits = parts.join('');
  // Python refuses mixed separators ('+01:0000') and anything but two, four or six digits.
  const uniform = parts.length === 1 || parts.every((part) => part.length === 2);
  if (!uniform || ![2, 4, 6].includes(digits.length)) return null;
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length >= 4 ? Number(digits.slice(2, 4)) : 0;
  const seconds = digits.length === 6 ? Number(digits.slice(4)) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return (text[0] === '-' ? -1 : 1) * (hours * 3600 + minutes * 60 + seconds);
}

/** Python keeps six digits and truncates the rest; `fromisoformat` never rounds. */
function fractionMicros(digits: string | undefined): number {
  return digits ? Number(digits.slice(0, 6).padEnd(6, '0')) : 0;
}

/**
 * Parse an ISO-8601 date/time the way Python 3.11+ accepts the texts EXIF produces: extended
 * or basic date, any single date/time separator, optional seconds and fraction ('.' or ','),
 * optional `Z`/`±HH:MM`/`±HHMM`/`±HH` zone. Returns null where Python raises ValueError, so a
 * malformed tag stays missing instead of becoming an invented time. Week and ordinal dates are
 * rejected on purpose (no camera writes them), as is hour 24 (only Python 3.14 accepts it).
 * Throws RangeError where Python's `astimezone(utc)` raises OverflowError.
 */
export function parseExifInstant(text: string): ExifInstant | null {
  const extended = EXTENDED_DATE.exec(text.slice(0, 10));
  const basic = extended ? null : BASIC_DATE.exec(text.slice(0, 8));
  const date = extended ?? basic;
  if (!date) return null;
  const dateLength = extended ? 10 : 8;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (year < 1 || month < 1 || month > 12) return null;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1] + (month === 2 && isLeap(year) ? 1 : 0)) return null;

  let hour = 0;
  let minute = 0;
  let second = 0;
  let micros = 0;
  let offsetSeconds: number | null = null;
  if (text.length > dateLength) {
    // Any single separator character is allowed between the date and the time.
    const rest = text.slice(dateLength + 1);
    const zoneAt = rest.search(/[Zz+-]/);
    const timeText = zoneAt < 0 ? rest : rest.slice(0, zoneAt);
    const time = (timeText.includes(':') ? EXTENDED_TIME : BASIC_TIME).exec(timeText);
    if (!time) return null;
    hour = Number(time[1]);
    minute = Number(time[2] ?? 0);
    second = Number(time[3] ?? 0);
    micros = fractionMicros(time[4]);
    if (hour > 23 || minute > 59 || second > 59) return null;
    if (zoneAt >= 0) {
      offsetSeconds = parseOffset(rest.slice(zoneAt));
      if (offsetSeconds === null) return null;
    }
  }

  const localMicros = daysFromCivil(year, month, day) * MICROS_PER_DAY
    + hour * MICROS_PER_HOUR + minute * MICROS_PER_MINUTE + second * MICROS_PER_SECOND + micros;
  const utcMicros = localMicros - (offsetSeconds ?? 0) * MICROS_PER_SECOND;
  if (utcMicros < MIN_MICROS || utcMicros >= MAX_MICROS) throw new RangeError('date value out of range');
  return { utcMicros, offsetSeconds };
}

/**
 * `dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')`: microseconds are printed
 * only when they are not zero, exactly like Python's `isoformat()`.
 */
export function formatUtcIso(utcMicros: number): string {
  const days = Math.floor(utcMicros / MICROS_PER_DAY);
  const rest = utcMicros - days * MICROS_PER_DAY;
  const [year, month, day] = civilFromDays(days);
  const hour = Math.floor(rest / MICROS_PER_HOUR);
  const minute = Math.floor((rest - hour * MICROS_PER_HOUR) / MICROS_PER_MINUTE);
  const second = Math.floor((rest - hour * MICROS_PER_HOUR - minute * MICROS_PER_MINUTE) / MICROS_PER_SECOND);
  const micros = rest - hour * MICROS_PER_HOUR - minute * MICROS_PER_MINUTE - second * MICROS_PER_SECOND;
  const stamp = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
  return `${micros ? `${stamp}.${pad(micros, 6)}` : stamp}Z`;
}
