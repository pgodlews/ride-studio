import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDesktopServer } from '../server/desktopServer';
import { createDemo } from '../server/demo';
import { detectHardwareEncoder, ffmpegPath, ffprobePath } from '../server/codecs';
import { studioPython, venvPython } from '../server/activities';
import { stopExports } from '../server/export';
import { FORMATS } from '../src/core/framing';
import { tileAttribution } from '../server/tiles';
import type { startHudRenderer } from '../server/hud';

app.setName('Ride Studio');
// Groups windows and notifications under one taskbar entry on Windows.
if (process.platform === 'win32') app.setAppUserModelId('com.piotrgodlewski.ride-studio');
const profile = process.argv.find((a) => a.startsWith('--profile='))?.slice(10);
if (profile) app.setPath('userData', resolve(profile));
if (!app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Captured HUD frames pass through /dev/shm; containers often mount only 64 MB, which fails capture with UnknownVizError.
if (process.platform === 'linux') {
  try { const shm = statfsSync('/dev/shm'); if (shm.bavail * shm.bsize < 512 * 2 ** 20) app.commandLine.appendSwitch('disable-dev-shm-usage'); }
  catch { app.commandLine.appendSwitch('disable-dev-shm-usage'); }
}
const smoke = process.argv.includes('--smoke');
const token = randomBytes(32).toString('hex');
let backend: Awaited<ReturnType<typeof startDesktopServer>>;
let main: BrowserWindow | null = null;
const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, partition: 'persist:ride-studio' };
process.env.PATH = [join(process.resourcesPath, 'tools'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
if (process.platform === 'darwin') process.env.STUDIO_VIDEO_ENCODER ??= 'h264_videotoolbox';
const assets = app.getAppPath();
const bundledPython = process.env.STUDIO_PYTHON;
if (!bundledPython && !app.isPackaged) {
  const venv = venvPython(resolve(assets, '../../.venv'));
  if (existsSync(venv)) process.env.STUDIO_PYTHON = venv;
}

function protect(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== backend.origin) event.preventDefault(); });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}
const renderHud: typeof startHudRenderer = async (o) => {
  const fmt = FORMATS.find((f) => f.id === o.project.formatId)!;
  const win = new BrowserWindow({ width: fmt.w, height: fmt.h, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { ...preferences, offscreen: { useSharedTexture: false, deviceScaleFactor: 1 } } });
  // Linux window managers clamp the initial size to the display; offscreen windows accept an explicit resize.
  win.setContentSize(fmt.w, fmt.h);
  protect(win);
  try {
    await win.loadURL(`${backend.origin}/__hud/index.html`);
    await win.webContents.executeJavaScript(`window.hudSetup(${JSON.stringify(o.project)},${JSON.stringify(o.ride)},${JSON.stringify(backend.origin)},${JSON.stringify(tileAttribution)})`);
  } catch (e) { win.destroy(); throw e; }
  o.log('HUD renderer: Electron capturePage, one isolated window');
  return { workers: 1, executablePath: process.execPath,
    async render(write) {
      for (let f = 0; f < o.totalFrames; f++) {
        await win.webContents.executeJavaScript(`window.hudFrame(${f})`);
        await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
        const frame = await win.webContents.capturePage({ x: 0, y: 0, width: fmt.w, height: fmt.h });
        const size = frame.getSize();
        if (size.width !== fmt.w || size.height !== fmt.h) throw new Error(`Unexpected HUD capture size ${size.width}×${size.height}`);
        const png = frame.toPNG();
        if (smoke && f === 0) writeFileSync(join(app.getPath('userData'), 'hud-smoke.png'), png);
        await write(png);
      }
    }, async close() { if (!win.isDestroyed()) win.destroy(); } };
};

