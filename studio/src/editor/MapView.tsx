/**
 * Editor map view: the whole ride on OpenStreetMap, coloured by speed / gradient / HR.
 * Click the route once for the clip start and again for the end, then add it to the
 * timeline. Detected moments are pins; timeline clips are highlighted and numbered.
 * Drag to pan, scroll to zoom. The private start/finish zone is neither drawn nor clickable.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { detectorById } from '../core/highlights';
import { gradeColor, ZONE_COLORS } from '../core/geometry';
import { positionAt, project, routeWorld, tilesIn, TILE } from '../core/mercator';
import type { PhotoFile, TimelineClip } from '../core/project';
import type { Ride } from '../core/ride';
import { display, pad2, type UnitSystem } from '../core/units';
import type { MomentInfo } from './MomentsPanel';
import { useAssets } from '../render/assets';

export type ColourBy = 'speed' | 'gradient' | 'heartRate';

interface Props {
  ride: Ride;
  units: UnitSystem;
  privacyTrim: number;
  moments: MomentInfo[];
  clips: TimelineClip[];
  playheadT: number;
  /** Current in/out selection (ride seconds). */
  selection: { a: number | null; b: number | null };
  onSelection: (s: { a: number | null; b: number | null }) => void;
  onMoment: (m: MomentInfo) => void;
  photos?: PhotoFile[];
  onPhoto?: (photo: PhotoFile) => void;
  /**
   * Pin mode (time sync): clicks report every pass of the track near the click instead of
   * clip in/out points. The editor shows the full route here (local view, nothing exported).
   */
  pin?: { candidates: number[]; chosen: number | null; onPin: (times: number[]) => void };
}

/** Separate passes merge when the track leaves the click radius for less than this. */
const PASS_GAP_SEC = 30;

const BINS = 12;

