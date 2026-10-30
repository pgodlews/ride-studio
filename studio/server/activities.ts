/**
 * Activity import for the studio: dropped or WebUSB-read FIT/GPX bytes become rides
 * through the parity-tested TypeScript importers. Originals are kept byte-for-byte under the
 * ignored cache; a repeated import of the same bytes returns the existing ride.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { extname, join } from 'node:path';
import type { StudioPaths } from './plugin';

import { inspectFitActivity } from '../src/importers/fitRide';
import { readGpx } from '../src/importers/gpx';
import { ridesDir } from './paths';
const LIMIT = 100 * 1024 * 1024;

interface ImportRecord { sha256: string; rideId: string; name: string; importedUtc: string }

export interface RideSummary {
  id: string;
  name: string;
  startUtc: string;
  durationSec: number;
  distanceM: number | null;
  sport: string | null;
  gps: boolean;
}

/** Python for the studio helpers (Garmin FIT SDK, Pillow): STUDIO_PYTHON, else the repository .venv, else python3. */
export function studioPython(paths: StudioPaths): string {
  const venv = join(paths.studio, '..', '.venv', 'bin', 'python');
  return process.env.STUDIO_PYTHON ?? (existsSync(venv) ? venv : 'python3');
}

const manifestPath = (paths: StudioPaths) => join(paths.cache, 'activity-imports.json');
const records = (paths: StudioPaths): ImportRecord[] => (existsSync(manifestPath(paths)) ? JSON.parse(readFileSync(manifestPath(paths), 'utf8')) : []);

const summaries = new Map<string, { mtime: number; summary: RideSummary }>();

/** Rides available to open, newest first; summaries are cached by file mtime. */
export function rideList(paths: StudioPaths): RideSummary[] {
  const dir = ridesDir(paths);
  if (!existsSync(dir)) return [];
  const names = new Map(records(paths).map((r) => [r.rideId, r.name]));
  const out: RideSummary[] = [];
  for (const file of readdirSync(dir).filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
    const path = join(dir, file);
    const mtime = statSync(path).mtimeMs;
    let entry = summaries.get(path);
    if (!entry || entry.mtime !== mtime) {
      try {
        const ride = JSON.parse(readFileSync(path, 'utf8'));
        const s = ride.meta?.summary ?? {};
        const t: number[] = ride.t ?? [];
        const lat: (number | null)[] = ride.channels?.lat ?? [];
        entry = {
          mtime,
          summary: {
            id: ride.id, name: names.get(ride.id) ?? ride.meta?.activity?.name ?? s.name ?? ride.meta?.source ?? ride.id, startUtc: ride.startUtc,
            durationSec: t.length ? t[t.length - 1] : 0,
            distanceM: typeof s.total_distance === 'number' ? s.total_distance : null,
            sport: ride.meta?.activity?.sport ?? (typeof s.sport === 'string' ? s.sport : null),
            gps: lat.filter((v) => v !== null).length >= 2,
          },
        };
        summaries.set(path, entry);
      } catch {
        continue;
      }
    }
    out.push(entry.summary);
  }
  return out.sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc));
}

function freeId(paths: StudioPaths, stem: string): string {
  const base = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'activity';
  let id = base;
  for (let n = 2; existsSync(join(ridesDir(paths), `${id}.json`)); n++) id = `${base}-${n}`;
  return id;
}

export async function importActivity(paths: StudioPaths, req: IncomingMessage, filename: string): Promise<{ rideId: string; existing: boolean; warnings: string[] }> {
  const ext = extname(filename).toLowerCase();
  if (ext !== '.fit' && ext !== '.gpx') throw new Error('Drop a Garmin .fit activity or a timestamped .gpx track');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('Activity exceeds the 100 MB import limit');
    chunks.push(chunk as Buffer);
  }
  if (!size) throw new Error('Activity file is empty');
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const known = records(paths).find((r) => r.sha256 === sha256 && existsSync(join(ridesDir(paths), `${r.rideId}.json`)));
  if (known) return { rideId: known.rideId, existing: true, warnings: [] };

  const safeName = filename.replace(/[\\/]/g, '_').replace(/[^\w. -]/g, '_').slice(-120) || `activity${ext}`;
  const dir = join(paths.cache, 'activity-imports', sha256);
  mkdirSync(dir, { recursive: true });
  const original = join(dir, safeName);
  if (!existsSync(original)) writeFileSync(original, bytes, { flag: 'wx' });
  let rideId = freeId(paths, safeName.replace(/\.[^.]+$/, ''));
  const imported = ext === '.fit'
    ? await inspectFitActivity(bytes, rideId, safeName)
    : await readGpx(bytes, rideId, { sourceName: safeName });
  const ride = imported.ride;
  if (!ride.startUtc || !ride.meta.activity?.routeImportEligible) {
    throw new Error(`This activity has no usable GPS track (${ride.meta.activity?.exclusionReason ?? 'missing timestamps'}); pin sync needs a route on the map`);
  }
  // Parsing yields to other uploads. Resolve duplicates and filename collisions again before the atomic write.
  const duplicate = records(paths).find((r) => r.sha256 === sha256 && existsSync(join(ridesDir(paths), `${r.rideId}.json`)));
  if (duplicate) return { rideId: duplicate.rideId, existing: true, warnings: [] };
  rideId = freeId(paths, safeName.replace(/\.[^.]+$/, ''));
  ride.id = rideId;
  mkdirSync(ridesDir(paths), { recursive: true });
  writeFileSync(join(ridesDir(paths), `${rideId}.json`), JSON.stringify(ride), { flag: 'wx' });
  const evidenceDir = join(paths.cache, ext === '.fit' ? 'activity-fit' : 'activity-gpx');
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = join(evidenceDir, `${sha256}${ext === '.fit' ? '.json' : '.gpx'}`);
  if (!existsSync(evidence)) writeFileSync(evidence, 'messages' in imported ? JSON.stringify(imported.messages) : bytes, { flag: 'wx' });
  const target = manifestPath(paths);
  const pending = `${target}.${sha256}.tmp`;
  writeFileSync(pending, JSON.stringify([...records(paths), { sha256, rideId, name: safeName, importedUtc: new Date().toISOString() }], null, 2));
  renameSync(pending, target);
  const warnings = ride.meta.warnings;
  return { rideId, existing: false, warnings };
}

