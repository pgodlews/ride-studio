/**
 * Bold social / neon — feed-stopping type: huge condensed numerals, neon glow,
 * segment meters, a pulse trace paced by real HR and comet-tail route.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { buildProfile, clamp, frac, gradeColor, linePath, polar, projectRoute, routePoints, routePosition, ZONE_COLORS, ZONE_NAMES } from '../../core/geometry';
import { movingAt, splitAt, summitFrame } from '../../core/activity';
import { display, formatDuration, grouped, MISSING, pad2 } from '../../core/units';
import { defineWidget, type FamilyInfo, type WidgetFrame } from '../../core/widget';
import { pulseShape, read, signed, Svg, url, useSvgIds } from '../shared';
import { Foot, footfall, MOVING_SETTINGS, paceTrail, ribbonTicks, splitRows, splitText, STEP_SETTINGS, stepsAt } from '../foot';
import { NorthMark, OSM_SETTINGS, OsmMap, type OsmSettings } from '../osm';

export const family: FamilyInfo = { id: 'neon', name: 'Bold social / neon', tagline: 'Huge numerals, glow, made for the feed.' };

const NUM = "'Bebas Neue', Impact, sans-serif";
const LBL = "'Space Grotesk Variable', 'Space Grotesk', sans-serif";
const PINK = '#FF2BD6';
const CYAN = '#00F0FF';
const LIME = '#C6FF00';
const ORANGE = '#FF7A1A';
const VIOLET = '#9D5CFF';
const MINT = '#5CFFC8';

/** Glow filter + dark rounded panel with a neon rim. */
function Neon({ w, h, o, color, r = 26, children }: { w: number; h: number; o: number; color: string; r?: number; children: ReactNode }) {
  const id = useSvgIds('glow', 'soft');
  return (
    <Svg w={w} h={h}>
      <defs>
        <filter id={id.glow} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={id.soft} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <rect x="2" y="2" width={w - 4} height={h - 4} rx={r} fill={`rgba(8,5,22,${o})`} />
      <rect x="2" y="2" width={w - 4} height={h - 4} rx={r} fill="none" stroke={color} strokeOpacity={0.25 + 0.5 * o} strokeWidth="2" filter={url(id.soft)} />
      <GlowCtx.Provider value={id}>{children}</GlowCtx.Provider>
    </Svg>
  );
}

const GlowCtx = createContext<{ glow: string; soft: string }>({ glow: '', soft: '' });
const useGlow = () => useContext(GlowCtx);

function Num({ x, y, size, color = '#fff', glow = CYAN, anchor, children }: { x: number; y: number; size: number; color?: string; glow?: string; anchor?: 'middle' | 'end'; children: ReactNode }) {
  const g = useGlow();
  return (
    <g>
      <text x={x} y={y} fontFamily={NUM} fontSize={size} fill={glow} textAnchor={anchor} filter={url(g.glow)} opacity="0.55" style={{ fontVariantNumeric: 'tabular-nums' }}>{children}</text>
      <text x={x} y={y} fontFamily={NUM} fontSize={size} fill={color} textAnchor={anchor} style={{ fontVariantNumeric: 'tabular-nums' }}>{children}</text>
    </g>
  );
}

function Lbl({ x, y, children, color, size = 16, anchor, rotate }: { x: number; y: number; children: ReactNode; color: string; size?: number; anchor?: 'middle' | 'end'; rotate?: number }) {
  return (
    <text x={x} y={y} fill={color} fontFamily={LBL} fontWeight={700} fontSize={size} letterSpacing={size * 0.18} textAnchor={anchor}
      transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}>{children}</text>
  );
}

/** Row of segments lit up to fraction p, colour ramp from a → b. */
function Segments({ x, y, w, h, n, p, a, b }: { x: number; y: number; w: number; h: number; n: number; p: number; a: string; b: string }) {
  const g = useGlow();
  const sw = (w - (n - 1) * 5) / n;
  const lit = Math.round(clamp(p || 0, 0, 1) * n);
  return (
    <g>
      {Array.from({ length: n }, (_, k) => (
        <rect key={k} x={x + k * (sw + 5)} y={y} width={sw} height={h} rx={2} fill={k < lit ? mix(a, b, k / (n - 1)) : 'rgba(255,255,255,0.10)'} filter={k < lit ? url(g.soft) : undefined} />
      ))}
    </g>
  );
}