async function checkSetup() {
  const run = promisify(execFile);
  const checks = [[ffmpegPath(), ['-version']], [ffprobePath(), ['-version']], [studioPython(backend.paths), ['-c', 'import PIL; print("Pillow " + PIL.__version__)']], ['exiftool', ['-ver']]] as const;
  const lines = await Promise.all(checks.map(async ([command, args]) => {
    try { const { stdout } = await run(command, [...args], { timeout: 10000 }); return `${command}: ${stdout.split('\n')[0]}`; }
    catch { return `${command}: unavailable (camera/photo import needs Python + Pillow + ExifTool)`; }
  }));
  lines.push(`H.264 encoder: ${process.env.STUDIO_VIDEO_ENCODER ?? 'libx264'}`);
  await dialog.showMessageBox({ type: 'info', title: 'Setup check', message: lines.join('\n'), detail: 'FIT and GPX imports run in TypeScript. Camera/photo and Apple Health helpers still need the documented external tools in this developer alpha.' });
}
async function openWindow() {
  const icon = join(assets, 'icon.png');
  main = new BrowserWindow({ width: 1440, height: 960, minWidth: 960, minHeight: 640, show: !smoke, title: 'Ride Studio', webPreferences: preferences, ...(process.platform !== 'darwin' && existsSync(icon) ? { icon } : {}) });
  protect(main);
  main.on('closed', () => { main = null; });
  await main.loadURL(`${backend.origin}/?activities`);
}
app.whenReady().then(async () => {
  if (process.platform === 'linux' || process.platform === 'win32') process.env.STUDIO_VIDEO_ENCODER ??= await detectHardwareEncoder();
  const dataRoot = join(app.getPath('userData'), 'library');
  mkdirSync(dataRoot, { recursive: true });
  const settingsFile = join(dataRoot, 'settings.json');
  let settings: { mediaRoot?: string; port?: number; python?: string } = {};
  if (existsSync(settingsFile)) {
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { /* retain valid defaults */ }
  }
  const port = Number.isInteger(settings.port) && settings.port! >= 1024 && settings.port! <= 65535 ? settings.port : undefined;
  backend = await startDesktopServer({ studio: assets, dataRoot, clientDir: join(assets, 'client'), hudDir: join(assets, 'hud'), token, port });
  backend.paths.renderHud = renderHud;
  if (typeof settings.mediaRoot === 'string') backend.paths.mediaRoot = settings.mediaRoot;
  const runtimePython = settings.python ?? venvPython(join(app.getPath('userData'), 'runtime'));
  if (!process.env.STUDIO_PYTHON && existsSync(runtimePython)) process.env.STUDIO_PYTHON = runtimePython;
  settings = { ...settings, port: Number(new URL(backend.origin).port) };
  writeFileSync(settingsFile, JSON.stringify(settings));
  const ses = session.fromPartition(preferences.partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeSendHeaders({ urls: [`${backend.origin}/*`] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Ride Studio', submenu: [{ role: 'about' }, { label: 'Check setup…', click: () => { void checkSetup(); } }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'Activities', click: () => { void main?.loadURL(`${backend.origin}/?activities`); } },
      { label: 'Load synthetic demo', click: async () => { try { const id = await createDemo(dataRoot); await main?.loadURL(`${backend.origin}/?ride=${id}`); } catch (e) { dialog.showErrorBox('Could not create demo', String(e)); } } },
      { label: 'Choose camera folder…', click: async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); if (!result.canceled) { backend.paths.mediaRoot = result.filePaths[0]; settings.mediaRoot = backend.paths.mediaRoot; writeFileSync(settingsFile, JSON.stringify(settings)); main?.webContents.reload(); } } },
      { label: 'Choose Python environment…', click: async () => { const result = await dialog.showOpenDialog({ title: 'Select the Python executable from an environment with Pillow installed', properties: ['openFile'] }); if (!result.canceled) { settings.python = result.filePaths[0]; process.env.STUDIO_PYTHON = settings.python; writeFileSync(settingsFile, JSON.stringify(settings)); } } },
      { label: 'Open library folder', click: () => { void shell.openPath(dataRoot); } },
      { label: 'Open exports folder', click: () => { mkdirSync(backend.paths.exports, { recursive: true }); void shell.openPath(backend.paths.exports); } },
    ] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  await openWindow();
  if (smoke) {
    const id = await createDemo(dataRoot);
    await main!.loadURL(`${backend.origin}/?ride=${id}`);
    const result = await main!.webContents.executeJavaScript(`(async () => { const r=await fetch('/api/rides'); const config=await (await fetch('/api/tiles/config')).json(); return {status:r.status,rides:(await r.json()).rides, node:typeof window.require, attribution:config.attribution}; })()`);
    if (result.status !== 200 || !result.rides.some((r: { id: string }) => r.id === id) || result.node !== 'undefined' || result.attribution !== tileAttribution) throw new Error('Desktop smoke failed');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const project = { version: 1, name: 'Electron smoke', rideId: id, formatId: '9x16', units: 'metric', panelOpacity: .5,
      framing: { cx: .5, cy: .5, zoom: 1 }, audioLevel: .35, rearOffsetSec: 0,
      overlays: [{ uid: 'speed', widgetId: 'speed.glass', nx: .5, ny: .7, scale: 1.4, opacity: 1 },
        { uid: 'map', widgetId: 'streetMap.glass', nx: .5, ny: .3, scale: .7, opacity: 1, settings: { privacyTrimMetres: 3000 } }],
      clips: [{ id: 'one', label: 'Synthetic', rideStart: 1, duration: 1, camera: 'front', sourceFile: 'DEMO-front.MP4' }] };
    const started = await fetch(`${backend.origin}/api/export`, { method: 'POST', headers, body: JSON.stringify({ project }) });
    if (!started.ok) throw new Error(await started.text());
    const jobId = (await started.json()).id;
    let job;
    const deadline = Date.now() + 120000;
    do { await new Promise((r) => setTimeout(r, 100)); job = await (await fetch(`${backend.origin}/api/export/${jobId}`, { headers })).json(); }
    while (!['done', 'error'].includes(job.status) && Date.now() < deadline);
    if (job.status !== 'done' || job.checks.frames !== 30) throw new Error(`Desktop export failed: ${job.message}\n${job.log.join('\n')}`);
    await promisify(execFile)(ffmpegPath(), ['-v', 'error', '-i', job.output, '-f', 'null', '-']);
    writeFileSync(join(app.getPath('userData'), 'smoke.json'), JSON.stringify({ ...result, origin: backend.origin, packaged: app.isPackaged, encoder: process.env.STUDIO_VIDEO_ENCODER ?? 'libx264', export: job.checks }));
    writeFileSync(join(app.getPath('userData'), 'studio-smoke.png'), (await main!.webContents.capturePage()).toPNG());
    console.log('Electron smoke passed: production UI, isolated renderer, authenticated backend, synthetic library and 30-frame native HUD export with full decode.');
    app.quit();
  }
}).catch((e) => { console.error(e); if (!smoke) dialog.showErrorBox('Ride Studio could not start', String(e)); app.exit(1); });
app.on('activate', () => { if (backend && !main) void openWindow(); });
app.on('second-instance', () => { main?.show(); main?.focus(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit(); });
app.on('before-quit', () => { stopExports(); void backend?.close(); });
