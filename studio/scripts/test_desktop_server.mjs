// Production backend security, clean library isolation and Python-free GPX import.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { get } from 'node:http';
import { FitEncoder, FitBaseType } from 'fit-file-parser';
const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'desktop-server-'));
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' });
let server;
const oldPython = process.env.STUDIO_PYTHON;
try {
  const { startDesktopServer } = await loader.ssrLoadModule('/server/desktopServer.ts');
  const client = join(temp, 'client'), hud = join(temp, 'hud'), library = join(temp, 'library');
  for (const p of [client, hud, library]) mkdirSync(p);
  writeFileSync(join(client, 'index.html'), '<!doctype html><title>Production fixture</title>');
  const token = randomBytes(32).toString('hex');
  server = await startDesktopServer({ studio: join(temp, 'read-only-code'), clientDir: client, hudDir: hud, dataRoot: library, token });
  const auth = { Authorization: `Bearer ${token}` };
  const request = (path, options = {}) => fetch(server.origin + path, { ...options, headers: { ...auth, ...options.headers } });
  assert.equal((await fetch(server.origin + '/')).status, 403);
  assert.equal((await request('/', { headers: { Authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await request('/', { headers: { Origin: 'https://hostile.invalid' } })).status, 403);
  const hostileHost = await new Promise((accept, reject) => {
    get(server.origin, { headers: { ...auth, Host: 'hostile.invalid' } }, (res) => { res.resume(); accept(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(home.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(typeof (await (await request('/api/tiles/config')).json()).attribution, 'string');
  assert.equal((await request('/data/..%2f..%2fsettings.json')).status, 404);
  process.env.STUDIO_PYTHON = '/nonexistent-python-must-not-be-called';
  const gpx = '<gpx version="1.1" creator="Synthetic"><trk><name>Fixture</name><trkseg>' +
    [0, 1, 2].map((i) => `<trkpt lat="0" lon="${i * .0001}"><time>2026-01-01T12:00:0${i}Z</time></trkpt>`).join('') + '</trkseg></trk></gpx>';
  const imported = await request('/api/activities?name=sample.gpx', { method: 'POST', body: gpx });
  assert.equal(imported.status, 201, await imported.clone().text());
  const result = await imported.json();
  assert.equal(result.rideId, 'sample');
  assert.equal((await (await request('/api/activities?name=again.gpx', { method: 'POST', body: gpx })).json()).existing, true);
  const ride = await (await request('/data/rides/sample.json')).json();
  assert.deepEqual(ride.t, [0, 1, 2]);
  const sha = createHash('sha256').update(gpx).digest('hex');
  assert.equal(readFileSync(join(library, '.cache/activity-imports', sha, 'sample.gpx'), 'utf8'), gpx);
  // The actual HTTP FIT path must also work with a deliberately unavailable Python interpreter.
  const encoder = new FitEncoder();
  const start = FitEncoder.toFitTimestamp(new Date('2026-01-01T12:00:00Z'));
  encoder.writeMessage(0, [{ number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 }]);
  encoder.writeMessage(18, [{ number: 5, size: 1, baseType: FitBaseType.Enum, value: 2 },
    { number: 2, size: 4, baseType: FitBaseType.Uint32, value: start }, { number: 253, size: 4, baseType: FitBaseType.Uint32, value: start + 2 }]);
  for (let i = 0; i < 3; i++) encoder.writeMessage(20, [
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: start + i },
    { number: 0, size: 4, baseType: FitBaseType.Sint32, value: 0 },
    { number: 1, size: 4, baseType: FitBaseType.Sint32, value: i * 10000 },
    { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 5000 },
    { number: 4, size: 1, baseType: FitBaseType.Uint8, value: 0 },
  ]);
  const fitBytes = encoder.close();
  const fitResponse = await request('/api/activities?name=fixture.fit', { method: 'POST', body: fitBytes });
  assert.equal(fitResponse.status, 201, await fitResponse.clone().text());
  const fitRide = await (await request('/data/rides/fixture.json')).json();
  assert.deepEqual(fitRide.channels.speed, [5, 5, 5]);
  assert.deepEqual(fitRide.channels.cadence, [0, 0, 0]);
  const fitSha = createHash('sha256').update(fitBytes).digest('hex');
  assert.deepEqual(readFileSync(join(library, '.cache/activity-imports', fitSha, 'fixture.fit')), Buffer.from(fitBytes));
  assert.equal(JSON.parse(readFileSync(join(library, '.cache/activity-fit', `${fitSha}.json`))).record_mesgs.length, 3);
  const bad = await request('/api/export', { method: 'POST', body: JSON.stringify({ project: { version: 1, rideId: '../../private' } }) });
  assert.equal(bad.status, 400);
  const huge = await request('/api/export', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(huge.status, 400);
  // Invalid and oversized suffix ranges do not escape as stream exceptions.
  mkdirSync(join(library, 'exports'));
  writeFileSync(join(library, 'exports/test.mp4'), Buffer.from('0123456789'));
  for (const range of ['bytes=20-30', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4']) assert.equal((await request('/exports/test.mp4', { headers: { Range: range } })).status, 416);
  const suffix = await request('/exports/test.mp4', { headers: { Range: 'bytes=-100' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), '0123456789');
  console.log('Desktop backend passed: token/host/origin protection, CSP, path containment, body/range limits, isolated library, original bytes/evidence and Python-free FIT/GPX imports.');
} finally {
  if (oldPython === undefined) delete process.env.STUDIO_PYTHON; else process.env.STUDIO_PYTHON = oldPython;
  await server?.close(); await loader.close(); rmSync(temp, { recursive: true, force: true });
}