export function MapView({ ride, units, privacyTrim, moments, clips, playheadT, selection, onSelection, onMoment, photos = [], onPhoto, pin }: Props) {
  const { tileAttribution } = useAssets();
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const route = routeWorld(ride, privacyTrim, 1);
  const privacyBlocked = privacyTrim > 0 && ride.has('lat') && ride.has('lon') && !route;
  const photoPins = photos.flatMap((photo) => {
    if (!photo.gps) return [];
    if (privacyBlocked) return [];
    const p = project(photo.gps.lat, photo.gps.lon, 0);
    // Keep photos nearest the hidden part of the route off this privacy-trimmed map.
    if (route && privacyTrim > 0) {
      let nearest = 0;
      let best = Infinity;
      route.pts.forEach((point, i) => {
        const d = (point[0] - p[0]) ** 2 + (point[1] - p[1]) ** 2;
        if (d < best) { best = d; nearest = i; }
      });
      if (nearest < route.from || nearest >= route.to) return [];
    }
    return [{ photo, p }];
  });
  const [view, setView] = useState<{ cx: number; cy: number; z: number } | null>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [colour, setColour] = useState<ColourBy>('speed');
  const [muted, setMuted] = useState(true);

  useLayoutEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the visible route on first layout.
  const fit = () => {
    const pts = [...(route?.pts.slice(route.from, route.to + 1) ?? []), ...photoPins.map((pin) => pin.p)];
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const z = Math.log2(Math.min(box.w / Math.max(0.001, (x1 - x0) * 1.15), box.h / Math.max(0.001, (y1 - y0) * 1.15)));
    setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z: Math.min(17, z) });
  };
  if (!view && (route || photoPins.length) && box.w > 100) fit();
  const v = view ?? { cx: 128, cy: 128, z: 2 };

  const zi = Math.max(0, Math.min(19, Math.round(v.z)));
  const k = 2 ** (v.z - zi);
  const Z = 2 ** zi;
  const S = 2 ** v.z; // zoom-0 px → screen px
  const toScreen = (p: [number, number]): [number, number] => [(p[0] - v.cx) * S + box.w / 2, (p[1] - v.cy) * S + box.h / 2];
  const R = { x: box.w / 2 / k, y: box.h / 2 / k };
  const tiles = privacyBlocked ? [] : tilesIn(v.cx * Z - R.x, v.cy * Z - R.y, v.cx * Z + R.x, v.cy * Z + R.y, zi);

  // Colour bins: one path per bin keeps thousands of segments cheap to draw.
  const values = useMemo(() => {
    if (!route) return [];
    const id = colour === 'speed' ? 'speed' : colour === 'gradient' ? 'gradient' : 'heartRate';
    return route.t.map((t) => ride.at(id, t));
  }, [route, ride, colour]);
  const [vmin, vmax] = useMemo(() => {
    const f = values.filter(Number.isFinite);
    return colour === 'gradient' ? [-10, 10] : [Math.min(...f), Math.max(...f)];
  }, [values, colour]);
  const colourOf = (x: number, bin?: number) => {
    if (colour === 'gradient') return gradeColor(x);
    if (colour === 'heartRate') return ZONE_COLORS[ride.hrZone(x)?.zone ?? 0];
    const f = bin !== undefined ? bin / (BINS - 1) : Math.max(0, Math.min(1, (x - vmin) / (vmax - vmin)));
    return `hsl(${190 - f * 190} 90% 52%)`;
  };
  const segPaths = useMemo(() => {
    if (!route) return [];
    const bins = new Map<string, string>();
    for (let i = route.from; i < route.to; i++) {
      if (route.breakBefore[i + 1]) continue;
      const x = values[i];
      let key: string;
      if (colour === 'speed') {
        const f = Number.isFinite(x) ? Math.max(0, Math.min(1, (x - vmin) / (vmax - vmin))) : 0;
        key = colourOf(x, Math.round(f * (BINS - 1)));
      } else key = colourOf(x);
      const [ax, ay] = route.pts[i];
      const [bx, by] = route.pts[i + 1];
      bins.set(key, `${bins.get(key) ?? ''}M${(ax * Z).toFixed(1)} ${(ay * Z).toFixed(1)}L${(bx * Z).toFixed(1)} ${(by * Z).toFixed(1)}`);
    }
    return [...bins.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, values, Z, colour, vmin, vmax]);

  const rangePath = (t0: number, t1: number) => {
    if (!route) return '';
    let d = '';
    for (let i = route.from; i <= route.to; i++) {
      if (route.t[i] < t0 || route.t[i] > t1) continue;
      const [x, y] = route.pts[i];
      d += `${d && !route.breakBefore[i] ? 'L' : 'M'}${(x * Z).toFixed(1)} ${(y * Z).toFixed(1)}`;
    }
    return d;
  };

  const nearest = (sx: number, sy: number): number | null => {
    if (!route) return null;
    let best = -1;
    let bd = 16 * 16;
    for (let i = route.from; i <= route.to; i++) {
      const [x, y] = toScreen(route.pts[i]);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  };

  /** Ride times of each separate pass within 24 px of a screen point, closest point per pass. */
  const passesNear = (sx: number, sy: number): number[] => {
    if (!route) return [];
    const runs: { i: number; d: number; last: number }[] = [];
    for (let i = route.from; i <= route.to; i++) {
      const [x, y] = toScreen(route.pts[i]);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d > 24 * 24) continue;
      const run = runs[runs.length - 1];
      if (run && !route.breakBefore[i] && route.t[i] - route.t[run.last] < PASS_GAP_SEC) {
        run.last = i;
        if (d < run.d) { run.d = d; run.i = i; }
      } else runs.push({ i, d, last: i });
    }
    return runs.map((r) => route.t[r.i]);
  };

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const sel = selection;
  const lo = sel.a !== null && sel.b !== null ? Math.min(sel.a, sel.b) : sel.a;
  const hi = sel.a !== null && sel.b !== null ? Math.max(sel.a, sel.b) : null;
  const clock = (t: number) => {
    const lt = ride.localTime(t);
    return `${pad2(lt.h)}:${pad2(lt.m)}:${pad2(lt.s)}`;
  };
  const marker = (t: number) => (route ? positionAt(ride, route, t) : null);
  const head = Number.isFinite(playheadT) ? marker(playheadT) : null;
  const tw = (t: number) => {
    const p = marker(t);
    return p && !p.hidden ? toScreen(p.p) : null;
  };

  return (
    <div className="mapview" ref={host}
      onWheel={(e) => {
        const [sx, sy] = local(e);
        const z = Math.max(3, Math.min(19, v.z - e.deltaY * 0.0025));
        const s0 = 2 ** v.z;
        const s1 = 2 ** z;
        const wx = v.cx + (sx - box.w / 2) / s0;
        const wy = v.cy + (sy - box.h / 2) / s0;
        setView({ z, cx: wx - (sx - box.w / 2) / s1, cy: wy - (sy - box.h / 2) / s1 });
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, cx: v.cx, cy: v.cy, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && e.buttons) {
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (d.moved) setView({ ...v, cx: d.cx - dx / S, cy: d.cy - dy / S });
          return;
        }
        const [sx, sy] = local(e);
        const i = nearest(sx, sy);
        setHover(i === null ? null : { i, x: sx, y: sy });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved) return;
        const [sx, sy] = local(e);
        if (pin) {
          const times = passesNear(sx, sy);
          if (times.length) pin.onPin(times);
          return;
        }
        const i = nearest(sx, sy);
        if (i === null || !route) return;
        const t = route.t[i];
        if (sel.a === null || sel.b !== null) onSelection({ a: t, b: null });
        else onSelection({ a: sel.a, b: t });
      }}>
      <svg width={box.w} height={box.h}>
        <g transform={`translate(${box.w / 2} ${box.h / 2}) scale(${k}) translate(${-v.cx * Z} ${-v.cy * Z})`}>
          <g style={{ filter: muted ? 'grayscale(0.8) brightness(1.05) contrast(0.9)' : undefined }}>
            {tiles.map((t) => <image key={`${zi}/${t.x}/${t.y}`} href={`/tiles/${zi}/${t.x}/${t.y}.png`} x={t.x * TILE} y={t.y * TILE} width={TILE + 0.6} height={TILE + 0.6} />)}
          </g>
          {clips.filter((c) => c.kind !== 'photo').map((c) => <path key={c.id} d={rangePath(c.rideStart, c.rideStart + c.duration)} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
          {segPaths.map(([col, d]) => <path key={col} d={d} stroke={col} strokeWidth={5} strokeLinecap="round" fill="none" vectorEffect="non-scaling-stroke" />)}
          {lo !== null && hi !== null && <path d={rangePath(lo, hi)} fill="none" stroke="#5bebf8" strokeWidth={11} strokeOpacity={0.85} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        </g>
        {clips.map((c, n) => {
          if (c.kind === 'photo') return null;
          const p = tw(c.rideStart);
          return p && (
            <g key={c.id} transform={`translate(${p[0]} ${p[1]})`}>
              <circle r="11" fill="#fff" stroke="#0a0d11" strokeWidth="2" />
              <text y="4" textAnchor="middle" fontSize="11" fontWeight={700} fill="#0a0d11">{n + 1}</text>
            </g>
          );
        })}
        {photoPins.map(({ photo, p }) => {
          const [x, y] = toScreen(p);
          return <g key={photo.id} className="pin" transform={`translate(${x} ${y})`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPhoto?.(photo)}>
            <title>{`${photo.label} · EXIF GPS · click to preview`}</title>
            <rect x="-13" y="-11" width="26" height="22" rx="4" fill="#11161c" stroke="#5bebf8" strokeWidth="2" />
            <text y="5" textAnchor="middle" fontSize="16" fill="#5bebf8">▧</text>
          </g>;
        })}
        {pin?.candidates.map((t, n) => {
          const p = tw(t);
          const on = pin.chosen === t;
          return p && (
            <g key={`pass${t}`} transform={`translate(${p[0]} ${p[1]})`}>
              <circle r={on ? 12 : 10} fill={on ? '#5bebf8' : '#11161c'} stroke={on ? '#0a0d11' : '#5bebf8'} strokeWidth="2.5" />
              <text y="4" textAnchor="middle" fontSize="11" fontWeight={700} fill={on ? '#0a0d11' : '#5bebf8'}>{n + 1}</text>
            </g>
          );
        })}
        {!pin && moments.filter((m) => m.rank <= 2 && !m.privacy).map((m) => {
          const p = tw(m.peakT);
          return p && (
            <g key={m.id} className="pin" transform={`translate(${p[0]} ${p[1] - 18})`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onMoment(m)}>
              <title>{`${m.label}: ${m.detail}`}</title>
              <path d="M0 18 L-7 6 A10 10 0 1 1 7 6 Z" fill="#11161c" stroke="#e9eff3" strokeWidth="1.5" />
              <text y="3" textAnchor="middle" fontSize="11" fill="#e9eff3">{detectorById(m.detector)?.icon}</text>
            </g>
          );
        })}
        {!pin && [sel.a, sel.b].map((t, j) => {
          const p = t !== null ? tw(t) : null;
          return p && <circle key={j} cx={p[0]} cy={p[1]} r="8" fill={j ? '#ff5a5a' : '#5bebf8'} stroke="#0a0d11" strokeWidth="3" />;
        })}
        {head && !head.hidden && (() => {
          const [x, y] = toScreen(head.p);
          return <circle cx={x} cy={y} r="7" fill="#fff" stroke="#0a0d11" strokeWidth="3" />;
        })()}
      </svg>
      {privacyBlocked && <div className="map-tip">Location hidden</div>}

      <div className="map-tools" onPointerDown={(e) => e.stopPropagation()}>
        <div className="group seg">
          {(['speed', 'gradient', 'heartRate'] as const).map((c) => <button key={c} className={colour === c ? 'on' : ''} onClick={() => setColour(c)}>{c === 'heartRate' ? 'HR zone' : c}</button>)}
        </div>
        <label className="check"><input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} /> Muted map</label>
        <button className="link" onClick={fit}>Fit route / photos</button>
      </div>
      {colour === 'speed' && (
        <div className="map-legend">
          <span>{display('speed', vmin, units, 0).text}</span>
          <div style={{ background: `linear-gradient(90deg, ${Array.from({ length: 6 }, (_, i) => `hsl(${190 - (i / 5) * 190} 90% 52%)`).join(',')})` }} />
          <span>{`${display('speed', vmax, units, 0).text} ${display('speed', 0, units).unit}`}</span>
        </div>
      )}
      {hover && route && !drag.current?.moved && (() => {
        const t = route.t[hover.i];
        return (
          <div className="map-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <strong>{clock(t)}</strong>
            <span>{`${display('speed', ride.at('speed', t), units).text} ${display('speed', 0, units).unit} · ${display('heartRate', ride.at('heartRate', t), units).text} bpm · ${display('percent', ride.at('gradient', t), units).text}%`}</span>
            <em>{pin ? 'Click where the current frame was filmed' : sel.a === null || sel.b !== null ? 'Click to set clip start' : 'Click to set clip end'}</em>
          </div>
        );
      })()}
      <div className="map-attrib">{tileAttribution}</div>
    </div>
  );
}
