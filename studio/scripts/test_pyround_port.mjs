// Property test: studio/src/importers/util.ts pyRound vs CPython round().
// Generates hundreds of thousands of doubles in Node (coordinates with 7-12
// decimals, distances with up to 9 decimals, exact/just-above/just-below ties and
// their nextafter neighbours, negatives, ±0, very large/tiny magnitudes), sends each
// with ndigits 0..9 to Python round() in a single call, and asserts every result is
// identical bit-for-bit, including the sign of zero (checked with Object.is).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const temp = mkdtempSync(join(tmpdir(), 'pyround-port-'));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom' });

// JSON numbers round-trip exactly between JS and Python (both print the shortest
// repr); only -0.0 needs an explicit sentinel because JSON.stringify(-0) === "0".
const RUNNER = String.raw`
import sys, json, math
data = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for v, nd in data:
    if v == '-0':
        v = -0.0
    r = round(v, nd)
    if r == 0.0 and math.copysign(1.0, r) < 0.0:
        r = '-0'
    out.append(r)
print(json.dumps(out, allow_nan=False))
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0xc0ffee);
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const rndDigits = (places) => Array.from({ length: places }, () => ri(0, 9)).join('');

const SIGN = 1n << 63n;
const MASK63 = 0x7fffffffffffffffn;
const MASK64 = (1n << 64n) - 1n;
const dvOf = (fn) => {
  const dv = new DataView(new ArrayBuffer(8));
  return fn(dv);
};
const bitsOf = (v) => dvOf((dv) => (dv.setFloat64(0, v, false), dv.getBigUint64(0, false)));
const floatOf = (b) => dvOf((dv) => (dv.setBigUint64(0, b, false), dv.getFloat64(0, false)));
// Monotonic (total) ordering of IEEE-754 bit patterns, with -0 just below +0.
const ordered = (bits) => ((bits >> 63n) === 1n ? MASK64 - bits : bits | SIGN);
const fromOrdered = (o) => ((o >> 63n) === 1n ? o & MASK63 : MASK64 - o);
function nextAfter(x, y) {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const xi = bitsOf(x);
  const yi = bitsOf(y);
  if (xi === yi) return y;
  const ox = ordered(xi);
  const oy = ordered(yi);
  return floatOf(fromOrdered(ox + (oy > ox ? 1n : -1n)));
}

try {
  const { pyRound } = await server.ssrLoadModule('/src/importers/util.ts');

  const base = [];

  // (1) random coordinates with 7-12 decimal places in [-180, 180].
  for (let i = 0; i < 12000; i++) {
    const sign = rng() < 0.5 ? '-' : '';
    base.push(Number(`${sign}${ri(0, 179)}.${rndDigits(ri(7, 12))}`));
  }

  // (2) random distances in [0, 300000] with up to 9 decimal places.
  for (let i = 0; i < 12000; i++) {
    const places = ri(0, 9);
    const frac = places ? `.${rndDigits(places)}` : '';
    base.push(Number(`${ri(0, 299999)}${frac}`));
  }

  // (3) exact/just-above/just-below ties k + 0.5*10**-n and their nextafter neighbours.
  for (let n = 1; n <= 9; n++) {
    const ks = [];
    for (let k = -20; k <= 20; k++) ks.push(k);
    for (let i = 0; i < 25; i++) ks.push(ri(-1_000_000, 1_000_000));
    for (const k of ks) {
      const t = k + 0.5 * 10 ** -n;
      base.push(t, nextAfter(t, -Infinity), nextAfter(t, Infinity));
    }
  }

  // (4) signs, zeros, very large and tiny magnitudes, and classic decimal-approx cases.
  base.push(
    0, -0,
    Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE, -Number.MIN_VALUE,
    1e300, 1e200, 1e100, 1e-100, 1e-200, 1e-300,
    -1e300, -1e100, -1e-100, -1e-300,
    2 ** 52, 2 ** 53, 2 ** 53 + 2,
    0.1, 0.3, 2.675, 2.45, 3.145, 1.005, 1.25, 7.5,
  );

  // Every value is compared at every ndigits 0..9.
  const tasks = [];
  for (const v of base) for (let nd = 0; nd <= 9; nd++) tasks.push([v, nd]);

  const inputPath = join(temp, 'values.json');
  writeFileSync(inputPath, JSON.stringify(tasks.map(([v, nd]) => [Object.is(v, -0) ? '-0' : v, nd])));

  const pyOut = JSON.parse(execFileSync(python, ['-c', RUNNER, inputPath], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));

  assert.equal(pyOut.length, tasks.length, 'Python returned a different number of results');
  let compared = 0;
  for (let i = 0; i < tasks.length; i++) {
    const got = pyOut[i] === '-0' ? -0 : pyOut[i];
    assert.ok(Object.is(pyRound(tasks[i][0], tasks[i][1]), got),
      `round(${tasks[i][0]}, ${tasks[i][1]}) differs: TS ${pyRound(tasks[i][0], tasks[i][1])} vs PY ${got}`);
    compared++;
  }
  console.log(`pyRound property test passed: ${compared} (value, ndigits) pairs compared bit-for-bit against CPython round().`);
} finally {
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}