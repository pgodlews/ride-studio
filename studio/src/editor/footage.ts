/** Client side of the footage index: which camera file plays at a ride time. */
import { useEffect, useState } from 'react';
import { fileStartMs, footagePieces, sourceInfo, type Camera, type FootageFile } from '../core/project';
import type { Ride } from '../core/ride';
import type { ClipRef } from '../gallery/Stage';

export interface FootageIndex {
  mediaRoot: string;
  files: FootageFile[];
  error?: string;
}

/** Footage for a ride; bump `version` to re-read it (after media imports or sync changes). */
export function useFootage(rideId?: string, version = 0): FootageIndex | null {
  const [idx, setIdx] = useState<FootageIndex | null>(null);
  useEffect(() => {
    fetch('/api/footage').then((r) => r.json()).then((index: FootageIndex) => setIdx({ ...index, files: index.files.filter((f) => !f.rideId || f.rideId === rideId) })).catch((e: Error) => setIdx({ mediaRoot: '', files: [], error: e.message }));
  }, [rideId, version]);
  return idx;
}

/** Preview video (camera's own GLV low-res file) covering ride time t, as a stage clip. */
export function previewAt(ride: Ride, files: FootageFile[], camera: Camera, t: number, rearOffsetSec: number, sourceFile?: string): (ClipRef & { file: FootageFile }) | null {
  const ms = ride.startMs + t * 1000;
  const piece = footagePieces(sourceFile ? files.filter((f) => f.name === sourceFile) : files, camera, ms, 0.05, rearOffsetSec)[0];
  const file = piece?.file;
  if (!file) return null;
  const src = `/media/${camera}/${file.preview?.name ?? file.name}`;
  return { src, startT: ride.rideTimeAt(fileStartMs(file, rearOffsetSec)), duration: file.duration, file };
}

export function stageSource(file: FootageFile | undefined) {
  return file ? sourceInfo(file) : { w: 3840, h: 2160, bottomStrip: 0.08, originalW: 3840 };
}
