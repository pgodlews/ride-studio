import { ffmpegPath, ffprobePath, decodeArgs, h264Args } from './codecs';
import { ridesDir } from './paths';
import { validateProject } from './validation';
/**
 * Export pipeline:
 *  1. A pool of headless Chrome processes renders the HUD (the editor's SVG OverlayLayer) as
 *     transparent PNG frames, streamed in order into FFmpeg's stdin (server/hud.ts).
 *  2. In the same FFmpeg run, each clip is cut from the ORIGINAL camera files (not proxies),
 *     cropped/scaled to the output format, given the rear inset for PiP clips and joined with
 *     short audio fades; the HUD is overlaid and the result encoded as H.264/AAC with fast start.
 *  3. The result is probed (frames, duration, streams) before it is reported as done.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cropRect, FORMATS, type Format } from '../src/core/framing';
import { footagePieces, photoSourceInfo, sourceInfo, type FootageFile, type FootagePiece, type PhotoFile, type Project } from '../src/core/project';
import type { RideJson } from '../src/core/ride';
import { startHudRenderer, type HudRenderer } from './hud';
import type { StudioPaths } from './plugin';
import { photoIndex, photoPath } from './photos';

const FPS = 30;

export interface Job {
  id: string;
  status: 'queued' | 'hud' | 'video' | 'done' | 'error';
  progress: number; // 0–1 within the current phase
  message: string;
  output?: string;
  url?: string;
  checks?: Record<string, unknown>;
  log: string[];
  startedAt: number;
  finishedAt?: number;
}

// Kept on globalThis so running jobs survive Vite's automatic server reloads (same process).
const jobs: Map<string, Job> = ((globalThis as { __studioJobs?: Map<string, Job> }).__studioJobs ??= new Map());
export const getJob = (id: string) => jobs.get(id);
const processes = new Set<ReturnType<typeof spawn>>();
export function stopExports() { for (const process of processes) process.kill('SIGTERM'); }

export function startExport(paths: StudioPaths, body: { project: Project }, origin: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job: Job = { id, status: 'queued', progress: 0, message: 'Queued', log: [], startedAt: Date.now() };
  jobs.set(id, job);
  runExport(paths, job, body.project, origin).catch((e: Error) => {
    job.status = 'error';
    job.message = e.message;
    job.log.push(String(e.stack ?? e));
    job.finishedAt = Date.now();
  });
  return id;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ride';

/** Export cannot silently compress missing source time. Validate before starting Chrome/FFmpeg. */
export function assertFootageCoverage(pieces: FootagePiece[], duration: number, label: string) {
  let end = 0;
  for (const piece of pieces) {
    if (piece.at - end > 0.001) throw new Error(`${label}: missing footage at ${end.toFixed(3)}–${piece.at.toFixed(3)} s; shorten or split the clip`);
    end = piece.at + piece.duration;
  }
  if (duration - end > 0.001) throw new Error(`${label}: missing footage at ${end.toFixed(3)}–${duration.toFixed(3)} s; shorten or split the clip`);
}

