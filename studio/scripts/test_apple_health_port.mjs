// Parity test: studio/src/importers/appleHealth.ts vs studio/scripts/apple_health.py
// (scan + build_ride). Both sides read the same synthetic Apple Health export produced by
// the reference fixture builder test_apple_health.write_export; the Python side reports its
// index / rides / errors as JSON, and the TypeScript port runs over a Node fs adapter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdtempSync, rmSync, existsSync, realpathSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? 'python3';
const temp = mkdtempSync(join(tmpdir(), 'apple-port-'));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom' });

const RUNNER = String.raw`
import sys, json
from pathlib import Path
from datetime import timedelta
sys.path.insert(0, sys.argv[1])
import test_apple_health as T
import apple_health

root = Path(sys.argv[2]); root.mkdir(parents=True, exist_ok=True)
export = T.write_export(root)
cache = root / 'cache'
index = apple_health.scan(export, cache)
samples = {p.stem: json.loads(p.read_text()) for p in sorted((cache / index['key'] / 'samples').glob('*.json'))}
ride_w, copy_w, walk_w = index['workouts']
ride, evidence = apple_health.build_ride(export, cache, ride_w['id'], 'apple-test')
walk, _ = apple_health.build_ride(export, cache, walk_w['id'], 'apple-walk')

def write_minimal(name, pts, missing_route=False):
    exp = root / name
    (exp / 'workout-routes').mkdir(parents=True)
    start = T.START
    end = start + timedelta(seconds=10)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<!DOCTYPE HealthData [',
             '<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>',
             ']>',
             '<HealthData locale="en_GB">',
             ' <ExportDate value="2026-10-05 10:43:07 +0100"/>',
             ' <Me/>',
             f' <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="1" durationUnit="min" sourceName="{T.WATCH}" sourceVersion="11.0" device="{T.DEVICE}" creationDate="{T.local(end)}" startDate="{T.local(start)}" endDate="{T.local(end)}">',
             f'  <WorkoutRoute sourceName="{T.WATCH}" sourceVersion="11.0" creationDate="{T.local(end)}" startDate="{T.local(start)}" endDate="{T.local(end)}">',
             '   <FileReference path="/workout-routes/route_min.gpx"/>',
             '  </WorkoutRoute>',
             ' </Workout>',
             '</HealthData>']
    (exp / 'export.xml').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    if not missing_route:
        trk = ''.join(f'<trkpt lon="{lon}" lat="{lat}"><ele>100</ele><time>{t}</time><extensions><speed>{spd}</speed></extensions></trkpt>' for lon, lat, t, spd in pts)
        (exp / 'workout-routes' / 'route_min.gpx').write_text('<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' + trk + '</trkseg></trk></gpx>')
    return exp

few = write_minimal('few', [('-1.5', '53.8', '2026-10-03T11:00:00Z', '5')])
missing = write_minimal('missing', [('-1.5', '53.8', '2026-10-03T11:00:00Z', '5')], missing_route=True)
badhead = root / 'badhead'; badhead.mkdir()
(badhead / 'export.xml').write_text('<foo/>')

few_id = apple_health.scan(few, cache)['workouts'][0]['id']
missing_id = apple_health.scan(missing, cache)['workouts'][0]['id']

errors = {}
for key, fn in (('no_route', lambda: apple_health.build_ride(export, cache, copy_w['id'], 'nope')),
                ('unknown', lambda: apple_health.build_ride(export, cache, 'bad-id', 'x')),
                ('no_export_xml', lambda: apple_health.scan(root, cache)),
                ('not_export', lambda: apple_health.scan(badhead, cache)),
                ('missing_route', lambda: apple_health.build_ride(missing, cache, missing_id, 'x')),
                ('few_gps', lambda: apple_health.build_ride(few, cache, few_id, 'x'))):
    try:
        fn()
        errors[key] = None
    except ValueError as e:
        errors[key] = str(e)

print(json.dumps({'export': str(export.resolve()), 'index': index, 'samples': samples, 'ride': ride, 'evidence': evidence,
                  'walk': walk, 'walkId': walk_w['id'], 'rideId': ride_w['id'], 'copyId': copy_w['id'],
                  'fewExport': str(few.resolve()), 'missingExport': str(missing.resolve()), 'badhead': str(badhead.resolve()),
                  'fewId': few_id, 'missingId': missing_id, 'errors': errors}, allow_nan=False))
`;

// Node implementation of the injected file interface, matching apple_health's Path semantics.
// `absolute`/`isWithin` mirror Python's `Path.resolve(strict=False)`, which resolves symlinks
// for existing components without requiring the final path to exist.
function realpathNonStrict(p) {
  const abs = resolve(p);
  const parts = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    parts.unshift(basename(cur));
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return parts.length ? join(base, ...parts) : base;
}

