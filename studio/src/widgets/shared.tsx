/** Helpers shared by every widget family. */
import { useId, type ReactNode, type SVGProps } from 'react';
import { CHANNELS, type ChannelId } from '../core/channels';
import { display, type Display } from '../core/units';
import type { WidgetFrame } from '../core/widget';

/** Root SVG: fixed design viewBox, scales to whatever box the host gives it. */
export function Svg({ w, h, children, ...rest }: { w: number; h: number; children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" overflow="visible" xmlns="http://www.w3.org/2000/svg" {...rest}>
      {children}
    </svg>
  );
}

/** Stable, url()-safe ids for SVG defs (many widget instances share a page). */
export function useSvgIds<K extends string>(...names: K[]): Record<K, string> {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return Object.fromEntries(names.map((n) => [n, `${base}${n}`])) as Record<K, string>;
}

export const url = (id: string) => `url(#${id})`;

/** Read a channel at the frame time and format it for display. */
export function read(f: WidgetFrame, id: ChannelId, decimals?: number): Display & { si: number } {
  const si = f.ride.at(id, f.t);
  return { ...display(CHANNELS[id].quantity, si, f.units, decimals), si };
}

/** Trailing window of a channel (oldest → newest), e.g. for sparklines and comet tails. */
export function trailing(f: WidgetFrame, id: ChannelId, seconds: number, count: number): Float64Array {
  return f.ride.series(id, f.t - seconds, f.t, count);
}

/** Signed text for gradients: "+6.2", "−3.0", "0.0". */
export function signed(text: string, value: number): string {
  if (!Number.isFinite(value) || /^0(\.0+)?$/.test(text)) return text;
  return value > 0 ? `+${text}` : `−${text.replace('-', '')}`;
}

/** Stylised PQRST pulse shape for a beat phase in [0,1); an animation, not ECG data. */
export function pulseShape(p: number): number {
  const g = (c: number, w: number, a: number) => a * Math.exp(-((p - c) ** 2) / (2 * w * w));
  return g(0.12, 0.025, 0.12) - g(0.21, 0.008, 0.18) + g(0.235, 0.012, 1) - g(0.265, 0.01, 0.32) + g(0.45, 0.045, 0.24);
}

/** Pulse envelope for icons: quick swell on each beat, decays before the next. */
export function beatScale(beats: number, amount = 0.16): number {
  if (!Number.isFinite(beats)) return 1;
  const p = beats - Math.floor(beats);
  return 1 + amount * Math.exp(-p * 7) * Math.min(1, p * 30);
}

/** Heart outline centred on (0,0), ~2·s wide. */
export function heartPath(s: number): string {
  const pts: string[] = [];
  for (let k = 0; k <= 60; k++) {
    const a = (k / 60) * Math.PI * 2;
    const x = 16 * Math.sin(a) ** 3;
    const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
    pts.push(`${((x / 16) * s).toFixed(2)} ${((-y / 16) * s + s * 0.1).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}
