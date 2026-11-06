// Auto camera/editor API import, CLI GoPro/DJI detection and a real HUD export.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? (existsSync(resolve(studio, process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python')) ? resolve(studio, process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python') : process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'));
process.env.STUDIO_PYTHON = python;
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'camera-studio-')));
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let http;
try {
  const { studioServer, footageIndex, mediaPath } = await loader.ssrLoadModule('/server/plugin.ts');
  const { startExport, getJob } = await loader.ssrLoadModule('/server/export.ts');
  const { Ride } = await loader.ssrLoadModule('/src/core/ride.ts');
  const paths = { studio: temp, cache: join(temp, '.cache'), mediaRoot: join(temp, 'unmounted'), exports: join(temp, 'exports') };
  mkdirSync(join(temp, 'public/data/rides'), { recursive: true });
  for (const d of ['scripts', 'src', 'node_modules']) symlinkSync(join(studio, d), join(temp, d), process.platform === 'win32' ? 'junction' : 'dir');
  http = await createServer({ root: temp, configFile: false, plugins: [studioServer(temp)], optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0 }, appType: 'custom', logLevel: 'error' });
  await http.listen();
  const origin = http.resolvedUrls.local[0].replace(/\/$/, '');
  const post = (url, body) => fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
  const generated = join(temp, 'sample.mp4');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', 'creation_time=2026-10-04T12:00:00Z', generated]);
  const generic = readFileSync(generated);
  let res = await post('/api/cameras?name=Hero13.MP4&timezone=Europe%2FLondon', generic);
  let result = await res.json();
  assert.equal(res.status, 201, JSON.stringify(result));
  assert.equal(result.detection.kind, 'exif', 'file naming must not determine the decoder');
  assert.equal(result.detection.gpsStatus, 'absent');
  const noGps = JSON.parse(readFileSync(join(temp, 'public/data/rides', result.rideId + '.json')));
  assert.deepEqual(noGps.channels, {});
  assert.equal(noGps.tzOffsetSec, 3600);
  // A camd box at top level is detected even without a DJI filename or track.
  const djiPath = join(temp, 'embedded-dji.mp4');
  writeFileSync(djiPath, generic);
  run(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from test_dji_telemetry import box,header,record; p=Path(sys.argv[2]); p.write_bytes(p.read_bytes()+box(b"camd",box(b"mdat",header()+record()+record(t=6000000,seq=1))))', join(studio, 'scripts'), djiPath]);
  res = await post('/api/cameras?name=unlabelled-dji.mp4', readFileSync(djiPath));
  const dji = await res.json();
  assert.equal(res.status, 201, JSON.stringify(dji));
  assert.equal(dji.detection.kind, 'dji');
  assert.equal(dji.detection.gpsStatus, 'usable');
  assert.equal(JSON.parse(readFileSync(join(temp, 'public/data/rides', dji.rideId + '.json'))).channels.speed[0], 5);
  run(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from test_gopro_telemetry import append_gpmf,packet; append_gpmf(Path(sys.argv[2]),[packet(),packet(fix=0),packet(fix=2),packet(speed=40000)])', join(studio, 'scripts'), generated]);
  const expectedHash = hash(generated);
  res = await post('/api/cameras?name=unlabelled.mp4', readFileSync(generated));
  result = await res.json();
  assert.equal(res.status, 201, JSON.stringify(result));
  assert.equal(result.detection.kind, 'gopro');
  assert.equal(result.detection.gpsStatus, 'usable');
  const rideId = result.rideId;
  const json = JSON.parse(readFileSync(join(temp, 'public/data/rides', rideId + '.json')));
  assert.equal(json.meta.telemetry.schemas[0], 'GPS5');
  assert.ok(!('sampleEvidence' in json.meta.telemetry), 'per-sample evidence stays out of the ride JSON');
  const ride = new Ride(json);
  assert.equal(ride.at('speed', 0), 1);
  assert.ok(Number.isNaN(ride.at('speed', 1.25)), 'no lock remains missing');
  assert.ok(Number.isNaN(ride.at('altitude', 2.25)), '2D fix cannot provide altitude');
  assert.ok(Number.isNaN(ride.at('speed', 3.25)), 'implausible speed is missing');
  assert.equal(ride.has('heartRate'), false);
  let files = (await footageIndex(paths)).files;
  let file = files.find((f) => f.rideId === rideId);
  assert.equal(file.bottomStrip, 0);
  assert.equal(file.sourcePath, undefined);
  assert.equal(hash(mediaPath(paths, 'front', file.name)), expectedHash);
  const goproEntry = JSON.parse(readFileSync(join(temp, '.cache/media.json'), 'utf8')).find((m) => m.rideId === rideId);
  const evidence = JSON.parse(readFileSync(join(temp, '.cache/media', goproEntry.id, 'telemetry-evidence.json'), 'utf8'));
  assert.equal(evidence.kind, 'gopro');
  assert.equal(evidence.sampleEvidence.length, json.meta.telemetry.gpsSamples, 'every GoPro sample keeps its raw evidence');
  assert.ok(evidence.sampleEvidence.some((s) => s.speedRejected), 'rejected raw readings are retained');
  res = await post(`/api/media?rideId=${rideId}&name=another.mp4`, readFileSync(generated));
  const media = await res.json();
  assert.equal(res.status, 201, JSON.stringify(media));
  assert.equal(media.detection.kind, 'gopro');
  assert.equal(media.detection.gpsSamples, 6);
  assert.equal(media.clockSource, 'GoPro GPS UTC minus metadata playback time (approximate)');
  const mediaEntry = JSON.parse(readFileSync(join(temp, '.cache/media.json'), 'utf8')).find((m) => m.id === media.id);
  assert.ok(!existsSync(join(temp, '.cache/media', mediaEntry.id, 'telemetry.json')), 'activity imports build no camera projection');
  res = await post(`/api/media?rideId=${rideId}&name=again.mp4`, readFileSync(generated));
  const secondMedia = await res.json();
  assert.equal(res.status, 201, JSON.stringify(secondMedia));
  assert.notEqual(secondMedia.id, media.id, 'imports into an activity keep their existing no-dedupe behaviour');
  const cli = (video, id) => {
    const boot = 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import prepare_media; prepare_media.STUDIO=Path(sys.argv[2]); sys.argv=sys.argv[3:]; prepare_media.main()';
    return run(python, ['-c', boot, join(studio, 'scripts'), temp, 'prepare_media.py', video, '--id', id, '--out-dir', join(temp, 'public/data/rides'), '--timezone', 'Europe/London', '--register']);
  };
  cli(generated, 'cli-gopro');
  assert.throws(() => cli(generated, 'cli-gopro'), /Command failed/);
  const cliGopro = JSON.parse(readFileSync(join(temp, 'public/data/rides/cli-gopro.json')));
  assert.ok(!('sampleEvidence' in cliGopro.meta.telemetry));
  assert.equal(JSON.parse(readFileSync(join(temp, '.cache/camera-evidence/cli-gopro.json'), 'utf8')).sampleEvidence.length, cliGopro.meta.telemetry.gpsSamples);
  const genericPath = join(temp, 'generic.mp4');
  writeFileSync(genericPath, generic);
  writeFileSync(join(temp, 'GENERIC.SRT'), '1\n00:00:00,000 --> 00:00:01,000\n[latitude: 0] [longitude: 0] [abs_alt: 10]\n\n2\n00:00:01,000 --> 00:00:02,000\n[latitude: 0] [longitude: 0.00001] [abs_alt: 11]\n');
  cli(genericPath, 'cli-dji');
  assert.equal(JSON.parse(readFileSync(join(temp, 'public/data/rides/cli-dji.json'))).meta.telemetry.kind, 'dji');
  const paired = await post('/api/camera-sidecars?name=GENERIC.SRT', readFileSync(join(temp, 'GENERIC.SRT')));
  assert.equal(paired.status, 201);
  const token = (await paired.json()).id;
  res = await post(`/api/cameras?name=generic.mp4&sidecar=${token}`, generic);
  const pairedCamera = await res.json();
  assert.equal(res.status, 201, JSON.stringify(pairedCamera));
  assert.equal(pairedCamera.detection.kind, 'dji');
  assert.equal(pairedCamera.detection.gpsStatus, 'usable');
  assert.equal((await post('/api/cameras?name=generic.mp4&sidecar=../../invalid', generic)).status, 400);
  const mediaDirs = () => readdirSync(join(temp, '.cache/media')).length;
  const before = mediaDirs();
  const repeat = await post('/api/camera-sidecars?name=GENERIC.SRT', readFileSync(join(temp, 'GENERIC.SRT')));
  assert.equal(repeat.status, 201);
  res = await post(`/api/cameras?name=generic.mp4&sidecar=${(await repeat.json()).id}`, generic);
  const duplicate = await res.json();
  assert.equal(res.status, 201, JSON.stringify(duplicate));
  assert.equal(duplicate.rideId, pairedCamera.rideId, 'the same bytes and sidecar reopen the existing camera ride');
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.detection.kind, 'dji');
  assert.equal(mediaDirs(), before, 'no second copy of the video is kept');
  assert.equal(readdirSync(join(temp, '.cache/camera-sidecars')).length, 0, 'staged SRT sidecars are removed once consumed');
  res = await post('/api/cameras?name=unlabelled.mp4', readFileSync(generated));
  const sameGopro = await res.json();
  assert.equal(sameGopro.rideId, rideId, 're-importing the same GoPro clip reopens its ride');
  assert.equal(sameGopro.existing, true);
  let exportRide = 'cli-gopro', at = 0;
  if (process.env.CAMERA_SAMPLE) {
    cli(process.env.CAMERA_SAMPLE, 'real-gopro');
    exportRide = 'real-gopro'; at = 20;
    const real = new Ride(JSON.parse(readFileSync(join(temp, 'public/data/rides/real-gopro.json'))));
    assert.ok(Number.isFinite(real.at('speed', at)));
    assert.ok(Number.isFinite(real.at('altitude', at)));
  }
  file = (await footageIndex(paths)).files.find((f) => f.rideId === exportRide);
  assert.ok(file);
  if (process.env.CAMERA_SAMPLE) {
    assert.equal(file.preview?.codec, 'h264', 'HEVC originals get a compatible preview automatically');
    assert.equal(mediaPath(paths, 'front', file.name), process.env.CAMERA_SAMPLE, 'export uses the original');
    assert.notEqual(mediaPath(paths, 'front', file.preview.name), process.env.CAMERA_SAMPLE);
  }
  const project = { version: 1, name: 'Camera detection test', rideId: exportRide, formatId: '9x16', units: 'metric', panelOpacity: .5,
    framing: { cx: .5, cy: .5, zoom: 1 }, audioLevel: .35, rearOffsetSec: -1,
    overlays: [{ uid: 'speed', widgetId: 'speed.glass', nx: .5, ny: .7, scale: .6, opacity: 1 },
      { uid: 'alt', widgetId: 'elevation.glass', nx: .5, ny: .8, scale: .6, opacity: 1 }],
    clips: [{ id: 'one', label: 'GoPro', rideStart: at, duration: 1, camera: 'front', sourceFile: file.name }] };
  const jobId = startExport(paths, { project }, origin);
  const deadline = Date.now() + 180000;
  let job;
  do {
    await new Promise((r) => setTimeout(r, 150)); job = getJob(jobId);
  } while (!['done', 'error'].includes(job.status) && Date.now() < deadline);
  assert.equal(job.status, 'done', `${job.message}\n${job.log.join('\n')}`);
  assert.equal(job.checks.frames, 30); assert.equal(job.checks.seconds, 1);
  assert.equal(job.checks.width, 1080); assert.equal(job.checks.height, 1920);
  assert.equal(job.checks.video, 'h264'); assert.equal(job.checks.audio, 'aac');
  run('ffmpeg', ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
  assert.equal(hash(generated), expectedHash);
  if (process.env.CAMERA_REPORT_DIR) {
    mkdirSync(process.env.CAMERA_REPORT_DIR, { recursive: true });
    writeFileSync(join(process.env.CAMERA_REPORT_DIR, 'export-checks.json'), JSON.stringify(job.checks, null, 2));
    const { copyFileSync } = await import('node:fs');
    copyFileSync(job.output, join(process.env.CAMERA_REPORT_DIR, 'hud-check.mp4'));
  }
  console.log(`Camera integration passed: content detection, HTTP camera/editor import with duplicate detection, missing-data breaks, CLI GoPro/DJI-sidecar registration, originals preserved, ${process.env.CAMERA_SAMPLE ? 'real HERO' : 'generated'} 30-frame HUD export + full decode.`);
} finally {
  await http?.close(); await loader.close(); rmSync(temp, { recursive: true, force: true });
}
