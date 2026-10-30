/**
 * Instrument gauges — cockpit/watch instruments: brushed bezels, analog dials and
 * needles, an altimeter, inclinometer, odometer drums and a heading-up moving map.
 */
import type { ReactNode } from 'react';
import { arc, clamp, frac, linePath, polar, projectRoute, routePoints, routePosition, ZONE_COLORS, ZONE_NAMES } from '../../core/geometry';
import { movingAt, splitAt, summitFrame, typicalTopSpeed } from '../../core/activity';
import { convert, display, formatDuration, MISSING, pad2 } from '../../core/units';
import { defineWidget, type FamilyInfo, type WidgetFrame } from '../../core/widget';
import { beatScale, heartPath, read, signed, Svg, url, useSvgIds } from '../shared';
import { cardinal, Foot, footfall, MOVING_SETTINGS, splitRows, splitText, stepsAt } from '../foot';
import { NorthMark, OSM_SETTINGS, OsmMap, type OsmSettings } from '../osm';

export const family: FamilyInfo = { id: 'gauge', name: 'Instrument gauges', tagline: 'Analog dials, needles and bezels.' };

const FONT = "'Saira Variable', Saira, sans-serif";
const TICK = '#ECE6D6';
const DIM = '#8E939B';
const AMBER = '#FFB547';
const RED = '#FF4D3D';
const NEEDLE = '#FF6A3D';
const tnum = { fontVariantNumeric: 'tabular-nums' } as const;

/** Bezel + face. Bezel stays partly visible at 0 % panel opacity so the dial still reads. */
function Dial({ cx, cy, r, o }: { cx: number; cy: number; r: number; o: number }) {
  const id = useSvgIds('bezel', 'face');
  return (
    <g>
      <defs>
        <linearGradient id={id.bezel} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#6b7280" />
          <stop offset="0.45" stopColor="#1b1e24" />
          <stop offset="1" stopColor="#474d58" />
        </linearGradient>
        <radialGradient id={id.face} cx="0.5" cy="0.38" r="0.7">
          <stop offset="0" stopColor={`rgba(36,40,47,${o})`} />
          <stop offset="1" stopColor={`rgba(8,9,12,${o})`} />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r + 9} fill="none" stroke={url(id.bezel)} strokeWidth="9" opacity={0.45 + 0.55 * o} />
      <circle cx={cx} cy={cy} r={r + 4} fill={url(id.face)} />
      <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
    </g>
  );
}

