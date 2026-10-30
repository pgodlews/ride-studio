/**
 * Pro broadcast — race-TV lower thirds: slanted navy blocks, colour tabs, condensed
 * italic numerals, Tour-style stage profile coloured by gradient category.
 */
import type { ReactNode, SVGProps } from 'react';
import { areaPath, buildProfile, clamp, frac, gradeColor, linePath, projectRoute, routePoints, routePosition, ZONE_COLORS, ZONE_NAMES } from '../../core/geometry';
import { elapsedAt, movingAt, splitAt, summitFrame } from '../../core/activity';
import { display, formatDuration, grouped, MISSING, pad2 } from '../../core/units';
import { defineWidget, type FamilyInfo, type WidgetFrame } from '../../core/widget';
import { beatScale, heartPath, read, signed, Svg, url, useSvgIds } from '../shared';
import { avgPace, cardinal, Foot, footfall, MOVING_SETTINGS, paceTrail, ribbonTicks, splitRows, splitText, stepsAt } from '../foot';
import { OSM_SETTINGS, OsmMap, type OsmSettings } from '../osm';

export const family: FamilyInfo = { id: 'broadcast', name: 'Pro broadcast', tagline: 'Race-TV graphics: slanted blocks, bold italics.' };

const FONT = "'Barlow Condensed', 'Arial Narrow', sans-serif";
const NAVY = '11,30,63';
const YELLOW = '#FFD400';
const RED = '#E4002B';
const STEEL = '#A9BCD9';

const para = (x: number, y: number, w: number, h: number, sk: number) => `M${x + sk} ${y}H${x + w}L${x + w - sk} ${y + h}H${x}Z`;

function Block({ w, h, o, y = 30, sk = 18 }: { w: number; h: number; o: number; y?: number; sk?: number }) {
  return <path d={para(0, y, w, h - y, sk)} fill={`rgba(${NAVY},${o})`} />;
}

function Tab({ text, color = YELLOW, ink = `rgb(${NAVY})`, w, icon }: { text: string; color?: string; ink?: string; w: number; icon?: ReactNode }) {
  return (
    <g>
      <path d={para(8, 0, w, 38, 10)} fill={color} />
      {icon}
      <text x={icon ? 52 : 26} y={28} fill={ink} fontFamily={FONT} fontWeight={800} fontStyle="italic" fontSize={25} letterSpacing={1}>{text}</text>
    </g>
  );
}

/** Text with a soft dark halo so it survives on footage when the block is transparent. */
function T({ o, children, ...p }: { o: number; children: ReactNode } & SVGProps<SVGTextElement>) {
  return (
    <text fontFamily={FONT} fontStyle="italic" fontWeight={800} stroke={`rgba(0,0,0,${0.45 * (1 - o)})`} strokeWidth={5} paintOrder="stroke" strokeLinejoin="round" {...p}>
      {children}
    </text>
  );
}

function Big({ f, x = 34, y, size = 104, text, unit, unitColor = YELLOW }: { f: WidgetFrame; x?: number; y: number; size?: number; text: string; unit?: string; unitColor?: string }) {
  return (
    <T o={f.panelOpacity} x={x} y={y} fill="#fff" fontSize={size} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {text}
      {unit && <tspan dx={8} fontSize={size * 0.34} fill={unitColor} letterSpacing={1}>{unit.toUpperCase()}</tspan>}
    </T>
  );
}

function Side({ f, x, label, value, color = STEEL }: { f: WidgetFrame; x: number; label: string; value: string; color?: string }) {
  return (
    <g>
      <T o={f.panelOpacity} x={x} y={78} fill={color} fontSize={20} fontWeight={700} letterSpacing={1} textAnchor="end">{label}</T>
      <T o={f.panelOpacity} x={x} y={122} fill="#fff" fontSize={44} textAnchor="end">{value}</T>
    </g>
  );
}

function Bar({ w, h, p, color }: { w: number; h: number; p: number; color: string }) {
  const W = (w - 40) * clamp(p || 0, 0, 1);
  return <path d={para(16, h - 7, W, 7, 2)} fill={color} />;
}

