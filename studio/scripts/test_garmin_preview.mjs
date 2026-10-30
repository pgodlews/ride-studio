// Garmin Vue previews: non-macOS caches one H.264 proxy for HEVC GLVs; macOS serves the GLV unchanged.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'garmin-preview-')));
const probe = (file) => {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
  const video = json.streams.find((stream) => stream.codec_type === 'video');
  return {
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    duration: Number(json.format.duration),
    created: json.format.tags?.creation_time ?? '',
  };
};
let loader;
let server;
const oldEncoder = process.env.STUDIO_VIDEO_ENCODER;
const oldMedia = process.env.STUDIO_MEDIA_ROOT;
try {
  const media = join(temp, 'media');
  const frontDir = join(media, 'new-front');
  const rearDir = join(media, 'new-back');
  mkdirSync(frontDir, { recursive: true });
  mkdirSync(rearDir, { recursive: true });
  const clip = (size, codec, output, extra = []) => execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', codec, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra, output,
  ], { stdio: 'pipe' });
  clip('1280x720', 'libx265', join(frontDir, 'GRMN0001.MP4'), ['-metadata', 'creation_time=2026-06-15T12:00:00Z']);
  clip('640x360', 'libx265', join(frontDir, 'GRMN0001.GLV'), ['-f', 'mp4']);
  clip('1280x720', 'libx264', join(rearDir, 'GRMN0002.MP4'));
  clip('640x360', 'libx264', join(rearDir, 'GRMN0002.GLV'), ['-f', 'mp4']);
  const frontGlv = probe(join(frontDir, 'GRMN0001.GLV'));
  const frontMain = probe(join(frontDir, 'GRMN0001.MP4'));
  const rearGlv = probe(join(rearDir, 'GRMN0002.GLV'));
  assert.equal(frontMain.codec, 'hevc');
  assert.equal(frontGlv.codec, 'hevc');
  assert.equal(probe(join(rearDir, 'GRMN0002.MP4')).codec, 'h264');
  assert.equal(rearGlv.codec, 'h264');
  assert.ok(frontGlv.width < frontMain.width && frontGlv.height < frontMain.height);
  assert.match(frontMain.created, /2026-06-15T12:00:00/);
  assert.ok(frontGlv.duration >= 1.5 && frontGlv.duration <= 2.5, `GLV duration ${frontGlv.duration}`);

  process.env.STUDIO_VIDEO_ENCODER = 'libx264';
  process.env.STUDIO_MEDIA_ROOT = media;
  const client = join(temp, 'client');
  const hud = join(temp, 'hud');
  const library = join(temp, 'library');
  for (const dir of [client, hud, library]) mkdirSync(dir);
  writeFileSync(join(client, 'index.html'), '<!doctype html><title>Garmin preview fixture</title>');
  loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' });
  const { startDesktopServer } = await loader.ssrLoadModule('/server/desktopServer.ts');
  const token = randomBytes(32).toString('hex');
  server = await startDesktopServer({ studio: join(temp, 'read-only-code'), clientDir: client, hudDir: hud, dataRoot: library, token });
  assert.equal(server.paths.mediaRoot, media);
  const request = (path, options = {}) => fetch(server.origin + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const indexRes = await request('/api/footage');
  assert.equal(indexRes.status, 200, await indexRes.clone().text());
  const index = await indexRes.json();
  const front = index.files.find((file) => file.camera === 'front' && file.name === 'GRMN0001.MP4');
  const rear = index.files.find((file) => file.camera === 'rear' && file.name === 'GRMN0002.MP4');
  assert.ok(front, 'front clip missing from footage index');
  assert.ok(rear, 'rear clip missing from footage index');

  if (process.platform === 'darwin') {
    assert.equal(front.preview?.name, 'GRMN0001.GLV');
    console.log('Garmin preview proxies passed: macOS serves the HEVC GLV unchanged.');
  } else {
    assert.equal(front.preview?.name, 'GRMN0001-preview.MP4');
    assert.equal(front.preview?.codec, 'h264');
    assert.equal(front.preview?.width, frontGlv.width);
    assert.equal(front.preview?.height, frontGlv.height);
    assert.equal(rear.preview?.name, 'GRMN0002.GLV');
    const previewPath = '/media/front/GRMN0001-preview.MP4';
    const [leftRes, rightRes] = await Promise.all([request(previewPath), request(previewPath)]);
    assert.equal(leftRes.status, 200, await leftRes.clone().text());
    assert.equal(rightRes.status, 200, await rightRes.clone().text());
    assert.equal(leftRes.headers.get('content-type'), 'video/mp4');
    assert.equal(rightRes.headers.get('content-type'), 'video/mp4');
    const left = Buffer.from(await leftRes.arrayBuffer());
    const right = Buffer.from(await rightRes.arrayBuffer());
    assert.ok(left.length > 0 && left.equals(right), 'concurrent proxy responses differ');
    const served = join(temp, 'served-preview.mp4');
    writeFileSync(served, left);
    const encoded = probe(served);
    assert.equal(encoded.codec, 'h264');
    assert.equal(encoded.width, frontGlv.width);
    assert.equal(encoded.height, frontGlv.height);
    assert.ok(Math.abs(encoded.duration - frontGlv.duration) <= 0.25, `proxy duration ${encoded.duration} vs GLV ${frontGlv.duration}`);
    const rangeRes = await request(previewPath, { headers: { Range: 'bytes=0-99' } });
    assert.equal(rangeRes.status, 206, await rangeRes.clone().text());
    const range = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(range.length, 100);
    assert.deepEqual(range, left.subarray(0, 100));
    assert.equal((await request('/media/front/GRMN9999-preview.MP4')).status, 404);
    assert.equal((await request('/media/front/..%2fx-preview.MP4')).status, 404);
    const cached = readdirSync(join(server.paths.cache, 'previews'));
    assert.deepEqual(cached.filter((name) => name.endsWith('.partial')), []);
    const finished = cached.filter((name) => name.endsWith('.mp4'));
    assert.equal(finished.length, 1, `preview cache: ${cached.join(', ')}`);
    assert.match(finished[0], /^front-GRMN0001-\d+-\d+\.mp4$/);
    console.log('Garmin preview proxies passed: H.264 proxy for the HEVC GLV, shared encode, byte range, direct rear GLV, and rejected missing or traversal names.');
  }
} finally {
  if (oldEncoder === undefined) delete process.env.STUDIO_VIDEO_ENCODER;
  else process.env.STUDIO_VIDEO_ENCODER = oldEncoder;
  if (oldMedia === undefined) delete process.env.STUDIO_MEDIA_ROOT;
  else process.env.STUDIO_MEDIA_ROOT = oldMedia;
  await server?.close();
  await loader?.close();
  rmSync(temp, { recursive: true, force: true });
}
