// End-to-end import, source resolution and FFmpeg export using temporary media.
// Run from studio: node scripts/test_dji_studio.mjs (FFmpeg/Python required).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'dji studio test ')));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const video = join(temp, 'original clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  const sidecar = join(temp, 'test.SRT');
  writeFileSync(sidecar, '1\n00:00:00,000 --> 00:00:00,500\n[latitude: 0] [longitude: 0] [abs_alt: 10]\n\n2\n00:00:00,500 --> 00:00:01,000\n[latitude: 0] [longitude: 0.0001] [abs_alt: 11]\n');
  const rides = join(temp, 'public/data/rides');
  mkdirSync(rides, { recursive: true });
  // Set only the importer's output root to this isolated test directory.
  const python = 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import prepare_dji; prepare_dji.STUDIO=Path(sys.argv[2]); sys.argv=sys.argv[3:]; prepare_dji.main()';
  const args = ['prepare_dji.py', sidecar, '--start-utc', '2026-10-04T12:00:00.125Z',
    '--clock-correction-sec', '2', '--timezone', 'Europe/London', '--id', 'dji-test', '--out-dir', rides,
    '--video', video, '--preview', video, '--register', '--camera', 'rear'];
  execFileSync(process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-c', python, join(studio, 'scripts'), temp, ...args]);
  const before = readFileSync(video);
  assert.throws(() => execFileSync(process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-c', python, join(studio, 'scripts'), temp, ...args], { stdio: 'pipe' }), /Command failed/);
  const { footageIndex, mediaPath } = await server.ssrLoadModule('/server/plugin.ts');
  const { fileStartMs, sourceInfo } = await server.ssrLoadModule('/src/core/project.ts');
  const { Ride } = await server.ssrLoadModule('/src/core/ride.ts');
  const paths = { studio: temp, mediaRoot: join(temp, 'unmounted-share'), cache: join(temp, '.cache'), exports: join(temp, 'exports') };
  const index = await footageIndex(paths);
  assert.equal(index.error, undefined);
  assert.equal(index.files.length, 1);
  const file = index.files[0];
  assert.equal(mediaPath(paths, 'rear', file.name), video);
  assert.equal(mediaPath(paths, 'rear', file.preview.name), video);
  assert.equal(mediaPath(paths, 'front', file.name), null);
  assert.equal(mediaPath(paths, 'rear', '../original clip.mp4'), null);
  assert.equal(file.sourcePath, undefined); // local paths stay out of client index
  assert.equal(sourceInfo(file).bottomStrip, 0);
  assert.equal(fileStartMs(file, -1), Date.parse('2026-10-04T12:00:02.125Z')); // no Garmin offset
  const rideJson = JSON.parse(readFileSync(join(rides, 'dji-test.json'), 'utf8'));
  const ride = new Ride(rideJson);
  assert.equal(ride.has('cadence'), false);
  assert.equal(ride.has('heartRate'), false);
  assert.equal(ride.at('altitude', .25), 10.5);
  assert.equal(ride.localTime(0).h, 13);
  // High-rate GPS still needs a finite heading; a sample-count window was too short.
  const dense = new Ride({ ...rideJson, t: Array.from({ length: 151 }, (_, i) => i / 50),
    channels: { lat: Array(151).fill(0), lon: Array.from({ length: 151 }, (_, i) => i * .000001) } });
  assert.equal(dense.at('heading', 1), 90);
  const { startExport, getJob } = await server.ssrLoadModule('/server/export.ts');
  const project = { version: 1, name: 'DJI test', rideId: 'dji-test', formatId: '16x9', units: 'metric', panelOpacity: .5,
    framing: { cx: .5, cy: .5, zoom: 1 }, overlays: [], audioLevel: .35, rearOffsetSec: -1,
    clips: [{ id: 'one', label: 'DJI', rideStart: 0, duration: 1, camera: 'rear' }] };
  const id = startExport(paths, { project }, 'http://localhost:5178');
  const deadline = Date.now() + 60000;
  let job;
  do {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = getJob(id);
  } while (!['done', 'error'].includes(job.status) && Date.now() < deadline);
  assert.equal(job.status, 'done', job.message);
  assert.equal(job.checks.frames, 30);
  assert.equal(job.checks.seconds, 1);
  assert.equal(job.checks.width, 1920);
  assert.equal(job.checks.height, 1080);
  assert.equal(job.checks.video, 'h264');
  assert.equal(job.checks.audio, 'aac');
  execFileSync('ffmpeg', ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
  assert.deepEqual(readFileSync(video), before);
  console.log('DJI integration passed: import, registration, preview/source resolution, high-rate heading, 30-frame H.264/AAC export and full decode.');
} finally {
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}
