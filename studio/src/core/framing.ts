/**
 * Output formats and source framing (the crop box). Pure geometry so the preview,
 * the editor and the exporter agree on exactly which source pixels are used.
 */
export interface Format {
  id: string;
  label: string;
  w: number;
  h: number;
  /** Platform UI that typically covers parts of the frame (design px). */
  unsafe?: { top: number; bottom: number; right: number };
}

export const FORMATS: Format[] = [
  { id: '9x16', label: '9:16', w: 1080, h: 1920, unsafe: { top: 220, bottom: 420, right: 150 } },
  { id: '16x9', label: '16:9', w: 1920, h: 1080 },
  { id: '1x1', label: '1:1', w: 1080, h: 1080 },
  { id: '4x5', label: '4:5', w: 1080, h: 1350 },
];

export interface Framing {
  /** Crop centre in normalised source coordinates. */
  cx: number;
  cy: number;
  /** 1 = largest crop that fits the safe source area; >1 zooms in. */
  zoom: number;
}

export interface SourceInfo {
  w: number;
  h: number;
  /** Fraction of the source height at the bottom that must never be shown
   *  (Garmin's burned-in strip with date, GPS position and speed). */
  bottomStrip: number;
  /** Width of the original camera file the proxy stands in for. */
  originalW: number;
}

export const GARMIN_VUE: SourceInfo = { w: 1280, h: 720, bottomStrip: 0.045, originalW: 3840 };

export const DEFAULT_FRAMING: Framing = { cx: 0.5, cy: 0.5, zoom: 1 };

/** Crop rectangle in source pixels for a format, clamped inside the safe area. */
export function cropRect(src: SourceInfo, fmt: Format, fr: Framing) {
  const aspect = fmt.w / fmt.h;
  const safeH = src.h * (1 - src.bottomStrip);
  let h = Math.min(safeH, src.w / aspect) / Math.max(1, fr.zoom);
  let w = h * aspect;
  if (w > src.w) {
    w = src.w;
    h = w / aspect;
  }
  const x = Math.min(src.w - w, Math.max(0, fr.cx * src.w - w / 2));
  const y = Math.min(safeH - h, Math.max(0, fr.cy * src.h - h / 2));
  return { x, y, w, h, upscale: fmt.w / ((w * src.originalW) / src.w) };
}
