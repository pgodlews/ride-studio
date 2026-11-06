// Production UI regressions: saved timelines survive empty auto-edit; replacement is explicit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'editor-ui-'));
const loader = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' });
const executablePath = process.env.STUDIO_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((p) => [join(p, 'Google/Chrome/Application/chrome.exe'), join(p, 'Microsoft/Edge/Application/msedge.exe')]),
].find(existsSync);
assert.ok(executablePath, 'Install Chrome/Chromium or set STUDIO_CHROME for the UI test');
let backend, browser;
try {
  const { startDesktopServer } = await loader.ssrLoadModule('/server/desktopServer.ts');
  const dataRoot = join(temp, 'library');
  const rides = join(dataRoot, 'public/data/rides'), cache = join(dataRoot, '.cache');
  for (const p of [rides, cache]) mkdirSync(p, { recursive: true });
  const startUtc = '2026-01-01T12:00:00Z';
  const t = Array.from({ length: 121 }, (_, i) => i);
  const fixture = { schema: 1, id: 'synthetic-ui', startUtc, tzOffsetSec: 0, t,
    channels: { lat: t.map(() => 0), lon: t.map((i) => i * .0001), speed: t.map((i) => 5 + Math.sin(i / 10)), distance: t.map((i) => i * 10) },
    meta: { hrZones: null, laps: [], climbs: [], summary: {}, sensors: [], warnings: ['Synthetic UI fixture'] } };
  writeFileSync(join(rides, 'synthetic-ui.json'), JSON.stringify(fixture));
  writeFileSync(join(rides, 'empty-ui.json'), JSON.stringify({ ...fixture, id: 'empty-ui', channels: {} }));
  const token = randomBytes(32).toString('hex');
  backend = await startDesktopServer({ studio, dataRoot, clientDir: join(studio, 'desktop-dist/client'), hudDir: join(studio, 'desktop-dist/hud'), token });
  browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('UI error:', error));
  await page.setViewport({ width: 1440, height: 960 });
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'usb', { configurable: true, value: { requestDevice: () => { throw new Error('No device access expected'); } } }));
  const open = async (id = 'synthetic-ui') => {
    await page.goto(backend.origin + '/?ride=' + id);
    await page.waitForSelector('.moments-panel');
  };
  await page.goto(backend.origin + '/?activities');
  await page.waitForFunction(() => document.body.textContent.includes('USB access is unavailable'));
  assert.equal(await page.$eval('button[title^="Desktop USB"]', (b) => b.disabled), true);
  await page.setRequestInterception(true);
  const browserCapability = (req) => req.url().endsWith('/api/capabilities')
    ? req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ desktop: false, webUsb: true }) }) : req.continue();
  page.on('request', browserCapability);
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Connect Garmin (USB)' && !b.disabled));
  page.off('request', browserCapability);
  await page.setRequestInterception(false);
  await page.evaluate(() => { localStorage.setItem('studio.page', '"editor"'); localStorage.setItem('studio.privacyZoneM', '0'); });
  await open();
  await page.waitForSelector('.moment .add');
  await page.click('.moment .add');
  const stored = () => page.evaluate(() => localStorage.getItem('studio.timeline.synthetic-ui'));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('studio.timeline.synthetic-ui') ?? '[]').length === 1);
  const original = await stored();
  const build = () => page.click('.moments-panel .auto button');
  await build();
  await page.waitForFunction(() => document.querySelector('.moments-panel [role=status]')?.textContent.includes('complete footage coverage'));
  assert.equal(await stored(), original, 'no footage must preserve saved clips');
  await page.reload();
  await page.waitForSelector('.moments-panel');
  assert.equal(await stored(), original, 'timeline persists after restart');
  await page.evaluate(() => localStorage.setItem('studio.privacyZoneM', '10000'));
  await page.reload();
  await page.waitForSelector('.moments-panel');
  await build();
  await page.waitForFunction(() => document.querySelector('.moments-panel [role=status]')?.textContent.includes('hidden start/finish zone'));
  assert.equal(await stored(), original, 'private moments must preserve saved clips');
  await open('empty-ui');
  await build();
  await page.waitForFunction(() => document.querySelector('.moments-panel [role=status]')?.textContent.includes('No moments detected'));
  // Supply full synthetic footage, then exercise cancellation and accepted replacement.
  const video = join(temp, 'synthetic.mp4');
  execFileSync(process.env.STUDIO_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=160x90:rate=30', '-t', '120', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  writeFileSync(join(cache, 'phone-footage.json'), JSON.stringify([{ camera: 'front', name: 'SYNTHETIC.MP4', createdUtc: startUtc, duration: 120, clockOffsetSec: 0, brand: 'phone', rideId: 'synthetic-ui', width: 160, height: 90, displayWidth: 160, codec: 'h264', audio: null, preview: null, bottomStrip: 0, sourcePath: video }]));
  await page.evaluate(() => localStorage.setItem('studio.privacyZoneM', '0'));
  await open();
  await page.waitForSelector('.moment .cam.ok');
  const cancel = new Promise((accept) => page.once('dialog', async (dialog) => { assert.match(dialog.message(), /Replace the existing 1-clip timeline/); await dialog.dismiss(); accept(); }));
  await build(); await cancel;
  assert.equal(await stored(), original, 'cancel keeps existing edits');
  const confirm = new Promise((accept) => page.once('dialog', async (dialog) => { await dialog.accept(); accept(); }));
  await build(); await confirm;
  await page.waitForFunction(() => document.querySelector('.moments-panel [role=status]')?.textContent.includes('Built a timeline'));
  assert.notEqual(await stored(), original);
  const built = await stored();
  assert.ok(JSON.parse(built).length > 0);
  await page.reload();
  await page.waitForSelector('.moments-panel');
  assert.equal(await stored(), built, 'successful replacement persists after restart');
  await page.evaluate(() => localStorage.removeItem('studio.timeline.synthetic-ui'));
  await page.reload();
  await page.waitForSelector('.moments-panel');
  await build();
  await page.waitForFunction(() => document.querySelector('.moments-panel [role=status]')?.textContent.includes('Built a timeline'));
  console.log('Editor UI passed: desktop/browser USB capability, no-picks explanations, persistent timeline preservation, cancelled/confirmed replacement and successful empty-timeline build.');
} finally {
  await browser?.close();
  await backend?.close();
  await loader.close();
  rmSync(temp, { recursive: true, force: true });
}
