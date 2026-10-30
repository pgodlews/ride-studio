// Run/walk/hike widgets: derived channels (steps, climb rate), splits, moving time and a
// render of every widget for frames in, between and outside the records.
// Usage: node scripts/test_foot_widgets.mjs  (also checks local rides in public/data/rides if present)
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/**
 * 1 Hz run, 3 m/s, climbing 0.1 m/s, 170 spm, heading east. Then: an 8 s smart-recording
 * interval, a 40 s gap, a 60 s stop (speed 0, cadence 0), a missing cadence reading and a
 * new recorded segment.
 */
function fixture() {
  const t = [];
  for (let s = 0; s <= 600; s++) t.push(s);
  t.push(608); // 8 s interval
  t.push(648); // 40 s gap
  for (let s = 649; s <= 900; s++) t.push(s);
  const breakAt = t.length;
  for (let s = 901; s <= 1200; s++) t.push(s);
  let d = 0;
  const ch = { speed: [], distance: [], altitude: [], stepCadence: [], heartRate: [], lat: [], lon: [], pace: [] };
  t.forEach((s, i) => {
    const stopped = s >= 700 && s < 760;
    const v = stopped ? 0 : 3;
    if (i > 0) d += (stopped ? 0 : 3) * (s - t[i - 1]);
    ch.speed.push(v);
    ch.pace.push(v > 0 ? 1 / v : null);
    ch.distance.push(d);
    ch.altitude.push(100 + 0.1 * s + (i % 2 ? 0.3 : -0.3));
    ch.stepCadence.push(stopped ? 0 : s === 800 ? null : 170);
    ch.heartRate.push(150);
    ch.lat.push(51.5);
    ch.lon.push(-0.1 + d / 69_000);
  });
  return {
    schema: 1, id: 'foot-fixture', startUtc: '2026-10-04T08:00:00Z', tzOffsetSec: 3600, t, breaks: [breakAt], channels: ch,
    meta: { hrZones: { highBoundaries: [90, 108, 126, 144, 162, 180], maxHeartRate: 180 }, laps: [], climbs: [], summary: {}, sensors: [], warnings: [] },
  };
}

