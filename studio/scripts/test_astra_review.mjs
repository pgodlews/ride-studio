// Regression checks for the Astra review, including real FFmpeg exports from synthetic sources.
// Usage: node studio/scripts/test_astra_review.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'astra-regression-')));
const attribution = '© Synthetic tile provider & contributors';
const savedTileEnv = { url: process.env.STUDIO_TILE_URL, attribution: process.env.STUDIO_TILE_ATTRIBUTION };
process.env.STUDIO_TILE_URL = 'http://127.0.0.1:9/{z}/{x}/{y}.png';
process.env.STUDIO_TILE_ATTRIBUTION = attribution;
const loader = await createServer({ root: studio, configFile: false, define: { __STUDIO_TILE_ATTRIBUTION__: JSON.stringify(attribution) },
  server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...options });
try {
  const { Ride } = await loader.ssrLoadModule('/src/core/ride.ts');
  const { projectRoute, routePosition } = await loader.ssrLoadModule('/src/core/geometry.ts');
  const { routeWorld, positionAt } = await loader.ssrLoadModule('/src/core/mercator.ts');
  const { coverage, footagePieces } = await loader.ssrLoadModule('/src/core/project.ts');
  const { previewAt } = await loader.ssrLoadModule('/src/editor/footage.ts');
  const { registry } = await loader.ssrLoadModule('/src/widgets/index.ts');
  const { AssetContext } = await loader.ssrLoadModule('/src/render/assets.tsx');
  const { assertFootageCoverage, ffmpeg, probeOutput, startExport, getJob, stopExports } = await loader.ssrLoadModule('/server/export.ts');
  const fixture = { schema: 1, id: 'astra-test', startUtc: '2026-01-01T00:00:00Z', tzOffsetSec: 0, t: [0, 1, 2, 3, 4],
    channels: { lat: [51, 51.001, 51.002, 51.003, 51.004], lon: [0, 0, 0, 0, 0], distance: [0, 100, 200, 300, 400], altitude: [10, null, 30, null, 50] },
    meta: { hrZones: null, laps: [], climbs: [], summary: {}, sensors: [], warnings: [] } };
  const short = new Ride(fixture);
  const { distance, ...withoutDistance } = fixture.channels;
  const privacyCases = [short, new Ride({ ...fixture, channels: withoutDistance }),
    new Ride({ ...fixture, channels: { ...fixture.channels, distance: [0, null, 1000, 1500, 2000] } }),
    new Ride({ ...fixture, channels: { ...fixture.channels, distance: [0, 1000, 800, 1500, 2000] } })];
  const map = registry.get('streetMap.glass');
  assert.ok(map);
  for (const ride of privacyCases) {
    assert.equal(routeWorld(ride, 500), null, 'sampling must not skip an invalid distance');
    assert.equal(routeWorld(ride, 500, 1), null);
    assert.equal(projectRoute(ride, 500), null);
    const html = renderToStaticMarkup(createElement(map.Component, { ride, t: 0, units: 'metric', panelOpacity: .5, settings: { ...map.defaults, privacyTrimMetres: 500 } }));
    assert.match(html, /Location hidden/);
    assert.ok(!html.includes('<image'), 'private route must not request map tiles');
    assert.ok(!/NaN|Infinity|undefined/.test(html));
  }
  assert.ok(routeWorld(short, 0));
  assert.ok(projectRoute(short, 0));
  const long = new Ride({ ...fixture, channels: { ...fixture.channels, distance: [1000, 1500, 2000, 2500, 3000] } });
  const world = routeWorld(long, 500, 1);
  const schematic = projectRoute(long, 500);
  assert.deepEqual([world.from, world.to], [1, 3], 'privacy distances are relative to the recorded start');
  assert.equal(positionAt(long, world, 0).hidden, true);
  assert.equal(positionAt(long, world, 3).hidden, false);
  assert.equal(routePosition(schematic, 0), null);
  assert.ok(routePosition(schematic, 2));
  const html = renderToStaticMarkup(createElement(AssetContext.Provider, { value: { tileBase: '', tileAttribution: attribution, Image: (p) => createElement('image', p) } },
    createElement(map.Component, { ride: long, t: 2, units: 'metric', panelOpacity: .5, settings: map.defaults })));
  assert.match(html, /Synthetic tile provider &amp; contributors/);
  // The injected build default is also used without a provider.
  assert.match(renderToStaticMarkup(createElement(map.Component, { ride: short, t: 0, units: 'metric', panelOpacity: .5, settings: map.defaults })), /Synthetic tile provider/);
  for (const distance of [[0, 100, 200, 300, 400], [0, 0, 0, 0, 0]]) {
    const ride = new Ride({ ...fixture, channels: { ...fixture.channels, distance } });
    const def = registry.get('elevationProfile.broadcast');
    for (const t of [0, 1, 2, 4]) {
      const profile = renderToStaticMarkup(createElement(def.Component, { ride, t, units: 'metric', panelOpacity: .5, settings: def.defaults }));
      assert.ok(!/NaN|Infinity|undefined/.test(profile), 'missing altitude / constant distance must have finite SVG');
    }
  }

  const base = Date.parse(fixture.startUtc);
  const file = (name, start, duration, extras = {}) => ({ camera: 'front', name, createdUtc: new Date(base + start * 1000).toISOString(), duration,
    clockOffsetSec: 0, brand: 'phone', rideId: fixture.id, width: 320, height: 180, displayWidth: 320, codec: 'h264', audio: null, preview: null, bottomStrip: 0, ...extras });
  const overlapping = [file('B.MP4', 0, 6), file('A.MP4', 0, 6), file('C.MP4', 4, 6)];
  const pieces = footagePieces(overlapping, 'front', base, 10);
  assert.deepEqual(pieces.map((p) => [p.file.name, p.at, p.srcIn, p.duration]), [['A.MP4', 0, 0, 6], ['C.MP4', 6, 2, 4]]);
  assert.equal(coverage(overlapping, 'front', base, 10), 1);
  assert.equal(coverage(overlapping.slice(0, 2), 'front', base, 10), .6);
  for (const t of [0, 4, 5.999, 6, 8]) {
    assert.equal(previewAt(short, overlapping, 'front', t, 0).file.name, t < 6 ? 'A.MP4' : 'C.MP4');
  }
  assert.equal(footagePieces([file('one.MP4', 0, 10)], 'front', base, 1 / 30).length, 1);
  const gap = footagePieces([file('a.MP4', 0, 4), file('b.MP4', 6, 4)], 'front', base, 10);
  assert.throws(() => assertFootageCoverage(gap, 10, 'Main camera'), /missing footage at 4.000–6.000/);
  assert.throws(() => assertFootageCoverage([], 1, 'Rear camera'), /missing footage/);
  assertFootageCoverage(pieces, 10, 'Main camera');

  // Startup failures reject rather than escaping as unhandled child-process errors.
  const originalPath = process.env.PATH;
  const emptyBin = join(temp, 'bin');
  mkdirSync(emptyBin);
  try {
    process.env.PATH = emptyBin;
    await assert.rejects(ffmpeg(['-version'], 1, { log: [] }), /ENOENT/);
    await assert.rejects(probeOutput('unused'), /ENOENT/);
    writeFileSync(join(emptyBin, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    await assert.rejects(ffmpeg(['-version'], 1, { log: [] }), /EACCES/);
  } finally { process.env.PATH = originalPath; }
  const canceled = ffmpeg(['-v', 'error', '-re', '-f', 'lavfi', '-i', 'color=size=32x32:rate=30', '-f', 'null', '-'], 1, { log: [] });
  const cancelCheck = assert.rejects(canceled, /ffmpeg.*(?:stopped|exited)/);
  await new Promise((r) => setTimeout(r, 100));
  stopExports();
  await cancelCheck;

  const paths = { studio: temp, mediaRoot: join(temp, 'unmounted'), cache: join(temp, '.cache'), exports: join(temp, 'exports') };
  mkdirSync(join(temp, 'public/data/rides'), { recursive: true });
  mkdirSync(paths.cache);
  for (const dir of ['src', 'node_modules']) symlinkSync(join(studio, dir), join(temp, dir));
  writeFileSync(join(temp, 'public/data/rides/astra-test.json'), JSON.stringify(fixture));
  const generate = (name, colour, duration, audio = false) => {
    const path = join(temp, name);
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:size=320x180:rate=30`,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), '-t', String(duration),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), path]);
    return path;
  };
  const silent = generate('silent.mp4', 'red', 1);
  const sound = generate('sound.mp4', 'blue', 1, true);
  const rear = generate('rear.mp4', 'green', 2);
  const files = [file('A.MP4', 0, 1, { sourcePath: silent }), file('B.MP4', 1, 1, { sourcePath: sound, audio: 'aac' }),
    file('duplicate.MP4', .5, .5, { sourcePath: sound }), file('R.MP4', 0, 2, { sourcePath: rear, camera: 'rear' })];
  const register = (entries) => writeFileSync(join(paths.cache, 'phone-footage.json'), JSON.stringify(entries));
  register(files);
  const project = { version: 1, name: 'Astra regression', rideId: fixture.id, formatId: '9x16', units: 'metric', panelOpacity: .5,
    framing: { cx: .5, cy: .5, zoom: 1 }, overlays: [], audioLevel: .35, rearOffsetSec: 0,
    clips: [{ id: 'c', label: 'Synthetic chunks', rideStart: 0, duration: 2, camera: 'front' }] };
  const exportProject = async (p, error) => {
    const id = startExport(paths, { project: p }, 'http://localhost:5178');
    const deadline = Date.now() + 120000;
    while (!['done', 'error'].includes(getJob(id).status) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const job = getJob(id);
    if (error) {
      assert.equal(job.status, 'error');
      assert.match(job.message, error);
      assert.ok(!job.log.some((s) => s.startsWith('ffmpeg ')), 'coverage must be rejected before rendering');
    } else {
      assert.equal(job.status, 'done', `${job.message}\n${job.log.join('\n')}`);
      assert.equal(job.checks.frames, p.clips.reduce((n, c) => n + Math.round(c.duration * 30), 0));
      assert.deepEqual([job.checks.width, job.checks.height, job.checks.video, job.checks.audio], [1080, 1920, 'h264', 'aac']);
      run('ffmpeg', ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
    }
    return job;
  };
  const joined = await exportProject(project);
  const frameColour = (time) => [...run('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', joined.output, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])];
  const red = frameColour(.5), blue = frameColour(1.5);
  assert.ok(red[0] > red[2] + 150 && blue[2] > blue[0] + 150, 'video cut must occur at the original ride time');
  const rms = (time) => {
    const bytes = run('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', joined.output, '-t', '0.2', '-vn', '-ac', '1', '-f', 'f32le', '-']);
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
  };
  assert.ok(rms(.3) < .0001, 'silent first chunk must remain silent');
  assert.ok(rms(1.3) > .001, 'second chunk audio must start with its video');
  await exportProject({ ...project, clips: [{ ...project.clips[0], camera: 'pip' }] });
  await exportProject({ ...project, clips: [{ ...project.clips[0], rideStart: .5, duration: 1 / 30 }] });
  await exportProject({ ...project, clips: [{ ...project.clips[0], rideStart: 29 / 30, duration: 2 / 30 }] });
  // Several sub-frame boundaries must not accumulate a frame of drift at each cut.
  register(Array.from({ length: 5 }, (_, i) => file(`part-${i}.MP4`, i * .21, i === 4 ? .16 : .21,
    { sourcePath: i % 2 ? sound : silent, audio: i % 2 ? 'aac' : null })));
  await exportProject({ ...project, clips: [{ ...project.clips[0], duration: 1 }] });
  register(files);
  // A real HUD build receives the custom provider credit; private routes need no tile server.
  await exportProject({ ...project, clips: [{ ...project.clips[0], duration: 1 / 30 }],
    overlays: [{ uid: 'map', widgetId: map.id, nx: .5, ny: .5, scale: 1, opacity: 1 }] });
  const assets = join(paths.cache, 'hud-page/assets');
  assert.ok(readdirSync(assets).filter((name) => name.endsWith('.js')).some((name) => readFileSync(join(assets, name), 'utf8').includes('Synthetic tile provider')),
    'export HUD bundle must contain the configured attribution');
  register([files[0], { ...files[1], createdUtc: new Date(base + 1200).toISOString() }]);
  await exportProject(project, /missing footage at 1.000–1.200/);
  register(files.filter((f) => f.camera === 'front'));
  await exportProject({ ...project, clips: [{ ...project.clips[0], camera: 'pip' }] }, /rear inset.*missing footage/);

  for (const group of ['dependencies', 'devDependencies']) {
    const pkg = JSON.parse(readFileSync(join(studio, 'package.json')));
    const lock = JSON.parse(readFileSync(join(studio, 'package-lock.json')));
    for (const [name, version] of Object.entries(pkg[group])) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
      assert.equal(lock.packages[''][group][name], version);
      assert.equal(lock.packages['node_modules/' + name].version, version);
    }
  }
  console.log('Astra regressions passed: privacy, overlap selection, gap rejection, finite profile SVG, attribution, process failures, exact pins; six full-decode exports including audio timing, PiP, frame boundaries and a private-map HUD with custom credits.');
} finally {
  await loader.close();
  if (savedTileEnv.url === undefined) delete process.env.STUDIO_TILE_URL; else process.env.STUDIO_TILE_URL = savedTileEnv.url;
  if (savedTileEnv.attribution === undefined) delete process.env.STUDIO_TILE_ATTRIBUTION; else process.env.STUDIO_TILE_ATTRIBUTION = savedTileEnv.attribution;
  rmSync(temp, { recursive: true, force: true });
}
