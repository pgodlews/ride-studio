// Pin-sync media: HTTP activity import (GPX) and any-video import, clock/pin/device
// placement, browser previews for unplayable formats, serving and export with full decode.
// Usage: node scripts/test_media_studio.mjs  (uses STUDIO_PYTHON or the repository .venv)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const venv = resolve(studio, process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python');
process.env.STUDIO_PYTHON ??= process.env.PYTHON ?? (existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3');
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'media studio test ')));
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let http;
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const START = Date.parse('2026-10-04T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
try {
  const { studioServer, footageIndex, mediaPath } = await loader.ssrLoadModule('/server/plugin.ts');
  const { startExport, getJob } = await loader.ssrLoadModule('/server/export.ts');
  const { mediaCoverage } = await loader.ssrLoadModule('/src/core/project.ts');
  const paths = { studio: temp, mediaRoot: join(temp, 'unmounted'), cache: join(temp, '.cache'), exports: join(temp, 'exports') };
  mkdirSync(join(temp, 'public/data/rides'), { recursive: true });
  for (const d of ['scripts', 'src', 'node_modules']) symlinkSync(join(studio, d), join(temp, d), process.platform === 'win32' ? 'junction' : 'dir');
  http = await createServer({ root: temp, configFile: false, plugins: [studioServer(temp)], optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0 }, appType: 'custom', logLevel: 'error' });
  await http.listen();
  const origin = http.resolvedUrls.local[0].replace(/\/$/, '');
  const post = (path, body, type = 'application/octet-stream') => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body });

  // --- Activity import: a 2-minute GPX walk east at 1.5 m/s (no sensors, GPS only).
  const pts = Array.from({ length: 121 }, (_, s) => `<trkpt lat="51.5" lon="${(-0.1 + s * 1.5 / 69_400).toFixed(7)}"><ele>${(20 + s * 0.05).toFixed(2)}</ele><time>${iso(START + s * 1000)}</time></trkpt>`).join('');
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Walk</name><trkseg>${pts}</trkseg></trk></gpx>`;
  let res = await post('/api/activities?name=' + encodeURIComponent('Morning walk.gpx'), gpx);
  const imported = await res.json();
  assert.equal(res.status, 201, JSON.stringify(imported));
  assert.equal(imported.rideId, 'Morning-walk');
  assert.equal(imported.existing, false);
  res = await post('/api/activities?name=again.gpx', gpx);
  assert.deepEqual(await res.json(), { rideId: 'Morning-walk', existing: true, warnings: [] }, 'same bytes return the existing ride');
  assert.equal((await post('/api/activities?name=notes.txt', 'hello')).status, 400);
  const untimed = await post('/api/activities?name=route.gpx', gpx.replace(/<time>[^<]+<\/time>/g, ''));
  assert.equal(untimed.status, 400);
  assert.match((await untimed.json()).error, /GPS|timestamp|track/i);
  const rides = (await (await fetch(`${origin}/api/rides`)).json()).rides;
  assert.equal(rides.length, 1);
  assert.equal(rides[0].gps, true);
  assert.equal(rides[0].name, 'Morning walk.gpx');
  const rideId = imported.rideId;
  const original = readFileSync(join(temp, '.cache/activity-imports', createHash('sha256').update(gpx).digest('hex'), 'Morning walk.gpx'), 'utf8');
  assert.equal(original, gpx, 'original activity bytes kept');

  // --- Videos: two from one camera with recorded clocks, one MKV/MPEG-4 without any clock.
  const clip = (file, args) => run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', ...args, join(temp, file)]);
  const meta = (when) => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', 'use_metadata_tags',
    '-metadata', `creation_time=${iso(when)}`, '-metadata', 'com.apple.quicktime.make=TestCam', '-metadata', 'com.apple.quicktime.model=One'];
  clip('first.mov', meta(START + 20_000));
  clip('second.mov', meta(START + 70_000));
  clip('noclock.mkv', ['-c:v', 'mpeg4', '-c:a', 'mp3', '-fflags', '+bitexact', '-map_metadata', '-1']);
  const firstHash = hash(join(temp, 'first.mov'));
  const upload = async (file) => {
    const r = await post(`/api/media?rideId=${rideId}&name=${encodeURIComponent(file)}`, readFileSync(join(temp, file)));
    const body = await r.json();
    assert.equal(r.status, 201, `${file}: ${JSON.stringify(body)}`);
    return body;
  };
  const [first, second, noclock] = [await upload('first.mov'), await upload('second.mov'), await upload('noclock.mkv')];
  assert.equal(first.device, 'TestCam One');
  assert.equal(first.recordedUtc, iso(START + 20_000));
  assert.equal(first.sync, 'clock');
  assert.equal(second.sync, 'clock');
  assert.equal(noclock.recordedUtc, null);
  assert.equal(noclock.sync, 'none');
  assert.ok(noclock.preview, 'MPEG-4/MKV gets an H.264 browser preview');
  assert.equal(first.preview, null, 'H.264 MOV plays as is');
  assert.equal(first.sourcePath, undefined, 'private paths stay on the server');
  assert.equal((await post(`/api/media?rideId=${rideId}&name=bad.mp4`, 'not a video')).status, 400);
  assert.equal((await post('/api/media?rideId=missing&name=a.mov', readFileSync(join(temp, 'first.mov')))).status, 400);

  let files = (await footageIndex(paths)).files;
  assert.deepEqual(files.map((f) => f.mediaId).sort(), [first.id, second.id].sort(), 'unplaced clips are not footage yet');
  assert.ok(files.every((f) => f.brand === 'media' && f.camera === 'front' && f.rideId === rideId));
  assert.ok(mediaPath(paths, 'front', noclock.preview.name).endsWith('preview.mp4'));
  assert.equal(mediaPath(paths, 'rear', first.name), null);

  // --- Pin the first clip 5 s later than its clock, for its whole camera.
  const sync = async (m, startUtc, device) => {
    const r = await post(`/api/media/${m.id}/sync`, JSON.stringify({ startUtc, device }), 'application/json');
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    return Object.fromEntries(body.media.map((x) => [x.id, x]));
  };
  let state = await sync(first, iso(START + 25_000), true);
  assert.equal(state[first.id].sync, 'pin');
  assert.equal(state[second.id].sync, 'device');
  assert.equal(state[second.id].startUtc, iso(START + 75_000), 'device offset +5 s');
  assert.equal(state[noclock.id].sync, 'none');
  state = await sync(noclock, iso(START + 100_000));
  assert.equal(state[noclock.id].sync, 'pin');
  const cov = (m) => Object.fromEntries(Object.entries(mediaCoverage(m, START, 120)).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  assert.deepEqual(cov(state[noclock.id]), { start: 100, end: 104, inside: 1 });
  state = await sync(first, null);
  assert.equal(state[first.id].sync, 'clock');
  assert.equal(state[second.id].sync, 'clock', 'clearing the source pin removes its device offset');
  state = await sync(first, iso(START + 118_000), true);
  assert.deepEqual(cov(state[first.id]), { start: 118, end: 122, inside: 0.5 }, 'partly outside is allowed');
  state = await sync(first, iso(START + 25_000), true);
  assert.equal((await post(`/api/media/${'0'.repeat(32)}/sync`, '{"startUtc":null}', 'application/json')).status, 400);
  files = (await footageIndex(paths)).files;
  assert.equal(files.length, 3);
  assert.equal(files.find((f) => f.mediaId === second.id).createdUtc, iso(START + 75_000));

  // --- Serving: range requests on the original and the preview alias.
  const ranged = await fetch(`${origin}/media/front/${first.name}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.equal(ranged.headers.get('Content-Type'), 'video/quicktime');
  assert.equal((await fetch(`${origin}/media/front/${noclock.preview.name}`)).status, 200);

  // --- Export: pinned MKV, device-placed MOV and a clip running past the activity end.
  const project = { version: 1, name: 'Media test', rideId, formatId: '9x16', units: 'metric', panelOpacity: .5,
    framing: { cx: .5, cy: .5, zoom: 1 }, audioLevel: .35, rearOffsetSec: -1,
    overlays: [{ uid: 'pace', widgetId: 'pace.glass', nx: .5, ny: .7, scale: .7, opacity: 1 }],
    clips: [
      { id: 'a', label: 'MKV', camera: 'front', sourceFile: noclock.name, rideStart: 101, duration: 2 },
      { id: 'b', label: 'Sibling', camera: 'front', sourceFile: second.name, rideStart: 76, duration: 1 },
    ] };
  const id = startExport(paths, { project }, origin);
  const deadline = Date.now() + 180000;
  let job;
  do {
    await new Promise((r) => setTimeout(r, 150));
    job = getJob(id);
  } while (!['done', 'error'].includes(job.status) && Date.now() < deadline);
  assert.equal(job.status, 'done', `${job.message}\n${job.log.join('\n')}`);
  assert.equal(job.checks.frames, 90);
  assert.equal(job.checks.audio, 'aac');
  run('ffmpeg', ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
  assert.equal(hash(join(temp, 'first.mov')), firstHash, 'source video untouched');
  const storedFirst = JSON.parse(readFileSync(join(temp, '.cache/media.json'), 'utf8')).find((m) => m.id === first.id);
  assert.equal(hash(storedFirst.sourcePath), firstHash, 'imported original kept byte-for-byte');
  // --- Apple Health export: scan (read-only), clip matching by time, import and re-import.
  const exportRoot = join(temp, 'apple');
  run(process.env.STUDIO_PYTHON, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from test_apple_health import write_export; from pathlib import Path; print(write_export(Path(sys.argv[2])))', join(studio, 'scripts'), exportRoot]);
  const exportDir = join(exportRoot, 'apple_health_export');
  await sync(noclock, '2026-10-03T11:01:00.000Z');
  res = await post('/api/apple-health/scan', JSON.stringify({ path: exportDir }), 'application/json');
  const scanned = await res.json();
  assert.equal(res.status, 200, JSON.stringify(scanned));
  assert.equal(scanned.workouts.length, 3);
  const appleRide = scanned.workouts.find((w) => w.hasRoute && w.sport === 'cycling');
  assert.deepEqual(appleRide.matches, ['noclock.mkv'], 'pinned clip overlaps the workout');
  assert.equal(scanned.workouts.find((w) => w.source === 'Connect').hasRoute, false);
  res = await post('/api/apple-health/import', JSON.stringify({ path: exportDir, workoutId: appleRide.id }), 'application/json');
  const appleImport = await res.json();
  assert.equal(res.status, 201, JSON.stringify(appleImport));
  assert.equal(appleImport.rideId, 'apple-cycling-2026-10-03-1200');
  res = await post('/api/apple-health/import', JSON.stringify({ path: exportDir, workoutId: appleRide.id }), 'application/json');
  assert.equal((await res.json()).existing, true);
  assert.ok((await (await fetch(`${origin}/api/rides`)).json()).rides.some((r) => r.id === appleImport.rideId));
  assert.equal((await post('/api/apple-health/scan', JSON.stringify({ path: 'relative/folder' }), 'application/json')).status, 400);
  assert.equal((await post('/api/apple-health/import', JSON.stringify({ path: exportDir, workoutId: scanned.workouts.find((w) => !w.hasRoute).id }), 'application/json')).status, 400);
  console.log('Media studio passed: GPX import/dedupe, any-video import with previews, clock/pin/device placement, serving, HUD export with full decode, Apple Health scan/match/import.');
} finally {
  await http?.close();
  await loader.close();
  rmSync(temp, { recursive: true, force: true });
}
