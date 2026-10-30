/** Shared numeric and digest helpers for the importers (no Node/DOM dependencies). */

function pow5(n: bigint): bigint {
  let result = 1n;
  let base = 5n;
  while (n > 0n) {
    if (n & 1n) result *= base;
    base *= base;
    n >>= 1n;
  }
  return result;
}

/** Python's round-half-even `round(value, ndigits)`, matching CPython's `_Py_double_round`.
 *
 * CPython rounds the EXACT binary value of the double to `ndigits` decimal places
 * (ties to even only on an exact `.5`), then converts the decimal result back to the
 * nearest double. Scaling the float by 10**ndigits first is wrong: that multiplication
 * introduces its own rounding error, so a value just below a tie can be pushed exactly
 * onto `.5` and take the wrong side. This port instead decomposes the double into its
 * exact significand and power-of-two exponent, does the decimal rounding in exact
 * BigInt rational arithmetic, and re-enters float space through the correctly-rounded
 * `Number()` string conversion.
 */
export function pyRound(value: number, ndigits: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, value, false);
  const bits = buf.getBigUint64(0, false);

  const negative = (bits >> 63n) !== 0n;
  const exponentBits = (bits >> 52n) & 0x7ffn;
  const fraction = bits & 0xfffffffffffffn;

  let mantissa: bigint;
  let pow2: bigint; // exact value = mantissa * 2**pow2
  if (exponentBits === 0n) {
    if (fraction === 0n) return value; // ±0.0: preserve the sign of zero
    mantissa = fraction; // subnormal
    pow2 = -1074n;
  } else if (exponentBits === 0x7ffn) {
    return value; // ±Infinity / NaN
  } else {
    mantissa = (1n << 52n) | fraction; // normal: 53-bit significand
    pow2 = BigInt(exponentBits) - 1075n;
  }

  // y = mantissa * 2**pow2 * 10**ndigits, expressed exactly as A / B.
  let twoExp = pow2;
  let fiveExp = 0n;
  if (ndigits >= 0) {
    twoExp += BigInt(ndigits);
    fiveExp = BigInt(ndigits);
  } else {
    const k = BigInt(-ndigits);
    twoExp -= k;
    fiveExp = -k;
  }
  let numerator = mantissa;
  let denominator = 1n;
  if (twoExp >= 0n) numerator *= 1n << twoExp;
  else denominator *= 1n << -twoExp;
  if (fiveExp >= 0n) numerator *= pow5(fiveExp);
  else denominator *= pow5(-fiveExp);

  // Round A / B to the nearest integer, rounding an exact `.5` to the even integer.
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  let rounded = quotient;
  if (twiceRemainder > denominator) rounded = quotient + 1n;
  else if (twiceRemainder === denominator && (quotient & 1n) === 1n) rounded = quotient + 1n;

  // result = +-rounded / 10**ndigits; Number() is correctly rounded (and keeps -0).
  const sign = negative ? '-' : '';
  return Number(`${sign}${rounded}e${-ndigits}`);
}

/** Python `float(text)`: number or NaN/Infinity, throwing for unparseable input. */
export function pythonFloat(text: unknown): number {
  const s = String(text).trim();
  if (s === '') throw new Error('empty');
  const lower = s.toLowerCase();
  if (lower === 'nan' || lower === '+nan' || lower === '-nan') return NaN;
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-inf' || lower === '-infinity') return -Infinity;
  const value = Number(s);
  if (Number.isNaN(value)) throw new Error('not a float');
  return value;
}

async function digestHex(algorithm: 'SHA-1' | 'SHA-256', bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest(algorithm, data.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(bytes: Uint8Array): Promise<string> {
  return digestHex('SHA-256', bytes);
}

export function sha1Hex(bytes: Uint8Array): Promise<string> {
  return digestHex('SHA-1', bytes);
}

export const textEncoder = new TextEncoder();