/** The standard lower-third: tab + block + big number, with optional right column. */
function Lower({ f, w, h = 150, tab, tabColor, tabInk, icon, text, size, unit, unitColor, side, bar, children }: {
  f: WidgetFrame; w: number; h?: number; tab: string; tabColor?: string; tabInk?: string; icon?: ReactNode;
  text: string; size?: number; unit?: string; unitColor?: string; side?: ReactNode; bar?: { p: number; color: string }; children?: ReactNode;
}) {
  return (
    <Svg w={w} h={h}>
      <Block w={w} h={h} o={f.panelOpacity} />
      <Tab text={tab} color={tabColor} ink={tabInk} w={Math.min(w - 40, tab.length * 13 + (icon ? 70 : 44))} icon={icon} />
      <Big f={f} y={h - 26} size={size} text={text} unit={unit} unitColor={unitColor} />
      {side}
      {bar && <Bar w={w} h={h} p={bar.p} color={bar.color} />}
      {children}
    </Svg>
  );
}

const speed = defineWidget({
  id: 'speed.broadcast', metric: 'speed', family: 'broadcast', name: 'Speed lower third',
  requires: ['speed'], size: { w: 460, h: 150 },
  Component: (f) => {
    const v = read(f, 'speed');
    const max = f.ride.extent('speed')[1];
    return <Lower f={f} w={460} tab="SPEED" text={v.text} unit={v.unit} bar={{ p: v.si / max, color: YELLOW }}
      side={<Side f={f} x={420} label="MAX" value={display('speed', max, f.units).text} />} />;
  },
});

const heartRate = defineWidget({
  id: 'heartRate.broadcast', metric: 'heartRate', family: 'broadcast', name: 'Heart-rate lower third',
  requires: ['heartRate'], size: { w: 400, h: 150 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const z = f.ride.hrZone(v.si);
    const s = beatScale(f.ride.at('heartBeats', f.t), 0.2);
    return (
      <Lower f={f} w={400} tab="HEART RATE" tabColor={RED} tabInk="#fff" text={v.text} unit={v.unit} unitColor="#FF6A7D"
        icon={<path d={heartPath(11)} transform={`translate(34 19) scale(${s})`} fill="#fff" />}
        bar={z ? { p: (z.zone - 1 + z.position) / 5, color: ZONE_COLORS[z.zone] } : undefined}
        side={z && <Side f={f} x={364} label="ZONE" value={`Z${z.zone}`} color={ZONE_COLORS[z.zone]} />} />
    );
  },
});

const cadence = defineWidget({
  id: 'cadence.broadcast', metric: 'cadence', family: 'broadcast', name: 'Cadence lower third',
  requires: ['cadence'], size: { w: 340, h: 150 },
  Component: (f) => {
    const v = read(f, 'cadence');
    return <Lower f={f} w={340} tab="CADENCE" text={v.text} unit={v.unit} bar={{ p: v.si / 120, color: '#7CFF6B' }} />;
  },
});

const elevation = defineWidget({
  id: 'elevation.broadcast', metric: 'elevation', family: 'broadcast', name: 'Altitude lower third',
  requires: ['altitude'], size: { w: 400, h: 150 },
  Component: (f) => {
    const v = read(f, 'altitude');
    const g = read(f, 'ascent');
    return <Lower f={f} w={400} tab="ALTITUDE" text={v.text} unit={v.unit}
      side={<Side f={f} x={362} label="GAIN" value={`+${g.text}`} />} />;
  },
});

const temperature = defineWidget({
  id: 'temperature.broadcast', metric: 'temperature', family: 'broadcast', name: 'Temperature tab',
  requires: ['temperature'], size: { w: 260, h: 150 },
  Component: (f) => {
    const v = read(f, 'temperature');
    return <Lower f={f} w={260} tab="TEMP" text={v.text} unit={v.unit} />;
  },
});

const distance = defineWidget({
  id: 'distance.broadcast', metric: 'distance', family: 'broadcast', name: 'Distance / to go',
  requires: ['distance'], size: { w: 480, h: 150 },
  Component: (f) => {
    const v = read(f, 'distance', 1);
    const total = f.ride.extent('distance')[1];
    const left = display('distance', Math.max(0, total - v.si), f.units, 1);
    return <Lower f={f} w={480} tab="DISTANCE" text={v.text} unit={v.unit} bar={{ p: v.si / total, color: YELLOW }}
      side={<Side f={f} x={440} label="TO GO" value={v.missing ? MISSING : left.text} color={YELLOW} />} />;
  },
});