function mix(a: string, b: string, f: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * f)).join(',')})`;
}

const speed = defineWidget({
  id: 'speed.neon', metric: 'speed', family: 'neon', name: 'Mega speed',
  requires: ['speed'], size: { w: 520, h: 270 },
  Component: (f) => {
    const v = read(f, 'speed');
    const [int, dec] = v.text.split('.');
    const max = f.ride.extent('speed')[1];
    return (
      <Neon w={520} h={270} o={f.panelOpacity} color={CYAN}>
        <Num x={34} y={206} size={220}>{int}<tspan fontSize={96} dx={4}>{dec !== undefined ? `.${dec}` : ''}</tspan></Num>
        <Lbl x={488} y={44} color={CYAN} size={20} rotate={90}>{v.unit.toUpperCase()}</Lbl>
        <Segments x={36} y={228} w={420} h={16} n={24} p={v.si / max} a={CYAN} b={PINK} />
      </Neon>
    );
  },
});

const heartRate = defineWidget({
  id: 'heartRate.neon', metric: 'heartRate', family: 'neon', name: 'Pulse trace',
  requires: ['heartRate'], size: { w: 480, h: 230 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const n = 140;
    const span = 3;
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const t = f.t - span + (span * k) / (n - 1);
      const beats = f.ride.at('heartBeats', t);
      pts.push([30 + (420 * k) / (n - 1), 92 - (Number.isFinite(beats) ? pulseShape(frac(beats)) : 0) * 62]);
    }
    const end = pts[n - 1];
    return (
      <Neon w={480} h={230} o={f.panelOpacity} color={PINK}>
        <Trace pts={pts} color={PINK} />
        <circle cx={end[0]} cy={end[1]} r="6" fill="#fff" />
        <Num x={34} y={206} size={104} glow={PINK}>{v.text}</Num>
        <Lbl x={446} y={200} color={PINK} size={22} anchor="end">{v.unit.toUpperCase()}</Lbl>
      </Neon>
    );
  },
});

function Trace({ pts, color, width = 4 }: { pts: [number, number][]; color: string; width?: number }) {
  const g = useGlow();
  return <path d={linePath(pts)} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" filter={url(g.glow)} />;
}

const cadence = defineWidget({
  id: 'cadence.neon', metric: 'cadence', family: 'neon', name: 'Spin ring',
  requires: ['cadence'], size: { w: 300, h: 300 },
  Component: (f) => {
    const v = read(f, 'cadence');
    const ang = frac(f.ride.at('crankRevs', f.t) || 0) * 360;
    const segs = 36;
    return (
      <Neon w={300} h={300} o={f.panelOpacity} color={LIME} r={150}>
        <Ring segs={segs} ang={ang} color={LIME} />
        <Num x={150} y={180} size={104} anchor="middle" glow={LIME}>{v.text}</Num>
        <Lbl x={150} y={212} color={LIME} size={18} anchor="middle">{v.unit.toUpperCase()}</Lbl>
      </Neon>
    );
  },
});

function Ring({ segs, ang, color }: { segs: number; ang: number; color: string }) {
  const g = useGlow();
  return (
    <g>
      {Array.from({ length: segs }, (_, k) => {
        const a = (k * 360) / segs;
        const behind = ((ang - a) % 360 + 360) % 360; // degrees the comet head is ahead of this segment
        const on = Math.max(0, 1 - behind / 200);
        const [x0, y0] = polar(150, 150, 118, a);
        const [x1, y1] = polar(150, 150, 134, a);
        return <line key={k} x1={x0} y1={y0} x2={x1} y2={y1} stroke={on > 0.02 ? color : 'rgba(255,255,255,0.12)'} strokeOpacity={on > 0.02 ? 0.25 + 0.75 * on : 1} strokeWidth="7" strokeLinecap="round" filter={on > 0.6 ? url(g.soft) : undefined} />;
      })}
    </g>
  );
}

const hrZone = defineWidget({
  id: 'hrZone.neon', metric: 'hrZone', family: 'neon', name: 'Zone equaliser',
  requires: ['heartRate'], size: { w: 440, h: 250 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const z = f.ride.hrZone(v.si);
    const c = z ? ZONE_COLORS[z.zone] : '#888';
    return (
      <Neon w={440} h={250} o={f.panelOpacity} color={c}>
        <Bars z={z} />
        <Lbl x={220} y={70} color={c} size={18}>{z ? ZONE_NAMES[z.zone].toUpperCase() : ''}</Lbl>
        <Num x={216} y={170} size={110} glow={c}>{z ? `ZONE ${z.zone}` : MISSING}</Num>
        <Lbl x={220} y={210} color="#fff" size={18}>{`${v.text} BPM`}</Lbl>
      </Neon>
    );
  },
});

function Bars({ z }: { z: { zone: number; position: number } | null }) {
  const g = useGlow();
  return (
    <g>
      {[1, 2, 3, 4, 5].map((k) => {
        const h = 40 + k * 28;
        const x = 34 + (k - 1) * 34;
        const fill = z ? (k < z.zone ? 1 : k === z.zone ? 0.35 + 0.65 * z.position : 0) : 0;
        return (
          <g key={k}>
            <rect x={x} y={214 - h} width="24" height={h} rx="4" fill="rgba(255,255,255,0.08)" />
            {fill > 0 && <rect x={x} y={214 - h * fill} width="24" height={h * fill} rx="4" fill={ZONE_COLORS[k]} filter={url(g.soft)} />}
          </g>
        );
      })}
    </g>
  );
}

const elevation = defineWidget({
  id: 'elevation.neon', metric: 'elevation', family: 'neon', name: 'Peak glow',
  requires: ['altitude'], size: { w: 380, h: 230 },
  Component: (f) => {
    const v = read(f, 'altitude');
    const gain = read(f, 'ascent');
    return (
      <Neon w={380} h={230} o={f.panelOpacity} color={ORANGE}>
        <Trace pts={[[34, 70], [70, 30], [92, 52], [112, 38], [150, 70]]} color={ORANGE} width={4} />
        <Lbl x={170} y={58} color={ORANGE} size={18}>ELEVATION</Lbl>
        <Num x={34} y={190} size={120} glow={ORANGE}>{v.text}<tspan fontSize={48} dx={6}>{v.unit.toUpperCase()}</tspan></Num>
        <Lbl x={346} y={190} color={LIME} size={18} anchor="end">{`+${gain.text}`}</Lbl>
      </Neon>
    );
  },
});

const elevationProfile = defineWidget({
  id: 'elevationProfile.neon', metric: 'elevationProfile', family: 'neon', name: 'Glow profile',
  requires: ['altitude', 'distance'], size: { w: 600, h: 250 },
  Component: (f) => <NeonProfile f={f} />,
});

function NeonProfile({ f }: { f: WidgetFrame }) {
  const id = useSvgIds('fill', 'clip');
  const prof = buildProfile(f.ride);
  const [d0, d1] = f.ride.extent('distance');
  const [a0, a1] = f.ride.extent('altitude');
  const [x0, x1, y0, y1] = [30, 570, 70, 214];
  const X = (d: number) => x0 + ((x1 - x0) * (d - d0)) / (d1 - d0);
  const Y = (a: number) => y1 - ((y1 - y0) * (a - a0)) / Math.max(1, a1 - a0);
  const pts = prof.map((p) => [X(p.d), Y(p.alt)] as [number, number]);
  const dNow = f.ride.at('distance', f.t);
  const aNow = f.ride.at('altitude', f.t);
  const cx = Number.isFinite(dNow) ? X(dNow) : x0;
  const alt = read(f, 'altitude');
  return (
    <Neon w={600} h={250} o={f.panelOpacity} color={PINK}>
      <defs>
        <linearGradient id={id.fill} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={PINK} stopOpacity="0.45" /><stop offset="1" stopColor={VIOLET} stopOpacity="0" /></linearGradient>
        <clipPath id={id.clip}><rect x="0" y="0" width={cx} height="250" /></clipPath>
      </defs>
      <Lbl x={34} y={48} color={PINK} size={16}>ELEVATION</Lbl>
      <Num x={566} y={56} size={50} anchor="end" glow={PINK}>{`${alt.text} ${alt.unit.toUpperCase()}`}</Num>
      <path d={linePath(pts)} fill="none" stroke={VIOLET} strokeOpacity="0.5" strokeWidth="2.5" />
      <g clipPath={url(id.clip)}>
        <path d={`${linePath(pts)}L${x1} ${y1}L${x0} ${y1}Z`} fill={url(id.fill)} />
        <Trace pts={pts} color={PINK} width={3.5} />
      </g>
      {Number.isFinite(aNow) && (
        <g>
          <line x1={cx} x2={cx} y1={Y(aNow)} y2={y1 + 10} stroke="#fff" strokeOpacity="0.5" strokeWidth="2" />
          <Trace pts={[[cx, Y(aNow)], [cx + 0.1, Y(aNow)]]} color="#fff" width={12} />
        </g>
      )}
    </Neon>
  );
}

const gradient = defineWidget({
  id: 'gradient.neon', metric: 'gradient', family: 'neon', name: 'Grade arrow',
  requires: ['gradient'], size: { w: 320, h: 230 },
  Component: (f) => {
    const v = read(f, 'gradient');
    const c = gradeColor(v.si);
    const ang = clamp(Math.atan((v.si || 0) / 100) * 3, -0.9, 0.9);
    const [ax, ay] = [258, 72];
    const dx = Math.cos(ang) * 34;
    const dy = -Math.sin(ang) * 34;
    return (
      <Neon w={320} h={230} o={f.panelOpacity} color={c}>
        <Lbl x={34} y={56} color={c} size={18}>GRADIENT</Lbl>
        <Trace pts={[[ax - dx, ay - dy], [ax + dx, ay + dy]]} color={c} width={6} />
        <path d={`M${ax + dx} ${ay + dy} l${-Math.cos(ang - 0.5) * 16} ${Math.sin(ang - 0.5) * 16} M${ax + dx} ${ay + dy} l${-Math.cos(ang + 0.5) * 16} ${Math.sin(ang + 0.5) * 16}`} stroke={c} strokeWidth="6" strokeLinecap="round" fill="none" />
        <Num x={34} y={196} size={128} glow={c}>{`${signed(v.text, v.si)}%`}</Num>
      </Neon>
    );
  },
});

const temperature = defineWidget({
  id: 'temperature.neon', metric: 'temperature', family: 'neon', name: 'Heat number',
  requires: ['temperature'], size: { w: 270, h: 230 },
  Component: (f) => {
    const v = read(f, 'temperature');
    const c = mix(CYAN, ORANGE, clamp(((v.si || 0) - 0) / 30, 0, 1));
    return (
      <Neon w={270} h={230} o={f.panelOpacity} color={CYAN}>
        <Lbl x={34} y={56} color={c} size={18}>TEMP</Lbl>
        <Num x={34} y={196} size={140} glow={c}>{v.text}<tspan fontSize={60} dx={4}>{v.unit}</tspan></Num>
      </Neon>
    );
  },
});

const distance = defineWidget({
  id: 'distance.neon', metric: 'distance', family: 'neon', name: 'Distance dots',
  requires: ['distance'], size: { w: 440, h: 220 },
  Component: (f) => {
    const v = read(f, 'distance', 1);
    const total = f.ride.extent('distance')[1];
    return (
      <Neon w={440} h={220} o={f.panelOpacity} color={VIOLET}>
        <Lbl x={34} y={52} color={VIOLET} size={18}>DISTANCE</Lbl>
        <Num x={34} y={160} size={112} glow={VIOLET}>{v.text}<tspan fontSize={44} dx={8}>{v.unit.toUpperCase()}</tspan></Num>
        <Lbl x={406} y={52} color="rgba(255,255,255,0.6)" size={16} anchor="end">{`/ ${display('distance', total, f.units, 1).text}`}</Lbl>
        <Segments x={36} y={182} w={368} h={10} n={30} p={v.si / total} a={VIOLET} b={PINK} />
      </Neon>
    );
  },
});

const time = defineWidget({
  id: 'time.neon', metric: 'time', family: 'neon', name: 'Digital clock',
  requires: [], size: { w: 440, h: 220 },
  Component: (f) => {
    const lt = f.ride.localTime(f.t);
    const blink = frac(f.t) < 0.5;
    return (
      <Neon w={440} h={220} o={f.panelOpacity} color={CYAN}>
        <Num x={34} y={162} size={150} glow={CYAN}>
          {pad2(lt.h)}<tspan opacity={blink ? 1 : 0.25}>:</tspan>{pad2(lt.m)}
          <tspan fontSize={56} dx={6} fill={PINK}>{pad2(lt.s)}</tspan>
        </Num>
        <Lbl x={36} y={194} color="rgba(255,255,255,0.7)" size={15}>{`ELAPSED ${formatDuration(f.t)}`}</Lbl>
      </Neon>
    );
  },
});

const respiration = defineWidget({
  id: 'respiration.neon', metric: 'respiration', family: 'neon', name: 'Breathing orb',
  requires: ['respiration'], size: { w: 300, h: 300 },
  Component: (f) => {
    const v = read(f, 'respiration');
    const ph = f.ride.at('breaths', f.t);
    const breath = Number.isFinite(ph) ? 0.5 - 0.5 * Math.cos(frac(ph) * Math.PI * 2) : 0;
    return (
      <Neon w={300} h={300} o={f.panelOpacity} color={MINT} r={150}>
        <Orb r={88 + breath * 30} />
        <Num x={150} y={176} size={96} anchor="middle" glow={MINT}>{v.text}</Num>
        <Lbl x={150} y={210} color={MINT} size={15} anchor="middle">BRPM · EST</Lbl>
      </Neon>
    );
  },
});

function Orb({ r }: { r: number }) {
  const g = useGlow();
  return (
    <g>
      <circle cx="150" cy="150" r={r} fill="none" stroke={MINT} strokeWidth="5" filter={url(g.glow)} />
      <circle cx="150" cy="150" r={r - 14} fill="none" stroke={MINT} strokeOpacity="0.3" strokeWidth="2" />
    </g>
  );
}

const map = defineWidget({
  id: 'map.neon', metric: 'map', family: 'neon', name: 'Comet route',
  requires: ['lat', 'lon'], size: { w: 340, h: 340 },
  defaults: { privacyTrimMetres: 500, tailSeconds: 300 },
  settings: [
    { key: 'privacyTrimMetres', label: 'Hide start/finish (m)', type: 'number', min: 0, max: 3000, step: 100 },
    { key: 'tailSeconds', label: 'Comet tail (s)', type: 'number', min: 10, max: 600, step: 10 },
  ],
  Component: (f) => <CometMap f={f} trim={f.settings.privacyTrimMetres} tail={f.settings.tailSeconds} />,
});

function CometMap({ f, trim, tail }: { f: WidgetFrame; trim: number; tail: number }) {
  const route = projectRoute(f.ride, trim, 1500);
  const [ox, oy, S] = [40, 40, 260];
  const P = (p: [number, number]) => [ox + p[0] * S, oy + p[1] * S] as [number, number];
  const pos = route && routePosition(route, f.t);
  const shown = route ? routePoints(route, route.shownFrom, route.shownTo).map(P) : [];
  const segs: ReactNode[] = [];
  if (route && pos) {
    let k = pos.index;
    let prev = P(pos.pt);
    while (k >= route.shownFrom && route.times[k] >= f.t - tail) {
      const cur = P(route.pts[k]);
      const age = (f.t - route.times[k]) / tail;
      segs.push(<line key={k} x1={prev[0]} y1={prev[1]} x2={cur[0]} y2={cur[1]} stroke={mix(CYAN, PINK, age)} strokeOpacity={1 - age} strokeWidth={9 - 5 * age} strokeLinecap="round" />);
      if (route.breakBefore[k]) break;
      prev = cur;
      k--;
    }
  }
  return (
    <Neon w={340} h={340} o={f.panelOpacity} color={VIOLET}>
      <path d={linePath(shown)} fill="none" stroke={VIOLET} strokeOpacity="0.55" strokeWidth="3" strokeLinejoin="round" />
      <CometGlow>{segs}</CometGlow>
      {pos && <circle cx={P(pos.pt)[0]} cy={P(pos.pt)[1]} r="7" fill="#fff" />}
    </Neon>
  );
}

function CometGlow({ children }: { children: ReactNode }) {
  const g = useGlow();
  return <g filter={url(g.soft)}>{children}</g>;
}

const streetMap = defineWidget<OsmSettings>({
  id: 'streetMap.neon', metric: 'streetMap', family: 'neon', name: 'Night street map',
  requires: ['lat', 'lon'], size: { w: 360, h: 360 },
  defaults: { shape: 'circle', zoom: 15.5, theme: 'dark', headingUp: false, privacyTrimMetres: 500 },
  settings: OSM_SETTINGS,
  Component: (f) => <NeonStreetMap f={f} s={f.settings} />,
});

function NeonStreetMap({ f, s }: { f: WidgetFrame; s: OsmSettings }) {
  const id = useSvgIds('glow');
  const circle = s.shape === 'circle';
  const rim = { fill: 'none', stroke: CYAN, strokeWidth: 3, filter: url(id.glow) };
  return (
    <Svg w={360} h={360}>
      <defs>
        <filter id={id.glow} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {circle ? <circle cx="180" cy="180" r="176" fill={`rgba(8,5,22,${f.panelOpacity})`} /> : <rect x="4" y="4" width="352" height="352" rx="30" fill={`rgba(8,5,22,${f.panelOpacity})`} />}
      <OsmMap f={f} s={s} size={332} x={14} y={14} radius={24} track="rgba(157,92,255,0.7)" done={PINK} marker="#fff" markerRing={PINK} />
      {circle ? <circle cx="180" cy="180" r="168" {...rim} /> : <rect x="12" y="12" width="336" height="336" rx="26" {...rim} />}
      {!s.headingUp && <NorthMark x={circle ? 300 : 322} y={circle ? 62 : 40} color={CYAN} />}
    </Svg>
  );
}

// ---------------------------------------------------------------- run · walk · hike

/** Neon line: a blurred wide copy under a crisp stroke. */
function GlowLine({ d, color, width = 4 }: { d: string; color: string; width?: number }) {
  const g = useGlow();
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={width * 2.5} opacity="0.4" filter={url(g.glow)} strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" />
    </g>
  );
}

/** Applies the panel's glow filter; must render inside <Neon>, where the filter ids live. */
function Glowing({ soft, on = true, children }: { soft?: boolean; on?: boolean; children: ReactNode }) {
  const g = useGlow();
  return <g filter={on ? url(soft ? g.soft : g.glow) : undefined}>{children}</g>;
}

const pace = defineWidget({
  id: 'pace.neon', metric: 'pace', family: 'neon', name: 'Mega pace',
  requires: ['pace'], size: { w: 520, h: 310 },
  Component: (f) => {
    const v = read(f, 'pace');
    const n = 60;
    const pts = paceTrail(f, 60, n).map((h, k) => [30 + (460 * k) / (n - 1), 290 - 54 * h] as [number, number]);
    const end = pts[n - 1];
    return (
      <Neon w={520} h={310} o={f.panelOpacity} color={CYAN}>
        <Lbl x={34} y={52} color={CYAN} size={18}>PACE</Lbl>
        <Lbl x={486} y={52} color={CYAN} size={16} anchor="end">{v.unit.toUpperCase()}</Lbl>
        <Num x={28} y={206} size={v.text.length > 4 ? 150 : 190}>{v.text}</Num>
        <GlowLine d={linePath(pts)} color={CYAN} />
        {Number.isFinite(end[1]) && <circle cx={end[0]} cy={end[1]} r="7" fill="#fff" />}
      </Neon>
    );
  },
});

const stepCadence = defineWidget({
  id: 'stepCadence.neon', metric: 'stepCadence', family: 'neon', name: 'Neon footfall',
  requires: ['stepCadence'], size: { w: 420, h: 310 },
  Component: (f) => {
    const v = read(f, 'stepCadence');
    const ff = footfall(f, 0.18);
    return (
      <Neon w={420} h={310} o={f.panelOpacity} color={LIME}>
        <Lbl x={34} y={52} color={LIME} size={18}>STEPS / MIN</Lbl>
        <Num x={28} y={230} size={176} glow={LIME} color={LIME}>{v.text}</Num>
        {([['left', 316, 222, true], ['right', 362, 140, false]] as const).map(([side, x, y, flip]) => {
          const o = ff[side];
          const lit = o > 0.18;
          return (
            <g key={side}>
              {lit && <Glowing><Foot x={x} y={y} s={0.85} fill={LIME} opacity={o} flip={flip} /></Glowing>}
              <Foot x={x} y={y} s={0.85} fill={lit ? '#fff' : LIME} opacity={lit ? o : 0.18} flip={flip} />
            </g>
          );
        })}
      </Neon>
    );
  },
});

const splits = defineWidget({
  id: 'splits.neon', metric: 'splits', family: 'neon', name: 'Split bars',
  requires: ['distance'], size: { w: 500, h: 310 },
  Component: (f) => {
    const s = splitAt(f.ride, f.t, f.units);
    const unit = f.units === 'metric' ? 'KM' : 'MI';
    const rows = splitRows(s);
    const p = clamp(s?.progress ?? NaN, 0, 1);
    return (
      <Neon w={500} h={310} o={f.panelOpacity} color={PINK}>
        <Lbl x={34} y={52} color={PINK} size={18}>{`${unit} SPLITS`}</Lbl>
        {!s && <Num x={34} y={200} size={96} glow={PINK}>{MISSING}</Num>}
        {rows.map((r, k) => {
          const x = 40 + k * 112;
          const h = Number.isFinite(r.rel) ? 60 + 90 * r.rel : 40;
          return (
            <g key={r.n}>
              <Glowing soft on={r.best}><rect x={x} y={250 - h} width="80" height={h} rx="14" fill={r.best ? PINK : VIOLET} opacity={Number.isFinite(r.rel) ? 1 : 0.35} /></Glowing>
              <text x={x + 40} y={244} textAnchor="middle" fontFamily={NUM} fontSize="28" fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{r.text}</text>
              <Lbl x={x + 40} y={284} color="#fff" size={14} anchor="middle">{`${unit} ${r.n}`}</Lbl>
            </g>
          );
        })}
        {s && (() => {
          const x = 40 + rows.length * 112;
          return (
            <g>
              <rect x={x} y={100} width="80" height="150" rx="14" fill="none" stroke={PINK} strokeWidth="2" strokeDasharray="6 6" opacity="0.6" />
              {p > 0 && <rect x={x} y={250 - 150 * p} width="80" height={150 * p} rx="14" fill={PINK} opacity="0.55" />}
              <Num x={x + 40} y={88} size={40} anchor="middle" glow={PINK}>{splitText(s.elapsed)}</Num>
              <Lbl x={x + 40} y={284} color="#fff" size={14} anchor="middle">{`${unit} ${s.current}`}</Lbl>
            </g>
          );
        })()}
      </Neon>
    );
  },
});

const steps = defineWidget({
  id: 'steps.neon', metric: 'steps', family: 'neon', name: 'Step count',
  requires: ['steps'], size: { w: 420, h: 310 },
  defaults: { goal: 10000 },
  settings: STEP_SETTINGS,
  Component: (f) => {
    const n = stepsAt(f);
    const d = read(f, 'distance');
    const p = clamp(n / f.settings.goal, 0, 1) || 0;
    const lit = Math.floor(p * 20);
    return (
      <Neon w={420} h={310} o={f.panelOpacity} color={MINT}>
        <Lbl x={34} y={52} color={MINT} size={18}>STEPS</Lbl>
        <Lbl x={386} y={52} color={MINT} size={14} anchor="end">EST.</Lbl>
        <Num x={28} y={196} size={grouped(n).length > 6 ? 120 : 150} glow={MINT}>{grouped(n)}</Num>
        {Array.from({ length: 20 }, (_, k) => <circle key={k} cx={40 + k * 17.6} cy={236} r={6} fill={MINT} opacity={k < lit ? 1 : 0.2} />)}
        <Lbl x={34} y={282} color="#fff" size={15}>{`${d.text} ${d.unit.toUpperCase()} · ${Math.round(p * 100)}% OF ${grouped(f.settings.goal)}`}</Lbl>
      </Neon>
    );
  },
});

const climbRate = defineWidget({
  id: 'climbRate.neon', metric: 'climbRate', family: 'neon', name: 'Climb chevrons',
  requires: ['climbRate'], size: { w: 460, h: 310 },
  Component: (f) => {
    const v = read(f, 'climbRate');
    const g = read(f, 'ascent');
    const mh = v.si * 3600;
    const lit = Number.isFinite(mh) ? [150, 400, 700].filter((x) => Math.abs(mh) >= x).length : 0;
    const up = !(mh < 0);
    const text = signed(v.text, v.si);
    return (
      <Neon w={460} h={310} o={f.panelOpacity} color={ORANGE}>
        <Lbl x={34} y={52} color={ORANGE} size={18}>{up ? 'CLIMBING' : 'DESCENDING'}</Lbl>
        <Num x={28} y={206} size={text.length > 4 ? 124 : 160} glow={ORANGE}>{text}</Num>
        <Lbl x={36} y={248} color={ORANGE} size={16}>{f.units === 'metric' ? 'METRES / HOUR' : 'FEET / HOUR'}</Lbl>
        <Lbl x={36} y={280} color="#fff" size={15}>{`+${g.text} ${g.unit.toUpperCase()} GAINED`}</Lbl>
        {[0, 1, 2].map((k) => {
          const y = up ? 210 - k * 46 : 110 + k * 46;
          const tip = up ? y - 38 : y + 38;
          return k < lit
            ? <GlowLine key={k} d={`M344 ${y}L382 ${tip}L420 ${y}`} color={ORANGE} width={10} />
            : <path key={k} d={`M344 ${y}L382 ${tip}L420 ${y}`} fill="none" stroke={ORANGE} strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" opacity="0.18" />;
        })}
      </Neon>
    );
  },
});

const summitProfile = defineWidget({
  id: 'elevationProfile.neon-summit', metric: 'elevationProfile', family: 'neon', name: 'Summit glow',
  requires: ['altitude', 'distance'], size: { w: 672, h: 290 },
  Component: (f) => {
    const id = useSvgIds('clip');
    const y1 = 256;
    const sf = summitFrame(f.ride, f.t, [30, 642, 110, y1]);
    const alt = read(f, 'altitude');
    const toGo = display('altitude', sf.toHigh, f.units);
    const good = sf.pts.filter((p) => Number.isFinite(p[1]));
    return (
      <Neon w={672} h={290} o={f.panelOpacity} color={ORANGE}>
        <defs><clipPath id={id.clip}><rect x="0" y="0" width={sf.cx} height="290" /></clipPath></defs>
        <Lbl x={34} y={52} color={ORANGE} size={18}>ALTITUDE</Lbl>
        <Num x={200} y={74} size={68} glow={ORANGE}>{alt.text}<tspan fontSize={30} dx={6}>{alt.unit.toUpperCase()}</tspan></Num>
        <Lbl x={638} y={52} color={ORANGE} size={16} anchor="end">{!toGo.missing ? `${toGo.text} ${toGo.unit.toUpperCase()} TO GO ▲` : sf.high ? 'HIGH POINT DONE ▲' : ''}</Lbl>
        <path d={linePath(sf.pts)} fill="none" stroke="#fff" strokeOpacity="0.25" strokeWidth="3" />
        <g clipPath={url(id.clip)}>
          {good.length > 1 && <path d={`${linePath(good)}L${good[good.length - 1][0]} ${y1}L${good[0][0]} ${y1}Z`} fill={ORANGE} fillOpacity="0.22" />}
          <GlowLine d={linePath(sf.pts)} color={ORANGE} />
        </g>
        {sf.here && <circle cx={sf.here.x} cy={sf.here.y} r="9" fill="#fff" />}
      </Neon>
    );
  },
});

const heading = defineWidget({
  id: 'heading.neon', metric: 'heading', family: 'neon', name: 'Glow compass',
  requires: ['heading'], size: { w: 560, h: 170 },
  Component: (f) => {
    const hdg = f.ride.at('heading', f.t);
    return (
      <Neon w={560} h={170} o={f.panelOpacity} color={CYAN}>
        <Lbl x={34} y={46} color={CYAN} size={16}>HEADING</Lbl>
        <Num x={526} y={54} size={46} anchor="end">{Number.isFinite(hdg) ? `${Math.round(hdg) % 360}°` : MISSING}</Num>
        {ribbonTicks(hdg, 90).map((t) => {
          const x = 280 + t.d * 2.6;
          const op = Math.max(0, 1 - Math.abs(t.d) / 95);
          if (t.name) {
            return (
              <Glowing key={t.hdg} soft on={Math.abs(t.d) < 25}>
                <text x={x} y={130} textAnchor="middle" fontFamily={NUM} fontSize="40" fill={t.name === 'N' ? PINK : CYAN} opacity={op}>{t.name}</text>
              </Glowing>
            );
          }
          return t.major ? <rect key={t.hdg} x={x - 2} y={96} width="4" height="16" rx="2" fill={CYAN} opacity={op} /> : null;
        })}
        <path d="M280 148 L268 164 L292 164 Z" fill="#fff" />
      </Neon>
    );
  },
});

const movingTime = defineWidget({
  id: 'movingTime.neon', metric: 'movingTime', family: 'neon', name: 'Moving clock',
  requires: ['speed'], size: { w: 460, h: 250 },
  defaults: { stoppedBelow: 0.5 },
  settings: MOVING_SETTINGS,
  Component: (f) => {
    const m = movingAt(f.ride, f.t, f.settings.stoppedBelow);
    const p = m && m.elapsed > 0 ? m.moving / m.elapsed : 0;
    return (
      <Neon w={460} h={250} o={f.panelOpacity} color={VIOLET}>
        <Lbl x={34} y={52} color={VIOLET} size={18}>MOVING</Lbl>
        <Num x={28} y={158} size={110} glow={VIOLET}>{m ? formatDuration(m.moving) : MISSING}</Num>
        <Lbl x={36} y={194} color="#fff" size={15}>{`ELAPSED ${m ? formatDuration(m.elapsed) : MISSING}`}</Lbl>
        <Segments x={36} y={212} w={388} h={12} n={24} p={p} a={VIOLET} b={PINK} />
      </Neon>
    );
  },
});

const runStrip = defineWidget({
  id: 'runStrip.neon', metric: 'runStrip', family: 'neon', name: 'Neon strip',
  requires: ['pace'], size: { w: 1080, h: 170 },
  Component: (f) => {
    const pc = read(f, 'pace');
    const hr = read(f, 'heartRate');
    const sp = read(f, 'stepCadence');
    const d = read(f, 'distance');
    const z = f.ride.hrZone(hr.si);
    const cells: [number, string, string, string][] = [
      [40, `PACE ${pc.unit.toUpperCase()}`, pc.text, CYAN], [310, 'BPM', hr.text, PINK], [540, 'SPM', sp.text, LIME], [770, d.unit.toUpperCase(), d.text, VIOLET],
    ];
    return (
      <Neon w={1080} h={170} o={f.panelOpacity} color={CYAN}>
        {cells.map(([x, label, text, c]) => (
          <g key={x}>
            <Lbl x={x} y={46} color={c} size={16}>{label}</Lbl>
            <Num x={x - 4} y={146} size={104} glow={c}>{text}</Num>
          </g>
        ))}
        {z && <circle cx="380" cy="40" r="8" fill={ZONE_COLORS[z.zone]} />}
        {z && <Lbl x={396} y={46} color="#fff" size={14}>{`Z${z.zone}`}</Lbl>}
      </Neon>
    );
  },
});

export const widgets = [
  speed, heartRate, hrZone, cadence, elevation, elevationProfile, gradient, temperature, distance, time, respiration, map, streetMap,
  pace, runStrip, stepCadence, steps, splits, climbRate, summitProfile, heading, movingTime,
];
