// Verify telemetry evaluation/units against a Python-generated running projection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const code = 'import sys,json; sys.path.insert(0,sys.argv[1]); from test_activity_telemetry import messages; from prepare_ride import build_ride; print(json.dumps(build_ride(messages(), "fixture", "generated"), allow_nan=False))';
const json = JSON.parse(execFileSync(python, ['-c', code, resolve(studio, 'scripts')], { encoding: 'utf8' }));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { Ride } = await server.ssrLoadModule('/src/core/ride.ts');
  const { display } = await server.ssrLoadModule('/src/core/units.ts');
  const run = new Ride(json);
  assert.equal(run.has('cadence'), false);
  assert.equal(run.has('crankRevs'), false);
  assert.equal(run.at('stepCadence', .5), 0);
  assert.equal(run.at('stepCadence', 1), 161);
  assert.equal(run.at('pace', .5), 1); // invert interpolated speed (1 m/s)
  assert.equal(run.at('pace', 1), .5);
  for (const t of [-1, 0, 3, 9, 10]) assert.ok(Number.isNaN(run.at('pace', t)), `Pace at ${t}`);
  assert.equal(display('pace', .3, 'metric').text, '5:00');
  assert.equal(display('pace', .3, 'imperial').text, '8:03');
  assert.equal(display('stepCadence', 161, 'metric').unit, 'spm');
  assert.equal(display('pace', NaN, 'metric').missing, true);
  assert.equal(display('pace', 0, 'metric').missing, true);
  const cycling = new Ride({ ...json, channels: { cadence: [0, 80, null], speed: [0, 2, null] } });
  assert.equal(cycling.has('crankRevs'), true);
  assert.equal(cycling.has('pace'), false);
  assert.equal(display('cadence', 80, 'metric').unit, 'rpm');
  if (process.env.ACTIVITY_SAMPLE) {
    const sample = new Ride(JSON.parse(readFileSync(process.env.ACTIVITY_SAMPLE, 'utf8')));
    const sync = sample.meta.telemetry.synchronization;
    assert.equal(sample.meta.activity.sport, 'running');
    assert.equal(sample.has('crankRevs'), false);
    assert.equal(sample.has('stepCadence'), true);
    assert.equal(sample.has('pace'), true);
    assert.ok(sync.clipStartRideSec >= 0 && sync.clipEndRideSec <= sample.duration);
    for (let t = sync.clipStartRideSec; t < sync.clipEndRideSec; t += 1 / 30) {
      assert.ok(Number.isFinite(sample.at('pace', t)));
      assert.ok(Number.isFinite(sample.at('heartRate', t)));
      assert.ok(Number.isFinite(sample.at('stepCadence', t)));
      assert.ok(Number.isFinite(sample.at('lat', t)));
    }
    console.log(`Real Venu/phone sample passed: ${sample.t.length} records, clip ${sync.clipStartRideSec}–${sync.clipEndRideSec} s fully covered, pace/HR/steps/GPS finite throughout.`);
  }
  console.log('Activity telemetry passed: pace/steps, cycling isolation, gaps, zero/missing speed, metric/imperial units.');
} finally {
  await server.close();
}
