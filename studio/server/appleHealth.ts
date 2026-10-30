import { ridesDir } from './paths';
/**
 * Apple Health export import for the studio. The export stays where it is (read-only);
 * scripts/apple_health.py caches a private workout index and imports one workout at a
 * time as a ride. Each workout is annotated with the clips and photos it overlaps in time.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileStartMs } from '../src/core/project';
import { studioPython } from './activities';
import type { StudioPaths } from './plugin';

const run = promisify(execFile);
const WORKOUT_ID = /^[a-f0-9]{16}$/;

export interface AppleWorkout {
  id: string;
  type: string;
  sport: string;
  startUtc: string;
  endUtc: string;
  tzOffsetSec: number;
  durationMin: number;
  distanceM: number | null;
  avgHeartRate: number | null;
  source: string;
  device: string | null;
  hasRoute: boolean;
  /** Clips/photos whose recording time overlaps the workout (camera clocks are unverified). */
  matches: string[];
  rideId: string | null;
}

const importsFile = (paths: StudioPaths) => join(paths.cache, 'apple-health-imports.json');
const imports = (paths: StudioPaths): Record<string, string> => (existsSync(importsFile(paths)) ? JSON.parse(readFileSync(importsFile(paths), 'utf8')) : {});

function exportDir(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path.trim())) throw new Error('Enter the full path of the unzipped apple_health_export folder');
  const dir = resolve(path.trim());
  if (!existsSync(join(dir, 'export.xml'))) throw new Error('That folder has no export.xml; choose the unzipped apple_health_export folder');
  return dir;
}

async function python(paths: StudioPaths, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(studioPython(paths), [join(paths.studio, 'scripts/apple_health.py'), ...args,
      '--cache', join(paths.cache, 'apple-health')], { maxBuffer: 64 << 20, cwd: paths.studio });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error((failure.stderr || failure.message).trim().replace(/^error:\s*/, ''));
  }
}

/** Time windows of camera files, placed imported videos and photos with a capture time. */
function clipWindows(paths: StudioPaths, files: { name: string; label?: string; createdUtc: string; duration: number; clockOffsetSec: number; camera: 'front' | 'rear'; brand?: string }[]): { label: string; start: number; end: number }[] {
  const out = files.map((f) => ({ label: f.label ?? `${f.camera}/${f.name}`, start: fileStartMs(f as never), end: fileStartMs(f as never) + f.duration * 1000 }));
  // Imported videos with any time (pin, camera offset or clock) are already footage files.
  const read = (name: string) => (existsSync(join(paths.cache, name)) ? JSON.parse(readFileSync(join(paths.cache, name), 'utf8')) : []);
  for (const p of read('photos.json') as { label: string; capturedUtc: string | null }[]) {
    const at = Date.parse(p.capturedUtc ?? '');
    if (Number.isFinite(at)) out.push({ label: p.label, start: at, end: at });
  }
  return out.filter((w) => Number.isFinite(w.start));
}

export async function scanAppleHealth(paths: StudioPaths, body: { path?: unknown }, footage: Parameters<typeof clipWindows>[1]) {
  const dir = exportDir(body.path);
  const index = JSON.parse(await python(paths, ['scan', dir, '--json']));
  const windows = clipWindows(paths, footage);
  const done = imports(paths);
  const rides = ridesDir(paths);
  const workouts: AppleWorkout[] = index.workouts.map((w: Record<string, unknown>) => {
    const a = Date.parse(w.startUtc as string);
    const b = Date.parse(w.endUtc as string);
    const rideId = done[w.id as string];
    return {
      id: w.id, type: w.type, sport: w.sport, startUtc: w.startUtc, endUtc: w.endUtc, tzOffsetSec: w.tzOffsetSec,
      durationMin: w.durationMin, distanceM: w.distanceM, avgHeartRate: w.avgHeartRate, source: w.source, device: w.device,
      hasRoute: (w.routes as string[]).length > 0,
      matches: windows.filter((c) => c.start <= b && c.end >= a).map((c) => c.label),
      rideId: rideId && existsSync(join(rides, `${rideId}.json`)) ? rideId : null,
    } as AppleWorkout;
  });
  return { exportDate: index.exportDate, export: dir, workouts: workouts.reverse() };
}

export async function importAppleWorkout(paths: StudioPaths, body: { path?: unknown; workoutId?: unknown }) {
  const dir = exportDir(body.path);
  const id = String(body.workoutId ?? '');
  if (!WORKOUT_ID.test(id)) throw new Error('Unknown workout');
  const done = imports(paths);
  const rides = ridesDir(paths);
  if (done[id] && existsSync(join(rides, `${done[id]}.json`))) return { rideId: done[id], existing: true, warnings: [] as string[] };
  const index = JSON.parse(await python(paths, ['scan', dir, '--json']));
  const w = index.workouts.find((x: { id: string }) => x.id === id);
  if (!w) throw new Error('Unknown workout; scan the export again');
  const local = new Date(Date.parse(w.startUtc) + w.tzOffsetSec * 1000).toISOString();
  const base = `apple-${String(w.type).toLowerCase()}-${local.slice(0, 10)}-${local.slice(11, 16).replace(':', '')}`.replace(/[^A-Za-z0-9_-]/g, '-');
  let rideId = base;
  for (let n = 2; existsSync(join(rides, `${rideId}.json`)); n++) rideId = `${base}-${n}`;
  const stdout = await python(paths, ['import', dir, id, '--id', rideId, '--out-dir', rides]);
  const pending = `${importsFile(paths)}.${id}.tmp`;
  writeFileSync(pending, JSON.stringify({ ...imports(paths), [id]: rideId }, null, 2));
  renameSync(pending, importsFile(paths));
  return { rideId, existing: false, warnings: stdout.split('\n').filter((l) => l.startsWith('warning:')).map((l) => l.slice(8).trim()) };
}