async function* streamLines(path) {
  // Streams like Python's line iteration: universal newlines, no terminator kept.
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

const vfs = {
  readLines: (path) => streamLines(path),
  readText: (path) => fsp.readFile(path, 'utf8'),
  readBytes: (path) => fsp.readFile(path),
  async stat(path) {
    const s = await fsp.stat(path);
    return { size: s.size, mtime: s.mtimeMs / 1000 };
  },
  async exists(path) {
    try {
      await fsp.stat(path);
      return true;
    } catch {
      return false;
    }
  },
  join: (dir, name) => join(dir, name),
  basename: (path) => basename(path),
  absolute: (path) => realpathNonStrict(path),
  isWithin: (dir, file) => {
    const rd = realpathNonStrict(dir);
    const rf = realpathNonStrict(file);
    return rf === rd || rf.startsWith(rd + sep);
  },
};

try {
  const { scan, buildRide } = await server.ssrLoadModule('/src/importers/appleHealth.ts');
  const ref = JSON.parse(execFileSync(python, ['-c', RUNNER, join(studio, 'scripts'), temp], { encoding: 'utf8' }));

  const tsScan = await scan(ref.export, vfs);
  assert.deepStrictEqual(tsScan.index, ref.index, 'index mismatch');
  assert.deepStrictEqual(tsScan.samples, ref.samples, 'samples mismatch');

  // The scan result is the callers' cache: it must survive a JSON round trip unchanged.
  const roundTripped = JSON.parse(JSON.stringify(tsScan));
  assert.deepStrictEqual(roundTripped, tsScan, 'scan result must survive JSON.stringify/parse');
  assert.deepStrictEqual(roundTripped.samples, ref.samples, 'round-tripped samples mismatch');

  // Recompute path (no cached data): buildRide reads export.xml again.
  const rideResult = await buildRide(ref.export, ref.rideId, 'apple-test', vfs);
  assert.deepStrictEqual(rideResult.ride, ref.ride, 'ride mismatch');
  assert.deepStrictEqual(rideResult.evidence, ref.evidence, 'evidence mismatch');

  // Cached path: buildRide accepts the scan result and never touches export.xml.
  const cachedRide = await buildRide(ref.export, ref.rideId, 'apple-test', vfs, tsScan);
  assert.deepStrictEqual(cachedRide.ride, ref.ride, 'cached ride mismatch');
  assert.deepStrictEqual(cachedRide.evidence, ref.evidence, 'cached evidence mismatch');

  const walkResult = await buildRide(ref.export, ref.walkId, 'apple-walk', vfs);
  assert.deepStrictEqual(walkResult.ride, ref.walk, 'walk ride mismatch');
  const cachedWalk = await buildRide(ref.export, ref.walkId, 'apple-walk', vfs, tsScan);
  assert.deepStrictEqual(cachedWalk.ride, ref.walk, 'cached walk ride mismatch');

  const expectError = async (fn, key) => {
    let message = null;
    try {
      await fn();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.ok(message !== null, `${key}: expected an error`);
    assert.equal(message, ref.errors[key], `${key}: error message mismatch`);
  };
  await expectError(() => buildRide(ref.export, ref.copyId, 'nope', vfs), 'no_route');
  await expectError(() => buildRide(ref.export, ref.copyId, 'nope', vfs, tsScan), 'no_route');
  await expectError(() => buildRide(ref.export, 'bad-id', 'x', vfs), 'unknown');
  await expectError(() => buildRide(ref.export, 'bad-id', 'x', vfs, tsScan), 'unknown');
  await expectError(() => scan(temp, vfs), 'no_export_xml');
  await expectError(() => scan(ref.badhead, vfs), 'not_export');
  await expectError(() => buildRide(ref.missingExport, ref.missingId, 'x', vfs), 'missing_route');
  await expectError(() => buildRide(ref.fewExport, ref.fewId, 'x', vfs), 'few_gps');

  // Streaming adapter: universal-newline semantics match Python's file iteration.
  const lineFile = join(temp, 'line-semantics.txt');
  await fsp.writeFile(lineFile, 'one\ntwo\r\nthree');
  const streamed = [];
  for await (const line of streamLines(lineFile)) streamed.push(line);
  assert.deepStrictEqual(streamed, ['one', 'two', 'three'], 'streaming must drop \\n/\\r\\n and keep a final unterminated line');

  console.log('Apple Health port passed: scan (index + samples), cached and recomputed rides, JSON round trip, error paths and streaming line semantics.');
} finally {
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}