const time = defineWidget({
  id: 'time.broadcast', metric: 'time', family: 'broadcast', name: 'Race clock',
  requires: [], size: { w: 500, h: 150 },
  Component: (f) => {
    const lt = f.ride.localTime(f.t);
    return <Lower f={f} w={500} tab="RIDE TIME" text={formatDuration(f.t)}
      side={<Side f={f} x={462} label={lt.label} value={`${pad2(lt.h)}:${pad2(lt.m)}`} />} />;
  },
});

const respiration = defineWidget({
  id: 'respiration.broadcast', metric: 'respiration', family: 'broadcast', name: 'Breathing tab',
  requires: ['respiration'], size: { w: 340, h: 150 },
  Component: (f) => {
    const v = read(f, 'respiration');
    return <Lower f={f} w={340} tab="BREATHING" text={v.text} unit={v.unit}
      side={<T o={f.panelOpacity} x={300} y={76} fill={STEEL} fontSize={18} textAnchor="end">EST.</T>} />;
  },
});

const gradient = defineWidget({
  id: 'gradient.broadcast', metric: 'gradient', family: 'broadcast', name: 'Gradient wedge',
  requires: ['gradient'], size: { w: 350, h: 150 },
  Component: (f) => {
    const v = read(f, 'gradient');
    const c = gradeColor(v.si);
    const g = clamp(v.si || 0, -15, 15);
    const rise = (Math.abs(g) / 15) * 70 + 4;
    const wedge = g >= 0 ? `M246 128 L318 128 L318 ${128 - rise} Z` : `M246 128 L318 128 L246 ${128 - rise} Z`;
    return (
      <Lower f={f} w={350} tab="GRADIENT" tabColor={c} text={signed(v.text, v.si)} unit="%" unitColor={c}>
        <path d={wedge} fill={c} />
      </Lower>
    );
  },
});

const hrZone = defineWidget({
  id: 'hrZone.broadcast', metric: 'hrZone', family: 'broadcast', name: 'Zone block',
  requires: ['heartRate'], size: { w: 460, h: 150 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const z = f.ride.hrZone(v.si);
    const c = z ? ZONE_COLORS[z.zone] : STEEL;
    return (
      <Svg w={460} h={150}>
        <Block w={460} h={150} o={f.panelOpacity} />
        <Tab text="HR ZONE" w={150} />
        <path d={para(14, 30, 120, 120, 18)} fill={c} />
        <T o={1} x={72} y={128} fill={`rgb(${NAVY})`} stroke="none" fontSize={104} textAnchor="middle">{z ? z.zone : '–'}</T>
        <T o={f.panelOpacity} x={150} y={92} fill="#fff" fontSize={48}>{z ? ZONE_NAMES[z.zone].toUpperCase() : MISSING}</T>
        <T o={f.panelOpacity} x={150} y={128} fill={STEEL} fontSize={28} fontWeight={700}>{`${v.text} BPM`}</T>
        {[1, 2, 3, 4, 5].map((k) => (
          <path key={k} d={para(318 + (k - 1) * 23, 112, 19, 16, 4)} fill={ZONE_COLORS[k]} opacity={z && k <= z.zone ? 1 : 0.25} />
        ))}
      </Svg>
    );
  },
});

