// Production imports with tools off PATH: overrides, missing dependencies and IANA offsets.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const locate = (tool) => execFileSync(python, ['-c', 'import shutil,sys; p=shutil.which(sys.argv[1]); assert p; print(p)', tool], { encoding: 'utf8' }).trim();
const tools = { STUDIO_FFPROBE: locate(process.env.STUDIO_FFPROBE ?? 'ffprobe'), STUDIO_EXIFTOOL: locate(process.env.STUDIO_EXIFTOOL ?? 'exiftool'), STUDIO_PYTHON: locate(python) };
const realFfmpeg = process.env.STUDIO_FFMPEG ?? 'ffmpeg';
const saved = { ...process.env };
const temp = mkdtempSync(join(tmpdir(), 'runtime tools ü '));
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' });
let backend;
try {
  const video = join(temp, 'synthetic.mp4');
  execFileSync(realFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=160x90:rate=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'creation_time=2026-07-01T12:00:00Z', video]);
  const bytes = readFileSync(video);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const { startDesktopServer } = await loader.ssrLoadModule('/server/desktopServer.ts');
  const client = join(temp, 'client'), hud = join(temp, 'hud');
  for (const dir of [client, hud]) mkdirSync(dir);
  writeFileSync(join(client, 'index.html'), '<!doctype html><title>Synthetic tool test</title>');
  const token = randomBytes(32).toString('hex');
  backend = await startDesktopServer({ studio, dataRoot: join(temp, 'library'), clientDir: client, hudDir: hud, token });
  const post = (path) => fetch(backend.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  Object.assign(process.env, tools, { PYTHONTZPATH: '' }); // Force the installed tzdata fallback on every OS.
  // No metadata executables can be found on PATH; each tool must use its override.
  const emptyPath = join(temp, 'empty-path');
  mkdirSync(emptyPath);
  process.env.PATH = emptyPath;
  if (saved.Path !== undefined) process.env.Path = process.env.PATH;
  for (const [date, offset] of [['2026-07-01', 3600], ['2026-01-01', 0]]) {
    // Explicit UTC remains unchanged; only display offset differs by season.
    execFileSync(realFfmpeg, ['-v', 'error', '-y', '-i', video, '-c', 'copy', '-metadata', `creation_time=${date}T12:00:00Z`, join(temp, 'season.mp4')], { env: saved });
    const seasonal = readFileSync(join(temp, 'season.mp4'));
    const res = await fetch(backend.origin + '/api/cameras?name=season.mp4&timezone=Europe%2FLondon', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: seasonal });
    assert.equal(res.status, 201, await res.clone().text());
    const { rideId } = await res.json();
    const ride = JSON.parse(readFileSync(join(temp, 'library/public/data/rides', rideId + '.json')));
    assert.equal(ride.tzOffsetSec, offset);
    assert.equal(Date.parse(ride.startUtc), Date.parse(date + 'T12:00:00Z'));
  }
  const camera = await post('/api/cameras?name=synthetic.mp4');
  assert.equal(camera.status, 201, await camera.clone().text());
  const { rideId } = await camera.json();
  const media = await post(`/api/media?rideId=${rideId}&name=existing-ride.mp4`);
  assert.equal(media.status, 201, await media.clone().text());
  const invalid = await post('/api/cameras?name=invalid-zone.mp4&timezone=Invalid%2FZone');
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Invalid\/Zone/);
  for (const [variable, tool] of [['STUDIO_FFPROBE', 'ffprobe'], ['STUDIO_EXIFTOOL', 'exiftool'], ['STUDIO_PYTHON', 'Python']]) {
    process.env[variable] = join(temp, 'missing-tool');
    for (const endpoint of ['/api/cameras?name=missing.mp4&timezone=UTC', `/api/media?rideId=${rideId}&name=missing.mp4`]) {
      const res = await post(endpoint);
      assert.equal(res.status, 400);
      const error = (await res.json()).error;
      assert.match(error, new RegExp(tool, 'i'));
      assert.match(error, new RegExp(variable));
      assert.match(error, /[Ii]nstall|[Cc]hoose/);
      assert.doesNotMatch(error, /Traceback/);
    }
    process.env[variable] = tools[variable];
  }
  assert.equal(createHash('sha256').update(readFileSync(video)).digest('hex'), sha);
  console.log('Runtime tools passed: override-only FFprobe, existing-ride import, independent missing-tool errors, winter/summer IANA offsets and invalid timezone.');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await backend?.close();
  await loader.close();
  rmSync(temp, { recursive: true, force: true });
}
