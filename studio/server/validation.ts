import type { Project } from '../src/core/project';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const framing = (v: unknown) => object(v) && finite(v.cx, 0, 1) && finite(v.cy, 0, 1) && finite(v.zoom, 1, 100);
/** Validate before resolving any filesystem path or constructing an FFmpeg filter. */
export function validateProject(v: unknown): asserts v is Project {
  if (!object(v) || v.version !== 1 || typeof v.rideId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(v.rideId)) throw new Error('Invalid project or ride id');
  if (typeof v.name !== 'string' || v.name.length > 200 || !['9x16', '16x9', '1x1', '4x5'].includes(String(v.formatId))
    || !['metric', 'imperial'].includes(String(v.units)) || !framing(v.framing)) throw new Error('Invalid project format, units or framing');
  if (!finite(v.audioLevel, 0, 1) || !finite(v.panelOpacity, 0, 1) || !finite(v.rearOffsetSec, -86400, 86400)) throw new Error('Invalid project levels or camera offset');
  if (!Array.isArray(v.clips) || v.clips.length > 500 || !Array.isArray(v.overlays) || v.overlays.length > 100) throw new Error('Too many clips or overlays');
  let duration = 0;
  for (const c of v.clips) {
    if (!object(c) || !finite(c.duration, Number.MIN_VALUE, 600) || !finite(c.rideStart, -86400, 864000)
      || !['front', 'rear', 'pip'].includes(String(c.camera)) || typeof c.label !== 'string' || c.label.length > 500
      || (c.kind !== undefined && c.kind !== 'photo' && c.kind !== 'video') || (c.framing !== undefined && !framing(c.framing))
      || (c.sourceFile !== undefined && (typeof c.sourceFile !== 'string' || !/^[A-Za-z0-9_-]+\.(MP4|GLV)$/i.test(c.sourceFile)))
      || (c.kind === 'photo' && (typeof c.photoId !== 'string' || !/^[a-f0-9-]{36}$/.test(c.photoId)))) throw new Error('Invalid clip duration, source, camera or framing');
    duration += c.duration as number;
  }
  if (duration > 3600) throw new Error('Export is limited to one hour');
  for (const o of v.overlays) {
    if (!object(o) || typeof o.widgetId !== 'string' || !/^[\w.-]{1,100}$/.test(o.widgetId)
      || !finite(o.nx, -10, 10) || !finite(o.ny, -10, 10) || !finite(o.scale, .1, 10) || !finite(o.opacity, 0, 1)
      || (o.settings !== undefined && !object(o.settings))) throw new Error('Invalid overlay');
    for (const value of Object.values(o.settings ?? {})) if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid overlay setting');
  }
}