const elevationProfile = defineWidget({
  id: 'elevationProfile.broadcast', metric: 'elevationProfile', family: 'broadcast', name: 'Stage profile',
  requires: ['altitude', 'distance'], size: { w: 680, h: 290 },
  Component: (f) => {
    const id = useSvgIds('future');
    const prof = buildProfile(f.ride, 220);
    const [d0, d1] = f.ride.extent('distance');
    const [a0, a1] = f.ride.extent('altitude');
    const [x0, x1, y0, y1] = [30, 650, 92, 236];
    const X = (d: number) => x0 + ((x1 - x0) * (d - d0)) / Math.max(1, d1 - d0);
    const Y = (a: number) => y1 - ((y1 - y0) * (a - a0)) / Math.max(1, a1 - a0);
    const dNow = f.ride.at('distance', f.t);
    const cx = Number.isFinite(dNow) ? X(dNow) : x0;
    const kmStep = f.units === 'metric' ? 5000 : 8046.72;
    const ticks = [];
    for (let d = kmStep; d < d1; d += kmStep) ticks.push(d);
    const alt = read(f, 'altitude');
    const dist = read(f, 'distance', 1);
    return (
      <Svg w={680} h={290}>
        <defs>
          <clipPath id={id.future}><rect x={cx} y={0} width={680} height={290} /></clipPath>
        </defs>
        <Block w={680} h={290} o={f.panelOpacity} sk={24} />
        <Tab text="STAGE PROFILE" w={210} />
        <T o={f.panelOpacity} x={636} y={74} fill="#fff" fontSize={34} textAnchor="end">
          {dist.text}<tspan fill={YELLOW} fontSize={20} dx={4}>{dist.unit.toUpperCase()}</tspan>
          <tspan dx={18}>{alt.text}</tspan><tspan fill={YELLOW} fontSize={20} dx={4}>{alt.unit.toUpperCase()}</tspan>
        </T>
        {prof.slice(1).map((p, k) => {
          const a = prof[k];
          if (![a.d, a.alt, p.d, p.alt].every(Number.isFinite)) return null;
          return <path key={k} d={`M${X(a.d).toFixed(1)} ${Y(a.alt).toFixed(1)}L${X(p.d).toFixed(1)} ${Y(p.alt).toFixed(1)}L${X(p.d).toFixed(1)} ${y1}L${X(a.d).toFixed(1)} ${y1}Z`}
            fill={gradeColor(p.grade)} stroke={gradeColor(p.grade)} strokeWidth="0.6" />;
        })}
        <path d={linePath(prof.map((p) => [X(p.d), Y(p.alt)]))} fill="none" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
        <rect x={cx} y={y0 - 20} width={x1 - cx + 2} height={y1 - y0 + 21} fill={`rgba(${NAVY},0.55)`} clipPath={url(id.future)} />
        {f.ride.meta.climbs.map((c) => {
          const top = buildProfile(f.ride, 220).reduce((m, p) => (p.d >= c.startDistance && p.d <= c.endDistance && p.alt > m.alt ? p : m), { d: c.endDistance, alt: -Infinity } as { d: number; alt: number });
          const x = X(top.d);
          const y = Number.isFinite(top.alt) ? Y(top.alt) - 12 : y0;
          return (
            <g key={c.number}>
              <line x1={x} x2={x} y1={y} y2={y - 16} stroke="#fff" strokeWidth="1.5" />
              <path d={para(x - 20, y - 40, 40, 24, 5)} fill="#fff" />
              <text x={x} y={y - 22} textAnchor="middle" fontFamily={FONT} fontWeight={800} fontStyle="italic" fontSize={18} fill={`rgb(${NAVY})`}>{`C${c.number}`}</text>
            </g>
          );
        })}
        <line x1={x0} x2={x1} y1={y1 + 1} y2={y1 + 1} stroke={STEEL} strokeWidth="1" opacity="0.6" />
        <line x1={x0} x2={cx} y1={y1 + 1} y2={y1 + 1} stroke={YELLOW} strokeWidth="4" />
        {ticks.map((d) => (
          <g key={d}>
            <line x1={X(d)} x2={X(d)} y1={y1 + 1} y2={y1 + 9} stroke={STEEL} strokeWidth="1.5" />
            <T o={1} stroke="none" x={X(d)} y={y1 + 30} fill={STEEL} fontSize={18} fontWeight={700} textAnchor="middle">{display('distance', d, f.units, 0).text}</T>
          </g>
        ))}
        {Number.isFinite(dNow) && (
          <g>
            <line x1={cx} x2={cx} y1={y0 - 18} y2={y1} stroke={YELLOW} strokeWidth="2.5" />
            <path d={`M${cx - 11} ${y0 - 34} h22 l-11 16 Z`} fill={YELLOW} />
          </g>
        )}
      </Svg>
    );
  },
});