function Ticks({ cx, cy, r, a0, a1, min, max, major, minor, label = (v) => String(v), labelR = r - 34, size = 22 }: {
  cx: number; cy: number; r: number; a0: number; a1: number; min: number; max: number; major: number; minor: number;
  label?: (v: number) => string; labelR?: number; size?: number;
}) {
  const out: ReactNode[] = [];
  const A = (v: number) => a0 + ((a1 - a0) * (v - min)) / (max - min);
  for (let v = min; v <= max + 1e-6; v += minor) {
    const isMajor = Math.abs(((v - min) / major) - Math.round((v - min) / major)) < 1e-6;
    const [x0, y0] = polar(cx, cy, r, A(v));
    const [x1, y1] = polar(cx, cy, r - (isMajor ? 16 : 8), A(v));
    out.push(<line key={`t${v}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={isMajor ? TICK : DIM} strokeWidth={isMajor ? 3 : 1.5} strokeLinecap="round" />);
    if (isMajor) {
      const [lx, ly] = polar(cx, cy, labelR, A(v));
      out.push(<text key={`l${v}`} x={lx} y={ly + size * 0.36} textAnchor="middle" fill={TICK} fontFamily={FONT} fontSize={size} fontWeight={560}>{label(Math.round(v * 100) / 100)}</text>);
    }
  }
  return <g>{out}</g>;
}

function Needle({ cx, cy, len, deg, color = NEEDLE, tail = 24, width = 5 }: { cx: number; cy: number; len: number; deg: number; color?: string; tail?: number; width?: number }) {
  const id = useSvgIds('glow');
  if (!Number.isFinite(deg)) return null;
  const tip = polar(cx, cy, len, deg);
  const l = polar(cx, cy, width, deg - 90);
  const r = polar(cx, cy, width, deg + 90);
  const t = polar(cx, cy, tail, deg + 180);
  return (
    <g>
      <defs>
        <filter id={id.glow} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor={color} floodOpacity="0.7" />
        </filter>
      </defs>
      <path d={`M${tip}L${l}L${t}L${r}Z`} fill={color} filter={url(id.glow)} />
      <circle cx={cx} cy={cy} r="13" fill="#23262c" stroke="#5b616b" strokeWidth="2" />
      <circle cx={cx} cy={cy} r="4.5" fill={color} />
    </g>
  );
}

const angleOf = (v: number, min: number, max: number, a0: number, a1: number) =>
  Number.isFinite(v) ? a0 + (a1 - a0) * clamp((v - min) / (max - min), 0, 1) : NaN;

function Readout({ cx, y, text, unit, size = 52, label }: { cx: number; y: number; text: string; unit?: string; size?: number; label?: string }) {
  return (
    <g fontFamily={FONT} textAnchor="middle">
      {label && <text x={cx} y={y - size - 6} fill={DIM} fontSize={15} fontWeight={600} letterSpacing={3}>{label}</text>}
      <text x={cx} y={y} fill="#fff" fontSize={size} fontWeight={600} style={tnum}>{text}</text>
      {unit && <text x={cx} y={y + 24} fill={DIM} fontSize={16} fontWeight={600} letterSpacing={2}>{unit.toUpperCase()}</text>}
    </g>
  );
}

/** Generic 270° dial used by several metrics. */
function RoundGauge({ f, size, min, max, major, minor, value, text, unit, label, bands, needleColor, children }: {
  f: WidgetFrame; size: number; min: number; max: number; major: number; minor: number; value: number;
  text: string; unit: string; label: string; bands?: { from: number; to: number; color: string; width?: number }[];
  needleColor?: string; children?: ReactNode;
}) {
  const c = size / 2;
  const r = c - 22;
  const [a0, a1] = [-135, 135];
  return (
    <Svg w={size} h={size}>
      <Dial cx={c} cy={c} r={r} o={f.panelOpacity} />
      {bands?.map((b, k) => (
        <path key={k} d={arc(c, c, r - 4, angleOf(b.from, min, max, a0, a1), angleOf(b.to, min, max, a0, a1))} fill="none" stroke={b.color} strokeWidth={b.width ?? 7} opacity="0.9" />
      ))}
      <Ticks cx={c} cy={c} r={r} a0={a0} a1={a1} min={min} max={max} major={major} minor={minor} size={size * 0.065} labelR={r - size * 0.11} />
      <Readout cx={c} y={c + size * 0.24} text={text} unit={unit} size={size * 0.15} />
      <text x={c} y={c - size * 0.16} textAnchor="middle" fill={DIM} fontFamily={FONT} fontSize={size * 0.045} fontWeight={600} letterSpacing={3}>{label}</text>
      {children}
      <Needle cx={c} cy={c} len={r - 10} deg={angleOf(value, min, max, a0, a1)} color={needleColor} />
    </Svg>
  );
}

const speed = defineWidget({
  id: 'speed.gauge', metric: 'speed', family: 'gauge', name: 'Speedometer',
  requires: ['speed'], size: { w: 340, h: 340 },
  Component: (f) => {
    const v = read(f, 'speed', 0);
    const max = Math.ceil(convert('speed', f.ride.extent('speed')[1], f.units) / 10) * 10 || 60;
    return (
      <RoundGauge f={f} size={340} min={0} max={max} major={10} minor={2} value={v.value} text={v.text} unit={v.unit} label="SPEED"
        bands={[{ from: 0, to: Number.isFinite(v.value) ? v.value : 0, color: AMBER, width: 4 }, { from: max * 0.85, to: max, color: RED }]} />
    );
  },
});

const heartRate = defineWidget({
  id: 'heartRate.gauge', metric: 'heartRate', family: 'gauge', name: 'Zoned HR dial',
  requires: ['heartRate'], size: { w: 300, h: 300 },
  Component: (f) => {
    const v = read(f, 'heartRate');
    const b = f.ride.meta.hrZones?.highBoundaries;
    const max = Math.ceil(((b?.[b.length - 1] ?? 190) + 5) / 20) * 20;
    const bands = b ? b.slice(0, -1).map((lo, k) => ({ from: lo, to: b[k + 1], color: ZONE_COLORS[k + 1] })) : [];
    const s = beatScale(f.ride.at('heartBeats', f.t), 0.25);
    return (
      <RoundGauge f={f} size={300} min={60} max={max} major={20} minor={5} value={v.value} text={v.text} unit={v.unit} label="" bands={bands}>
        <path d={heartPath(10)} transform={`translate(150 104) scale(${s})`} fill="#FF5A6E" />
      </RoundGauge>
    );
  },
});

const hrZone = defineWidget({
  id: 'hrZone.gauge', metric: 'hrZone', family: 'gauge', name: 'Zone semicircle',
  requires: ['heartRate'], size: { w: 360, h: 230 },
  Component: (f) => {
    const id = useSvgIds('face');
    const v = read(f, 'heartRate');
    const z = f.ride.hrZone(v.si);
    const [cx, cy, r] = [180, 196, 150];
    const deg = z ? -90 + clamp(z.zone - 1 + z.position, 0, 5) * 36 : NaN;
    const o = f.panelOpacity;
    return (
      <Svg w={360} h={230}>
        <defs>
          <radialGradient id={id.face} cx="0.5" cy="0.9" r="0.9">
            <stop offset="0" stopColor={`rgba(36,40,47,${o})`} />
            <stop offset="1" stopColor={`rgba(8,9,12,${o})`} />
          </radialGradient>
        </defs>
        <path d={`${arc(cx, cy, r + 12, -90, 90)}L${cx - r - 12} ${cy}Z`} fill={url(id.face)} />
        <path d={arc(cx, cy, r + 12, -90, 90)} fill="none" stroke="#3b414c" strokeWidth="7" opacity={0.45 + 0.55 * o} />
        {[1, 2, 3, 4, 5].map((k) => (
          <path key={k} d={arc(cx, cy, r - 10, -90 + (k - 1) * 36 + 1.5, -90 + k * 36 - 1.5)} fill="none" stroke={ZONE_COLORS[k]} strokeWidth="22" opacity={z?.zone === k ? 1 : 0.35} />
        ))}
        {[1, 2, 3, 4, 5].map((k) => {
          const [x, y] = polar(cx, cy, r - 46, -90 + (k - 0.5) * 36);
          return <text key={k} x={x} y={y + 7} textAnchor="middle" fontFamily={FONT} fontSize="20" fontWeight={600} fill={z?.zone === k ? '#fff' : DIM}>{k}</text>;
        })}
        <text x={cx} y={cy - 54} textAnchor="middle" fontFamily={FONT} fontSize="20" fontWeight={600} fill={z ? ZONE_COLORS[z.zone] : DIM} letterSpacing={2}>{z ? ZONE_NAMES[z.zone].toUpperCase() : MISSING}</text>
        <Needle cx={cx} cy={cy} len={r - 22} deg={deg} color="#fff" tail={0} width={4} />
        <text x={cx + 30} y={cy - 6} fontFamily={FONT} fontSize="22" fontWeight={600} fill="#fff" style={tnum}>{v.text}<tspan fill={DIM} fontSize="14" dx="4">BPM</tspan></text>
      </Svg>
    );
  },
});

const cadence = defineWidget({
  id: 'cadence.gauge', metric: 'cadence', family: 'gauge', name: 'Cadence dial',
  requires: ['cadence'], size: { w: 280, h: 280 },
  Component: (f) => {
    const v = read(f, 'cadence');
    return <RoundGauge f={f} size={280} min={0} max={140} major={20} minor={5} value={v.si} text={v.text} unit={v.unit} label="CADENCE"
      bands={[{ from: 80, to: 100, color: '#7BE07B' }]} needleColor="#7BE07B" />;
  },
});

const elevation = defineWidget({
  id: 'elevation.gauge', metric: 'elevation', family: 'gauge', name: 'Altimeter',
  requires: ['altitude'], size: { w: 290, h: 290 },
  Component: (f) => {
    const v = read(f, 'altitude');
    const rev = f.units === 'metric' ? 100 : 1000; // long hand: one turn per 100 m / 1000 ft
    const [c, r] = [145, 123];
    const long = Number.isFinite(v.value) ? (frac(v.value / rev) * 360) : NaN;
    const short = Number.isFinite(v.value) ? (frac(v.value / (rev * 10)) * 360) : NaN;
    return (
      <Svg w={290} h={290}>
        <Dial cx={c} cy={c} r={r} o={f.panelOpacity} />
        <Ticks cx={c} cy={c} r={r} a0={0} a1={360} min={0} max={10} major={1} minor={0.2} label={(n) => (n === 10 ? '' : String(n))} size={26} labelR={r - 38} />
        <text x={c} y={c - 46} textAnchor="middle" fontFamily={FONT} fontSize="15" fontWeight={600} letterSpacing={3} fill={DIM}>ALT</text>
        <text x={c} y={c - 28} textAnchor="middle" fontFamily={FONT} fontSize="12" fontWeight={600} letterSpacing={1} fill={DIM}>{f.units === 'metric' ? '×10 M' : '×100 FT'}</text>
        <rect x={c - 46} y={c + 30} width="92" height="34" rx="5" fill="#050608" stroke="#3b414c" />
        <text x={c} y={c + 55} textAnchor="middle" fontFamily={FONT} fontSize="22" fontWeight={600} fill="#fff" style={tnum}>{`${v.text} ${v.unit}`}</text>
        <Needle cx={c} cy={c} len={r - 58} deg={short} color={TICK} tail={14} width={8} />
        <Needle cx={c} cy={c} len={r - 8} deg={long} color={AMBER} tail={26} width={4} />
      </Svg>
    );
  },
});

const gradient = defineWidget({
  id: 'gradient.gauge', metric: 'gradient', family: 'gauge', name: 'Inclinometer',
  requires: ['gradient'], size: { w: 290, h: 290 },
  Component: (f) => {
    const id = useSvgIds('clip', 'sky', 'ground');
    const v = read(f, 'gradient');
    const tilt = (g: number) => clamp((Math.atan(g / 100) * 180) / Math.PI * 3, -50, 50); // ×3 so road grades read
    const ang = tilt(v.si || 0);
    const [c, r] = [145, 118];
    const o = 0.35 + 0.65 * f.panelOpacity;
    return (
      <Svg w={290} h={290}>
        <defs>
          <clipPath id={id.clip}><circle cx={c} cy={c} r={r} /></clipPath>
          <linearGradient id={id.sky} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0f2236" /><stop offset="1" stopColor="#2f5f8a" /></linearGradient>
          <linearGradient id={id.ground} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7a5230" /><stop offset="1" stopColor="#2c1d10" /></linearGradient>
        </defs>
        <Dial cx={c} cy={c} r={r} o={f.panelOpacity} />
        <g clipPath={url(id.clip)} opacity={o}>
          <g transform={`rotate(${-ang} ${c} ${c})`}>
            <rect x={c - 200} y={c - 200} width="400" height="200" fill={url(id.sky)} />
            <rect x={c - 200} y={c} width="400" height="200" fill={url(id.ground)} />
            <line x1={c - 200} x2={c + 200} y1={c} y2={c} stroke="#fff" strokeWidth="2.5" />
          </g>
        </g>
        {[-15, -10, -5, 0, 5, 10, 15].map((g) => {
          const a = 90 - tilt(g); // where the horizon's right end points at grade g
          const [x0, y0] = polar(c, c, r, a);
          const [x1, y1] = polar(c, c, r - (g % 10 === 0 ? 16 : 10), a);
          const [lx, ly] = polar(c, c, r + 22, a);
          return (
            <g key={g}>
              <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={TICK} strokeWidth={g === 0 ? 3 : 2} />
              {g % 10 === 0 && <text x={lx} y={ly + 5} textAnchor="middle" fontFamily={FONT} fontSize="13" fontWeight={600} fill={DIM}>{g > 0 ? `+${g}` : g}</text>}
            </g>
          );
        })}
        <path d={`M${c - 62} ${c} H${c - 24} L${c - 12} ${c + 12} L${c} ${c} L${c + 12} ${c + 12} L${c + 24} ${c} H${c + 62}`} fill="none" stroke={AMBER} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={c} cy={c} r="4" fill={AMBER} />
        <rect x={c - 52} y={c + 52} width="104" height="34" rx="5" fill="rgba(5,6,8,0.85)" stroke="#3b414c" />
        <text x={c} y={c + 77} textAnchor="middle" fontFamily={FONT} fontSize="22" fontWeight={600} fill="#fff" style={tnum}>{`${signed(v.text, v.si)}%`}</text>
      </Svg>
    );
  },
});

const temperature = defineWidget({
  id: 'temperature.gauge', metric: 'temperature', family: 'gauge', name: 'Thermo dial',
  requires: ['temperature'], size: { w: 230, h: 230 },
  Component: (f) => {
    const v = read(f, 'temperature');
    const [min, max] = f.units === 'metric' ? [-10, 40] : [10, 110];
    const segs = 24;
    return (
      <RoundGauge f={f} size={230} min={min} max={max} major={f.units === 'metric' ? 10 : 20} minor={f.units === 'metric' ? 2 : 5} value={v.value} text={v.text} unit={v.unit} label="TEMP">
        {Array.from({ length: segs }, (_, k) => {
          const a = -135 + (270 * k) / segs;
          const hue = 210 - (k / (segs - 1)) * 190;
          return <path key={k} d={arc(115, 115, 89, a, a + 270 / segs - 0.8)} fill="none" stroke={`hsl(${hue} 85% 58%)`} strokeWidth="5" />;
        })}
      </RoundGauge>
    );
  },
});

function Drum({ x, y, w, h, digit, roll, bg, ink }: { x: number; y: number; w: number; h: number; digit: number; roll: number; bg: string; ink: string }) {
  const id = useSvgIds('clip', 'shade');
  const dy = -roll * h;
  return (
    <g>
      <defs>
        <clipPath id={id.clip}><rect x={x} y={y} width={w} height={h} rx="4" /></clipPath>
        <linearGradient id={id.shade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="0.3" stopColor="#000" stopOpacity="0" />
          <stop offset="0.7" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={w} height={h} rx="4" fill={bg} />
      <g clipPath={url(id.clip)} fontFamily={FONT} fontSize={h * 0.72} fontWeight={600} fill={ink} textAnchor="middle">
        <text x={x + w / 2} y={y + h * 0.76 + dy}>{digit}</text>
        <text x={x + w / 2} y={y + h * 1.76 + dy}>{(digit + 1) % 10}</text>
      </g>
      <rect x={x} y={y} width={w} height={h} rx="4" fill={url(id.shade)} />
    </g>
  );
}

const distance = defineWidget({
  id: 'distance.gauge', metric: 'distance', family: 'gauge', name: 'Odometer drums',
  requires: ['distance'], size: { w: 430, h: 150 },
  Component: (f) => {
    const id = useSvgIds('bezel');
    const v = read(f, 'distance');
    const hundredths = Number.isFinite(v.value) ? Math.max(0, v.value * 100) : 0;
    const drums = 5;
    const [dw, dh, gap, x0, y0] = [52, 74, 6, 40, 46];
    return (
      <Svg w={430} h={150}>
        <defs>
          <linearGradient id={id.bezel} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5d6470" /><stop offset="1" stopColor="#1b1e24" /></linearGradient>
        </defs>
        <rect x="4" y="4" width="422" height="142" rx="18" fill={`rgba(10,11,14,${f.panelOpacity})`} stroke={url(id.bezel)} strokeWidth="6" opacity={1} />
        <text x="40" y="34" fontFamily={FONT} fontSize="15" fontWeight={600} letterSpacing={3} fill={DIM}>ODOMETER</text>
        {Array.from({ length: drums }, (_, k) => {
          const p = drums - 1 - k; // power of ten in hundredths
          const pos = hundredths / 10 ** p;
          const digit = Math.floor(pos) % 10;
          const roll = p === 0 ? frac(pos) : clamp((hundredths % 10 ** p) - (10 ** p - 1), 0, 1);
          const dec = p < 2;
          const x = x0 + k * (dw + gap) + (dec ? 16 : 0);
          return <Drum key={k} x={x} y={y0} w={dw} h={dh} digit={digit} roll={roll} bg={dec ? '#e9e4d6' : '#111316'} ink={dec ? '#111316' : '#f2eee2'} />;
        })}
        <circle cx={x0 + 3 * (dw + gap) - gap / 2 + 5} cy={y0 + dh - 8} r="4" fill={TICK} />
        <text x="390" y={y0 + dh - 6} textAnchor="end" fontFamily={FONT} fontSize="22" fontWeight={600} fill={AMBER}>{v.unit.toUpperCase()}</text>
      </Svg>
    );
  },
});

const time = defineWidget({
  id: 'time.gauge', metric: 'time', family: 'gauge', name: 'Chronograph',
  requires: [], size: { w: 300, h: 300 },
  Component: (f) => {
    const lt = f.ride.localTime(f.t);
    const [c, r] = [150, 128];
    const sec = lt.s * 6;
    const min = (lt.m + lt.s / 60) * 6;
    const hr = ((lt.h % 12) + lt.m / 60) * 30;
    return (
      <Svg w={300} h={300}>
        <Dial cx={c} cy={c} r={r} o={f.panelOpacity} />
        <Ticks cx={c} cy={c} r={r} a0={0} a1={360} min={0} max={60} major={5} minor={1} label={(n) => (n % 15 === 0 && n < 60 ? String(n === 0 ? 12 : n / 5) : '')} size={26} labelR={r - 36} />
        <text x={c} y={c + 52} textAnchor="middle" fontFamily={FONT} fontSize="13" fontWeight={600} letterSpacing={2} fill={DIM}>ELAPSED</text>
        <text x={c} y={c + 76} textAnchor="middle" fontFamily={FONT} fontSize="22" fontWeight={600} fill="#fff" style={tnum}>{formatDuration(f.t)}</text>
        <text x={c} y={c - 44} textAnchor="middle" fontFamily={FONT} fontSize="12" fontWeight={600} letterSpacing={2} fill={DIM}>{lt.label}</text>
        <Needle cx={c} cy={c} len={r - 62} deg={hr} color={TICK} tail={12} width={7} />
        <Needle cx={c} cy={c} len={r - 22} deg={min} color={TICK} tail={16} width={5} />
        <Needle cx={c} cy={c} len={r - 6} deg={sec} color={NEEDLE} tail={30} width={2.5} />
        <title>{`${pad2(lt.h)}:${pad2(lt.m)}`}</title>
      </Svg>
    );
  },
});

const respiration = defineWidget({
  id: 'respiration.gauge', metric: 'respiration', family: 'gauge', name: 'Respiration dial',
  requires: ['respiration'], size: { w: 230, h: 230 },
  Component: (f) => {
    const v = read(f, 'respiration');
    return <RoundGauge f={f} size={230} min={10} max={50} major={10} minor={2} value={v.si} text={v.text} unit={`${v.unit} · est`} label="RESP" needleColor="#7FE3C8" />;
  },
});

const elevationProfile = defineWidget({
  id: 'elevationProfile.gauge', metric: 'elevationProfile', family: 'gauge', name: 'Profile scope',
  requires: ['altitude', 'distance'], size: { w: 600, h: 250 },
  Component: (f) => {
    const id = useSvgIds('glow', 'bezel', 'fill');
    const [x0, x1, y0, y1] = [34, 566, 70, 214];
    // Shared geometry: the position marker needs both distance and altitude at t.
    const { pts, here } = summitFrame(f.ride, f.t, [x0, x1, y0, y1]);
    const alt = read(f, 'altitude');
    const gr = read(f, 'gradient');
    const dist = read(f, 'distance', 1);
    const grid: ReactNode[] = [];
    for (let x = x0; x <= x1 + 1; x += (x1 - x0) / 12) grid.push(<line key={`x${x}`} x1={x} x2={x} y1={y0 - 18} y2={y1} />);
    for (let y = y1; y >= y0 - 18; y -= 27) grid.push(<line key={`y${y}`} x1={x0} x2={x1} y1={y} y2={y} />);
    const done = here ? pts.filter(([x]) => x <= here.x) : [];
    return (
      <Svg w={600} h={250}>
        <defs>
          <filter id={id.glow} x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="3.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <linearGradient id={id.bezel} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5d6470" /><stop offset="1" stopColor="#1b1e24" /></linearGradient>
          <linearGradient id={id.fill} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={AMBER} stopOpacity="0.28" /><stop offset="1" stopColor={AMBER} stopOpacity="0" /></linearGradient>
        </defs>
        <rect x="4" y="4" width="592" height="242" rx="20" fill={`rgba(9,10,8,${f.panelOpacity})`} stroke={url(id.bezel)} strokeWidth="6" />
        <g stroke="rgba(255,200,120,0.09)" strokeWidth="1">{grid}</g>
        <g fontFamily={FONT} fontSize="15" fontWeight={600} letterSpacing={1.5} style={tnum}>
          <text x={x0} y={36} fill={DIM}>ALT <tspan fill={AMBER}>{`${alt.text} ${alt.unit.toUpperCase()}`}</tspan></text>
          <text x={x0 + 170} y={36} fill={DIM}>GRD <tspan fill={AMBER}>{`${signed(gr.text, gr.si)}%`}</tspan></text>
          <text x={x1} y={36} fill={DIM} textAnchor="end">DST <tspan fill={AMBER}>{`${dist.text} ${dist.unit.toUpperCase()}`}</tspan></text>
        </g>
        <path d={linePath(pts)} fill="none" stroke={AMBER} strokeOpacity="0.28" strokeWidth="2" />
        {done.length > 1 && <path d={`${linePath(done)}L${done[done.length - 1][0]} ${y1}L${done[0][0]} ${y1}Z`} fill={url(id.fill)} />}
        <path d={linePath(done)} fill="none" stroke={AMBER} strokeWidth="2.5" filter={url(id.glow)} />
        {here && (
          <g stroke={TICK} strokeWidth="1" strokeDasharray="4 4" opacity="0.7">
            <line x1={here.x} x2={here.x} y1={y0 - 18} y2={y1} />
            <line x1={x0} x2={x1} y1={here.y} y2={here.y} />
          </g>
        )}
        {here && <circle cx={here.x} cy={here.y} r="5" fill="#fff" filter={url(id.glow)} />}
      </Svg>
    );
  },
});

const map = defineWidget({
  id: 'map.gauge', metric: 'map', family: 'gauge', name: 'Heading-up moving map',
  requires: ['lat', 'lon'], size: { w: 320, h: 320 },
  defaults: { privacyTrimMetres: 500, radiusMetres: 1200 },
  settings: [
    { key: 'privacyTrimMetres', label: 'Hide start/finish (m)', type: 'number', min: 0, max: 3000, step: 100 },
    { key: 'radiusMetres', label: 'Map radius (m)', type: 'number', min: 300, max: 5000, step: 100 },
  ],
  Component: (f) => {
    const id = useSvgIds('clip');
    const route = projectRoute(f.ride, f.settings.privacyTrimMetres, 1500);
    const [c, r] = [160, 124];
    const hdg = f.ride.at('heading', f.t);
    const pos = route && routePosition(route, f.t);
    const k = r / f.settings.radiusMetres;
    const P = (p: [number, number]) => (pos && route ? [c + (p[0] - pos.pt[0]) * route.metresPerUnit * k, c + (p[1] - pos.pt[1]) * route.metresPerUnit * k] : [NaN, NaN]) as [number, number];
    const shown = route ? routePoints(route, route.shownFrom, route.shownTo).map(P) : [];
    const done = route && pos ? [...routePoints(route, route.shownFrom, pos.index).map(P), [c, c] as [number, number]] : [];
    const rot = Number.isFinite(hdg) ? -hdg : 0;
    return (
      <Svg w={320} h={320}>
        <defs><clipPath id={id.clip}><circle cx={c} cy={c} r={r} /></clipPath></defs>
        <Dial cx={c} cy={c} r={r + 4} o={f.panelOpacity} />
        <g clipPath={url(id.clip)}>
          <g transform={`rotate(${rot} ${c} ${c})`}>
            <path d={linePath(shown)} fill="none" stroke="rgba(236,230,214,0.35)" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
            <path d={linePath(done)} fill="none" stroke={AMBER} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
          </g>
          {[r * 0.33, r * 0.66].map((rr) => <circle key={rr} cx={c} cy={c} r={rr} fill="none" stroke="rgba(255,255,255,0.08)" />)}
        </g>
        <g transform={`rotate(${rot} ${c} ${c})`}>
          {Array.from({ length: 36 }, (_, i) => {
            const [x0, y0] = polar(c, c, r + 4, i * 10);
            const [x1, y1] = polar(c, c, r - (i % 9 === 0 ? 10 : 4), i * 10);
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={i % 9 === 0 ? TICK : DIM} strokeWidth={i % 9 === 0 ? 2.5 : 1} />;
          })}
          {['N', 'E', 'S', 'W'].map((l, i) => {
            const [x, y] = polar(c, c, r - 24, i * 90);
            return <text key={l} x={x} y={y + 7} textAnchor="middle" fontFamily={FONT} fontSize="20" fontWeight={650} fill={l === 'N' ? RED : TICK} transform={`rotate(${-rot} ${x} ${y})`}>{l}</text>;
          })}
        </g>
        <path d={`M${c} ${c - 15} L${c + 10} ${c + 11} L${c} ${c + 5} L${c - 10} ${c + 11} Z`} fill="#fff" stroke="#000" strokeWidth="1.5" />
        <path d={`M${c - 9} ${c - r - 14} h18 l-9 13 Z`} fill={AMBER} />
        <rect x={c - 36} y={c + r - 2} width="72" height="26" rx="5" fill="#050608" stroke="#3b414c" />
        <text x={c} y={c + r + 17} textAnchor="middle" fontFamily={FONT} fontSize="16" fontWeight={600} fill="#fff" style={tnum}>{Number.isFinite(hdg) ? `${String(Math.round(hdg) % 360).padStart(3, '0')}°` : MISSING}</text>
      </Svg>
    );
  },
});

const streetMap = defineWidget<OsmSettings>({
  id: 'streetMap.gauge', metric: 'streetMap', family: 'gauge', name: 'Moving-map instrument',
  requires: ['lat', 'lon'], size: { w: 360, h: 360 },
  defaults: { shape: 'circle', zoom: 16, theme: 'muted', headingUp: true, privacyTrimMetres: 500 },
  settings: OSM_SETTINGS,
  Component: (f) => {
    const s = f.settings;
    const hdg = f.ride.at('heading', f.t);
    const rot = s.headingUp && Number.isFinite(hdg) ? -hdg : 0;
    const circle = s.shape === 'circle';
    return (
      <Svg w={360} h={360}>
        {circle ? <Dial cx={180} cy={180} r={162} o={f.panelOpacity} /> : <rect x="4" y="4" width="352" height="352" rx="22" fill={`rgba(10,11,14,${f.panelOpacity})`} stroke="#4a515c" strokeWidth="6" />}
        <OsmMap f={f} s={s} size={circle ? 324 : 330} x={circle ? 18 : 15} y={circle ? 18 : 15} radius={14} track="rgba(30,30,30,0.5)" done={AMBER} marker={AMBER} markerRing="#111" />
        {circle && (
          <g transform={`rotate(${rot} 180 180)`}>
            {Array.from({ length: 72 }, (_, i) => {
              const [x0, y0] = polar(180, 180, 162, i * 5);
              const [x1, y1] = polar(180, 180, 162 - (i % 18 === 0 ? 14 : i % 2 === 0 ? 8 : 4), i * 5);
              return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={i % 18 === 0 ? '#fff' : 'rgba(255,255,255,0.75)'} strokeWidth={i % 18 === 0 ? 3 : 1.2} />;
            })}
            {['N', 'E', 'S', 'W'].map((l, i) => {
              const [x, y] = polar(180, 180, 136, i * 90);
              return (
                <g key={l} transform={`rotate(${-rot} ${x} ${y})`}>
                  <circle cx={x} cy={y} r="13" fill="rgba(8,9,12,0.7)" />
                  <text x={x} y={y + 6} textAnchor="middle" fontFamily={FONT} fontSize="17" fontWeight={650} fill={l === 'N' ? RED : TICK}>{l}</text>
                </g>
              );
            })}
          </g>
        )}
        {circle && s.headingUp && <path d="M171 4 h18 l-9 13 Z" fill={AMBER} />}
        {!circle && !s.headingUp && <NorthMark x={322} y={40} color={TICK} />}
      </Svg>
    );
  },
});

// ---------------------------------------------------------------- run · walk · hike

/** Brushed rectangular instrument plate used by the non-round foot-sport instruments. */
function Plate({ w, h, o, r = 22 }: { w: number; h: number; o: number; r?: number }) {
  const id = useSvgIds('bezel');
  return (
    <g>
      <defs>
        <linearGradient id={id.bezel} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5d6470" /><stop offset="1" stopColor="#1b1e24" /></linearGradient>
      </defs>
      <rect x="4" y="4" width={w - 8} height={h - 8} rx={r} fill={`rgba(10,11,14,${o})`} stroke={url(id.bezel)} strokeWidth="6" />
    </g>
  );
}

const plateLabel = (x: number, y: number, text: string, anchor?: 'end' | 'middle', color = DIM) => (
  <text x={x} y={y} textAnchor={anchor} fontFamily={FONT} fontSize="15" fontWeight={600} letterSpacing={3} fill={color}>{text}</text>
);

/** Pace dial range in display minutes: whole minutes from the typical top speed. */
function paceRange(f: WidgetFrame): { fast: number; slow: number; major: number; minor: number } {
  const top = convert('pace', 1 / typicalTopSpeed(f.ride), f.units);
  const fast = Number.isFinite(top) ? Math.max(2, Math.floor(top)) : 4;
  const span = fast < 7 ? 5 : 10;
  return { fast, slow: fast + span, major: span === 5 ? 1 : 2, minor: span === 5 ? 0.25 : 0.5 };
}

const pace = defineWidget({
  id: 'pace.gauge', metric: 'pace', family: 'gauge', name: 'Pace dial',
  requires: ['pace'], size: { w: 340, h: 340 },
  Component: (f) => {
    const v = read(f, 'pace');
    const r = paceRange(f);
    // The dial runs slow → fast clockwise, so it is drawn on negated minutes.
    const val = Number.isFinite(v.value) ? -v.value : NaN;
    const c = 170;
    const rad = c - 22;
    return (
      <Svg w={340} h={340}>
        <Dial cx={c} cy={c} r={rad} o={f.panelOpacity} />
        {Number.isFinite(val) && <path d={arc(c, c, rad - 4, -135, angleOf(val, -r.slow, -r.fast, -135, 135))} fill="none" stroke={AMBER} strokeWidth="4" opacity="0.9" />}
        <Ticks cx={c} cy={c} r={rad} a0={-135} a1={135} min={-r.slow} max={-r.fast} major={r.major} minor={r.minor} label={(x) => String(-x)} size={22} labelR={rad - 38} />
        <text x={c} y={c - 54} textAnchor="middle" fill={DIM} fontFamily={FONT} fontSize={15} fontWeight={600} letterSpacing={3}>PACE</text>
        <Readout cx={c} y={c + 82} text={v.text} unit={v.unit} size={v.text.length > 4 ? 42 : 50} />
        <Needle cx={c} cy={c} len={rad - 10} deg={angleOf(val, -r.slow, -r.fast, -135, 135)} />
      </Svg>
    );
  },
});

const stepCadence = defineWidget({
  id: 'stepCadence.gauge', metric: 'stepCadence', family: 'gauge', name: 'Cadence dial + feet',
  requires: ['stepCadence'], size: { w: 340, h: 340 },
  Component: (f) => {
    const v = read(f, 'stepCadence');
    const ff = footfall(f, 0.2);
    return (
      <RoundGauge f={f} size={340} min={0} max={200} major={40} minor={10} value={v.value} text={v.text} unit="spm" label=""
        bands={[{ from: 0, to: Number.isFinite(v.value) ? v.value : 0, color: '#7CD992', width: 4 }]}>
        <Foot x={152} y={116} s={0.4} fill="#7CD992" opacity={ff.left} flip />
        <Foot x={188} y={106} s={0.4} fill="#7CD992" opacity={ff.right} />
      </RoundGauge>
    );
  },
});

/** One mechanical digit; the last seconds digit rolls continuously. */
function Digits({ x, y, text, roll, w = 40, h = 64 }: { x: number; y: number; text: string; roll: number; w?: number; h?: number }) {
  let cx = x;
  const out: ReactNode[] = [];
  [...text].forEach((ch, k) => {
    if (ch === ':') {
      out.push(<text key={k} x={cx + 8} y={y + h * 0.72} textAnchor="middle" fontFamily={FONT} fontSize={h * 0.6} fontWeight={600} fill={DIM}>:</text>);
      cx += 16;
      return;
    }
    out.push(<Drum key={k} x={cx} y={y} w={w} h={h} digit={Number(ch)} roll={k === text.length - 1 ? roll : 0} bg="#0b0c0f" ink={TICK} />);
    cx += w + 6;
  });
  return <g>{out}</g>;
}

const splits = defineWidget({
  id: 'splits.gauge', metric: 'splits', family: 'gauge', name: 'Split counter',
  requires: ['distance'], size: { w: 440, h: 320 },
  Component: (f) => {
    const s = splitAt(f.ride, f.t, f.units);
    const unit = f.units === 'metric' ? 'KM' : 'MI';
    const rows = splitRows(s);
    const live = s ? splitText(s.elapsed) : MISSING;
    const p = clamp(s?.progress ?? NaN, 0, 1);
    return (
      <Svg w={440} h={320}>
        <Plate w={440} h={320} o={f.panelOpacity} />
        {plateLabel(36, 50, s ? `${unit} ${s.current} · SPLIT` : 'SPLIT')}
        {s && /^\d+:\d\d$/.test(live) ? <Digits x={36} y={68} text={live} roll={frac(s.elapsed)} /> : (
          <text x={36} y={120} fontFamily={FONT} fontSize="48" fontWeight={600} fill={TICK}>{live}</text>
        )}
        {rows.map((r, k) => (
          <g key={r.n} fontFamily={FONT}>
            <text x={36} y={186 + k * 36} fontSize="15" fontWeight={600} letterSpacing={2} fill={DIM}>{`${unit} ${r.n}`}</text>
            <text x={118} y={186 + k * 36} fontSize="25" fontWeight={560} fill={r.best ? AMBER : TICK} style={tnum}>{r.text}</text>
            <text x={250} y={186 + k * 36} textAnchor="end" fontSize="15" fontWeight={600} fill={DIM} style={tnum}>{r.delta}</text>
          </g>
        ))}
        <circle cx="340" cy="212" r="62" fill="none" stroke="#2a2e35" strokeWidth="12" />
        {p > 0 && <path d={arc(340, 212, 62, 0, 360 * p)} fill="none" stroke={AMBER} strokeWidth="12" />}
        <Ticks cx={340} cy={212} r={52} a0={0} a1={360} min={0} max={10} major={1} minor={1} label={() => ''} />
        <text x="340" y="220" textAnchor="middle" fontFamily={FONT} fontSize="24" fontWeight={600} fill="#fff" style={tnum}>{Number.isFinite(p) ? `${Math.round(p * 100)}%` : MISSING}</text>
      </Svg>
    );
  },
});

const steps = defineWidget({
  id: 'steps.gauge', metric: 'steps', family: 'gauge', name: 'Step odometer',
  requires: ['steps'], size: { w: 380, h: 210 },
  Component: (f) => {
    const n = stepsAt(f);
    const d = read(f, 'distance');
    const sp = read(f, 'stepCadence');
    const total = Number.isFinite(n) ? Math.max(0, n) : 0;
    const drums = total >= 100000 ? 6 : 5;
    const dw = drums === 6 ? 44 : 52;
    return (
      <Svg w={380} h={210}>
        <Plate w={380} h={210} o={f.panelOpacity} />
        {plateLabel(34, 46, 'STEPS')}
        {plateLabel(346, 46, 'EST.', 'end')}
        {Array.from({ length: drums }, (_, k) => {
          const p = drums - 1 - k;
          const pos = total / 10 ** p;
          const roll = p === 0 ? frac(pos) : clamp((total % 10 ** p) - (10 ** p - 1), 0, 1);
          return <Drum key={k} x={34 + k * (dw + 6)} y={62} w={dw} h={74} digit={Math.floor(pos) % 10} roll={roll} bg={p === 0 ? '#2b0d08' : '#111316'} ink={p === 0 ? NEEDLE : '#f2eee2'} />;
        })}
        <text x="34" y="180" fontFamily={FONT} fontSize="26" fontWeight={560} fill="#fff" style={tnum}>{`${d.text} `}<tspan fontSize="16" fill={DIM}>{d.unit.toUpperCase()}</tspan></text>
        <text x="346" y="180" textAnchor="end" fontFamily={FONT} fontSize="20" fontWeight={560} fill={DIM} style={tnum}>{`${sp.text} SPM`}</text>
      </Svg>
    );
  },
});

const climbRate = defineWidget({
  id: 'climbRate.gauge', metric: 'climbRate', family: 'gauge', name: 'Variometer',
  requires: ['climbRate'], size: { w: 340, h: 340 },
  Component: (f) => {
    const v = read(f, 'climbRate');
    const g = read(f, 'ascent');
    const max = f.units === 'metric' ? 1000 : 3000;
    // Aviation-style vario: zero at nine o'clock, climb clockwise over the top.
    const [a0, a1] = [-270, 90];
    const deg = angleOf(v.value, -max, max, a0, a1);
    const c = 170;
    const rad = c - 22;
    return (
      <Svg w={340} h={340}>
        <Dial cx={c} cy={c} r={rad} o={f.panelOpacity} />
        {Number.isFinite(deg) && <path d={deg >= -90 ? arc(c, c, rad - 4, -90, deg) : arc(c, c, rad - 4, deg, -90)} fill="none" stroke={deg >= -90 ? AMBER : '#7FB2FF'} strokeWidth="6" />}
        <Ticks cx={c} cy={c} r={rad} a0={a0} a1={a1} min={-max} max={max} major={max / 2} minor={max / 10} size={20} labelR={rad - 36}
          label={(x) => (x === 0 ? '0' : x === -max ? '' : `${x === max ? '±' : x > 0 ? '+' : '−'}${Math.abs(x) / (max / 10)}`)} />
        <text x={c + 14} y={c - 48} textAnchor="middle" fill={DIM} fontFamily={FONT} fontSize={15} fontWeight={600} letterSpacing={3}>VARIO</text>
        <text x={c + 14} y={c - 28} textAnchor="middle" fill={DIM} fontFamily={FONT} fontSize={12} fontWeight={600} letterSpacing={2}>{`×${max / 10} ${v.unit.toUpperCase()}`}</text>
        <Readout cx={c + 20} y={c + 70} text={signed(v.text, v.si)} size={signed(v.text, v.si).length > 4 ? 38 : 46} />
        <text x={c + 20} y={c + 96} textAnchor="middle" fill={DIM} fontFamily={FONT} fontSize={13} fontWeight={600} letterSpacing={1}>{`GAIN +${g.text} ${g.unit.toUpperCase()}`}</text>
        <Needle cx={c} cy={c} len={rad - 10} deg={deg} />
      </Svg>
    );
  },
});

const summitProfile = defineWidget({
  id: 'elevationProfile.gauge-summit', metric: 'elevationProfile', family: 'gauge', name: 'Altimeter profile',
  requires: ['altitude', 'distance'], size: { w: 672, h: 250 },
  Component: (f) => {
    const id = useSvgIds('clip');
    const [x0, x1, y0, y1] = [36, 636, 84, 196];
    const sf = summitFrame(f.ride, f.t, [x0, x1, y0, y1]);
    const alt = read(f, 'altitude');
    const toGo = display('altitude', sf.toHigh, f.units);
    const hpText = sf.high ? display('altitude', sf.high.alt, f.units) : null;
    return (
      <Svg w={672} h={250}>
        <defs><clipPath id={id.clip}><rect x="0" y="0" width={sf.cx} height="250" /></clipPath></defs>
        <Plate w={672} h={250} o={f.panelOpacity} />
        {[0, 1, 2, 3].map((k) => <line key={k} x1={x0} x2={x1} y1={y0 + ((y1 - y0) * k) / 3} y2={y0 + ((y1 - y0) * k) / 3} stroke={TICK} strokeOpacity="0.12" />)}
        {Array.from({ length: 11 }, (_, k) => <line key={k} x1={x0 + k * 60} x2={x0 + k * 60} y1={y1} y2={y1 + (k % 2 ? 4 : 8)} stroke={TICK} strokeWidth="1.5" />)}
        {plateLabel(36, 52, 'ALTIMETER')}
        <text x="186" y="56" fontFamily={FONT} fontSize="34" fontWeight={600} fill="#fff" style={tnum}>{alt.text}<tspan dx="6" fontSize="15" fill={DIM}>{alt.unit.toUpperCase()}</tspan></text>
        {plateLabel(636, 52, !toGo.missing ? `${toGo.text} ${toGo.unit.toUpperCase()} TO HIGH POINT` : hpText ? `HIGH POINT ${hpText.text} ${hpText.unit.toUpperCase()}` : '', 'end', AMBER)}
        <path d={linePath(sf.pts)} fill="none" stroke={TICK} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="4 5" />
        <g clipPath={url(id.clip)}>
          <path d={`${linePath(sf.pts.filter((p) => Number.isFinite(p[1])))}L${x1} ${y1}L${x0} ${y1}Z`} fill={AMBER} fillOpacity="0.18" />
          <path d={linePath(sf.pts)} fill="none" stroke={AMBER} strokeWidth="3" />
        </g>
        {sf.here && (
          <g>
            <line x1={sf.here.x} x2={sf.here.x} y1={y0} y2={y1} stroke={NEEDLE} strokeWidth="2" />
            <circle cx={sf.here.x} cy={sf.here.y} r="7" fill={NEEDLE} />
          </g>
        )}
        <text x={x0} y="228" fontFamily={FONT} fontSize="13" fontWeight={600} fill={DIM}>0</text>
        <text x={x1} y="228" textAnchor="end" fontFamily={FONT} fontSize="13" fontWeight={600} fill={DIM}>{`${convert('distance', sf.total, f.units).toFixed(1)} ${f.units === 'metric' ? 'KM' : 'MI'}`}</text>
      </Svg>
    );
  },
});

const heading = defineWidget({
  id: 'heading.gauge', metric: 'heading', family: 'gauge', name: 'Compass card',
  requires: ['heading'], size: { w: 300, h: 300 },
  Component: (f) => {
    const hdg = f.ride.at('heading', f.t);
    const [c, r] = [150, 128];
    const ticks: ReactNode[] = [];
    for (let d = 0; d < 360; d += 5) {
      const big = d % 45 === 0;
      const [xa, ya] = polar(c, c, r, d);
      const [xb, yb] = polar(c, c, r - (big ? 20 : d % 15 === 0 ? 12 : 7), d);
      ticks.push(<line key={d} x1={xa} y1={ya} x2={xb} y2={yb} stroke={big ? TICK : DIM} strokeWidth={big ? 3 : 1.2} />);
    }
    for (const [d, n] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']] as const) {
      const [lx, ly] = polar(c, c, r - 40, d);
      ticks.push(<text key={n} x={lx} y={ly + 9} textAnchor="middle" fontFamily={FONT} fontSize="26" fontWeight={650} fill={n === 'N' ? RED : TICK} transform={`rotate(${d} ${lx} ${ly})`}>{n}</text>);
    }
    return (
      <Svg w={300} h={300}>
        <Dial cx={c} cy={c} r={r + 2} o={f.panelOpacity} />
        <g transform={`rotate(${Number.isFinite(hdg) ? -hdg : 0} ${c} ${c})`} opacity={Number.isFinite(hdg) ? 1 : 0.35}>{ticks}</g>
        <path d={`M${c} 8 L${c - 9} 28 L${c + 9} 28 Z`} fill={NEEDLE} />
        <text x={c} y={c + 6} textAnchor="middle" fontFamily={FONT} fontSize="34" fontWeight={600} fill="#fff" style={tnum}>{Number.isFinite(hdg) ? `${Math.round(hdg) % 360}°` : MISSING}</text>
        <text x={c} y={c + 30} textAnchor="middle" fontFamily={FONT} fontSize="15" fontWeight={600} letterSpacing={3} fill={DIM}>{cardinal(hdg)}</text>
      </Svg>
    );
  },
});

const movingTime = defineWidget({
  id: 'movingTime.gauge', metric: 'movingTime', family: 'gauge', name: 'Moving chronograph',
  requires: ['speed'], size: { w: 440, h: 230 },
  defaults: { stoppedBelow: 0.5 },
  settings: MOVING_SETTINGS,
  Component: (f) => {
    const m = movingAt(f.ride, f.t, f.settings.stoppedBelow);
    const p = m && m.elapsed > 0 ? clamp(m.moving / m.elapsed, 0, 1) : NaN;
    const thr = display('speed', f.settings.stoppedBelow, f.units);
    return (
      <Svg w={440} h={230}>
        <Plate w={440} h={230} o={f.panelOpacity} />
        {plateLabel(32, 52, 'MOVING')}
        <text x="28" y="122" fontFamily={FONT} fontSize="54" fontWeight={600} fill="#fff" style={tnum}>{m ? formatDuration(m.moving) : MISSING}</text>
        <text x="32" y="158" fontFamily={FONT} fontSize="16" fontWeight={600} letterSpacing={1} fill={DIM} style={tnum}>{`ELAPSED ${m ? formatDuration(m.elapsed) : MISSING}`}</text>
        {plateLabel(32, 194, `STOPPED < ${thr.text} ${thr.unit.toUpperCase()}`)}
        <circle cx="352" cy="128" r="54" fill="#0b0c0f" stroke="#3b414c" strokeWidth="2" />
        <Ticks cx={352} cy={128} r={50} a0={0} a1={360} min={0} max={20} major={5} minor={1} label={() => ''} />
        {p > 0 && <path d={arc(352, 128, 36, 0, 360 * p)} fill="none" stroke={AMBER} strokeWidth="7" />}
        <text x="352" y="136" textAnchor="middle" fontFamily={FONT} fontSize="22" fontWeight={600} fill="#fff">{Number.isFinite(p) ? `${Math.round(p * 100)}%` : MISSING}</text>
      </Svg>
    );
  },
});

const runStrip = defineWidget({
  id: 'runStrip.gauge', metric: 'runStrip', family: 'gauge', name: 'Dial cluster',
  requires: ['pace'], size: { w: 1080, h: 190 },
  Component: (f) => {
    const pc = read(f, 'pace');
    const hr = read(f, 'heartRate');
    const sp = read(f, 'stepCadence');
    const d = read(f, 'distance');
    const r = paceRange(f);
    const z = f.ride.hrZone(hr.si);
    const maxHr = f.ride.meta.hrZones?.maxHeartRate ?? f.ride.meta.hrZones?.highBoundaries.at(-1) ?? 200;
    const total = f.ride.extent('distance')[1];
    const dials: [string, string, string, number, string][] = [
      ['PACE', pc.text, pc.unit, (r.slow - pc.value) / (r.slow - r.fast), AMBER],
      ['HEART', hr.text, 'BPM', hr.si / maxHr, z ? ZONE_COLORS[z.zone] : DIM],
      ['CADENCE', sp.text, 'SPM', sp.si / 200, '#7CD992'],
      ['DISTANCE', d.text, d.unit, d.si / total, TICK],
    ];
    return (
      <Svg w={1080} h={190}>
        {dials.map(([label, text, unit, p, col], k) => {
          const x = 135 + k * 270;
          const q = clamp(p, 0, 1) || 0;
          return (
            <g key={label}>
              <Dial cx={x} cy={95} r={70} o={f.panelOpacity} />
              <path d={arc(x, 95, 58, -130, 130)} fill="none" stroke="#2a2e35" strokeWidth="8" />
              {q > 0 && <path d={arc(x, 95, 58, -130, -130 + 260 * q)} fill="none" stroke={col} strokeWidth="8" />}
              <text x={x} y={74} textAnchor="middle" fontFamily={FONT} fontSize="13" fontWeight={600} letterSpacing={2} fill={DIM}>{label}</text>
              <text x={x} y={108} textAnchor="middle" fontFamily={FONT} fontSize={text.length > 4 ? 28 : 32} fontWeight={600} fill="#fff" style={tnum}>{text}</text>
              <text x={x} y={130} textAnchor="middle" fontFamily={FONT} fontSize="12" fontWeight={600} letterSpacing={2} fill={DIM}>{unit.toUpperCase()}</text>
            </g>
          );
        })}
      </Svg>
    );
  },
});

export const widgets = [
  speed, heartRate, hrZone, cadence, elevation, elevationProfile, gradient, temperature, distance, time, respiration, map, streetMap,
  pace, runStrip, stepCadence, steps, splits, climbRate, summitProfile, heading, movingTime,
];