async function runExport(paths: StudioPaths, job: Job, project: Project, origin: string) {
  validateProject(project);
  const { footageIndex, mediaPath } = await import('./plugin');
  if (!project.clips.length) throw new Error('Timeline is empty');
  const fmt = FORMATS.find((f) => f.id === project.formatId) ?? FORMATS[0];
  const rideFile = join(ridesDir(paths), `${project.rideId}.json`);
  const ride = JSON.parse(readFileSync(rideFile, 'utf8')) as RideJson;
  const rideStartMs = Date.parse(ride.startUtc);
  const { files: indexedFiles, error } = project.clips.some((c) => c.kind !== 'photo')
    ? await footageIndex(paths) : { files: [], error: undefined };
  const files = indexedFiles.filter((f) => !f.rideId || f.rideId === project.rideId);
  if (error && project.clips.some((c) => c.kind !== 'photo')) throw new Error(error);
  const photos = photoIndex(paths, project.rideId);
  for (const c of project.clips) {
    if (!Number.isFinite(c.duration) || c.duration <= 0 || !Number.isFinite(c.rideStart)) throw new Error('Clip duration and ride time must be finite; duration must be positive');
    if (c.kind === 'photo' && (!photos.some((p) => p.id === c.photoId) || !photoPath(paths, c.photoId ?? ''))) throw new Error(`Photo missing: ${c.label}`);
  }

  // Snap clip lengths to whole frames so HUD and footage agree exactly.
  const clips = project.clips.map((c) => ({ ...c, duration: Math.max(1 / FPS, Math.round(c.duration * FPS) / FPS) }));
  const snapped: Project = { ...project, clips };
  mkdirSync(paths.exports, { recursive: true });
  const hasOverlays = project.overlays.length > 0;

  // ---- 1–2. FFmpeg graph: footage, then the HUD frames from stdin ----
  const args: string[] = ['-v', 'error', '-y', '-progress', 'pipe:1', '-nostats'];
  const filters: string[] = [];
  let input = 0;
  const addInput = (p: FootagePiece) => {
    const path = mediaPath(paths, p.file.camera, p.file.name);
    if (!path) throw new Error(`Source video missing: ${p.file.name}`);
    args.push(...decodeArgs(), '-ss', p.srcIn.toFixed(6), '-t', (p.duration + 0.2).toFixed(6), '-i', path);
    return input++;
  };

  clips.forEach((c, k) => {
    const frames = Math.round(c.duration * FPS);
    if (c.kind === 'photo') {
      const photo = photos.find((p) => p.id === c.photoId)!;
      const idx = input++;
      args.push('-loop', '1', '-framerate', String(FPS), '-t', c.duration.toFixed(6), '-i', photoPath(paths, photo.id)!);
      filters.push(`[${idx}:v]${cropScale(photo, fmt, c.framing ?? project.framing)},fps=${FPS},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${k}]`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${c.duration.toFixed(6)},asetpts=PTS-STARTPTS[a${k}]`);
      return;
    }
    const startMs = rideStartMs + c.rideStart * 1000;
    const mainCam = c.camera === 'rear' ? 'rear' : 'front';
    const pieces = footagePieces(c.sourceFile ? files.filter((f) => f.name === c.sourceFile) : files, mainCam, startMs, c.duration, project.rearOffsetSec);
    if (!pieces.length) throw new Error(`Clip ${k + 1} (${c.label}): no ${mainCam} footage at that time`);
    assertFootageCoverage(pieces, c.duration, `Clip ${k + 1} (${c.label}), ${mainCam}`);
    const framing = c.framing ?? project.framing;
    const vParts: string[] = [];
    const aParts: string[] = [];
    pieces.forEach((p, j) => {
      const idx = addInput(p);
      // Quantise boundaries on the clip's frame grid, rather than rounding every piece up.
      const pieceFrames = Math.round((p.at + p.duration) * FPS) - Math.round(p.at * FPS);
      if (pieceFrames > 0) {
        filters.push(`[${idx}:v]${cropScale(p.file, fmt, framing)},fps=${FPS},tpad=stop_mode=clone:stop_duration=${1 / FPS},trim=end_frame=${pieceFrames},setpts=PTS-STARTPTS[c${k}v${j}]`);
        vParts.push(`[c${k}v${j}]`);
      }
      if (p.file.audio) {
        filters.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=mono,apad,atrim=duration=${p.duration.toFixed(6)},asetpts=PTS-STARTPTS[c${k}a${j}]`);
      } else filters.push(`anullsrc=r=48000:cl=mono,atrim=duration=${p.duration.toFixed(6)},asetpts=PTS-STARTPTS[c${k}a${j}]`);
      aParts.push(`[c${k}a${j}]`);
    });
    const lead = pieces[0].at;
    filters.push(`${vParts.join('')}concat=n=${vParts.length}:v=1:a=0,trim=end_frame=${frames},setpts=PTS-STARTPTS[c${k}main]`);

    let vOut = `[c${k}main]`;
    if (c.camera === 'pip') {
      const rear = footagePieces(files, 'rear', startMs, c.duration, project.rearOffsetSec);
      assertFootageCoverage(rear, c.duration, `Clip ${k + 1} (${c.label}), rear inset`);
      if (rear.length) {
        const iw = even(fmt.w * (fmt.w < fmt.h ? 0.42 : 0.3));
        const ih = even((iw * 9) / 16);
        const rParts = rear.flatMap((p, j) => {
          const pieceFrames = Math.round((p.at + p.duration) * FPS) - Math.round(p.at * FPS);
          if (pieceFrames <= 0) return [];
          const idx = addInput(p);
          const info = sourceInfo(p.file);
          const ch = even(p.file.height * (1 - info.bottomStrip));
          const cw = even(Math.min(p.file.width, (ch * 16) / 9 * (p.file.width / p.file.displayWidth)));
          filters.push(`[${idx}:v]crop=${cw}:${ch}:${even((p.file.width - cw) / 2)}:0,scale=${iw}:${ih}:flags=lanczos,setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=${1 / FPS},trim=end_frame=${pieceFrames},setpts=PTS-STARTPTS[c${k}r${j}]`);
          return `[c${k}r${j}]`;
        });
        const margin = Math.round(fmt.w * 0.04);
        const y = (fmt.unsafe?.top ?? 0) + margin;
        filters.push(`${rParts.join('')}concat=n=${rParts.length}:v=1:a=0,trim=end_frame=${frames},setpts=PTS-STARTPTS,drawbox=c=white@0.9:t=4[c${k}rear]`);
        filters.push(`[c${k}main][c${k}rear]overlay=x=${fmt.w - iw - margin}:y=${y}:shortest=1[c${k}pip]`);
        vOut = `[c${k}pip]`;
      }
    }
    filters.push(`${vOut}null[v${k}]`);

    const fade = Math.min(0.15, c.duration / 4);
    const aFx = `highpass=f=90,lowpass=f=12000,volume=${project.audioLevel.toFixed(2)},apad,atrim=duration=${c.duration.toFixed(6)},afade=t=in:d=${fade},afade=t=out:st=${(c.duration - fade).toFixed(6)}:d=${fade},aformat=channel_layouts=stereo`;
    if (aParts.length) filters.push(`${aParts.join('')}concat=n=${aParts.length}:v=0:a=1,adelay=${Math.round(lead * 1000)}:all=1,${aFx}[a${k}]`);
    else filters.push(`anullsrc=r=48000:cl=mono,${aFx}[a${k}]`);
  });

  filters.push(`${clips.map((_, k) => `[v${k}][a${k}]`).join('')}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
  if (hasOverlays) {
    const hudIdx = input++;
    args.push('-thread_queue_size', '64', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0');
    filters.push(`[vcat][${hudIdx}:v]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[vout]`);
  } else filters.push('[vcat]format=yuv420p[vout]');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `${slug(project.name)}-${fmt.id}-${stamp}-${job.id}.mp4`;
  const out = join(paths.exports, name);
  // Encode to a temporary name; only a complete, verified file gets the real name.
  const partial = join(paths.exports, `${name}.partial`);
  const totalFrames = clips.reduce((s, c) => s + Math.round(c.duration * FPS), 0);
  const encoder = process.env.STUDIO_VIDEO_ENCODER ?? 'libx264';
  const encoderArgs = h264Args(false, encoder);
  args.push('-filter_complex', filters.join(';\n'), '-map', '[vout]', '-map', '[acat]');
  const encoderAt = args.length;
  args.push(...encoderArgs, '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', String(FPS * 2), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
    '-frames:v', String(totalFrames), '-f', 'mp4', partial);
  job.log.push(`ffmpeg ${args.map((a) => (/[\s;\[]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);

  let hud: HudRenderer | null = null;
  try {
    if (hasOverlays) {
      job.status = 'hud';
      job.message = 'Starting HUD renderer';
      const t0 = Date.now();
      hud = await startHudRenderer({ paths, project: snapped, ride, tileBase: origin, totalFrames, log: (s) => job.log.push(s) });
      job.log.push(`HUD renderer ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    job.status = 'video';
    job.progress = 0;
    job.message = hasOverlays ? 'Rendering HUD, cutting footage and encoding' : 'Cutting footage and encoding';
    const t1 = Date.now();
    const renderer = hud;
    const encode = (argv: string[]) => ffmpeg(argv, totalFrames / FPS, job, renderer ? (write) => renderer.render(write) : undefined);
    try {
      await encode(args);
    } catch (error) {
      // The startup probe only shows the encoder opened once. A later session can still fail
      // before any frame (NVENC session limit, driver). Retry that one encode with libx264.
      const failed = error as Error & { code?: number | null; signal?: NodeJS.Signals | null; stderr?: string; frames?: number };
      const hardware = encoder === 'h264_nvenc' || encoder === 'h264_videotoolbox';
      if (!(hardware && failed.frames === 0 && typeof failed.code === 'number' && failed.code !== 0 && !failed.signal)) throw error;
      const first = ((failed.stderr ?? '').split('\n')[0] ?? '').replace(/\r$/, '');
      job.log.push(`Hardware encoder ${encoder} failed (${first}); retried with libx264`);
      const fallback = args.slice();
      fallback.splice(encoderAt, encoderArgs.length, ...h264Args(false, 'libx264'));
      await encode(fallback);
    }
    job.log.push(`Composite and encode: ${((Date.now() - t1) / 1000).toFixed(1)} s for ${totalFrames} frames`);
  } finally {
    await hud?.close();
  }

  // ---- 3. Verify ----
  const checks = await probeOutput(partial);
  if (checks.frames !== totalFrames || checks.width !== fmt.w || checks.height !== fmt.h || checks.video !== 'h264' || checks.audio !== 'aac' || Math.abs(checks.seconds - totalFrames / FPS) > 0.1) {
    throw new Error(`Export verification failed: ${JSON.stringify(checks)}; expected ${totalFrames} frames at ${fmt.w} × ${fmt.h}`);
  }
  renameSync(partial, out);
  job.checks = { ...checks, expectedFrames: totalFrames, expectedSeconds: totalFrames / FPS, sizeMB: +(statSync(out).size / 1e6).toFixed(1) };
  job.status = 'done';
  job.progress = 1;
  job.output = out;
  job.url = `/exports/${name}`;
  job.message = `Exported ${name}`;
  job.finishedAt = Date.now();
}

/** Crop the framed area (display coords → stored pixels for anamorphic files) and scale to the format. */
function cropScale(file: FootageFile | PhotoFile, fmt: Format, framing: Project['framing']): string {
  const displayWidth = 'camera' in file ? file.displayWidth : file.width;
  const info = 'camera' in file ? sourceInfo(file) : photoSourceInfo(file);
  const c = cropRect(info, fmt, framing);
  if (!('camera' in file)) {
    const w = Math.min(file.width, Math.max(1, Math.round(c.w)));
    const h = Math.min(file.height, Math.max(1, Math.round(c.h)));
    const x = Math.min(file.width - w, Math.max(0, Math.round(c.x)));
    const y = Math.min(file.height - h, Math.max(0, Math.round(c.y)));
    return `crop=${w}:${h}:${x}:${y},scale=${fmt.w}:${fmt.h}:flags=lanczos,setsar=1`;
  }
  const sx = file.width / displayWidth;
  const w = even(c.w * sx);
  const h = even(c.h);
  const x = even(c.x * sx);
  const y = even(c.y);
  return `crop=${w}:${h}:${Math.min(x, file.width - w)}:${Math.min(y, file.height - h)},scale=${fmt.w}:${fmt.h}:flags=lanczos,setsar=1`;
}

/**
 * Runs FFmpeg, reporting progress from -progress pipe:1. `feed` streams data into stdin; if it
 * fails, FFmpeg is stopped and the feed's error is reported instead of FFmpeg's.
 */
export function ffmpeg(args: string[], seconds: number, job: Job, feed?: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { stdio: [feed ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    processes.add(p);
    p.once('error', () => processes.delete(p));
    p.once('close', () => processes.delete(p));
    p.once('error', reject);
    let err = '';
    let frames = 0;
    let carry = '';
    let feedError: unknown = null;
    let feedDone = Promise.resolve();
    const noteFrames = (text: string) => {
      carry += text;
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const frame = /frame=(\d+)/.exec(line);
        if (frame) frames = Math.max(frames, Number(frame[1]));
      }
    };
    if (feed) {
      const stdin = p.stdin!;
      stdin.on('error', () => undefined); // EPIPE when FFmpeg exits early; its exit status says why
      const write = (chunk: Uint8Array) => new Promise<void>((res, rej) => { stdin.write(chunk, (e) => (e ? rej(e) : res())); });
      feedDone = feed(write).then(() => { stdin.end(); }, (e: NodeJS.ErrnoException) => {
        // A closed pipe means FFmpeg is already ending; any other failure stops it.
        if (e?.code === 'EPIPE' || e?.code === 'ERR_STREAM_DESTROYED' || p.exitCode !== null || p.signalCode !== null) return;
        feedError = e;
        p.kill('SIGKILL');
      });
    }
    p.stdout!.on('data', (d: Buffer) => {
      const text = d.toString();
      const m = /out_time_us=(\d+)/.exec(text);
      if (m) job.progress = Math.min(1, Number(m[1]) / 1e6 / seconds);
      noteFrames(text);
    });
    p.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('close', (code, signal) => {
      noteFrames('\n');
      const finish = () => {
        if (err.trim()) job.log.push(err.trim().slice(-4000));
        if (feedError) reject(feedError);
        else if (code === 0) resolve();
        else reject(Object.assign(new Error(`ffmpeg ${code === null ? `stopped by ${signal}` : `exited ${code}`}: ${err.trim().split('\n').slice(-3).join(' | ')}`), { code, signal, stderr: err, frames }));
      };
      // With a HUD feed, wait until that render settles so a retry cannot use the same pages twice.
      if (feed) void feedDone.then(finish, finish);
      else finish();
    });
  });
}

export function probeOutput(path: string): Promise<{ frames: number; seconds: number; width: number; height: number; video: string; audio: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath(), ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_name,codec_type,width,height,nb_read_packets:format=duration', '-of', 'json', path]);
    p.once('error', reject);
    let s = '';
    p.stdout.on('data', (d: Buffer) => { s += d.toString(); });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed on output'));
      try {
        const j = JSON.parse(s);
        const v = j.streams.find((x: { codec_type: string }) => x.codec_type === 'video');
        const a = j.streams.find((x: { codec_type: string }) => x.codec_type === 'audio');
        resolve({ frames: Number(v?.nb_read_packets), seconds: Number(j.format.duration), width: v?.width, height: v?.height, video: v?.codec_name, audio: a?.codec_name ?? 'none' });
      } catch (e) { reject(e); }
    });
  });
}
