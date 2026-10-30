/**
 * HUD frames for export. The editor's SVG OverlayLayer (page: src/hud) is rendered by a pool
 * of headless Chrome processes through Puppeteer and handed over as PNG frames in output order,
 * so FFmpeg can composite them directly with no intermediate video file.
 *
 * Separate browser processes, not tabs: screenshots from tabs of one browser are serialised.
 * Measured for a 60 s 9:16 HUD on an M5 Max: 24 fps with 1–8 tabs, 189 fps with 8 processes.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, totalmem } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { FORMATS } from '../src/core/framing';
import type { Project } from '../src/core/project';
import type { RideJson } from '../src/core/ride';
import type { StudioPaths } from './plugin';
import { tileAttribution } from './tiles';

/** Frames per worker that may wait for in-order delivery before that worker pauses. */
const LOOKAHEAD = 4;

export interface HudRenderer {
  workers: number;
  executablePath: string;
  /** Renders frames 0…totalFrames−1 and passes each PNG to `write` in order. */
  render(write: (png: Uint8Array) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

let bundled: { promise: Promise<string>; stamp: number; outDir: string } | null = null;

/** Newest modification time under a directory, so widget edits trigger a fresh build. */
function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

/** Builds src/hud with Vite; rebuilt only when files under src changed since the last export. */
function hudPage(paths: StudioPaths): Promise<string> {
  if (paths.hudPage) return Promise.resolve(paths.hudPage);
  const stamp = newest(join(paths.studio, 'src'));
  const outDir = join(paths.cache, 'hud-page');
  if (!bundled || bundled.stamp !== stamp || bundled.outDir !== outDir) {
    const promise = (async () => {
      const { build } = await import('vite');
      await build({
        root: realpathSync(join(paths.studio, 'src/hud')), base: './', configFile: false, logLevel: 'warn', esbuild: { jsx: 'automatic' },
        define: { __STUDIO_TILE_ATTRIBUTION__: JSON.stringify(tileAttribution) },
        build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 8192 },
      });
      return outDir;
    })();
    bundled = { promise, stamp, outDir };
    promise.catch(() => { if (bundled?.promise === promise) bundled = null; });
  }
  return bundled.promise;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Serves the built page on a private loopback port (module scripts cannot load from file://). */
function serve(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://hud').pathname);
    const file = normalize(join(dir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const winDirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
const INSTALLED: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  win32: winDirs.flatMap((d) => [join(d, 'Google/Chrome/Application/chrome.exe'), join(d, 'Microsoft/Edge/Application/msedge.exe')]),
};

/**
 * STUDIO_CHROME (a path, or `headless-shell` to force the download), else an installed
 * Chrome/Chromium/Edge, else Chrome's headless shell, downloaded once into .cache/browsers.
 */
async function browserExecutable(paths: StudioPaths, log: (s: string) => void): Promise<string> {
  const env = process.env.STUDIO_CHROME;
  if (env && env !== 'headless-shell') return env;
  const installed = env ? undefined : INSTALLED[process.platform]?.find((p) => existsSync(p));
  if (installed) return installed;
  const b = await import('@puppeteer/browsers');
  const cacheDir = join(paths.cache, 'browsers');
  const have = (await b.getInstalledBrowsers({ cacheDir })).find((i) => i.browser === b.Browser.CHROMEHEADLESSSHELL);
  if (have) return have.executablePath;
  const platform = b.detectBrowserPlatform();
  if (!platform) throw new Error(`No Chrome found for ${process.platform}/${process.arch}; set STUDIO_CHROME to a Chrome or Chromium executable`);
  const buildId = await b.resolveBuildId(b.Browser.CHROMEHEADLESSSHELL, platform, 'stable');
  log(`Downloading Chrome headless shell ${buildId} into ${cacheDir}`);
  return (await b.install({ browser: b.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform })).executablePath;
}

/** Browser processes: half the cores, at most 8, about 1 GB of RAM each (STUDIO_HUD_WORKERS overrides). */
function workerCount(frames: number): number {
  const env = Number(process.env.STUDIO_HUD_WORKERS);
  const n = env > 0 ? env : Math.min(8, Math.floor(cpus().length / 2), Math.floor(totalmem() / 2 ** 30));
  return Math.max(1, Math.min(Math.floor(n), frames));
}

/** close() can stall when several browsers shut down together; never let it hang an export. */
async function closeBrowser(browser: Browser) {
  const proc = browser.process();
  await Promise.race([browser.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
}

export async function startHudRenderer(o: {
  paths: StudioPaths; project: Project; ride: RideJson; tileBase: string; totalFrames: number; log: (s: string) => void;
}): Promise<HudRenderer> {
  if (o.paths.renderHud) return o.paths.renderHud(o);
  const fmt = FORMATS.find((f) => f.id === o.project.formatId) ?? FORMATS[0];
  const { server, origin } = await serve(await hudPage(o.paths));
  const browsers: Browser[] = [];
  const close = async () => {
    await Promise.all(browsers.map(closeBrowser));
    server.close();
  };
  try {
    const executablePath = await browserExecutable(o.paths, o.log);
    const { default: puppeteer } = await import('puppeteer-core');
    const headless = /headless[-_ ]shell/i.test(executablePath) ? 'shell' : true;
    const workers = workerCount(o.totalFrames);
    const open = async (): Promise<Page> => {
      const browser = await puppeteer.launch({
        executablePath, headless, protocolTimeout: 180_000,
        args: ['--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
      });
      browsers.push(browser);
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      page.on('pageerror', (e) => o.log(`HUD page error: ${e instanceof Error ? e.message : String(e)}`));
      await page.setViewport({ width: fmt.w, height: fmt.h, deviceScaleFactor: 1 });
      // Every page renders as if focused, so no worker is throttled as a background page.
      await (await page.createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
      await page.waitForFunction('window.hudReady === true');
      await page.evaluate((p, r, t, a) => (window as unknown as { hudSetup: (...a: unknown[]) => Promise<void> }).hudSetup(p, r, t, a), o.project, o.ride, o.tileBase, tileAttribution);
      return page;
    };
    const pages = await Promise.all(Array.from({ length: workers }, open));
    o.log(`HUD renderer: ${workers} browser processes (${executablePath})`);

    const render = async (write: (png: Uint8Array) => Promise<void>) => {
      const total = o.totalFrames;
      const ready = new Map<number, Uint8Array>();
      let next = 0;
      let failure: unknown = null;
      let waiters: (() => void)[] = [];
      const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
      const fail = (e: unknown) => { failure ??= e; wake(); };
      const drain = async () => {
        while (!failure && ready.has(next)) {
          const png = ready.get(next)!;
          ready.delete(next);
          await write(png);
          next++;
          wake();
        }
      };
      let writing = Promise.resolve();
      // Worker i renders frames i, i + n, i + 2n, … so delivery order never waits on a far-ahead range.
      await Promise.all(pages.map(async (page, i) => {
        let f = i;
        try {
          for (; f < total && !failure; f += pages.length) {
            while (!failure && f - next >= pages.length * LOOKAHEAD) await new Promise<void>((r) => waiters.push(r));
            if (failure) break;
            await page.evaluate((x) => (window as unknown as { hudFrame: (f: number) => Promise<void> }).hudFrame(x), f);
            ready.set(f, await page.screenshot({ type: 'png', omitBackground: true, optimizeForSpeed: true }));
            writing = writing.then(drain).catch(fail);
          }
        } catch (e) {
          fail(new Error(`HUD renderer failed at frame ${f}: ${e instanceof Error ? e.message : String(e)}`, { cause: e }));
        }
      }));
      await writing;
      if (failure) throw failure;
      if (next !== total) throw new Error(`HUD renderer delivered ${next} of ${total} frames`);
    };
    return { workers, executablePath, render, close };
  } catch (e) {
    await close();
    throw e;
  }
}
