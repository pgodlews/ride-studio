/**
 * Edit project: an ordered list of ride moments (clips) with camera choice and framing,
 * plus one overlay layout. Shared by the editor (preview) and the exporter so both
 * resolve exactly the same source files and offsets.
 */
import type { Framing } from './framing';
import type { UnitSystem } from './units';

export type Camera = 'front' | 'rear';
/** `pip` = front footage with the rear camera inset. */
export type CameraMode = 'front' | 'rear' | 'pip';

export interface OverlayItem {
  uid: string;
  widgetId: string;
  nx: number;
  ny: number;
  scale: number;
  opacity: number;
  settings?: Record<string, unknown>;
}

export interface TimelineClip {
  id: string;
  label: string;
  /** Ride time (s since first record) of the in-point. */
  rideStart: number;
  duration: number;
  camera: CameraMode;
  /** Omitted for legacy video clips. Photos hold rideStart for the whole display. */
  kind?: 'video' | 'photo';
  photoId?: string;
  /** Explicit main-camera source when registered footage overlaps another camera file. */
  sourceFile?: string;
  /** Per-clip crop; falls back to the project framing for the format. */
  framing?: Framing;
  /** Where the clip came from (detector moment), for icons and re-detection. */
  momentId?: string;
  detector?: string;
}

/** Imported still, separate from timed footage and sensor channels. */
export interface PhotoFile {
  id: string;
  rideId: string;
  label: string;
  width: number;
  height: number;
  capturedUtc: string | null;
  captureTime: string | null;
  clockSource: string | null;
  gps: { lat: number; lon: number; altitude: number | null } | null;
  warnings: string[];
}

export const photoUrl = (photo: Pick<PhotoFile, 'id'>) => `/photos/${photo.id}.png`;
export const photoSourceInfo = (photo: Pick<PhotoFile, 'width' | 'height'>) => ({ w: photo.width, h: photo.height, originalW: photo.width, bottomStrip: 0 });

/** Only an offset-bearing EXIF time (or GPS UTC) can suggest a ride-time anchor. */
export function photoRideTime(photo: PhotoFile, rideStartMs: number, rideDuration: number): number | null {
  const t = photo.capturedUtc ? (Date.parse(photo.capturedUtc) - rideStartMs) / 1000 : NaN;
  return Number.isFinite(t) && t >= 0 && t <= rideDuration ? t : null;
}

export interface Project {
  version: 1;
  name: string;
  rideId: string;
  formatId: string;
  units: UnitSystem;
  panelOpacity: number;
  framing: Framing;
  overlays: OverlayItem[];
  clips: TimelineClip[];
  /** Camera audio level 0–1 (filtered, faded at cuts). */
  audioLevel: number;
  /** Extra seconds added to every rear-camera clock (rear sync is unverified). */
  rearOffsetSec: number;
}

/** Subset of the server's footage index the client needs. */
export interface FootageFile {
  brand?: 'garmin' | 'dji' | 'gopro' | 'exif' | 'phone' | 'media';
  /** Imported-in-editor video (see MediaInfo); its start comes from a pin, device offset or clock. */
  mediaId?: string;
  rideId?: string;
  label?: string;
  syncNotice?: string;
  /** Explicit crop for other cameras; Garmin files use the legacy safe margins. */
  bottomStrip?: number;
  camera: Camera;
  name: string;
  createdUtc: string;
  duration: number;
  /** Pixel dimensions after the video display matrix (FFmpeg autorotation). */
  width: number;
  height: number;
  displayWidth: number;
  codec: string;
  audio: string | null;
  preview: { name: string; width: number; height: number; codec: string } | null;
  clockOffsetSec: number;
}

/** How an imported video's playback zero was placed on the activity. */
export type MediaSync = 'pin' | 'device' | 'clock' | 'none';

/** A video imported in the editor, with its sync state; placed ones also appear as footage files. */
export interface MediaInfo {
  id: string;
  rideId: string;
  /** Served alias, e.g. MEDIA-0123456789abcdef.MP4 under /media/front/. */
  name: string;
  label: string;
  duration: number;
  width: number;
  height: number;
  displayWidth: number;
  codec: string;
  audio: string | null;
  /** Camera clock at playback zero, when the file records one. */
  recordedUtc: string | null;
  clockSource: string | null;
  /** Camera make/model; clips sharing it share a clock offset. */
  device: string | null;
  warnings: string[];
  preview: { name: string; width: number; height: number; codec: string } | null;
  detection?: { kind: 'dji' | 'gopro' | 'exif'; by: string; gpsStatus: 'usable' | 'no-usable-fix' | 'absent' | 'unsupported'; gpsSamples: number };
  /** Effective playback-zero UTC, or null while unplaced. */
  startUtc: string | null;
  sync: MediaSync;
  syncNotice: string;
}

