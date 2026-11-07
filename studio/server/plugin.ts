import { ffmpegPath, ffprobePath, h264Args } from './codecs';
/**
 * Local studio backend, mounted inside the Vite dev server:
 *   GET  /api/footage            index of front/rear camera files on the media share
 *   GET  /media/<cam>/<file>     range-served camera files (GLV previews or MP4 originals)
 *   POST /api/export             start an export job (project JSON body)
 *   GET  /api/export/<id>        job status
 *   GET  /exports/<file>         finished exports
 *   GET/POST /api/photos        list/import a still for a ride (binary upload)
 *   GET  /photos/<id>.png       oriented still used by preview and export
 *   GET  /api/rides             activities available to open
 *   POST /api/activities        import a dropped/WebUSB FIT or GPX (binary upload)
 *   GET/POST /api/media         list/import a video for a ride (binary upload, any format FFmpeg reads)
 *   POST /api/media/<id>/sync   pin a video's playback zero (optionally for its whole camera)
 *   POST /api/apple-health/scan   list workouts of a local Apple Health export (read-only) with overlapping clips
 *   POST /api/apple-health/import import one Apple Watch workout with a route as a ride
 * Read-only towards the camera share; everything it writes goes under studio/.cache and studio/exports.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import type { Camera, FootageFile } from '../src/core/project';
import { getJob, startExport } from './export';
import { getTile, validTile, tileAttribution } from './tiles';
import { importPhoto, photoIndex, photoPath } from './photos';
import { importActivity, rideList } from './activities';
import { importCameraSidecar, importMedia, mediaFootage, mediaIndex, mediaSource, syncMedia } from './media';
import { importAppleWorkout, scanAppleHealth } from './appleHealth';
import type { startHudRenderer } from './hud';
import { validateProject } from './validation';

const run = promisify(execFile);
export const CAMERAS: Record<Camera, string> = { front: 'new-front', rear: 'new-back' };
const FILE_RE = /^[A-Za-z0-9_-]+\.(MP4|GLV)$/i;

interface RegisteredFootage extends FootageFile {
  sourcePath: string;
  preview: (NonNullable<FootageFile['preview']> & { sourcePath: string }) | null;
}

function registeredFiles(paths: StudioPaths): RegisteredFootage[] {
  return ['dji-footage.json', 'phone-footage.json', 'camera-footage.json'].flatMap((name) => {
    const manifest = join(paths.cache, name);
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
  });
}


export interface StudioPaths {
  studio: string;
  dataRoot?: string;
  hudPage?: string;
  renderHud?: typeof startHudRenderer;
  mediaRoot: string;
  cache: string;
  exports: string;
}

export function studioPaths(studio: string, dataRoot = process.env.STUDIO_DATA_ROOT): StudioPaths {
  return {
    studio,
    dataRoot,
    mediaRoot: process.env.STUDIO_MEDIA_ROOT ?? join(dataRoot ?? studio, 'camera'),
    cache: join(dataRoot ?? studio, '.cache'),
    exports: join(dataRoot ?? studio, 'exports'),
  };
}

export function mediaPath(paths: StudioPaths, camera: string, name: string): string | null {
  const dir = CAMERAS[camera as Camera];
  if (!dir || !FILE_RE.test(name)) return null;
  if (camera === 'front' && name.startsWith('MEDIA-')) return mediaSource(paths, name);
  for (const file of registeredFiles(paths)) {
    if (file.camera !== camera) continue;
    const registered = name === file.name ? file.sourcePath : name === file.preview?.name ? file.preview.sourcePath : null;
    if (registered) return existsSync(registered) ? registered : null;
  }
  const p = resolve(paths.mediaRoot, dir, name);
  return p.startsWith(resolve(paths.mediaRoot)) && existsSync(p) ? p : null;
}

// Chromium plays HEVC only through platform decoders: VideoToolbox on macOS, VAAPI (rarely available) on Linux.
// Garmin Vue GLV previews are HEVC, so other platforms get a cached H.264 proxy with the same timeline.
const BROWSER_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PROXY_RE = /^([A-Za-z0-9_]+)-preview\.MP4$/;
const proxies = new Map<string, { job: Promise<string>; start: () => void }>();
let warming: Promise<unknown> = Promise.resolve();
const needsProxy = (codec: string) => process.platform !== 'darwin' && !BROWSER_CODECS.has(codec);

function proxySource(paths: StudioPaths, camera: Camera, stem: string): string | null {
  const dir = join(paths.mediaRoot, CAMERAS[camera]);
  return [`${stem}.GLV`, `${stem}.MP4`].map((n) => join(dir, n)).find((p) => existsSync(p)) ?? null;
}

/**
 * Encode (once) and return the proxy for a Garmin source; concurrent requests share the job.
 * Background warming runs one encode at a time; a file the UI requests (`now`) starts immediately.
 */