const map = defineWidget({
  id: 'map.broadcast', metric: 'map', family: 'broadcast', name: 'Live route card',
  requires: ['lat', 'lon'], size: { w: 360, h: 330 },
  defaults: { privacyTrimMetres: 500 },
  settings: [{ key: 'privacyTrimMetres', label: 'Hide start/finish (m)', type: 'number', min: 0, max: 3000, step: 100 }],
  Component: (f) => {
    const route = projectRoute(f.ride, f.settings.privacyTrimMetres);
    const [ox, oy, S] = [44, 58, 260];
    const P = (p: [number, number]) => [ox + p[0] * S, oy + p[1] * S] as [number, number];
    const pos = route && routePosition(route, f.t);
    const shown = route ? routePoints(route, route.shownFrom, route.shownTo).map(P) : [];
    const done = route && pos ? [...routePoints(route, route.shownFrom, pos.index).map(P), P(pos.pt)] : [];
    const blink = frac(f.t) < 0.5;
    return (
      <Svg w={360} h={330}>
        <Block w={360} h={330} o={f.panelOpacity} sk={22} />
        <Tab text="ROUTE" w={110} />
        <g transform="translate(262 4)">
          <path d={para(0, 0, 84, 30, 8)} fill={RED} />
          <circle cx="22" cy="15" r="5" fill="#fff" opacity={blink ? 1 : 0.3} />
          <text x="34" y="24" fontFamily={FONT} fontWeight={800} fontStyle="italic" fontSize={20} fill="#fff">LIVE</text>
        </g>
        <path d={linePath(shown)} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath(done)} fill="none" stroke={YELLOW} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" />
        {pos && (() => {
          const [x, y] = P(pos.pt);
          return <circle cx={x} cy={y} r="10" fill={RED} stroke="#fff" strokeWidth="4" />;
        })()}
      </Svg>
    );
  },
});

const streetMap = defineWidget<OsmSettings>({
  id: 'streetMap.broadcast', metric: 'streetMap', family: 'broadcast', name: 'Live street map',
  requires: ['lat', 'lon'], size: { w: 380, h: 420 },
  defaults: { shape: 'square', zoom: 15, theme: 'standard', headingUp: false, privacyTrimMetres: 500 },
  settings: OSM_SETTINGS,
  Component: (f) => {
    const s = f.settings;
    const circle = s.shape === 'circle';
    const blink = frac(f.t) < 0.5;
    const border = { fill: 'none', stroke: `rgba(${NAVY},${0.35 + 0.65 * f.panelOpacity})`, strokeWidth: 10 };
    return (
      <Svg w={380} h={420}>
        <OsmMap f={f} s={s} size={364} x={8} y={48} radius={6} track={`rgba(${NAVY},0.55)`} done="#F5B800" marker={RED} />
        {circle ? <circle cx="190" cy="230" r="183" {...border} /> : <rect x="3" y="43" width="374" height="374" rx="8" {...border} />}
        <Tab text="LIVE MAP" w={150} />
        <g transform="translate(292 4)">
          <path d={para(0, 0, 84, 30, 8)} fill={RED} />
          <circle cx="22" cy="15" r="5" fill="#fff" opacity={blink ? 1 : 0.3} />
          <text x="34" y="24" fontFamily={FONT} fontWeight={800} fontStyle="italic" fontSize={20} fill="#fff">LIVE</text>
        </g>
      </Svg>
    );
  },
});

// ---------------------------------------------------------------- run · walk · hike

const pace = defineWidget({
  id: 'pace.broadcast', metric: 'pace', family: 'broadcast', name: 'Pace lower third',
  requires: ['pace'], size: { w: 540, h: 150 },
  Component: (f) => {
    const v = read(f, 'pace');
    const n = 48;
    const [x0, x1, y0, y1] = [330, 500, 54, 104];
    const pts = paceTrail(f, 60, n).map((h, k) => [x0 + ((x1 - x0) * k) / (n - 1), y1 - (y1 - y0) * h] as [number, number]);
    const end = pts[n - 1];
    return (
      <Lower f={f} w={540} tab="PACE" text={v.text} size={v.text.length > 4 ? 84 : 104} unit={f.units === 'metric' ? '/km' : '/mi'}>
        <path d={linePath(pts)} fill="none" stroke={YELLOW} strokeWidth="3.5" strokeLinejoin="round" />
        {Number.isFinite(end[1]) && <circle cx={end[0]} cy={end[1]} r="6" fill={YELLOW} />}
        <T o={f.panelOpacity} x={500} y={132} fill={STEEL} fontSize={20} fontWeight={700} letterSpacing={1} textAnchor="end">{`AVG ${avgPace(f).text}`}</T>
      </Lower>
    );
  },
});

