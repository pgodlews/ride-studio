// Hardware H.264 session failures retry once with libx264. No overlays, so no Chrome.
// Usage: node studio/scripts/test_encoder_fallback.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'encoder-fallback-')));
const realFfmpeg = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
const calls = join(temp, 'ffmpeg-calls.log');
const failX264 = join(temp, 'fail-libx264');
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
writeFileSync(join(temp, 'ffmpeg-wrapper'), `#!/bin/sh
calls=${quote(calls)}
fail_x264=${quote(failX264)}
real=${quote(realFfmpeg)}
nvenc=0
x264=0
for arg in "$@"; do
  case "$arg" in
    *h264_nvenc*) nvenc=1 ;;
    *libx264*) x264=1 ;;
  esac
done
printf 'nvenc=%s x264=%s\\n' "$nvenc" "$x264" >> "$calls"
if [ "$nvenc" = 1 ]; then
  printf '%s\\n' 'OpenEncodeSessionEx failed: out of memory (10)' >&2
  exit 1
fi
if [ -f "$fail_x264" ] && [ "$x264" = 1 ]; then
  printf '%s\\n' 'libx264 failed' >&2
  exit 1
fi
exec "$real" "$@"
`, { mode: 0o755 });
const saved = { ffmpeg: process.env.STUDIO_FFMPEG, encoder: process.env.STUDIO_VIDEO_ENCODER };
process.env.STUDIO_FFMPEG = join(temp, 'ffmpeg-wrapper');
process.env.STUDIO_VIDEO_ENCODER = 'h264_nvenc';
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' });
let server;
try {
  const clip = join(temp, 'clip.mp4');
  execFileSync(realFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { stdio: 'pipe' });
  const { startDesktopServer } = await loader.ssrLoadModule('/server/desktopServer.ts');
  const client = join(temp, 'client');
  const hud = join(temp, 'hud');
  const library = join(temp, 'library');
  for (const path of [client, hud, library]) mkdirSync(path);
  writeFileSync(join(client, 'index.html'), '<!doctype html><title>Encoder fallback</title>');
  const token = randomBytes(32).toString('hex');
  server = await startDesktopServer({ studio: join(temp, 'read-only-code'), clientDir: client, hudDir: hud, dataRoot: library, token });
  const request = (path, options = {}) => fetch(server.origin + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const startUtc = '2026-01-01T00:00:00Z';
  const frames = 6;
  mkdirSync(join(library, 'public/data/rides'), { recursive: true });
  mkdirSync(join(library, '.cache'), { recursive: true });
  writeFileSync(join(library, 'public/data/rides/encoder-fallback.json'), JSON.stringify({
    schema: 1, id: 'encoder-fallback', startUtc, tzOffsetSec: 0, t: [0, 1],
    channels: { lat: [0, 0], lon: [0, 0] },
    meta: { hrZones: null, laps: [], climbs: [], summary: {}, sensors: [], warnings: [] },
  }));
  writeFileSync(join(library, '.cache/phone-footage.json'), JSON.stringify([{
    camera: 'front', name: 'CLIP.MP4', createdUtc: startUtc, duration: 1, clockOffsetSec: 0, brand: 'phone',
    rideId: 'encoder-fallback', width: 320, height: 180, displayWidth: 320, codec: 'h264', audio: null,
    preview: null, bottomStrip: 0, sourcePath: clip,
  }]));
  const project = {
    version: 1, name: 'Encoder fallback', rideId: 'encoder-fallback', formatId: '16x9', units: 'metric', panelOpacity: .5,
    framing: { cx: .5, cy: .5, zoom: 1 }, overlays: [], audioLevel: .35, rearOffsetSec: 0,
    clips: [{ id: 'c', label: 'Synthetic', rideStart: 0, duration: frames / 30, camera: 'front' }],
  };
  const exportJob = async () => {
    const started = await request('/api/export', { method: 'POST', body: JSON.stringify({ project }) });
    assert.equal(started.status, 202, await started.clone().text());
    const { id } = await started.json();
    const deadline = Date.now() + 120000;
    let job;
    do {
      job = await (await request(`/api/export/${id}`)).json();
      if (job.status === 'done' || job.status === 'error') return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`export timed out: ${job?.status ?? 'unknown'}`);
  };
  const fallbackLine = 'Hardware encoder h264_nvenc failed (OpenEncodeSessionEx failed: out of memory (10)); retried with libx264';
  const done = await exportJob();
  assert.equal(done.status, 'done', `${done.message}\n${(done.log ?? []).join('\n')}`);
  assert.equal(done.checks.frames, frames);
  assert.ok(done.log.includes(fallbackLine), (done.log ?? []).join('\n'));
  execFileSync(realFfmpeg, ['-v', 'error', '-i', done.output, '-f', 'null', '-'], { stdio: 'pipe' });

  writeFileSync(calls, '');
  writeFileSync(failX264, '');
  const failed = await exportJob();
  assert.equal(failed.status, 'error', `${failed.message}\n${(failed.log ?? []).join('\n')}`);
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
  assert.deepEqual(invocations, ['nvenc=1 x264=0', 'nvenc=0 x264=1']);
  console.log('Encoder fallback passed: NVENC session failure retried with libx264 (6 frames, full decode); a libx264 failure stops after one attempt.');
} finally {
  if (saved.ffmpeg === undefined) delete process.env.STUDIO_FFMPEG; else process.env.STUDIO_FFMPEG = saved.ffmpeg;
  if (saved.encoder === undefined) delete process.env.STUDIO_VIDEO_ENCODER; else process.env.STUDIO_VIDEO_ENCODER = saved.encoder;
  await server?.close();
  await loader.close();
  rmSync(temp, { recursive: true, force: true });
}
