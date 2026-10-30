/**
 * Street-map engine shared by every family's map widget: OpenStreetMap tiles (via the
 * local cached proxy), the ride track, travelled part, and the rider marker — square or
 * circle, any zoom, north-up or heading-up. Families wrap it in their own frame.
 *
 * Privacy: inside the hidden start/finish zone the marker disappears and the view parks
 * at the edge of the visible route; the hidden part of the track is never drawn.
 */
import { MISSING } from '../core/units';
import { positionAt, routeWorld, tilesIn, TILE } from '../core/mercator';
import type { SettingField, WidgetFrame } from '../core/widget';
import { tileUrl, useAssets } from '../render/assets';
import { url, useSvgIds } from './shared';

export interface OsmSettings extends Record<string, unknown> {
  shape: 'square' | 'circle';
  zoom: number;
  theme: 'standard' | 'dark' | 'muted';
  headingUp: boolean;
  privacyTrimMetres: number;
}

export const OSM_SETTINGS: SettingField[] = [
  { key: 'shape', label: 'Shape', type: 'select', options: [{ value: 'square', label: 'Square' }, { value: 'circle', label: 'Circle' }] },
  { key: 'zoom', label: 'Zoom', type: 'number', min: 11, max: 18.5, step: 0.25 },
  { key: 'theme', label: 'Map style', type: 'select', options: [{ value: 'standard', label: 'Standard' }, { value: 'muted', label: 'Muted' }, { value: 'dark', label: 'Dark' }] },
  { key: 'headingUp', label: 'Heading up', type: 'boolean' },
  { key: 'privacyTrimMetres', label: 'Hide start/finish (m)', type: 'number', min: 0, max: 3000, step: 100 },
];

const THEME_FILTER: Record<OsmSettings['theme'], string | undefined> = {
  standard: undefined,
  muted: 'grayscale(0.85) brightness(1.04) contrast(0.92)',
  dark: 'invert(1) hue-rotate(180deg) brightness(0.82) contrast(0.92) saturate(0.45)',
};

export interface OsmMapProps {
  f: WidgetFrame;
  s: OsmSettings;
  /** Square side in design px; the map is drawn at (x, y). */
  size: number;
  x?: number;
  y?: number;
  radius?: number;
  track: string;
  done: string;
  marker: string;
  markerRing?: string;
}

export function OsmMap({ f, s, size: S, x = 0, y = 0, radius = 28, track, done, marker, markerRing = '#fff' }: OsmMapProps) {
  const id = useSvgIds('clip');
  const { tileBase, tileAttribution, Image } = useAssets();
  const route = routeWorld(f.ride, s.privacyTrimMetres);
  const zoom = Math.min(19, Math.max(2, s.zoom));
  const zi = Math.floor(zoom);
  const k = 2 ** (zoom - zi);
  const Z = 2 ** zi;
  const pos = route && positionAt(f.ride, route, f.t);
  const hdg = f.ride.at('heading', f.t);
  const rot = s.headingUp && Number.isFinite(hdg) ? -hdg : 0;
  const c: [number, number] = pos ? [pos.p[0] * Z, pos.p[1] * Z] : route ? [route.pts[route.from][0] * Z, route.pts[route.from][1] * Z] : [0, 0];
  const R = (S / 2 / k) * (rot ? 1.42 : 1.02);
  const tiles = route ? tilesIn(c[0] - R, c[1] - R, c[0] + R, c[1] + R, zi) : [];

  const path = (a: number, b: number) => {
    if (!route) return '';
    let d = '';
    for (let i = a; i <= b; i++) {
      const [px, py] = route.pts[i];
      d += `${i === a || route.breakBefore[i] ? 'M' : 'L'}${(px * Z).toFixed(1)} ${(py * Z).toFixed(1)}`;
    }
    return d;
  };
  const full = route ? f.ride.memo(`osmFull:${s.privacyTrimMetres}:${zi}`, () => path(route.from, route.to)) : '';
  const travelled = route && pos && !pos.hidden ? `${path(route.from, pos.index)}L${c[0].toFixed(1)} ${c[1].toFixed(1)}` : '';
  const pulse = f.t / 1.6 - Math.floor(f.t / 1.6);
  const arrow = s.headingUp ? 0 : Number.isFinite(hdg) ? hdg : NaN;
  const circle = s.shape === 'circle';

  return (
    <g transform={`translate(${x} ${y})`}>
      <defs>
        <clipPath id={id.clip}>{circle ? <circle cx={S / 2} cy={S / 2} r={S / 2} /> : <rect width={S} height={S} rx={radius} />}</clipPath>
      </defs>
      <g clipPath={url(id.clip)}>
        <rect width={S} height={S} fill={s.theme === 'dark' ? '#1c2026' : '#ebe7df'} />
        <g transform={`translate(${S / 2} ${S / 2}) rotate(${rot}) scale(${k}) translate(${-c[0]} ${-c[1]})`}>
          <g style={{ filter: THEME_FILTER[s.theme] }}>
            {tiles.map((t) => (
              <Image key={`${zi}/${t.x}/${t.y}`} href={tileUrl(tileBase, zi, t.x, t.y)} x={t.x * TILE} y={t.y * TILE} width={TILE + 0.6} height={TILE + 0.6} preserveAspectRatio="none" />
            ))}
          </g>
          <path d={full} fill="none" stroke={track} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={travelled} fill="none" stroke={done} strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
        {pos && !pos.hidden && (
          <g transform={`translate(${S / 2} ${S / 2})`}>
            <circle r={10 + 18 * pulse} fill="none" stroke={marker} strokeWidth="3" opacity={1 - pulse} />
            {Number.isFinite(arrow) ? (
              <path d="M0 -15 L11 11 L0 5 L-11 11 Z" transform={`rotate(${arrow})`} fill={marker} stroke={markerRing} strokeWidth="3" strokeLinejoin="round" />
            ) : (
              <circle r="9" fill={marker} stroke={markerRing} strokeWidth="4" />
            )}
          </g>
        )}
        {pos?.hidden && (
          <text x={S / 2} y={S / 2} textAnchor="middle" fontFamily="'Inter Variable', sans-serif" fontSize="15" fontWeight={600} fill={s.theme === 'dark' ? '#cfd6dc' : '#3b4650'}>Location hidden</text>
        )}
        {!route && <text x={S / 2} y={S / 2} textAnchor="middle" fontSize="15" fill="#888">{s.privacyTrimMetres > 0 && f.ride.has('lat') && f.ride.has('lon') ? 'Location hidden' : `No GPS ${MISSING}`}</text>}
        <g transform={`translate(${S / 2} ${S - (circle ? 26 : 14)})`}>
          <rect x={-S / 2 + 8} y="-11" width={S - 16} height="16" rx="8" fill="rgba(255,255,255,0.72)" />
          <text y="1.5" textAnchor="middle" fontFamily="'Inter Variable', sans-serif" fontSize="10.5" fill="#333">{tileAttribution}</text>
        </g>
      </g>
    </g>
  );
}

/** North arrow for north-up maps. */
export function NorthMark({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="15" fill="rgba(0,0,0,0.45)" />
      <path d="M0 -10 L5 4 L0 1 L-5 4 Z" fill={color} />
      <text y="12" textAnchor="middle" fontFamily="'Inter Variable', sans-serif" fontSize="8" fontWeight={700} fill={color}>N</text>
    </g>
  );
}