const stepCadence = defineWidget({
  id: 'stepCadence.broadcast', metric: 'stepCadence', family: 'broadcast', name: 'Cadence + footfall',
  requires: ['stepCadence'], size: { w: 400, h: 150 },
  Component: (f) => {
    const v = read(f, 'stepCadence');
    const ff = footfall(f, 0.25);
    return (
      <Lower f={f} w={400} tab="CADENCE" text={v.text} unit="spm">
        <Foot x={308} y={102} s={0.56} fill={ff.left > 0.25 ? YELLOW : '#fff'} opacity={ff.left} flip />
        <Foot x={350} y={84} s={0.56} fill={ff.right > 0.25 ? YELLOW : '#fff'} opacity={ff.right} />
      </Lower>
    );
  },
});

const splits = defineWidget({
  id: 'splits.broadcast', metric: 'splits', family: 'broadcast', name: 'Split table',
  requires: ['distance'], size: { w: 460, h: 300 },
  Component: (f) => {
    const s = splitAt(f.ride, f.t, f.units);
    const unit = f.units === 'metric' ? 'KM' : 'MI';
    const rows = splitRows(s);
    const p = clamp(s?.progress ?? NaN, 0, 1);
    const o = f.panelOpacity;
    return (
      <Svg w={460} h={300}>
        <Tab text={`${unit} SPLITS`} color={RED} ink="#fff" w={150} />
        <path d={para(0, 46, 440, 44, 14)} fill={`rgba(${NAVY},${o})`} />
        <T o={o} x={26} y={78} fill={YELLOW} fontSize={26}>{s ? `${unit} ${s.current}` : unit}</T>
        <T o={o} x={124} y={80} fill="#fff" fontSize={34} style={{ fontVariantNumeric: 'tabular-nums' }}>{s ? splitText(s.elapsed) : MISSING}</T>
        <rect x="236" y="62" width="174" height="10" fill="rgba(255,255,255,0.2)" />
        {Number.isFinite(p) && <rect x="236" y="62" width={174 * p} height="10" fill={YELLOW} />}
        {rows.map((r, k) => {
          const y = 96 + k * 46;
          return (
            <g key={r.n}>
              <path d={para(0, y - 4, 440, 42, 14)} fill={`rgba(${NAVY},${o})`} />
              {r.best && <path d={para(0, y - 4, 66, 42, 14)} fill={YELLOW} />}
              <T o={r.best ? 1 : o} x={26} y={y + 28} fill={r.best ? `rgb(${NAVY})` : '#fff'} stroke={r.best ? 'none' : undefined} fontSize={28}>{r.n}</T>
              <T o={o} x={96} y={y + 28} fill="#fff" fontSize={32} style={{ fontVariantNumeric: 'tabular-nums' }}>{r.text}</T>
              <T o={o} x={410} y={y + 28} fill={r.faster ? '#7CFF6B' : STEEL} fontSize={26} textAnchor="end">{r.delta}</T>
            </g>
          );
        })}
      </Svg>
    );
  },
});

const steps = defineWidget({
  id: 'steps.broadcast', metric: 'steps', family: 'broadcast', name: 'Steps lower third',
  requires: ['steps'], size: { w: 440, h: 150 },
  Component: (f) => {
    const d = read(f, 'distance');
    return (
      <Lower f={f} w={440} tab="STEPS" text={grouped(stepsAt(f))}
        side={<Side f={f} x={404} label={d.unit.toUpperCase()} value={d.text} />}>
        <T o={f.panelOpacity} x={124} y={28} fill={STEEL} fontSize={18} fontWeight={700} letterSpacing={1}>EST.</T>
      </Lower>
    );
  },
});

