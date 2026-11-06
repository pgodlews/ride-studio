// HTTP import + persistence + still/mixed/HUD exports, using generated local fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'photo studio test ')));
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
let http;
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
try {
  const { studioServer, footageIndex } = await loader.ssrLoadModule('/server/plugin.ts');
  const { photoIndex, photoPath } = await loader.ssrLoadModule('/server/photos.ts');
  const { programAt, photoRideTime } = await loader.ssrLoadModule('/src/core/project.ts');
  const { startExport, getJob } = await loader.ssrLoadModule('/server/export.ts');
  const paths = { studio: temp, mediaRoot: join(temp, 'unmounted'), cache: join(temp, '.cache'), exports: join(temp, 'exports') };
  const rides = join(temp, 'public/data/rides');
  mkdirSync(rides, { recursive: true });
  symlinkSync(join(studio, 'scripts'), join(temp, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(studio, 'src'), join(temp, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(studio, 'node_modules'), join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const ride = { schema: 1, id: 'photos-test', startUtc: '2026-10-04T12:10:00Z', tzOffsetSec: 3600,
    t: [0, 1, 2, 3], channels: { speed: [0, 3, 6, 9], cadence: [0, 70, 80, 90] },
    meta: { hrZones: null, laps: [], climbs: [], summary: {}, sensors: [], warnings: [] } };
  writeFileSync(join(rides, 'photos-test.json'), JSON.stringify(ride));
  http = await createServer({ root: temp, configFile: false, plugins: [studioServer(temp)], optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0 }, appType: 'custom' });
  await http.listen();
  const origin = http.resolvedUrls.local[0].replace(/\/$/, '');
  const jpeg = join(temp, 'phone portrait.jpg');
  const png = join(temp, 'no gps.png');
  run(python, ['-c', 'from PIL import Image; import sys; im=Image.new("RGB",(320,180),"red"); im.paste("blue",(160,0,320,180)); im.save(sys.argv[1],quality=95); Image.new("RGB",(200,200),"green").save(sys.argv[2])', jpeg, png]);
  run('exiftool', ['-overwrite_original', '-Orientation#=6', '-GPSLatitude=51.25', '-GPSLatitudeRef=N', '-GPSLongitude=0.5', '-GPSLongitudeRef=W',
    '-DateTimeOriginal=2026:10:04 13:10:01', '-OffsetTimeOriginal=+01:00', jpeg]);
  const originalHash = hash(jpeg);
  const upload = async (name, bytes, rideId = ride.id) => fetch(`${origin}/api/photos?rideId=${encodeURIComponent(rideId)}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  const responses = await Promise.all([upload('phone portrait.jpg', readFileSync(jpeg)), upload('no gps.png', readFileSync(png))]);
  assert.deepEqual(responses.map((r) => r.status), [201, 201]);
  const [photo, plain] = await Promise.all(responses.map((r) => r.json()));
  assert.equal(photo.width, 180);
  assert.equal(photo.height, 320);
  assert.deepEqual(photo.gps, { lat: 51.25, lon: -.5, altitude: null });
  assert.equal(photo.capturedUtc, '2026-10-04T12:10:01Z');
  assert.equal(plain.gps, null);
  assert.equal(plain.capturedUtc, null);
  assert.equal(photo.originalPath, undefined);
  assert.equal(photoIndex(paths, ride.id).length, 2);
  assert.equal(photoIndex(paths, 'other-ride').length, 0);
  assert.equal(photoPath(paths, '../photos.json'), null);
  assert.equal(photoRideTime(photo, Date.parse(ride.startUtc), 3), 1);
  assert.equal(photoRideTime(photo, Date.parse(ride.startUtc) + 2000, 3), null);
  assert.equal(photoRideTime(plain, Date.parse(ride.startUtc), 3), null);
  const list = await (await fetch(`${origin}/api/photos?rideId=${ride.id}`)).json();
  assert.equal(list.photos.length, 2);
  const served = await fetch(`${origin}/photos/${photo.id}.png`);
  assert.equal(served.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), readFileSync(photoPath(paths, photo.id)));
  assert.equal((await upload('bad.jpg', Buffer.from('not a photo'))).status, 400);
  assert.equal((await upload('empty.jpg', Buffer.alloc(0))).status, 400);
  assert.equal((await upload('bad.svg', Buffer.from('<svg/>'))).status, 400);
  assert.equal((await upload('unknown.jpg', readFileSync(jpeg), 'missing')).status, 400);
  assert.equal(photoIndex(paths, ride.id).length, 2);
  const stored = JSON.parse(readFileSync(join(paths.cache, 'photos.json'))).find((p) => p.id === photo.id);
  assert.equal(hash(stored.originalPath), originalHash);
  assert.equal(hash(jpeg), originalHash);
  const still = { id: 'one', label: photo.label, kind: 'photo', photoId: photo.id, camera: 'front', rideStart: 1, duration: 1.0333333333333334 };
  const project = { version: 1, name: 'Photo test', rideId: ride.id, formatId: '9x16', units: 'metric', panelOpacity: .5,
    framing: { cx: .5, cy: .5, zoom: 1 }, overlays: [], audioLevel: .35, rearOffsetSec: -1, clips: [still] };
  assert.equal(programAt(project, .5).rideT, 1);
  assert.equal(programAt(project, 1).rideT, 1);
  const exportProject = async (p) => {
    const id = startExport(paths, { project: p }, origin);
    const deadline = Date.now() + 120000;
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = getJob(id);
    } while (!['done', 'error'].includes(job.status) && Date.now() < deadline);
    assert.equal(job.status, 'done', `${job.message}\n${job.log.join('\n')}`);
    assert.equal(job.checks.width, 1080);
    assert.equal(job.checks.height, 1920);
    assert.equal(job.checks.frames, p.clips.reduce((n, c) => n + Math.round(c.duration * 30), 0));
    assert.equal(job.checks.video, 'h264');
    assert.equal(job.checks.audio, 'aac');
    run('ffmpeg', ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
    return job;
  };
  const photoOnly = await exportProject(project);
  // Independently orient/crop the expected still and compare the first encoded frame.
  const rawFrame = (file, inputArgs, filter) => execFileSync('ffmpeg', ['-v', 'error', ...inputArgs, '-i', file,
    '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 8 << 20 });
  const expected = rawFrame(photoPath(paths, photo.id), [], 'crop=180:320:0:0,scale=1080:1920:flags=lanczos,scale=90:160');
  const actual = rawFrame(photoOnly.output, [], 'scale=90:160');
  const mae = expected.reduce((sum, v, i) => sum + Math.abs(v - actual[i]), 0) / expected.length;
  assert.ok(mae < 3, `Photo crop/orientation pixel error ${mae}`);
  const video = join(temp, 'test.mp4');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  mkdirSync(paths.cache, { recursive: true });
  writeFileSync(join(paths.cache, 'phone-footage.json'), JSON.stringify([{ brand: 'phone', rideId: ride.id, camera: 'front',
    name: 'PHONE-test.MP4', sourcePath: video, createdUtc: ride.startUtc, duration: 1, width: 320, height: 180,
    displayWidth: 320, codec: 'h264', audio: 'aac', bottomStrip: 0, clockOffsetSec: 0, preview: null }]));
  assert.equal((await footageIndex(paths)).files.length, 1);
  const mixed = { ...project, clips: [{ ...still, duration: .5 }, { id: 'video', label: 'Video', sourceFile: 'PHONE-test.MP4', camera: 'front', rideStart: 0, duration: .5 },
    { ...still, id: 'plain', photoId: plain.id, duration: 1.0333333333333334 }] };
  assert.equal(programAt(mixed, .75).rideT, .25);
  assert.equal(programAt(mixed, 1.5).rideT, 1);
  const mixedJob = await exportProject(mixed);
  assert.equal(mixedJob.checks.frames, 61);
  // Photo spans have silence; the video span keeps camera audio.
  const rms = (start, duration) => {
    const bytes = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', mixedJob.output, '-t', String(duration), '-vn', '-ac', '1', '-f', 'f32le', '-']);
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
  };
  assert.ok(rms(.1, .2) < .0001);
  assert.ok(rms(.65, .2) > .001);
  const withHud = { ...project, name: 'Photo frozen HUD', clips: [{ ...still, duration: .5 }], overlays: [{ uid: 'speed', widgetId: 'speed.broadcast', nx: .5, ny: .7, scale: .7, opacity: 1 }] };
  const hudJob = await exportProject(withHud);
  const first = rawFrame(hudJob.output, [], 'scale=90:160');
  assert.ok(actual.reduce((sum, v, i) => sum + Math.abs(v - first[i]), 0) / actual.length > .5, 'A visible HUD must be rendered');
  const last = rawFrame(hudJob.output, ['-ss', '0.4'], 'scale=90:160');
  assert.ok(first.reduce((sum, v, i) => sum + Math.abs(v - last[i]), 0) / first.length < 1, 'HUD must remain frozen for the still');
  const missing = { ...project, clips: [{ ...still, photoId: '00000000-0000-0000-0000-000000000000' }] };
  const missingJob = startExport(paths, { project: missing }, origin);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(getJob(missingJob).status, 'error');
  assert.match(getJob(missingJob).message, /Photo missing/);
  // A one-pixel source and a one-frame duration must be usable stills too.
  const tiny = join(temp, 'tiny.png');
  run(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB",(1,1),"red").save(sys.argv[1])', tiny]);
  const tinyResponse = await upload('tiny.png', readFileSync(tiny));
  assert.equal(tinyResponse.status, 201);
  const tinyPhoto = await tinyResponse.json();
  await exportProject({ ...project, clips: [{ ...still, photoId: tinyPhoto.id, duration: 1 / 30 }] });
  const invalidJob = startExport(paths, { project: { ...project, clips: [{ ...still, duration: 0 }] } }, origin);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(getJob(invalidJob).status, 'error');
  assert.match(getJob(invalidJob).message, /duration/);
  assert.equal(hash(jpeg), originalHash);
  console.log('Photo HTTP import, EXIF, persistence, frozen HUD, still/mixed export and full decode passed.');
} finally {
  await http?.close();
  await loader.close();
  rmSync(temp, { recursive: true, force: true });
}
