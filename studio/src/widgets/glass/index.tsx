/**
 * Refined glass — evolution of the first edit's HUD: translucent graphite panels,
 * hairline borders, tracked small-caps labels, tabular Inter numerals, one accent per metric.
 */
import type { ReactNode } from 'react';
import { arc, areaPath, clamp, buildProfile, frac, linePath, polar, projectRoute, routePoints, routePosition, ZONE_COLORS, ZONE_NAMES } from '../../core/geometry';
import { movingAt, splitAt, summitFrame } from '../../core/activity';
import { display, formatDuration, grouped, MISSING, pad2, type Display } from '../../core/units';
import { defineWidget, type FamilyInfo, type WidgetFrame } from '../../core/widget';
import { beatScale, heartPath, read, signed, Svg, trailing, url, useSvgIds } from '../shared';
import { avgPace, cardinal, Foot, footfall, MOVING_SETTINGS, paceTrail, ribbonTicks, splitRows, splitText, STEP_SETTINGS, stepsAt } from '../foot';
import { NorthMark, OSM_SETTINGS, OsmMap, type OsmSettings } from '../osm';

export const family: FamilyInfo = { id: 'glass', name: 'Refined glass', tagline: 'Translucent graphite, hairlines, calm precision.' };

const FONT = "'Inter Variable', Inter, system-ui, sans-serif";
const INK = '#F4F9FB';
const MUTED = '#A8BDC8';
const A = {
  speed: '#5BEBF8', hr: '#FF7089', cadence: '#BDEF7C', elevation: '#FFCB78', temp: '#FF9F6E',
  distance: '#A9B8FF', time: '#E6EEF2', resp: '#8FE3C8', map: '#5BEBF8',
};

