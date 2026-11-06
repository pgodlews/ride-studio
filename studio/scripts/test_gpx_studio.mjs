// Check the Python GPX projection through the shared browser/export evaluator.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const code = 'import sys,json; sys.path.insert(0,sys.argv[1]); from test_gpx_activity import fixture_ride; print(json.dumps(fixture_ride(), allow_nan=False))';
const json = JSON.parse(execFileSync(python, ['-c', code, resolve(studio, 'scripts')], { encoding: 'utf8' }));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { Ride } = await server.ssrLoadModule('/src/core/ride.ts');
  const { projectRoute, routePosition, routePoints, linePath } = await server.ssrLoadModule('/src/core/geometry.ts');
  const { routeWorld, positionAt } = await server.ssrLoadModule('/src/core/mercator.ts');
  const ride = new Ride(json);
  assert.equal(ride.localTime(0).h, 17);
  assert.equal(ride.at('cadence', .5), 0);
  assert.ok(ride.at('speed', 1) > 1 && ride.at('speed', 1) < 2);
  for (const t of [1.01, 1.5, 1.99]) {
    for (const c of ['speed', 'lat', 'lon', 'heartRate', 'cadence', 'distance', 'ascent', 'heartBeats']) {
      assert.ok(Number.isNaN(ride.at(c, t)), `${c} must be missing at segment boundary ${t}`);
    }
  }
  assert.equal(ride.at('heartRate', 2), 120); // real endpoint still available
  assert.equal(ride.at('heartBeats', 2), 2); // only the first 1 s of HR integrated
  assert.equal(ride.at('crankRevs', 3), 0);
  assert.equal(ride.has('gradient'), false); // don't infer a grade across disconnected distance
  const route = projectRoute(ride, 0, 600);
  assert.deepEqual(route.breakBefore, [false, false, true, false]);
  assert.equal(routePosition(route, 1.5), null);
  assert.ok(routePosition(route, 2));
  const path = linePath(routePoints(route, 0, 3));
  assert.equal((path.match(/M/g) ?? []).length, 2);
  assert.equal((path.match(/L/g) ?? []).length, 2);
  assert.equal(path.includes('NaN'), false);
  const world = routeWorld(ride, 0, 1);
  assert.deepEqual(world.breakBefore, [false, false, true, false]);
  assert.equal(positionAt(ride, world, 1.5), null);
  // Decimation must preserve a break even when the boundary sample is skipped.
  assert.equal(routeWorld(ride, 0, 3).breakBefore[1], true);
  console.log('GPX evaluator passed: UTC/local time, derived speed, zero cadence, sensor/animation breaks and disconnected maps.');
} finally {
  await server.close();
}