const climbRate = defineWidget({
  id: 'climbRate.broadcast', metric: 'climbRate', family: 'broadcast', name: 'Vertical lower third',
  requires: ['climbRate'], size: { w: 460, h: 150 },
  Component: (f) => {
    const v = read(f, 'climbRate');
    const g = read(f, 'ascent');
    const mh = v.si * 3600;
    const lit = Number.isFinite(mh) ? [150, 400, 700].filter((x) => Math.abs(mh) >= x).length : 0;
    const up = !(mh < 0);
    return (
      <Lower f={f} w={460} tab="VERTICAL" text={signed(v.text, v.si)} unit={v.unit}>
        <T o={f.panelOpacity} x={440} y={28} fill="#fff" fontSize={20} fontWeight={700} letterSpacing={1} textAnchor="end">{`GAIN +${g.text} ${g.unit.toUpperCase()}`}</T>
        {[0, 1, 2].map((k) => {
          const y = up ? 118 - k * 22 : 70 + k * 22;
          const tip = up ? y - 18 : y + 18;
          return <path key={k} d={`M368 ${y} L392 ${tip} L416 ${y}`} fill="none" stroke={up ? YELLOW : STEEL} strokeWidth="7" opacity={k < lit ? 1 : 0.22} />;
        })}
      </Lower>
    );
  },
});

const summitProfile = defineWidget({
  id: 'elevationProfile.broadcast-summit', metric: 'elevationProfile', family: 'broadcast', name: 'Summit profile',
  requires: ['altitude', 'distance'], size: { w: 672, h: 220 },
  Component: (f) => {
    const id = useSvgIds('clip');
    const y1 = 178;
    const sf = summitFrame(f.ride, f.t, [24, 640, 70, y1]);
    const alt = read(f, 'altitude');
    const toGo = display('altitude', sf.toHigh, f.units);
    const o = f.panelOpacity;
    return (
      <Svg w={672} h={220}>
        <defs><clipPath id={id.clip}><rect x="0" y="0" width={sf.cx} height="220" /></clipPath></defs>
        <path d={para(0, 46, 662, 162, 18)} fill={`rgba(${NAVY},${o})`} />
        <Tab text="PROFILE" color={RED} ink="#fff" w={140} />
        <path d={areaPath(sf.pts, y1)} fill="rgba(169,188,217,0.22)" />
        <g clipPath={url(id.clip)}><path d={areaPath(sf.pts, y1)} fill={YELLOW} fillOpacity="0.88" /></g>
        {sf.here && (
          <g>
            <line x1={sf.here.x} x2={sf.here.x} y1={sf.here.y - 6} y2={y1} stroke="#fff" strokeWidth="3" />
            <T o={o} x={sf.here.x > 330 ? sf.here.x - 12 : sf.here.x + 12} y={Math.max(96, sf.here.y - 12)} fill="#fff" fontSize={30} textAnchor={sf.here.x > 330 ? 'end' : 'start'}>{`${alt.text} ${alt.unit.toUpperCase()}`}</T>
          </g>
        )}
        <T o={o} x={640} y={30} fill={YELLOW} fontSize={24} textAnchor="end">{!toGo.missing ? `${toGo.text} ${toGo.unit.toUpperCase()} TO TOP` : sf.high ? 'HIGH POINT PASSED' : ''}</T>
        <T o={o} x={26} y={200} fill={STEEL} fontSize={18} fontWeight={700}>0</T>
        <T o={o} x={634} y={200} fill={STEEL} fontSize={18} fontWeight={700} textAnchor="end">{`${display('distance', sf.total, f.units, 1).text} ${display('distance', sf.total, f.units).unit.toUpperCase()}`}</T>
      </Svg>
    );
  },
});

const heading = defineWidget({
  id: 'heading.broadcast', metric: 'heading', family: 'broadcast', name: 'Heading tape',
  requires: ['heading'], size: { w: 560, h: 160 },
  Component: (f) => {
    const hdg = f.ride.at('heading', f.t);
    const o = f.panelOpacity;
    return (
      <Svg w={560} h={160}>
        <path d={para(0, 48, 550, 100, 16)} fill={`rgba(${NAVY},${o})`} />
        <Tab text="HEADING" w={130} />
        <T o={o} x={530} y={34} fill="#fff" fontSize={30} textAnchor="end">{Number.isFinite(hdg) ? `${cardinal(hdg)} ${Math.round(hdg) % 360}°` : MISSING}</T>
        {ribbonTicks(hdg, 120).map((t) => {
          const x = 270 + t.d * 1.6;
          if (x < 40 || x > 510) return null;
          return (
            <g key={t.hdg}>
              <line x1={x} x2={x} y1="72" y2={t.major ? 86 : 80} stroke="#fff" strokeWidth={t.major ? 2 : 1} opacity="0.75" />
              {t.name && <T o={o} x={x} y={128} fill={t.name === 'N' ? RED : '#fff'} fontSize={28} textAnchor="middle">{t.name}</T>}
            </g>
          );
        })}
        <path d="M261 56 L279 56 L270 70 Z" fill={YELLOW} />
      </Svg>
    );
  },
});

