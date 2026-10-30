import { ffmpegPath, ffprobePath, h264Args } from './codecs';
import { ridesDir } from './paths';
/**
 * Imported videos for the pin-sync editor. Any container/codec FFmpeg reads is accepted;
 * originals are stored unmodified under the ignored cache and formats a browser cannot
 * play get an H.264 preview with the same timing. A clip is placed on the activity by,
 * in order: its own map pin, a pin on another clip from the same camera (device offset),
 * or its recorded clock. Without any of these it stays unsynced until pinned.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { FootageFile, MediaInfo, MediaSync } from '../src/core/project';
import { studioPython } from './activities';
import type { StudioPaths } from './plugin';

const run = promisify(execFile);
const RIDE_ID = /^[A-Za-z0-9_-]+$/;
const MEDIA_ID = /^[a-f0-9]{32}$/;
const LIMIT = 32 * 1024 ** 3;

interface StoredMedia extends Omit<MediaInfo, 'startUtc' | 'sync' | 'syncNotice'> {
  sourcePath: string;
  previewPath: string | null;
  /** Playback-zero UTC set by a map pin on this clip, or null. */
  pinnedUtc: string | null;
  /** SHA-256 of the imported bytes (absent on entries imported before it was recorded). */
  sha256?: string;
  /** Camera imports only: the other inputs that shape the projection. Activity imports never dedupe. */
  cameraKey?: { sidecarSha256: string | null; timezone: string | null } | null;
}
/** Per ride: device name → seconds added to that camera's recorded clock. */
type DeviceOffsets = Record<string, Record<string, { offsetSec: number; fromId: string }>>;

const mediaFile = (paths: StudioPaths) => join(paths.cache, 'media.json');
const offsetsFile = (paths: StudioPaths) => join(paths.cache, 'media-sync.json');
const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
function writeJson(path: string, value: unknown) {
  const pending = `${path}.${randomUUID()}.tmp`;
  writeFileSync(pending, JSON.stringify(value, null, 2));
  renameSync(pending, path);
}
const stored = (paths: StudioPaths) => readJson<StoredMedia[]>(mediaFile(paths), []);

