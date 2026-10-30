import { ridesDir } from './paths';
/** Local still imports. Originals and metadata stay in the ignored cache. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { PhotoFile } from '../src/core/project';
import { studioPython } from './activities';
import type { StudioPaths } from './plugin';

const run = promisify(execFile);
const RIDE_ID = /^[A-Za-z0-9_-]+$/;
const PHOTO_ID = /^[a-f0-9-]{36}$/;
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.heif']);
interface StoredPhoto extends PhotoFile { originalPath: string; imagePath: string }

function manifest(paths: StudioPaths): StoredPhoto[] {
  const path = join(paths.cache, 'photos.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

export function photoIndex(paths: StudioPaths, rideId: string): PhotoFile[] {
  return manifest(paths).filter((p) => p.rideId === rideId).map(({ originalPath: _original, imagePath: _image, ...p }) => p);
}

export function photoPath(paths: StudioPaths, id: string): string | null {
  if (!PHOTO_ID.test(id)) return null;
  const p = manifest(paths).find((p) => p.id === id)?.imagePath;
  return p && existsSync(p) ? p : null;
}

export async function importPhoto(paths: StudioPaths, req: IncomingMessage, rideId: string, filename: string): Promise<PhotoFile> {
  if (!RIDE_ID.test(rideId) || !existsSync(join(ridesDir(paths), `${rideId}.json`))) throw new Error('Select an existing ride before importing a photo');
  const extension = extname(filename).toLowerCase();
  if (!EXTENSIONS.has(extension)) throw new Error('Supported photos: JPEG, PNG, WebP, TIFF, HEIC/HEIF (macOS)');
  const limit = 50 * 1024 * 1024;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Photo exceeds the 50 MB import limit');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Photo is empty');
  const id = randomUUID();
  const dir = join(paths.cache, 'photos', id);
  mkdirSync(dir, { recursive: true });
  const originalPath = join(dir, `original${extension}`);
  const imagePath = join(dir, 'image.png');
  try {
    writeFileSync(originalPath, Buffer.concat(chunks), { flag: 'wx' });
    const { stdout } = await run(studioPython(paths), [join(paths.studio, 'scripts/photo_metadata.py'), originalPath, imagePath], { maxBuffer: 1 << 20 });
    const photo: PhotoFile = { ...JSON.parse(stdout), id, rideId, label: basename(filename) };
    // Read after the asynchronous decoder, then append/rename synchronously so concurrent imports survive.
    const entries = [...manifest(paths), { ...photo, originalPath, imagePath }];
    const target = join(paths.cache, 'photos.json');
    const pending = `${target}.${id}.tmp`;
    writeFileSync(pending, JSON.stringify(entries, null, 2));
    renameSync(pending, target);
    return photo;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