/** Ride seconds covered by a placed clip: [start, end] and the fraction inside the activity. */
export function mediaCoverage(m: Pick<MediaInfo, 'startUtc' | 'duration'>, rideStartMs: number, rideDuration: number): { start: number; end: number; inside: number } | null {
  if (!m.startUtc) return null;
  const start = (Date.parse(m.startUtc) - rideStartMs) / 1000;
  const end = start + m.duration;
  const inside = Math.max(0, Math.min(end, rideDuration) - Math.max(start, 0)) / Math.max(1e-6, m.duration);
  return { start, end, inside };
}

export interface FootagePiece {
  file: FootageFile;
  /** Seconds into the source file. */
  srcIn: number;
  duration: number;
  /** Seconds into the clip where this piece starts. */
  at: number;
}

/** UTC ms at which a file's playback position 0 was recorded. */
export function fileStartMs(f: FootageFile, rearOffsetSec = 0): number {
  return Date.parse(f.createdUtc) + (f.clockOffsetSec + (f.camera === 'rear' && (!f.brand || f.brand === 'garmin') ? rearOffsetSec : 0)) * 1000;
}

/** Split a UTC window into per-file pieces for one camera (files are 5–10 min chunks). */
export function footagePieces(files: FootageFile[], camera: Camera, startMs: number, duration: number, rearOffsetSec = 0): FootagePiece[] {
  const out: FootagePiece[] = [];
  const endMs = startMs + duration * 1000;
  let coveredTo = startMs;
  // Earlier recordings win overlaps; file name breaks equal-clock ties reproducibly.
  const list = files.filter((f) => f.camera === camera).sort((a, b) => fileStartMs(a, rearOffsetSec) - fileStartMs(b, rearOffsetSec) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const file of list) {
    const f0 = fileStartMs(file, rearOffsetSec);
    const f1 = f0 + file.duration * 1000;
    const a = Math.max(startMs, f0, coveredTo);
    const b = Math.min(endMs, f1);
    if (b - a <= 0.001) continue; // one microsecond tolerance for UTC floating-point arithmetic
    out.push({ file, srcIn: (a - f0) / 1000, duration: (b - a) / 1000, at: (a - startMs) / 1000 });
    coveredTo = b;
  }
  return out;
}

/** Fraction of a window covered by a camera (0–1). */
export function coverage(files: FootageFile[], camera: Camera, startMs: number, duration: number, rearOffsetSec = 0): number {
  return footagePieces(files, camera, startMs, duration, rearOffsetSec).reduce((s, p) => s + p.duration, 0) / duration;
}

/** Source windows available for manual editing, including clips without telemetry. */
export function sourceWindows(files: FootageFile[], rideStartMs: number, rideDuration: number, rearOffsetSec = 0) {
  return files.flatMap((file) => {
    const playbackZero = (fileStartMs(file, rearOffsetSec) - rideStartMs) / 1000;
    const start = Math.max(0, playbackZero);
    const end = Math.min(rideDuration, playbackZero + file.duration);
    return end - start >= 1 / 30 ? [{ file, start, end }] : [];
  });
}

/** Display geometry of a camera's footage, including the burned-in text strip to hide. */
export function sourceInfo(file: Pick<FootageFile, 'camera' | 'displayWidth' | 'height' | 'bottomStrip' | 'brand'>) {
  return {
    w: file.displayWidth,
    h: file.height,
    // Sized for the GLV previews, whose burned-in strip is relatively larger (front ~7 %, rear two lines ~11 %),
    // so preview framing and export framing are identical and the strip never shows in either.
    bottomStrip: file.bottomStrip ?? (file.brand && file.brand !== 'garmin' ? 0 : file.camera === 'rear' ? 0.125 : 0.08),
    originalW: file.displayWidth,
  };
}

export const totalDuration = (p: Pick<Project, 'clips'>) => p.clips.reduce((s, c) => s + c.duration, 0);

/** Which clip plays at program time `pt`, and the ride time there. */
export function programAt(p: Pick<Project, 'clips'>, pt: number): { index: number; clip: TimelineClip; local: number; rideT: number } | null {
  let acc = 0;
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    if (pt < acc + c.duration || i === p.clips.length - 1) {
      const local = Math.min(c.duration, Math.max(0, pt - acc));
      return { index: i, clip: c, local, rideT: c.rideStart + (c.kind === 'photo' ? 0 : local) };
    }
    acc += c.duration;
  }
  return null;
}