function garminProxy(paths: StudioPaths, camera: Camera, stem: string, now: boolean): Promise<string> | null {
  const source = proxySource(paths, camera, stem);
  if (!source) return null;
  const st = statSync(source);
  const target = join(paths.cache, 'previews', `${camera}-${stem}-${st.size}-${Math.round(st.mtimeMs)}.mp4`);
  if (existsSync(target)) return Promise.resolve(target);
  let entry = proxies.get(target);
  if (!entry) {
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const job = started.then(async () => {
      mkdirSync(join(paths.cache, 'previews'), { recursive: true });
      const partial = `${target}.partial`;
      await run(ffmpegPath(), ['-v', 'error', '-y', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1280,iw)':-2",
        '-fps_mode', 'passthrough', ...h264Args(true), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', partial], { maxBuffer: 4 << 20 });
      const [a, b] = await Promise.all([probe(source), probe(partial)]);
      if (!(Math.abs(a.duration - b.duration) <= 0.25)) { rmSync(partial, { force: true }); throw new Error(`Preview proxy timing differs for ${stem}`); }
      renameSync(partial, target);
      return target;
    }).finally(() => proxies.delete(target));
    entry = { job, start };
    proxies.set(target, entry);
    if (!now) warming = warming.then(() => { start(); return job.catch(() => undefined); });
  }
  if (now) entry.start(); // resolving an already started job again is a no-op
  return entry.job;
}

async function probe(path: string) {
  const { stdout } = await run(ffprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { maxBuffer: 8 << 20 });
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = j.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const [sn, sd] = String(v.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  const sar = sn > 0 && sd > 0 ? sn / sd : 1;
  return {
    createdUtc: j.format.tags?.creation_time as string,
    duration: Number(j.format.duration),
    width: v.width as number,
    height: v.height as number,
    displayWidth: Math.round(v.width * sar),
    codec: v.codec_name as string,
    audio: (a?.codec_name as string) ?? null,
  };
}

/** Verified per-file clock corrections (seek correction +2 s ⇒ video runs 2 s behind). */
function knownOffsets(paths: StudioPaths): Record<string, number> {
  const out: Record<string, number> = {};
  const plan = join(paths.studio, '..', 'video-studio', 'edit-plan.json');
  if (!existsSync(plan)) return out;
  for (const s of JSON.parse(readFileSync(plan, 'utf8')).segments ?? []) {
    const name = String(s.source).split('/').pop();
    if (name && s.visual_clock_correction_s) out[`${s.camera ?? 'front'}/${name}`] = -Number(s.visual_clock_correction_s);
  }
  return out;
}

export async function footageIndex(paths: StudioPaths): Promise<{ mediaRoot: string; files: FootageFile[]; error?: string }> {
  const registered = registeredFiles(paths);
  const media = mediaFootage(paths);
  if (!existsSync(paths.mediaRoot) && !registered.length) return { mediaRoot: paths.mediaRoot, files: media, error: media.length ? undefined : 'Media share not mounted' };
  mkdirSync(paths.cache, { recursive: true });
  const cacheFile = join(paths.cache, 'probe-cache.json');
  const cache: Record<string, unknown> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const offsets = knownOffsets(paths);
  const files: FootageFile[] = [...media, ...registered.filter((f) => existsSync(f.sourcePath)).map(({ sourcePath: _path, preview, ...file }) => ({
    ...file,
    preview: preview && existsSync(preview.sourcePath) ? { name: preview.name, width: preview.width, height: preview.height, codec: preview.codec } : null,
  }))];
  const { readdirSync } = await import('node:fs');
  for (const camera of Object.keys(CAMERAS) as Camera[]) {
    const dir = join(paths.mediaRoot, CAMERAS[camera]);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => /\.MP4$/i.test(n)).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      const key = `${camera}/${name}:${st.size}:${st.mtimeMs}`;
      if (!cache[key]) {
        const main = await probe(path);
        const glvName = name.replace(/\.MP4$/i, '.GLV');
        const glvPath = join(dir, glvName);
        const glv = existsSync(glvPath) ? await probe(glvPath) : null;
        cache[key] = { ...main, preview: glv && { name: glvName, width: glv.width, height: glv.height, codec: glv.codec } };
      }
      const file: FootageFile = { camera, name, brand: 'garmin', clockOffsetSec: offsets[`${camera}/${name}`] ?? 0, ...(cache[key] as Omit<FootageFile, 'camera' | 'name' | 'clockOffsetSec'>) };
      const shown = file.preview ?? { width: file.width, height: file.height, codec: file.codec };
      if (needsProxy(shown.codec)) {
        const stem = name.replace(/\.MP4$/i, '');
        const scale = Math.min(1, 1280 / shown.width);
        file.preview = { name: `${stem}-preview.MP4`, width: Math.round(shown.width * scale), height: 2 * Math.round(shown.height * scale / 2), codec: 'h264' };
        garminProxy(paths, camera, stem, false)?.catch((e: Error) => console.error(e.message)); // warm the cache in the background
      }
      files.push(file);
    }
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  return { mediaRoot: paths.mediaRoot, files };
}

function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
  const size = statSync(path).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.headers.range && !range) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if ((!range[1] && !Number(range[2])) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(path).on('error', () => res.destroy()).pipe(res);
  }
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error('JSON request exceeds 1 MB');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function studioMiddleware(paths: StudioPaths) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://local');
        try {
          if (url.pathname === '/api/capabilities' && req.method === 'GET') return json(res, 200, { desktop: false, webUsb: true });
          if (url.pathname === '/api/photos') {
            const rideId = url.searchParams.get('rideId') ?? '';
            if (req.method === 'GET') return json(res, 200, { photos: photoIndex(paths, rideId) });
            if (req.method === 'POST') {
              try {
                return json(res, 201, await importPhoto(paths, req, rideId, url.searchParams.get('name') ?? ''));
              } catch (e) {
                return json(res, 400, { error: (e as Error).message });
              }
            }
          }
          const photo = /^\/photos\/([a-f0-9-]+)\.png$/.exec(url.pathname);
          if (photo) {
            const path = photoPath(paths, photo[1]);
            return path ? sendFile(req, res, path, 'image/png') : json(res, 404, { error: 'photo not found' });
          }
          if (url.pathname === '/api/footage') return json(res, 200, await footageIndex(paths));
          if (url.pathname === '/api/tiles/config') return json(res, 200, { attribution: tileAttribution });
          if (url.pathname === '/api/rides') return json(res, 200, { rides: rideList(paths) });
          if (url.pathname === '/api/activities' && req.method === 'POST') {
            try {
              return json(res, 201, await importActivity(paths, req, url.searchParams.get('name') ?? ''));
            } catch (e) {
              return json(res, 400, { error: (e as Error).message });
            }
          }
          if (url.pathname === '/api/cameras' && req.method === 'POST') {
            try {
              const { info, existing } = await importMedia(paths, req, '', url.searchParams.get('name') ?? '', true, url.searchParams.get('timezone') ?? undefined, url.searchParams.get('sidecar') ?? undefined);
              return json(res, 201, { rideId: info.rideId, existing, detection: info.detection, warnings: info.warnings });
            } catch (e) {
              return json(res, 400, { error: (e as Error).message });
            }
          }
          if (url.pathname === '/api/camera-sidecars' && req.method === 'POST') {
            try {
              return json(res, 201, await importCameraSidecar(paths, req, url.searchParams.get('name') ?? ''));
            } catch (e) {
              return json(res, 400, { error: (e as Error).message });
            }
          }
          if (url.pathname === '/api/media') {
            const rideId = url.searchParams.get('rideId') ?? '';
            if (req.method === 'GET') return json(res, 200, { media: mediaIndex(paths, rideId) });
            if (req.method === 'POST') {
              try {
                return json(res, 201, (await importMedia(paths, req, rideId, url.searchParams.get('name') ?? '', false, undefined, url.searchParams.get('sidecar') ?? undefined)).info);
              } catch (e) {
                return json(res, 400, { error: (e as Error).message });
              }
            }
          }
          if (url.pathname === '/api/apple-health/scan' && req.method === 'POST') {
            try {
              return json(res, 200, await scanAppleHealth(paths, JSON.parse(await readBody(req)), (await footageIndex(paths)).files));
            } catch (e) {
              return json(res, 400, { error: (e as Error).message });
            }
          }
          if (url.pathname === '/api/apple-health/import' && req.method === 'POST') {
            try {
              return json(res, 201, await importAppleWorkout(paths, JSON.parse(await readBody(req))));
            } catch (e) {
              return json(res, 400, { error: (e as Error).message });
            }
          }
          const sync = /^\/api\/media\/([a-f0-9]{32})\/sync$/.exec(url.pathname);
          if (sync && req.method === 'POST') {
            try {
              return json(res, 200, { media: syncMedia(paths, sync[1], JSON.parse(await readBody(req))) });
            } catch (e) {
              return json(res, 400, { error: (e as Error).message });
            }
          }
          const tile = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
          if (tile) {
            const [z, x, y] = tile.slice(1).map(Number);
            if (!validTile(z, x, y)) return json(res, 400, { error: 'bad tile' });
            const buf = await getTile(paths.cache, z, x, y);
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.end(buf);
          }
          let m = /^\/media\/(\w+)\/([^/]+)$/.exec(url.pathname);
          if (m) {
            const name = decodeURIComponent(m[2]);
            let p = mediaPath(paths, m[1], name);
            const proxy = !p && m[1] in CAMERAS ? PROXY_RE.exec(name) : null;
            if (proxy) p = await garminProxy(paths, m[1] as Camera, proxy[1], true) ?? null;
            return p ? sendFile(req, res, p, /\.mov$/i.test(p) ? 'video/quicktime' : /\.webm$/i.test(p) ? 'video/webm' : 'video/mp4') : json(res, 404, { error: 'not found' });
          }
          if (url.pathname === '/api/export' && req.method === 'POST') {
            try {
              const body = JSON.parse(await readBody(req));
              validateProject(body.project);
              // Export renders fetch map tiles back from this server.
              const id = startExport(paths, body, `http://${req.headers.host ?? 'localhost:5178'}`);
              return json(res, 202, { id });
            } catch (e) { return json(res, 400, { error: (e as Error).message }); }
          }
          m = /^\/api\/export\/([\w-]+)$/.exec(url.pathname);
          if (m) {
            const job = getJob(m[1]);
            return job ? json(res, 200, job) : json(res, 404, { error: 'no such job' });
          }
          m = /^\/exports\/([\w.-]+\.mp4)$/.exec(url.pathname);
          if (m && existsSync(join(paths.exports, m[1]))) return sendFile(req, res, join(paths.exports, m[1]), 'video/mp4');
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
        next();
  };
}

export function studioServer(studioDir: string): Plugin {
  return {
    name: 'studio-server',
    configureServer(server) {
      server.middlewares.use(studioMiddleware(studioPaths(studioDir)));
    },
  };
}