const movingTime = defineWidget({
  id: 'movingTime.broadcast', metric: 'movingTime', family: 'broadcast', name: 'Moving clock',
  requires: ['speed'], size: { w: 500, h: 150 },
  defaults: { stoppedBelow: 0.5 },
  settings: MOVING_SETTINGS,
  Component: (f) => {
    const m = movingAt(f.ride, f.t, f.settings.stoppedBelow);
    return (
      <Svg w={500} h={150}>
        <Block w={500} h={150} o={f.panelOpacity} />
        <Tab text="MOVING TIME" w={170} />
        <Big f={f} y={124} size={82} text={m ? formatDuration(m.moving) : MISSING} />
        <Side f={f} x={462} label="ELAPSED" value={m ? formatDuration(m.elapsed) : MISSING} />
        <Bar w={500} h={150} p={m && m.elapsed > 0 ? m.moving / m.elapsed : 0} color={YELLOW} />
      </Svg>
    );
  },
});

const runStrip = defineWidget({
  id: 'runStrip.broadcast', metric: 'runStrip', family: 'broadcast', name: 'Run ticker',
  requires: ['pace'], size: { w: 1080, h: 130 },
  Component: (f) => {
    const d = read(f, 'distance');
    const pc = read(f, 'pace');
    const hr = read(f, 'heartRate');
    const sp = read(f, 'stepCadence');
    const z = f.ride.hrZone(hr.si);
    const o = f.panelOpacity;
    const ink = `rgb(${NAVY})`;
    const num = { fontVariantNumeric: 'tabular-nums' } as const;
    return (
      <Svg w={1080} h={130}>
        <path d={para(0, 0, 1080, 112, 24)} fill={`rgba(${NAVY},${o})`} />
        <path d={para(0, 0, 210, 112, 24)} fill={YELLOW} />
        <T o={1} x={30} y={46} fill={ink} stroke="none" fontSize={26}>{d.unit.toUpperCase()}</T>
        <T o={1} x={30} y={98} fill={ink} stroke="none" fontSize={56} style={num}>{d.text}</T>
        <T o={o} x={236} y={44} fill={YELLOW} fontSize={22}>PACE</T>
        <T o={o} x={236} y={98} fill="#fff" fontSize={58} style={num}>{pc.text}<tspan dx={6} fontSize={22} fill={STEEL}>{f.units === 'metric' ? '/KM' : '/MI'}</tspan></T>
        <T o={o} x={470} y={44} fill="#FF6A7D" fontSize={22}>HEART RATE</T>
        <T o={o} x={470} y={98} fill="#fff" fontSize={58} style={num}>{hr.text}</T>
        {z && <path d={para(572, 60, 76, 38, 6)} fill={ZONE_COLORS[z.zone]} />}
        {z && <T o={1} x={588} y={89} fill={ink} stroke="none" fontSize={28}>{`Z${z.zone}`}</T>}
        <T o={o} x={700} y={44} fill="#7CFF6B" fontSize={22}>CADENCE</T>
        <T o={o} x={700} y={98} fill="#fff" fontSize={58} style={num}>{sp.text}<tspan dx={6} fontSize={22} fill={STEEL}>SPM</tspan></T>
        <T o={o} x={890} y={44} fill={STEEL} fontSize={22}>TIME</T>
        <T o={o} x={890} y={98} fill="#fff" fontSize={50} style={num}>{formatDuration(elapsedAt(f.ride, f.t))}</T>
        <rect x="0" y="116" width="1056" height="8" fill={RED} />
      </Svg>
    );
  },
});

export const widgets = [
  speed, heartRate, hrZone, cadence, elevation, elevationProfile, gradient, temperature, distance, time, respiration, map, streetMap,
  pace, runStrip, stepCadence, steps, splits, climbRate, summitProfile, heading, movingTime,
];