const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { Ride } = await server.ssrLoadModule('/src/core/ride.ts');
  const { display, grouped } = await server.ssrLoadModule('/src/core/units.ts');
  const { splitAt, movingAt, averagePaceAt, highPoint } = await server.ssrLoadModule('/src/core/activity.ts');
  const { footfall, splitRows } = await server.ssrLoadModule('/src/widgets/foot.tsx');
  const { registry } = await server.ssrLoadModule('/src/widgets/index.ts');

  const run = new Ride(fixture());

  // Gap tolerance follows the recording: 1 Hz keeps 5 s, so its odd 8 s interval is a gap.
  assert.equal(run.gapSec, 5);
  // Steps: 170 spm integrates exactly; intervals beyond the tolerance add nothing, and
  // each interval uses its starting reading (as displayed), so a missing one adds nothing.
  near(run.at('steps', 60), 170, 1e-9, 'steps after 60 s');
  near(run.at('steps', 608) - run.at('steps', 600), 0, 1e-9, '8 s interval in a 1 Hz ride adds no steps');
  near(run.at('steps', 648) - run.at('steps', 608), 0, 1e-9, '40 s gap adds no steps');
  near(run.at('steps', 801) - run.at('steps', 799), 170 / 60, 1e-9, 'missing cadence adds nothing after it');
  assert.ok(Number.isNaN(run.at('steps', 604)), 'not interpolated across a gap');

  // Smart recording (8 s records, one 60 s pause, then a 2.1 km GPS jump): the tolerance
  // becomes 8 s, so cadence, steps, footfall and moving time bridge records but not the pause.
  const sparseT = [];
  for (let s = 0; s <= 400; s += 8) sparseT.push(s);
  for (let s = 460; s <= 800; s += 8) sparseT.push(s);
  const sparse = new Ride({
    ...fixture(), id: 'smart-recording', t: sparseT, breaks: [],
    channels: {
      speed: sparseT.map(() => 3), pace: sparseT.map(() => 1 / 3), stepCadence: sparseT.map(() => 170), heartRate: sparseT.map(() => 150),
      distance: sparseT.map((s) => (s <= 400 ? 3 * s : 3500 + 3 * (s - 460))), altitude: sparseT.map((s) => 100 + 0.1 * s),
      lat: sparseT.map(() => 51.5), lon: sparseT.map((s) => -0.1 + s / 23_000),
    },
  });
  assert.equal(sparse.gapSec, 8);
  assert.equal(sparse.at('stepCadence', 4), 170);
  near(sparse.at('steps', 400), 170 / 60 * 400, 1e-9, 'steps across 8 s records');
  near(sparse.at('steps', 460) - sparse.at('steps', 400), 0, 1e-9, '60 s pause adds no steps');
  assert.equal(footfall({ ride: sparse, t: 4, units: 'metric', panelOpacity: 0.5 }).stepping, true);
  assert.ok(Number.isFinite(sparse.at('heading', 200)), 'heading from neighbouring records');
  near(movingAt(sparse, sparse.duration, 0.5).moving, sparse.duration - 60, 1e-9, 'moving across 8 s records, not the pause');
  // Completed splits stay visible inside the pause; only live progress is unknown.
  const gapSplit = splitAt(sparse, 430, 'metric');
  assert.equal(gapSplit.done.length, 1);
  near(gapSplit.done[0].sec, 1000 / 3, 1e-6, 'km 1 before the pause');
  assert.ok(Number.isNaN(gapSplit.progress));
  // Marks passed inside the pause/jump have no known time: never 0 s, never compared.
  const jump = splitAt(sparse, sparse.duration, 'metric'); // last record 796 s, 4,508 m
  assert.deepEqual(jump.done.map((r) => r.n), [1, 2, 3, 4]);
  assert.deepEqual(jump.done.map((r) => Number.isFinite(r.sec)), [true, false, false, false]);
  assert.deepEqual(splitRows(jump).map((r) => r.best), [false, false, false]);
  assert.ok(Number.isFinite(jump.elapsed), 'km 5 started at an interpolated crossing');

  // Distance starting part-way (2.45 km): numbering continues at km 3 and the partial first
  // split is shown but not compared.
  const offset = new Ride({ ...fixture(), id: 'offset', breaks: [], t: fixture().t.slice(0, 601),
    channels: { speed: Array(601).fill(3), distance: Array.from({ length: 601 }, (_, s) => 2450 + 3 * s), altitude: Array(601).fill(100) } });
  const off = splitAt(offset, 600, 'metric');
  assert.deepEqual(off.done.map((r) => [r.n, r.comparable]), [[3, false], [4, true]]);
  near(off.done[1].sec, 1000 / 3, 1e-6, 'km 4');
  assert.equal(off.current, 5);
  assert.deepEqual(splitRows(off).map((r) => r.delta), ['', '']);

  // Footfall: alternates with whole steps; dim when cadence is zero (real stop).
  const ff = (t) => footfall({ ride: run, t, units: 'metric', panelOpacity: 0.5 });
  assert.equal(ff(10).stepping, true);
  assert.notEqual(ff(10).left > ff(10).right, ff(10 + 60 / 170).left > ff(10 + 60 / 170).right, 'feet alternate per step');
  assert.equal(ff(730).stepping, false);

  // Climb rate: least-squares slope ignores the ±0.3 m alternating noise.
  near(display('verticalSpeed', run.at('climbRate', 300), 'metric').value, 360, 1, 'climb m/h');
  assert.equal(display('verticalSpeed', run.at('climbRate', 300), 'metric').text, '360');
  assert.equal(display('verticalSpeed', 0.1, 'imperial').text, '1181');
  assert.ok(Number.isNaN(run.at('climbRate', 630)), 'not across the 40 s gap');

  // Splits: 1 km every 333.3 s while running; imperial uses miles.
  const s = splitAt(run, 700, 'metric');
  assert.equal(s.done.length, 2);
  near(s.done[0].sec, 1000 / 3, 1e-6, 'first km split');
  near(s.done[1].sec, 1000 / 3, 1e-6, 'second km split');
  assert.equal(s.current, 3);
  near(s.progress, 0.097, 1e-6, 'split progress (2,097 m: the stop starts at 700 s)');
  assert.equal(splitAt(run, 700, 'imperial').done.length, 1);
  assert.equal(splitAt(run, -5, 'metric'), null);

  // Moving time: the 60 s stop, the 40 s gap and (at 1 Hz) the 8 s gap are not moving.
  const m = movingAt(run, 900, 0.5);
  near(m.elapsed, 900, 1e-9, 'elapsed');
  near(m.moving, 900 - 40 - 61 - 8, 1e-9, 'moving'); // stop spans the 699→760 s records
  near(movingAt(run, 650.5, 0.5).moving, 600 + 2.5, 1e-9, 'partial interval');
  near(movingAt(run, run.duration + 50, 0.5).elapsed, run.duration, 1e-9, 'elapsed holds after the end');
  near(movingAt(run, 900, 5).moving, 0, 1e-9, 'threshold above every speed');

  near(averagePaceAt(run, 300), 300 / 900, 1e-9, 'average pace so far');
  assert.ok(Number.isNaN(averagePaceAt(run, 10)), 'average pace needs 50 m');
  assert.equal(grouped(6842), '6,842');
  assert.equal(grouped(1234567.4), '1,234,567');
  assert.equal(highPoint(run).alt > 200, true);

  // Render every widget on several rides and frames: no crash, no NaN/Infinity in markup.
  const FOOT = ['pace', 'stepCadence', 'steps', 'splits', 'climbRate', 'heading', 'movingTime', 'runStrip'];
  const rides = [['fixture', run]];
  const cycling = new Ride({ ...fixture(), id: 'cycling', channels: { speed: fixture().channels.speed, distance: fixture().channels.distance, altitude: fixture().channels.altitude, cadence: fixture().channels.stepCadence.map((v) => (v == null ? null : v / 2)) } });
  rides.push(['cycling', cycling], ['smart-recording', sparse], ['offset', offset]);
  const dir = resolve(studio, 'public/data/rides');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) rides.push([f, new Ride(JSON.parse(readFileSync(resolve(dir, f), 'utf8')))]);
  }
  const foot = registry.all().filter((w) => FOOT.includes(w.metric) || w.id.endsWith('-summit'));
  assert.equal(foot.length, 4 * 9, 'nine run/walk/hike widgets in each of four families');
  const STRICT = ['elevationProfile.gauge', 'elevationProfile.broadcast']; // repaired older widgets remain strict
  let frames = 0;
  const older = new Set(); // pre-existing widgets: reported, not failed
  for (const [name, ride] of rides) {
    const times = [-10, 0, 0.5, ride.duration * 0.25, ride.duration * 0.5 + 0.37, ride.duration * 0.9, ride.duration, ride.duration + 5, 604, 630];
    for (const def of registry.all().filter((w) => w.metric !== 'streetMap')) {
      if (!registry.isAvailable(def, ride)) continue;
      for (const t of times) {
        for (const units of ['metric', 'imperial']) {
          const html = renderToStaticMarkup(createElement(def.Component, { ride, t, units, panelOpacity: 0.5, settings: def.defaults }));
          const bad = /NaN|Infinity|undefined/.test(html);
          if (foot.includes(def) || STRICT.includes(def.id)) assert.ok(!bad, `${def.id} on ${name} at t=${t} (${units}): ${html.match(/.{40}(NaN|Infinity|undefined).{20}/)?.[0]}`);
          else if (bad) older.add(`${def.id} on ${name}`);
          frames++;
        }
      }
    }
  }
  for (const id of ['pace.glass', 'steps.neon', 'stepCadence.gauge', 'runStrip.broadcast']) {
    assert.equal(registry.isAvailable(registry.get(id), cycling), false, `${id} hidden for cycling rides`);
  }
  if (older.size) console.log(`Note: older widgets emit NaN/undefined markup: ${[...older].join('; ')}`);
  console.log(`Foot widgets passed: steps/climb/splits/moving checks, ${foot.length} new widgets, ${frames} frames rendered across ${rides.length} rides; new widgets never emit NaN.`);
} finally {
  await server.close();
}