function Panel({ w, h, o, accent, r = 28 }: { w: number; h: number; o: number; accent: string; r?: number }) {
  const id = useSvgIds('sheen');
  return (
    <g>
      <defs>
        <linearGradient id={id.sheen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity={0.07 * o} />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width={w - 2} height={h - 2} rx={r} fill={`rgba(10,20,27,${o})`} />
      <rect x="1" y="1" width={w - 2} height={h - 2} rx={r} fill={url(id.sheen)} />
      <rect x="1" y="1" width={w - 2} height={h - 2} rx={r} fill="none" stroke="rgba(213,243,255,0.2)" strokeWidth="1.5" />
      {r < h / 2 && <rect x={r + 6} y="0" width="64" height="4" rx="2" fill={accent} />}
    </g>
  );
}

function Label({ x, y, children, color, size = 17, anchor }: { x: number; y: number; children: ReactNode; color: string; size?: number; anchor?: 'end' | 'middle' }) {
  return (
    <text x={x} y={y} fill={color} fontFamily={FONT} fontSize={size} fontWeight={650} letterSpacing={size * 0.22} textAnchor={anchor}>
      {children}
    </text>
  );
}

function Value({ x, y, size, text, unit, unitColor = MUTED, anchor }: { x: number; y: number; size: number; text: string; unit?: string; unitColor?: string; anchor?: 'end' | 'middle' }) {
  return (
    <text x={x} y={y} fill={INK} fontFamily={FONT} fontWeight={620} fontSize={size} letterSpacing={-size * 0.035} textAnchor={anchor} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {text}
      {unit && (
        <tspan dx={size * 0.12} fontSize={size * 0.3} fontWeight={500} fill={unitColor} letterSpacing={0}>
          {unit}
        </tspan>
      )}
    </text>
  );
}

/** Compact "icon + label / big value" tile used by several metrics. */
function Tile({ f, w = 330, h = 170, accent, label, icon, text, unit, footer }: {
  f: WidgetFrame; w?: number; h?: number; accent: string; label: string; icon: ReactNode; text: string; unit: string; footer?: ReactNode;
}) {
  return (
    <Svg w={w} h={h}>
      <Panel w={w} h={h} o={f.panelOpacity} accent={accent} />
      <g transform="translate(46 56)">{icon}</g>
      <Label x={78} y={62} color={accent}>{label}</Label>
      <Value x={30} y={footer ? 132 : 142} size={78} text={text} unit={unit} />
      {footer}
    </Svg>
  );
}

const speed = defineWidget({
  id: 'speed.glass', metric: 'speed', family: 'glass', name: 'Speed + 30 s trace',
  requires: ['speed'], size: { w: 540, h: 230 },
  defaults: { traceSeconds: 30 },
  settings: [{ key: 'traceSeconds', label: 'Trace length (s)', type: 'number', min: 10, max: 120, step: 5 }],
  Component: (f) => {
    const id = useSvgIds('fill');
    const v = read(f, 'speed');
    const n = 60;
    const trail = trailing(f, 'speed', f.settings.traceSeconds, n);
    const max = Math.max(1, f.ride.extent('speed')[1]);
    const [x0, x1, y0, y1] = [312, 508, 70, 178];
    const pts = Array.from(trail, (s, k) => [x0 + ((x1 - x0) * k) / (n - 1), y1 - (y1 - y0) * clamp(s / max, 0, 1)] as [number, number]);
    const end = pts[n - 1];
    return (
      <Svg w={540} h={230}>
        <defs>
          <linearGradient id={id.fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={A.speed} stopOpacity="0.32" />
            <stop offset="1" stopColor={A.speed} stopOpacity="0" />
          </linearGradient>
        </defs>
        <Panel w={540} h={230} o={f.panelOpacity} accent={A.speed} />
        <Label x={34} y={58} color={A.speed}>SPEED</Label>
        <Label x={x0} y={58} color={MUTED} size={14}>{`${f.settings.traceSeconds} SEC`}</Label>
        <Value x={28} y={168} size={118} text={v.text} />
        <Label x={36} y={205} color={A.speed} size={18}>{v.unit.toUpperCase()}</Label>
        {[y0, (y0 + y1) / 2, y1].map((y) => <line key={y} x1={x0} x2={x1} y1={y} y2={y} stroke="rgba(213,243,255,0.12)" />)}
        <path d={areaPath(pts, y1)} fill={url(id.fill)} />
        <path d={linePath(pts)} fill="none" stroke={A.speed} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {Number.isFinite(end[1]) && (
          <g>
            <circle cx={end[0]} cy={end[1]} r="11" fill={A.speed} opacity="0.25" />
            <circle cx={end[0]} cy={end[1]} r="5.5" fill={A.speed} />
          </g>
        )}
        <Label x={x1} y={205} color={MUTED} size={13} anchor="end">{`MAX ${display('speed', max, f.units).text}`}</Label>
      </Svg>
    );
  },
});

const heartRate = defineWidget({
  id: 'heartRate.glass', metric: 'heartRate', family: 'glass', name: 'Pulse tile',
  requires: ['heartRate'], size: { w: 330, h: 170 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const s = beatScale(f.ride.at('heartBeats', f.t));
    const z = f.ride.hrZone(v.si);
    return (
      <Tile f={f} accent={A.hr} label="HEART RATE" text={v.text} unit={v.unit}
        icon={<path d={heartPath(15)} transform={`translate(0 -6) scale(${s})`} fill={A.hr} />}
        footer={z && (
          <g transform="translate(30 150)">
            {[1, 2, 3, 4, 5].map((k) => (
              <rect key={k} x={(k - 1) * 54} y="0" width="48" height="5" rx="2.5" fill={ZONE_COLORS[k]} opacity={k === z.zone ? 1 : 0.22} />
            ))}
          </g>
        )} />
    );
  },
});

function CrankIcon({ angle, color }: { angle: number; color: string }) {
  const [x, y] = polar(0, -6, 15, angle);
  const [x2, y2] = polar(0, -6, 15, angle + 180);
  return (
    <g stroke={color} strokeWidth="3" strokeLinecap="round" fill="none">
      <circle cx="0" cy="-6" r="11" />
      <line x1={x2} y1={y2} x2={x} y2={y} />
      <line x1={x - 5} y1={y} x2={x + 5} y2={y} />
      <line x1={x2 - 5} y1={y2} x2={x2 + 5} y2={y2} />
    </g>
  );
}

const cadence = defineWidget({
  id: 'cadence.glass', metric: 'cadence', family: 'glass', name: 'Crank tile',
  requires: ['cadence'], size: { w: 330, h: 170 },
  Component: (f) => {
    const v = read(f, 'cadence');
    const angle = frac(f.ride.at('crankRevs', f.t) || 0) * 360;
    return <Tile f={f} accent={A.cadence} label="CADENCE" text={v.text} unit={v.unit} icon={<CrankIcon angle={angle} color={A.cadence} />} />;
  },
});

const mountain = (c: string) => <path d="M-17 6 L-5 -14 L2 -4 L7 -10 L18 6 Z" fill="none" stroke={c} strokeWidth="3" strokeLinejoin="round" />;

const elevation = defineWidget({
  id: 'elevation.glass', metric: 'elevation', family: 'glass', name: 'Elevation + gain',
  requires: ['altitude'], size: { w: 330, h: 170 },
  Component: (f) => {
    const v = read(f, 'altitude');
    const gain = read(f, 'ascent');
    return (
      <Tile f={f} accent={A.elevation} label="ELEVATION" text={v.text} unit={v.unit} icon={mountain(A.elevation)}
        footer={<Label x={32} y={156} color={MUTED} size={14}>{`▲ ${gain.text} ${gain.unit.toUpperCase()} CLIMBED`}</Label>} />
    );
  },
});

const temperature = defineWidget({
  id: 'temperature.glass', metric: 'temperature', family: 'glass', name: 'Thermometer tile',
  requires: ['temperature'], size: { w: 270, h: 170 },
  Component: (f) => {
    const v = read(f, 'temperature');
    return (
      <Tile f={f} w={270} accent={A.temp} label="TEMP" text={v.text} unit={v.unit}
        icon={<g fill="none" stroke={A.temp} strokeWidth="3"><rect x="-4" y="-22" width="8" height="20" rx="4" /><circle cx="0" cy="4" r="7" fill={A.temp} /></g>} />
    );
  },
});

const distance = defineWidget({
  id: 'distance.glass', metric: 'distance', family: 'glass', name: 'Distance + progress',
  requires: ['distance'], size: { w: 360, h: 170 },
  Component: (f) => {
    const v = read(f, 'distance', 1);
    const total = f.ride.extent('distance')[1];
    const p = clamp(v.si / total, 0, 1) || 0;
    return (
      <Tile f={f} w={360} accent={A.distance} label="DISTANCE" text={v.text} unit={v.unit}
        icon={<g fill="none" stroke={A.distance} strokeWidth="3" strokeLinecap="round"><path d="M-16 4 C-8 -14 8 6 16 -12" /><circle cx="-16" cy="4" r="3" fill={A.distance} /></g>}
        footer={<g>
          <rect x="30" y="148" width="300" height="5" rx="2.5" fill="rgba(213,243,255,0.14)" />
          <rect x="30" y="148" width={300 * p} height="5" rx="2.5" fill={A.distance} />
          <Label x={330} y={136} color={MUTED} size={13} anchor="end">{`/ ${display('distance', total, f.units, 1).text}`}</Label>
        </g>} />
    );
  },
});

const time = defineWidget({
  id: 'time.glass', metric: 'time', family: 'glass', name: 'Clock + elapsed',
  requires: [], size: { w: 360, h: 170 },
  Component: (f) => {
    const lt = f.ride.localTime(f.t);
    return (
      <Svg w={360} h={170}>
        <Panel w={360} h={170} o={f.panelOpacity} accent={A.time} />
        <Label x={34} y={58} color={MUTED}>{`${lt.label} TIME`}</Label>
        <Value x={30} y={126} size={70} text={`${pad2(lt.h)}:${pad2(lt.m)}`} unit={`:${pad2(lt.s)}`} />
        <Label x={34} y={154} color={MUTED} size={14}>{`ELAPSED ${formatDuration(f.t)}`}</Label>
      </Svg>
    );
  },
});

const respiration = defineWidget({
  id: 'respiration.glass', metric: 'respiration', family: 'glass', name: 'Breath wave',
  requires: ['respiration'], size: { w: 330, h: 170 },
  Component: (f) => {
    const v = read(f, 'respiration');
    const ph = f.ride.at('breaths', f.t);
    const pts = Array.from({ length: 25 }, (_, k) => [-18 + k * 1.5, -6 + 8 * Math.sin((k / 24) * Math.PI * 2 - (ph || 0) * Math.PI * 2)] as [number, number]);
    return (
      <Tile f={f} accent={A.resp} label="RESPIRATION" text={v.text} unit={v.unit}
        icon={<path d={linePath(pts)} fill="none" stroke={A.resp} strokeWidth="3" strokeLinecap="round" />}
        footer={<Label x={32} y={156} color={MUTED} size={12}>GARMIN ESTIMATE</Label>} />
    );
  },
});

const gradient = defineWidget({
  id: 'gradient.glass', metric: 'gradient', family: 'glass', name: 'Slope tile',
  requires: ['gradient'], size: { w: 300, h: 170 },
  Component: (f) => {
    const v = read(f, 'gradient');
    const ang = Math.atan((v.si || 0) / 100) * 3; // exaggerated ×3 so small grades read
    const dx = 20 * Math.cos(ang);
    const dy = 20 * Math.sin(ang);
    return (
      <Tile f={f} w={300} accent={A.elevation} label="GRADIENT" text={signed(v.text, v.si)} unit="%"
        icon={<g stroke={A.elevation} strokeWidth="3" strokeLinecap="round" fill="none"><line x1={-dx} y1={dy - 4} x2={dx} y2={-dy - 4} /><line x1="-20" y1="10" x2="20" y2="10" opacity="0.4" /></g>} />
    );
  },
});

const hrZone = defineWidget({
  id: 'hrZone.glass', metric: 'hrZone', family: 'glass', name: 'Zone bar',
  requires: ['heartRate'], size: { w: 470, h: 180 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const z = f.ride.hrZone(v.si);
    const segW = 78;
    return (
      <Svg w={470} h={180}>
        <Panel w={470} h={180} o={f.panelOpacity} accent={z ? ZONE_COLORS[z.zone] : MUTED} />
        <Label x={34} y={56} color={MUTED}>HEART-RATE ZONE</Label>
        <Value x={30} y={120} size={64} text={z ? `Z${z.zone}` : MISSING} />
        <text x={130} y={120} fill={z ? ZONE_COLORS[z.zone] : MUTED} fontFamily={FONT} fontSize={30} fontWeight={600}>{z ? ZONE_NAMES[z.zone] : ''}</text>
        <Value x={436} y={120} size={34} text={v.text} unit="bpm" anchor="end" />
        {[1, 2, 3, 4, 5].map((k) => {
          const x = 30 + (k - 1) * (segW + 4);
          const on = z?.zone === k;
          return (
            <g key={k}>
              <rect x={x} y={142} width={segW} height={12} rx={6} fill={ZONE_COLORS[k]} opacity={on ? 1 : z && k < z.zone ? 0.55 : 0.18} />
              {on && <path d={`M${x + segW * z.position - 7} 168 l7 -9 l7 9 Z`} fill={INK} />}
            </g>
          );
        })}
      </Svg>
    );
  },
});

const elevationProfile = defineWidget({
  id: 'elevationProfile.glass', metric: 'elevationProfile', family: 'glass', name: 'Ride profile',
  requires: ['altitude', 'distance'], size: { w: 580, h: 230 },
  Component: (f) => {
    const id = useSvgIds('past', 'clipPast');
    const prof = buildProfile(f.ride);
    const [d0, d1] = f.ride.extent('distance');
    const [a0, a1] = f.ride.extent('altitude');
    const [x0, x1, y0, y1] = [30, 550, 80, 190];
    const X = (d: number) => x0 + ((x1 - x0) * (d - d0)) / (d1 - d0);
    const Y = (a: number) => y1 - ((y1 - y0) * (a - a0)) / Math.max(1, a1 - a0);
    const pts = prof.map((p) => [X(p.d), Y(p.alt)] as [number, number]);
    const dNow = f.ride.at('distance', f.t);
    const aNow = f.ride.at('altitude', f.t);
    const cx = Number.isFinite(dNow) ? X(dNow) : x0;
    const alt = read(f, 'altitude');
    return (
      <Svg w={580} h={230}>
        <defs>
          <linearGradient id={id.past} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={A.elevation} stopOpacity="0.45" />
            <stop offset="1" stopColor={A.elevation} stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={id.clipPast}><rect x="0" y="0" width={cx} height="230" /></clipPath>
        </defs>
        <Panel w={580} h={230} o={f.panelOpacity} accent={A.elevation} />
        <Label x={34} y={56} color={A.elevation}>ELEVATION PROFILE</Label>
        <Value x={546} y={60} size={38} text={alt.text} unit={alt.unit} anchor="end" />
        <path d={areaPath(pts, y1)} fill="rgba(213,243,255,0.06)" />
        <path d={linePath(pts)} fill="none" stroke="rgba(213,243,255,0.35)" strokeWidth="2" />
        <g clipPath={url(id.clipPast)}>
          <path d={areaPath(pts, y1)} fill={url(id.past)} />
          <path d={linePath(pts)} fill="none" stroke={A.elevation} strokeWidth="3" strokeLinejoin="round" />
        </g>
        {Number.isFinite(aNow) && (
          <g>
            <line x1={cx} x2={cx} y1={Y(aNow)} y2={y1} stroke={INK} strokeWidth="1.5" strokeDasharray="3 4" />
            <circle cx={cx} cy={Y(aNow)} r="12" fill={A.elevation} opacity="0.25" />
            <circle cx={cx} cy={Y(aNow)} r="6" fill={INK} stroke={A.elevation} strokeWidth="3" />
          </g>
        )}
        <Label x={x0} y={214} color={MUTED} size={12}>0</Label>
        <Label x={x1} y={214} color={MUTED} size={12} anchor="end">{`${display('distance', d1, f.units, 1).text} ${display('distance', d1, f.units).unit.toUpperCase()}`}</Label>
      </Svg>
    );
  },
});

const map = defineWidget({
  id: 'map.glass', metric: 'map', family: 'glass', name: 'Minimap',
  requires: ['lat', 'lon'], size: { w: 320, h: 320 },
  defaults: { privacyTrimMetres: 500 },
  settings: [{ key: 'privacyTrimMetres', label: 'Hide start/finish (m)', type: 'number', min: 0, max: 3000, step: 100 }],
  Component: (f) => {
    const route = projectRoute(f.ride, f.settings.privacyTrimMetres);
    const pad = 40;
    const S = 320 - pad * 2;
    const P = (p: [number, number]) => [pad + p[0] * S, pad + p[1] * S] as [number, number];
    const pos = route && routePosition(route, f.t);
    const shown = route ? routePoints(route, route.shownFrom, route.shownTo).map(P) : [];
    const done = route && pos ? [...routePoints(route, route.shownFrom, pos.index).map(P), P(pos.pt)] : [];
    const pulse = frac(f.t / 1.6);
    return (
      <Svg w={320} h={320}>
        <Panel w={320} h={320} o={f.panelOpacity} accent={A.map} r={36} />
        <Label x={34} y={52} color={A.map} size={15}>ROUTE</Label>
        <g transform="translate(282 44)" fill={MUTED}>
          <path d="M0 -12 L6 6 L0 2 L-6 6 Z" />
          <text y="22" textAnchor="middle" fontFamily={FONT} fontSize="11" fontWeight={700}>N</text>
        </g>
        <path d={linePath(shown)} fill="none" stroke="rgba(213,243,255,0.32)" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath(done)} fill="none" stroke={A.map} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
        {pos && (() => {
          const [x, y] = P(pos.pt);
          return (
            <g>
              <circle cx={x} cy={y} r={9 + 16 * pulse} fill="none" stroke={A.map} strokeWidth="2" opacity={1 - pulse} />
              <circle cx={x} cy={y} r="8" fill={INK} stroke={A.map} strokeWidth="4" />
            </g>
          );
        })()}
      </Svg>
    );
  },
});

/** Arc meter variant for speed: a lighter alternative within the same family. */
const speedArc = defineWidget({
  id: 'speed.glass-arc', metric: 'speed', family: 'glass', name: 'Speed arc',
  requires: ['speed'], size: { w: 300, h: 300 },
  Component: (f) => {
    const v = read(f, 'speed');
    const max = Math.ceil((display('speed', f.ride.extent('speed')[1], f.units).value || 1) / 10) * 10;
    const p = clamp(v.value / max, 0, 1) || 0;
    return (
      <Svg w={300} h={300}>
        <Panel w={300} h={300} o={f.panelOpacity} accent={A.speed} r={150} />
        <path d={arc(150, 150, 118, -135, 135)} fill="none" stroke="rgba(213,243,255,0.14)" strokeWidth="10" strokeLinecap="round" />
        {p > 0 && <path d={arc(150, 150, 118, -135, -135 + 270 * p)} fill="none" stroke={A.speed} strokeWidth="10" strokeLinecap="round" />}
        <Label x={150} y={102} color={A.speed} anchor="middle" size={15}>SPEED</Label>
        <Value x={150} y={182} size={84} text={v.text} anchor="middle" />
        <Label x={150} y={222} color={MUTED} anchor="middle" size={15}>{v.unit.toUpperCase()}</Label>
      </Svg>
    );
  },
});

const streetMap = defineWidget<OsmSettings>({
  id: 'streetMap.glass', metric: 'streetMap', family: 'glass', name: 'Street map',
  requires: ['lat', 'lon'], size: { w: 360, h: 360 },
  defaults: { shape: 'square', zoom: 15.5, theme: 'muted', headingUp: false, privacyTrimMetres: 500 },
  settings: OSM_SETTINGS,
  Component: (f) => {
    const s = f.settings;
    const circle = s.shape === 'circle';
    const frame = { fill: 'none', stroke: `rgba(10,20,27,${0.25 + 0.75 * f.panelOpacity})`, strokeWidth: 12 };
    return (
      <Svg w={360} h={360}>
        <OsmMap f={f} s={s} size={344} x={8} y={8} radius={28} track="rgba(20,70,95,0.5)" done="#12BFD9" marker={A.map} />
        {circle ? <circle cx="180" cy="180" r="174" {...frame} /> : <rect x="2" y="2" width="356" height="356" rx="34" {...frame} />}
        {circle ? <circle cx="180" cy="180" r="179" fill="none" stroke="rgba(213,243,255,0.5)" strokeWidth="1.5" />
          : <rect x="0.75" y="0.75" width="358.5" height="358.5" rx="36" fill="none" stroke="rgba(213,243,255,0.5)" strokeWidth="1.5" />}
        {!s.headingUp && <NorthMark x={circle ? 300 : 322} y={circle ? 62 : 40} color="#fff" />}
      </Svg>
    );
  },
});

// ---------------------------------------------------------------- run · walk · hike

const pace = defineWidget({
  id: 'pace.glass', metric: 'pace', family: 'glass', name: 'Pace + 60 s trace',
  requires: ['pace'], size: { w: 540, h: 230 },
  defaults: { traceSeconds: 60 },
  settings: [{ key: 'traceSeconds', label: 'Trace length (s)', type: 'number', min: 10, max: 180, step: 5 }],
  Component: (f) => {
    const id = useSvgIds('fill');
    const v = read(f, 'pace');
    const n = 60;
    const [x0, x1, y0, y1] = [312, 508, 70, 178];
    const pts = paceTrail(f, f.settings.traceSeconds, n).map((h, k) => [x0 + ((x1 - x0) * k) / (n - 1), y1 - (y1 - y0) * h] as [number, number]);
    const end = pts[n - 1];
    const avg = avgPace(f);
    return (
      <Svg w={540} h={230}>
        <defs>
          <linearGradient id={id.fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={A.speed} stopOpacity="0.3" />
            <stop offset="1" stopColor={A.speed} stopOpacity="0" />
          </linearGradient>
        </defs>
        <Panel w={540} h={230} o={f.panelOpacity} accent={A.speed} />
        <Label x={34} y={58} color={A.speed}>PACE</Label>
        <Label x={x0} y={58} color={MUTED} size={14}>{`${f.settings.traceSeconds} SEC · FASTER ↑`}</Label>
        <Value x={28} y={168} size={v.text.length > 4 ? 92 : 118} text={v.text} />
        <Label x={36} y={205} color={A.speed} size={18}>{v.unit.toUpperCase().replace('/', ' / ')}</Label>
        {[y0, (y0 + y1) / 2, y1].map((y) => <line key={y} x1={x0} x2={x1} y1={y} y2={y} stroke="rgba(213,243,255,0.12)" />)}
        <path d={areaPath(pts, y1)} fill={url(id.fill)} />
        <path d={linePath(pts)} fill="none" stroke={A.speed} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {Number.isFinite(end[1]) && (
          <g>
            <circle cx={end[0]} cy={end[1]} r="11" fill={A.speed} opacity="0.25" />
            <circle cx={end[0]} cy={end[1]} r="5.5" fill={A.speed} />
          </g>
        )}
        <Label x={x1} y={205} color={MUTED} size={13} anchor="end">{`AVG ${avg.text}`}</Label>
      </Svg>
    );
  },
});

const stepCadence = defineWidget({
  id: 'stepCadence.glass', metric: 'stepCadence', family: 'glass', name: 'Footfall tile',
  requires: ['stepCadence'], size: { w: 400, h: 230 },
  Component: (f) => {
    const v = read(f, 'stepCadence');
    const ff = footfall(f);
    return (
      <Svg w={400} h={230}>
        <Panel w={400} h={230} o={f.panelOpacity} accent={A.cadence} />
        <Label x={34} y={58} color={A.cadence}>CADENCE</Label>
        <Value x={28} y={162} size={104} text={v.text} />
        <Label x={36} y={200} color={A.cadence} size={18}>STEPS / MIN</Label>
        <Foot x={296} y={134} s={0.95} fill={A.cadence} opacity={ff.left} flip />
        <Foot x={350} y={104} s={0.95} fill={A.cadence} opacity={ff.right} />
      </Svg>
    );
  },
});

const splits = defineWidget({
  id: 'splits.glass', metric: 'splits', family: 'glass', name: 'Split ladder',
  requires: ['distance'], size: { w: 520, h: 330 },
  Component: (f) => {
    const s = splitAt(f.ride, f.t, f.units);
    const unit = f.units === 'metric' ? 'KM' : 'MI';
    const rows = splitRows(s);
    const p = clamp(s?.progress ?? NaN, 0, 1);
    return (
      <Svg w={520} h={330}>
        <Panel w={520} h={330} o={f.panelOpacity} accent={A.speed} />
        <Label x={34} y={58} color={A.speed}>{s ? `${unit} ${s.current} SPLIT` : 'SPLIT'}</Label>
        <Value x={28} y={126} size={64} text={s ? splitText(s.elapsed) : MISSING} />
        <Label x={486} y={126} color={MUTED} size={14} anchor="end">{Number.isFinite(p) ? `${Math.round(p * 100)}% OF ${unit}` : ''}</Label>
        <rect x="34" y="144" width="452" height="6" rx="3" fill="rgba(213,243,255,0.14)" />
        {Number.isFinite(p) && <rect x="34" y="144" width={452 * p} height="6" rx="3" fill={A.speed} />}
        {!rows.length && <Label x={34} y={216} color={MUTED} size={14}>{s ? `FIRST ${unit} IN PROGRESS` : ''}</Label>}
        {rows.map((r, k) => {
          const y = 196 + k * 40;
          const c = r.best ? A.speed : INK;
          return (
            <g key={r.n}>
              <Label x={34} y={y} color={MUTED} size={15}>{`${unit} ${r.n}`}</Label>
              <Value x={118} y={y + 1} size={26} text={r.text} />
              {Number.isFinite(r.rel) && <rect x="210" y={y - 14} width={70 + 130 * r.rel} height="10" rx="5" fill={c} opacity={r.best ? 1 : 0.45} />}
              <Label x={486} y={y} color={r.faster ? A.speed : MUTED} size={14} anchor="end">{r.delta}</Label>
            </g>
          );
        })}
      </Svg>
    );
  },
});

const steps = defineWidget({
  id: 'steps.glass', metric: 'steps', family: 'glass', name: 'Steps + goal ring',
  requires: ['steps'], size: { w: 400, h: 230 },
  defaults: { goal: 10000 },
  settings: STEP_SETTINGS,
  Component: (f) => {
    const n = stepsAt(f);
    const d = read(f, 'distance');
    const p = clamp(n / f.settings.goal, 0, 1) || 0;
    const [cx, cy, r] = [316, 112, 62];
    return (
      <Svg w={400} h={230}>
        <Panel w={400} h={230} o={f.panelOpacity} accent={A.cadence} />
        <Label x={34} y={58} color={A.cadence}>STEPS</Label>
        <Value x={28} y={140} size={70} text={grouped(n)} />
        <Label x={36} y={176} color={MUTED} size={13}>EST. FROM CADENCE</Label>
        <Value x={34} y={210} size={26} text={d.text} unit={d.unit.toUpperCase()} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(213,243,255,0.14)" strokeWidth="10" />
        {p > 0 && <path d={arc(cx, cy, r, 0, 360 * p)} fill="none" stroke={A.cadence} strokeWidth="10" strokeLinecap="round" />}
        <Value x={cx} y={cy + 9} size={26} text={`${Math.round(p * 100)}%`} anchor="middle" />
        <Label x={cx} y={206} color={MUTED} size={11} anchor="middle">{`OF ${grouped(f.settings.goal)}`}</Label>
      </Svg>
    );
  },
});

const climbRate = defineWidget({
  id: 'climbRate.glass', metric: 'climbRate', family: 'glass', name: 'Climb rate + 10 min bars',
  requires: ['climbRate'], size: { w: 480, h: 230 },
  Component: (f) => {
    const v = read(f, 'climbRate');
    const gain = read(f, 'ascent');
    const bins = Array.from(trailing(f, 'climbRate', 540, 10));
    const scale = Math.max(300 / 3600, ...bins.filter(Number.isFinite).map(Math.abs));
    const base = 150;
    return (
      <Svg w={480} h={230}>
        <Panel w={480} h={230} o={f.panelOpacity} accent={A.elevation} />
        <Label x={34} y={58} color={A.elevation}>CLIMB RATE</Label>
        <Value x={28} y={148} size={signed(v.text, v.si).length > 4 ? 72 : 90} text={signed(v.text, v.si)} />
        <Label x={36} y={186} color={A.elevation} size={18}>{v.unit.toUpperCase().replace('/', ' / ')}</Label>
        <Label x={36} y={212} color={MUTED} size={14}>{`GAIN +${gain.text} ${gain.unit.toUpperCase()}`}</Label>
        <line x1="250" x2="446" y1={base} y2={base} stroke="rgba(213,243,255,0.2)" />
        {bins.map((b, k) => {
          if (!Number.isFinite(b)) return null;
          const h = Math.max(2, Math.abs(b / scale) * (b >= 0 ? 76 : 36));
          return <rect key={k} x={252 + k * 20} y={b >= 0 ? base - h : base} width="13" height={h} rx="3" fill={A.elevation} opacity={0.35 + 0.065 * k} />;
        })}
        <Label x={446} y={212} color={MUTED} size={12} anchor="end">LAST 10 MIN</Label>
      </Svg>
    );
  },
});

const summitProfile = defineWidget({
  id: 'elevationProfile.glass-summit', metric: 'elevationProfile', family: 'glass', name: 'Summit profile',
  requires: ['altitude', 'distance'], size: { w: 672, h: 250 },
  Component: (f) => {
    const id = useSvgIds('clip');
    const [x0, x1, y1] = [34, 638, 212];
    const sf = summitFrame(f.ride, f.t, [x0, x1, 100, y1]);
    const alt = read(f, 'altitude');
    const toGo = display('altitude', sf.toHigh, f.units);
    const hpText = sf.high ? display('altitude', sf.high.alt, f.units) : null;
    return (
      <Svg w={672} h={250}>
        <defs><clipPath id={id.clip}><rect x="0" y="0" width={sf.cx} height="250" /></clipPath></defs>
        <Panel w={672} h={250} o={f.panelOpacity} accent={A.elevation} />
        <Label x={34} y={58} color={A.elevation}>ELEVATION</Label>
        <Value x={240} y={64} size={40} text={alt.text} unit={alt.unit} />
        <Label x={638} y={58} color={MUTED} size={14} anchor="end">
          {!toGo.missing ? `${toGo.text} ${toGo.unit.toUpperCase()} TO HIGH POINT` : hpText ? `HIGH POINT ${hpText.text} ${hpText.unit.toUpperCase()}` : ''}
        </Label>
        <path d={areaPath(sf.pts, y1)} fill="rgba(213,243,255,0.07)" />
        <path d={linePath(sf.pts)} fill="none" stroke="rgba(213,243,255,0.32)" strokeWidth="2" />
        <g clipPath={url(id.clip)}>
          <path d={areaPath(sf.pts, y1)} fill={A.elevation} fillOpacity="0.26" />
          <path d={linePath(sf.pts)} fill="none" stroke={A.elevation} strokeWidth="3" strokeLinejoin="round" />
        </g>
        {sf.high && hpText && (
          <g>
            <line x1={sf.high.x} x2={sf.high.x} y1={sf.high.y} y2={sf.high.y - 22} stroke={INK} strokeWidth="2" />
            <path d={`M${sf.high.x} ${sf.high.y - 22}l18 6l-18 6Z`} fill={INK} />
            <Label x={sf.high.x - 8} y={sf.high.y - 10} color={MUTED} size={12} anchor="end">{hpText.text}</Label>
          </g>
        )}
        {sf.here && (
          <g>
            <circle cx={sf.here.x} cy={sf.here.y} r="12" fill={A.elevation} opacity="0.3" />
            <circle cx={sf.here.x} cy={sf.here.y} r="6" fill={A.elevation} />
          </g>
        )}
        <Label x={x0} y={238} color={MUTED} size={12}>0</Label>
        <Label x={x1} y={238} color={MUTED} size={12} anchor="end">{`${display('distance', sf.total, f.units, 1).text} ${display('distance', sf.total, f.units).unit.toUpperCase()}`}</Label>
      </Svg>
    );
  },
});

const heading = defineWidget({
  id: 'heading.glass', metric: 'heading', family: 'glass', name: 'Heading ribbon',
  requires: ['heading'], size: { w: 540, h: 150 },
  Component: (f) => {
    const id = useSvgIds('fade', 'mask');
    const hdg = f.ride.at('heading', f.t);
    return (
      <Svg w={540} h={150}>
        <defs>
          <linearGradient id={id.fade} x1="0" x2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.2" stopColor="#fff" />
            <stop offset="0.8" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={id.mask}><rect width="540" height="150" fill={url(id.fade)} /></mask>
        </defs>
        <Panel w={540} h={150} o={f.panelOpacity} accent={A.map} />
        <Label x={34} y={44} color={A.map} size={15}>HEADING</Label>
        <Value x={506} y={46} size={26} anchor="end" text={Number.isFinite(hdg) ? `${cardinal(hdg)} ${Math.round(hdg) % 360}°` : MISSING} />
        <g mask={url(id.mask)}>
          {ribbonTicks(hdg, 90).map((t) => {
            const x = 270 + t.d * 2.6;
            if (t.name) {
              return (
                <g key={t.hdg}>
                  <line x1={x} x2={x} y1="68" y2="86" stroke={INK} strokeWidth="2" />
                  <text x={x} y="116" textAnchor="middle" fill={t.name === 'N' ? A.hr : INK} fontFamily={FONT} fontSize={t.name.length === 1 ? 22 : 17} fontWeight={650}>{t.name}</text>
                </g>
              );
            }
            return t.major ? <line key={t.hdg} x1={x} x2={x} y1="70" y2="80" stroke={MUTED} strokeWidth="1.5" /> : null;
          })}
        </g>
        <path d="M270 62 L260 48 L280 48 Z" fill={A.map} />
        <Label x={270} y={140} color={MUTED} size={11} anchor="middle">FROM GPS TRACK</Label>
      </Svg>
    );
  },
});

const movingTime = defineWidget({
  id: 'movingTime.glass', metric: 'movingTime', family: 'glass', name: 'Moving vs elapsed',
  requires: ['speed'], size: { w: 400, h: 230 },
  defaults: { stoppedBelow: 0.5 },
  settings: MOVING_SETTINGS,
  Component: (f) => {
    const m = movingAt(f.ride, f.t, f.settings.stoppedBelow);
    const p = m && m.elapsed > 0 ? m.moving / m.elapsed : NaN;
    const thr = display('speed', f.settings.stoppedBelow, f.units);
    return (
      <Svg w={400} h={230}>
        <Panel w={400} h={230} o={f.panelOpacity} accent={A.time} />
        <Label x={34} y={58} color={A.time}>MOVING TIME</Label>
        <Value x={28} y={128} size={66} text={m ? formatDuration(m.moving) : MISSING} />
        <Label x={36} y={166} color={MUTED} size={14}>{`ELAPSED ${m ? formatDuration(m.elapsed) : MISSING}`}</Label>
        <rect x="34" y="186" width="332" height="10" rx="5" fill="rgba(213,243,255,0.14)" />
        <rect x="34" y="186" width={332 * (clamp(p, 0, 1) || 0)} height="10" rx="5" fill={A.time} />
        <Label x={34} y={218} color={MUTED} size={12}>{Number.isFinite(p) ? `${Math.round(p * 100)}% MOVING` : ''}</Label>
        <Label x={366} y={218} color={MUTED} size={12} anchor="end">{`STOP < ${thr.text} ${thr.unit.toUpperCase()}`}</Label>
      </Svg>
    );
  },
});

const runStrip = defineWidget({
  id: 'runStrip.glass', metric: 'runStrip', family: 'glass', name: 'Run strip',
  requires: ['pace'], size: { w: 1080, h: 150 },
  Component: (f) => {
    const pc = read(f, 'pace');
    const hr = read(f, 'heartRate');
    const sp = read(f, 'stepCadence');
    const d = read(f, 'distance');
    const z = f.ride.hrZone(hr.si);
    const cells: [number, string, Display, string, string][] = [
      [40, 'PACE', pc, f.units === 'metric' ? '/KM' : '/MI', A.speed], [330, 'HEART', hr, 'BPM', A.hr],
      [580, 'CADENCE', sp, 'SPM', A.cadence], [820, 'DISTANCE', d, d.unit.toUpperCase(), A.distance],
    ];
    return (
      <Svg w={1080} h={150}>
        <Panel w={1080} h={150} o={f.panelOpacity} accent={A.speed} />
        {cells.map(([x, label, v, unit, c], k) => (
          <g key={label}>
            {k > 0 && <line x1={x - 30} x2={x - 30} y1="34" y2="118" stroke="rgba(213,243,255,0.14)" />}
            <Label x={x} y={50} color={c} size={16}>{label}</Label>
            <Value x={x - 4} y={116} size={64} text={v.text} unit={unit} />
          </g>
        ))}
        {z && [1, 2, 3, 4, 5].map((k) => (
          <rect key={k} x={330 + (k - 1) * 40} y="128" width="36" height="6" rx="3" fill={ZONE_COLORS[k]} opacity={k === z.zone ? 1 : 0.3} />
        ))}
      </Svg>
    );
  },
});

export const widgets = [
  speed, speedArc, heartRate, hrZone, cadence, elevation, elevationProfile, gradient, temperature, distance, time, respiration, map, streetMap,
  pace, runStrip, stepCadence, steps, splits, climbRate, summitProfile, heading, movingTime,
];
