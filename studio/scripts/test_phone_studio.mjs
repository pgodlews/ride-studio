// Generated MOV fixtures; optionally PHONE_SAMPLE=/absolute/sample.MOV for a real clip.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'phone studio test ')));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
try {
  const rides = join(temp, 'public/data/rides');
  mkdirSync(rides, { recursive: true });
  const base = join(temp, 'base.mov');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  const video = join(temp, 'phone rotated.mov');
  run('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', base, '-c', 'copy',
    '-metadata', 'creation_time=2026-08-22T16:31:23Z', video]);
  const before = hash(video);
  const importCode = 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import prepare_phone; prepare_phone.STUDIO=Path(sys.argv[2]); sys.argv=sys.argv[3:]; prepare_phone.main()';
  const importClip = (path, id, extra = []) => run(python, ['-c', importCode, join(studio, 'scripts'), temp,
    'prepare_phone.py', path, '--id', id, '--register', '--camera', 'rear', ...extra]);
  importClip(video, 'phone-no-fit');
  const decoded = join(temp, 'fixture.json');
  writeFileSync(decoded, JSON.stringify({ record_mesgs: [
    { timestamp: '2026-08-22T16:31:20Z', enhanced_speed: 5, heart_rate: 120, cadence: 80 },
    { timestamp: '2026-08-22T16:31:23Z', enhanced_speed: 6, heart_rate: 130, cadence: 0 },
    { timestamp: '2026-08-22T16:31:24Z', enhanced_speed: 7, heart_rate: 140, cadence: 90 },
    { timestamp: '2026-08-22T16:31:35Z', enhanced_speed: 8, heart_rate: 150, cadence: 100 },
  ] }));
  importClip(video, 'phone-fit', ['--fit', decoded, '--clock-correction-sec', '0.25', '--timezone', 'Europe/London']);
  const gpx = join(temp, 'fixture.gpx');
  writeFileSync(gpx, `<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:tpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" version="1.1" creator="fixture"><trk><trkseg>
    <trkpt lat="0" lon="0"><time>2026-08-22T16:31:23Z</time><ele>10</ele><extensions><tpx:TrackPointExtension><tpx:speed>6</tpx:speed><tpx:cad>0</tpx:cad></tpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="0" lon="0.00001"><time>2026-08-22T16:31:24Z</time><ele>11</ele><extensions><tpx:TrackPointExtension><tpx:speed>7</tpx:speed><tpx:cad>90</tpx:cad></tpx:TrackPointExtension></extensions></trkpt>
    </trkseg></trk></gpx>`);
  const gpxBefore = hash(gpx);
  importClip(video, 'phone-gpx', ['--gpx', gpx, '--sport', 'cycling', '--timezone', 'Europe/London']);
  assert.throws(() => importClip(video, 'wrong-gpx', ['--gpx', gpx, '--start-utc', '2026-08-23T12:00:00Z']), /Command failed/);
  assert.throws(() => importClip(video, 'phone-fit'), /Command failed/);
  assert.throws(() => importClip(video, 'wrong-fit', ['--fit', decoded, '--start-utc', '2026-08-23T12:00:00Z']), /Command failed/);
  const { footageIndex, mediaPath } = await server.ssrLoadModule('/server/plugin.ts');
  const { fileStartMs, sourceInfo, sourceWindows } = await server.ssrLoadModule('/src/core/project.ts');
  const { Ride } = await server.ssrLoadModule('/src/core/ride.ts');
  const paths = { studio: temp, mediaRoot: join(temp, 'unmounted'), cache: join(temp, '.cache'), exports: join(temp, 'exports') };
  const index = await footageIndex(paths);
  assert.equal(index.error, undefined);
  const standalone = index.files.find((f) => f.rideId === 'phone-no-fit');
  const file = index.files.find((f) => f.rideId === 'phone-fit');
  const gpxFile = index.files.find((f) => f.rideId === 'phone-gpx');
  const gpxRide = new Ride(JSON.parse(readFileSync(join(rides, 'phone-gpx.json'), 'utf8')));
  assert.equal(gpxRide.at('speed', .5), 6.5);
  assert.equal(gpxRide.at('cadence', .5), 0);
  assert.match(gpxFile.syncNotice, /phone\/GPX/);
  assert.equal(hash(gpx), gpxBefore);
  assert.equal(hash(join(temp, '.cache/phone-gpx', `${gpxBefore}.gpx`)), gpxBefore);
  assert.equal(file.width, 180);
  assert.equal(file.height, 320);
  assert.equal(sourceInfo(file).bottomStrip, 0);
  assert.equal(fileStartMs(file, -1), Date.parse('2026-08-22T16:31:23.250Z'));
  assert.equal(mediaPath(paths, 'rear', file.name), video);
  assert.equal(mediaPath(paths, 'front', file.name), null);
  assert.equal(mediaPath(paths, 'rear', '../phone rotated.mov'), null);
  assert.equal(file.sourcePath, undefined);
  const noFit = new Ride(JSON.parse(readFileSync(join(rides, 'phone-no-fit.json'), 'utf8')));
  assert.equal(noFit.has('speed'), false);
  assert.equal(noFit.has('lat'), false);
  assert.equal(sourceWindows([standalone], noFit.startMs, noFit.duration).length, 1);
  const ride = new Ride(JSON.parse(readFileSync(join(rides, 'phone-fit.json'), 'utf8')));
  assert.equal(ride.at('speed', 3.25), 6.25);
  assert.equal(Number.isNaN(ride.at('speed', -0.01)), true);
  const sparse = new Ride({ schema: 1, id: 'sparse', startUtc: '2026-08-22T12:00:00Z', tzOffsetSec: 0,
    t: [0, 1, 2], channels: { speed: [5, null, 6] }, meta: { hrZones: null, laps: [], climbs: [], summary: {}, sensors: [], warnings: [] } });
  assert.equal(sparse.at('speed', 0), 5);
  assert.equal(Number.isNaN(sparse.at('speed', .5)), true);
  assert.equal(ride.at('cadence', 3.25), 0);
  assert.equal(ride.localTime(3.25).h, 17);
  assert.equal(Number.isNaN(ride.at('heartRate', 7)), true);
  const windows = sourceWindows([file], ride.startMs, ride.duration);
  assert.equal(windows[0].start, 3.25);
  assert.equal(windows[0].end, 4.25);
  const { startExport, getJob } = await server.ssrLoadModule('/server/export.ts');
  const exportClip = async (rideId, source, rideStart, duration, name, overlays = []) => {
    const project = { version: 1, name, rideId, formatId: '9x16', units: 'metric', panelOpacity: .5,
      framing: { cx: .5, cy: .5, zoom: 1 }, overlays, audioLevel: .35, rearOffsetSec: -1,
      clips: [{ id: 'one', label: name, rideStart, duration, camera: 'rear', sourceFile: source.name }] };
    const id = startExport(paths, { project }, 'http://localhost:5178');
    const deadline = Date.now() + 60000;
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = getJob(id);
    } while (!['done', 'error'].includes(job.status) && Date.now() < deadline);
    assert.equal(job.status, 'done', `${job.message}\n${job.log.join('\n')}`);
    assert.equal(job.checks.frames, Math.round(duration * 30));
    assert.equal(job.checks.width, 1080);
    assert.equal(job.checks.height, 1920);
    assert.equal(job.checks.video, 'h264');
    assert.equal(job.checks.audio, 'aac');
    assert.ok(Math.abs(job.checks.seconds - Math.round(duration * 30) / 30) < .04);
    run('ffmpeg', ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
    return job;
  };
  const output = await exportClip('phone-fit', file, 3.25, 1, 'Phone FIT fixture');
  // Independent autorotation comparison catches portrait distortion despite correct output dimensions.
  const frame = (path, filter) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', filter,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const expected = frame(video, 'scale=1080:1920:flags=lanczos,scale=18:32');
  const actual = frame(output.output, 'scale=18:32');
  const mae = expected.reduce((sum, v, i) => sum + Math.abs(v - actual[i]), 0) / expected.length;
  assert.ok(mae < 8, `Portrait content differs (mean pixel error ${mae})`);
  if (process.env.PHONE_HUD) {
    symlinkSync(join(studio, 'src'), join(temp, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(join(studio, 'node_modules'), join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const hud = await exportClip('phone-fit', file, 3.25, 1, 'Phone FIT HUD', [
      { uid: 'speed', widgetId: 'speed.glass', nx: .5, ny: .7, scale: 1, opacity: 1 },
      { uid: 'cadence', widgetId: 'cadence.glass', nx: .5, ny: .9, scale: 1, opacity: 1 },
    ]);
    assert.equal(hud.checks.frames, 30);
    console.log('Phone FIT HUD export passed: shared SVG speed/cadence widgets, 30 frames and full decode.');
    const gpxHud = await exportClip('phone-gpx', gpxFile, 0, 1, 'Phone GPX HUD', [
      { uid: 'speed', widgetId: 'speed.glass', nx: .5, ny: .7, scale: 1, opacity: 1 },
      { uid: 'cadence', widgetId: 'cadence.glass', nx: .5, ny: .9, scale: 1, opacity: 1 },
    ]);
    assert.equal(gpxHud.checks.frames, 30);
    console.log('Phone GPX HUD export passed: recorded GPX speed/cadence, 30 frames and full decode.');
  }
  assert.equal(hash(video), before);
  if (process.env.PHONE_SAMPLE) {
    const sample = realpathSync(process.env.PHONE_SAMPLE);
    const sampleBefore = hash(sample);
    importClip(sample, 'sample');
    const sampleRide = new Ride(JSON.parse(readFileSync(join(rides, 'sample.json'), 'utf8')));
    const sampleFile = (await footageIndex(paths)).files.find((f) => f.rideId === 'sample');
    assert.equal(sampleRide.has('lat'), false);
    assert.equal(sampleRide.meta.telemetry.locationMode, 'clip-geotag');
    assert.equal(sampleFile.width, 1080);
    assert.equal(sampleFile.height, 1920);
    const job = await exportClip('sample', sampleFile, 0, sampleRide.duration, 'Real iPhone sample');
    assert.equal(hash(sample), sampleBefore);
    console.log(`Real sample passed: ${job.checks.frames} frames, ${job.checks.seconds} s, portrait export and full decode; original hash unchanged.`);
  }
  console.log('Phone integration passed: no-FIT/FIT import, corrections, source selection, missing channels, portrait content, H.264/AAC export and full decode.');
} finally {
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}