/** A paired DJI SRT upload is kept exactly, then copied beside its video for detection. */
export async function importCameraSidecar(paths: StudioPaths, req: IncomingMessage, filename: string): Promise<{ id: string }> {
  if (extname(filename).toLowerCase() !== '.srt') throw new Error('Select an SRT beside its matching camera video');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 ** 2) throw new Error('SRT exceeds the 16 MB import limit');
    chunks.push(chunk as Buffer);
  }
  if (!size) throw new Error('SRT is empty');
  const id = randomUUID().replace(/-/g, '');
  const dir = join(paths.cache, 'camera-sidecars');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.srt`), Buffer.concat(chunks), { flag: 'wx' });
  return { id };
}

/** Effective playback-zero UTC and how it was obtained. */
function placement(m: StoredMedia, offsets: DeviceOffsets): { startUtc: string | null; sync: MediaSync } {
  if (m.pinnedUtc) return { startUtc: m.pinnedUtc, sync: 'pin' };
  const device = m.device ? offsets[m.rideId]?.[m.device] : undefined;
  if (m.recordedUtc && device) return { startUtc: new Date(Date.parse(m.recordedUtc) + device.offsetSec * 1000).toISOString(), sync: 'device' };
  if (m.recordedUtc) return { startUtc: m.recordedUtc, sync: 'clock' };
  return { startUtc: null, sync: 'none' };
}

const NOTICE: Record<MediaSync, string> = {
  pin: 'Placed by a map pin. Sync is time-only and approximate; long clips may drift.',
  device: 'Placed with the clock offset pinned on another clip from this camera. Time-only, approximate.',
  clock: "Placed by the camera's recorded clock, which may be wrong. Pin a moment on the map to correct it.",
  none: 'Not placed yet: pin a moment of this clip on the map.',
};

function publicInfo(m: StoredMedia, offsets: DeviceOffsets): MediaInfo {
  const { sourcePath: _s, previewPath: _p, pinnedUtc: _pin, sha256: _sha, cameraKey: _key, ...info } = m;
  const p = placement(m, offsets);
  return { ...info, ...p, syncNotice: NOTICE[p.sync] };
}

export function mediaIndex(paths: StudioPaths, rideId: string): MediaInfo[] {
  const offsets = readJson<DeviceOffsets>(offsetsFile(paths), {});
  return stored(paths).filter((m) => m.rideId === rideId).map((m) => publicInfo(m, offsets));
}

/** Placed media as footage files for the timeline and exporter (unplaced clips are omitted). */
export function mediaFootage(paths: StudioPaths): FootageFile[] {
  const offsets = readJson<DeviceOffsets>(offsetsFile(paths), {});
  return stored(paths).flatMap((m) => {
    const p = placement(m, offsets);
    if (!p.startUtc || !existsSync(m.sourcePath)) return [];
    return [{
      brand: 'media', rideId: m.rideId, label: m.label, syncNotice: NOTICE[p.sync], bottomStrip: 0, camera: 'front',
      name: m.name, createdUtc: p.startUtc, duration: m.duration, width: m.width, height: m.height, displayWidth: m.displayWidth,
      codec: m.codec, audio: m.audio, clockOffsetSec: 0, mediaId: m.id,
      preview: m.preview && m.previewPath && existsSync(m.previewPath) ? m.preview : null,
    } satisfies FootageFile];
  });
}

/** Original or preview path for a served media alias. */
export function mediaSource(paths: StudioPaths, name: string): string | null {
  for (const m of stored(paths)) {
    const path = name === m.name ? m.sourcePath : name === m.preview?.name ? m.previewPath : null;
    if (path) return existsSync(path) ? path : null;
  }
  return null;
}

async function probePreview(path: string): Promise<{ duration: number; width: number; height: number }> {
  const { stdout } = await run(ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path]);
  const j = JSON.parse(stdout);
  return { duration: Number(j.format?.duration), width: Number(j.streams?.[0]?.width), height: Number(j.streams?.[0]?.height) };
}

export async function importMedia(paths: StudioPaths, req: IncomingMessage, rideId: string, filename: string, cameraActivity = false, timezone?: string, sidecarId?: string): Promise<{ info: MediaInfo; existing: boolean }> {
  if (!cameraActivity && (!RIDE_ID.test(rideId) || !existsSync(join(ridesDir(paths), `${rideId}.json`)))) throw new Error('Open an activity before importing video');
  const id = randomUUID().replace(/-/g, '');
  if (cameraActivity) rideId = `camera-${id}`;
  const dir = join(paths.cache, 'media', id);
  mkdirSync(dir, { recursive: true });
  const ext = (extname(filename).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) ?? ['.video'])[0];
  const sourcePath = join(dir, `original${ext}`);
  // Validated before the path is built, so a hostile ?sidecar= can never name a file to delete.
  const stagedSidecar = sidecarId && MEDIA_ID.test(sidecarId) ? join(paths.cache, 'camera-sidecars', `${sidecarId}.srt`) : null;
  let createdRide: string | null = null;
  try {
    let size = 0;
    const digest = createHash('sha256');
    await pipeline(req, async function* (source) {
      for await (const chunk of source) {
        size += (chunk as Buffer).length;
        if (size > LIMIT) throw new Error('Video exceeds the 32 GB import limit');
        digest.update(chunk as Buffer);
        yield chunk;
      }
    }, createWriteStream(sourcePath, { flags: 'wx' }));
    if (!size) throw new Error('Video file is empty');
    const sha256 = digest.digest('hex');
    let sidecarSha256: string | null = null;
    if (sidecarId) {
      if (!stagedSidecar || !existsSync(stagedSidecar)) throw new Error('Unknown SRT sidecar');
      sidecarSha256 = createHash('sha256').update(readFileSync(stagedSidecar)).digest('hex');
      copyFileSync(stagedSidecar, join(dir, 'original.srt'));
    }
    const cameraKey = cameraActivity ? { sidecarSha256, timezone: timezone ?? null } : null;
    if (cameraKey) {
      // A sidecar or a timezone changes the projection, so both belong to the duplicate key.
      const known = stored(paths).find((m) => m.sha256 === sha256 && m.cameraKey?.sidecarSha256 === cameraKey.sidecarSha256
        && m.cameraKey?.timezone === cameraKey.timezone && existsSync(join(ridesDir(paths), `${m.rideId}.json`)));
      if (known) {
        rmSync(dir, { recursive: true, force: true });
        return { info: publicInfo(known, readJson<DeviceOffsets>(offsetsFile(paths), {})), existing: true };
      }
    }
    const projectionPath = join(dir, 'telemetry.json');
    const { stdout } = await run(studioPython(paths), [join(paths.studio, 'scripts/media_metadata.py'), sourcePath,
      ...(cameraActivity ? ['--telemetry-out', projectionPath, '--id', rideId] : []), ...(timezone ? ['--timezone', timezone] : [])], { maxBuffer: 1 << 20 });
    const meta = JSON.parse(stdout);
    if (cameraActivity && !existsSync(projectionPath)) throw new Error('No recording UTC found. Open a FIT/GPX activity and import this clip there to pin it on the map.');
    const name = `MEDIA-${id.slice(0, 16)}.MP4`;
    let preview: StoredMedia['preview'] = null;
    let previewPath: string | null = null;
    if (!meta.browserPlayable) {
      // Same timeline as the original (autorotated pixels, no dropped start), small and H.264.
      previewPath = join(dir, 'preview.mp4');
      await run(ffmpegPath(), ['-v', 'error', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1280,iw)':-2,fps=30",
        ...h264Args(true), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', previewPath], { maxBuffer: 4 << 20 });
      const p = await probePreview(previewPath);
      if (!(Math.abs(p.duration - meta.duration) <= 0.25)) throw new Error('Could not make a browser preview with matching timing');
      preview = { name: name.replace('.MP4', '-preview.MP4'), width: p.width, height: p.height, codec: 'h264' };
    }
    const entry: StoredMedia = {
      id, rideId, name, label: basename(filename), duration: meta.duration, width: meta.width, height: meta.height,
      displayWidth: meta.displayWidth, codec: meta.codec, audio: meta.audio, recordedUtc: meta.recordedUtc,
      clockSource: meta.clockSource, device: meta.device, warnings: meta.warnings, preview, sourcePath, previewPath, pinnedUtc: null,
      detection: meta.detection, sha256, cameraKey,
    };
    if (cameraActivity) {
      const ride = JSON.parse(readFileSync(projectionPath, 'utf8'));
      ride.meta.source = basename(filename);
      ride.meta.summary.name = basename(filename);
      const target = join(ridesDir(paths), `${rideId}.json`);
      mkdirSync(ridesDir(paths), { recursive: true });
      writeFileSync(target, JSON.stringify(ride), { flag: 'wx' });
      createdRide = target;
    }
    writeJson(mediaFile(paths), [...stored(paths), entry]);
    return { info: publicInfo(entry, readJson<DeviceOffsets>(offsetsFile(paths), {})), existing: false };
  } catch (error) {
    if (createdRide) rmSync(createdRide, { force: true });
    rmSync(dir, { recursive: true, force: true });
    const failure = error as Error & { stderr?: string };
    // The helper and FFmpeg report the reason on their last stderr line.
    throw new Error(failure.stderr?.trim().split('\n').pop() || failure.message);
  } finally {
    // The upload is staged for this one import only; the detector reads the copy beside the video.
    if (stagedSidecar) rmSync(stagedSidecar, { force: true });
  }
}

/**
 * Set (or clear with null) a clip's pinned playback-zero UTC. With `device`, the offset
 * between the pin and the clip's recorded clock also places other clips from the same
 * camera on this activity that have no pin of their own.
 */
export function syncMedia(paths: StudioPaths, id: string, body: { startUtc: string | null; device?: boolean }): MediaInfo[] {
  if (!MEDIA_ID.test(id)) throw new Error('Unknown video');
  const all = stored(paths);
  const m = all.find((x) => x.id === id);
  if (!m) throw new Error('Unknown video');
  if (body.startUtc !== null && !Number.isFinite(Date.parse(body.startUtc))) throw new Error('Invalid start time');
  m.pinnedUtc = body.startUtc === null ? null : new Date(Date.parse(body.startUtc)).toISOString();
  const offsets = readJson<DeviceOffsets>(offsetsFile(paths), {});
  const rideOffsets = (offsets[m.rideId] ??= {});
  if (m.device) {
    if (body.device && m.pinnedUtc && m.recordedUtc) {
      rideOffsets[m.device] = { offsetSec: (Date.parse(m.pinnedUtc) - Date.parse(m.recordedUtc)) / 1000, fromId: m.id };
    } else if (rideOffsets[m.device]?.fromId === m.id && (body.startUtc === null || body.device === false)) {
      delete rideOffsets[m.device];
    }
  }
  writeJson(mediaFile(paths), all);
  writeJson(offsetsFile(paths), offsets);
  return mediaIndex(paths, m.rideId);
}
