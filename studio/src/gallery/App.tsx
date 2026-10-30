import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_FRAMING, FORMATS, GARMIN_VUE, type Framing, type SourceInfo } from '../core/framing';
import { fileStartMs, sourceInfo, type FootageFile } from '../core/project';
import { loadRide, type Ride } from '../core/ride';
import type { UnitSystem } from '../core/units';
import type { WidgetFrame } from '../core/widget';
import { registry } from '../widgets';
import { Catalog, type CardBg } from './Catalog';
import { usePersisted } from './persist';
import { SettingsFields } from './SettingsFields';
import { Review } from './Review';
import { Editor } from '../editor/Editor';
import type { ReactNode } from 'react';
import { useClock } from './clock';
import { Stage, type ClipRef, type StageItem } from './Stage';
import { Timeline, type Moment } from './Timeline';
import { Activities } from './Activities';

interface Demo {
  ride: string;
  clips: { label: string; src: string; poster?: string; startUtc: string; duration: number; source?: SourceInfo }[];
}

export function App() {
  const [data, setData] = useState<{ ride: Ride; demo: Demo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activities, setActivities] = useState<{ demo: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      const query = new URLSearchParams(location.search);
      if (query.has('activities')) {
        setActivities({ demo: isJson(await fetch('data/demo.json', { method: 'HEAD' })) });
        return;
      }
      const rideId = query.get('ride');
      if (rideId) {
        if (!/^[A-Za-z0-9_-]+$/.test(rideId)) throw new Error('Invalid ride id');
        const ride = await loadRide(`data/rides/${rideId}.json`);
        const res = await fetch('/api/footage');
        if (!res.ok) throw new Error('Could not load camera footage');
        const index = await res.json() as { files: FootageFile[] };
        const clips = index.files.filter((f) => (!f.rideId || f.rideId === ride.id) && fileStartMs(f) < ride.startMs + ride.duration * 1000 && fileStartMs(f) + f.duration * 1000 > ride.startMs).map((f) => ({
          label: f.label ?? f.name, src: `/media/${f.camera}/${f.preview?.name ?? f.name}`, startUtc: new Date(fileStartMs(f)).toISOString(), duration: f.duration, source: sourceInfo(f),
        }));
        setData({ ride, demo: { ride: `data/rides/${rideId}.json`, clips } });
        return;
      }
      const res = await fetch('data/demo.json');
      if (!isJson(res)) {
        // No demo media: start from the activity list instead.
        setActivities({ demo: false });
        return;
      }
      const demo = (await res.json()) as Demo;
      setData({ demo, ride: await loadRide(demo.ride) });
    })().catch((e: Error) => setError(e.message));
  }, []);
  if (activities) return <Activities demo={activities.demo} />;
  if (error) return <div className="boot">{error}</div>;
  if (!data) return <div className="boot">Loading ride…</div>;
  if (new URLSearchParams(location.search).has('review')) {
    const c = data.demo.clips[0];
    return <Review ride={data.ride} poster={c?.poster} defaultT={c ? data.ride.rideTimeAt(Date.parse(c.startUtc)) + 15 : 0} />;
  }
  return <Pages ride={data.ride} demo={data.demo} />;
}

/** The dev server answers missing files with index.html, so check the type as well. */
const isJson = (res: Response) => res.ok && (res.headers.get('content-type') ?? '').includes('json');

function Pages({ ride, demo }: { ride: Ride; demo: Demo }) {
  const [page, setPage] = usePersisted<'gallery' | 'editor'>('page', 'gallery');
  const nav = (
    <nav className="pages">
      <span className="dot" />
      <button onClick={() => { location.href = '/?activities'; }}>Activities</button>
      {(['gallery', 'editor'] as const).map((p) => (
        <button key={p} className={page === p ? 'on' : ''} onClick={() => setPage(p)}>{p === 'gallery' ? 'Widgets' : 'Editor'}</button>
      ))}
    </nav>
  );
  return page === 'editor' ? <Editor ride={ride} nav={nav} /> : <Gallery ride={ride} demo={demo} nav={nav} />;
}

const DEFAULT_STAGE: StageItem[] = [
  { uid: 'a', widgetId: 'speed.glass', nx: 0.5, ny: 0.72, scale: 1.4, opacity: 1 },
  { uid: 'b', widgetId: 'heartRate.glass', nx: 0.27, ny: 0.84, scale: 1.1, opacity: 1 },
  { uid: 'c', widgetId: 'cadence.glass', nx: 0.73, ny: 0.84, scale: 1.1, opacity: 1 },
];

function Gallery({ ride, demo, nav }: { ride: Ride; demo: Demo; nav: ReactNode }) {
  const clips: ClipRef[] = useMemo(() => demo.clips.map((c) => ({
    src: c.src, poster: c.poster, duration: c.duration, startT: ride.rideTimeAt(Date.parse(c.startUtc)),
  })), [demo, ride]);
  const moments: Moment[] = useMemo(() => [
    ...demo.clips.map((c, i) => ({ id: `clip${i}`, kind: 'clip' as const, label: `▶ ${c.label}`, start: clips[i].startT, end: clips[i].startT + c.duration - 0.1 })),
    ...ride.meta.climbs.map((c) => ({ id: `climb${c.number}`, kind: 'climb' as const, label: `▲ Climb ${c.number}`, start: c.startT, end: c.endT })),
  ], [demo, ride, clips]);

  const clock = useClock(moments[0]?.start ?? 0, ride.duration);
  useEffect(() => {
    if (moments[0]) clock.setLoop([moments[0].start, moments[0].end]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Store hidden families so families added later show up by default.
  const [hidden, setHidden] = usePersisted<string[]>('hiddenFamilies', []);
  const families = registry.families.map((f) => f.id).filter((id) => !hidden.includes(id));
  const [opacity, setOpacity] = usePersisted('panelOpacity', 0.5);
  const [units, setUnits] = usePersisted<UnitSystem>('units', 'metric');
  const [formatId, setFormatId] = usePersisted('format', '9x16');
  const [bg, setBg] = usePersisted<CardBg>('cardBg', 'footage');
  const [items, setItems] = usePersisted<StageItem[]>('stage', DEFAULT_STAGE);
  const [framings, setFramings] = usePersisted<Record<string, Framing>>('framing', {});
  const [showSafe, setShowSafe] = usePersisted('safe', true);
  const [selected, setSelected] = useState<string | null>(null);

  const format = FORMATS.find((f) => f.id === formatId) ?? FORMATS[0];
  const framing = framings[format.id] ?? DEFAULT_FRAMING;
  const clip = clips.find((c) => clock.t >= c.startT && clock.t <= c.startT + c.duration) ?? null;
  const source = clip ? demo.clips[clips.indexOf(clip)]?.source ?? GARMIN_VUE : GARMIN_VUE;
  const frame: WidgetFrame = useMemo(() => ({ ride, t: clock.t, units, panelOpacity: opacity }), [ride, clock.t, units, opacity]);
  const onStage = useMemo(() => new Set(items.map((i) => i.widgetId)), [items]);
  const sel = items.find((i) => i.uid === selected);
  const selDef = sel && registry.get(sel.widgetId);

  const toggle = (widgetId: string) => {
    if (onStage.has(widgetId)) {
      setItems(items.filter((i) => i.widgetId !== widgetId));
      return;
    }
    const uid = Math.random().toString(36).slice(2, 8);
    setItems([...items, { uid, widgetId, nx: 0.5, ny: 0.4, scale: 1, opacity: 1 }]);
    setSelected(uid);
  };
  const patchSel = (patch: Partial<StageItem>) => setItems(items.map((i) => (i.uid === selected ? { ...i, ...patch } : i)));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {nav}
          <p>{`${ride.id} · ${registry.all().length} widgets · ${registry.families.length} families`}</p>
        </div>
        <div className="controls">
          <div className="group">
            {registry.families.map((f) => (
              <button key={f.id} title={f.tagline} className={`chip fam-${f.id} ${families.includes(f.id) ? 'on' : ''}`}
                onClick={() => setHidden(hidden.includes(f.id) ? hidden.filter((x) => x !== f.id) : [...hidden, f.id])}>
                {f.name}
              </button>
            ))}
          </div>
          <label className="slider">
            Panel opacity <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
            <output>{Math.round(opacity * 100)}%</output>
          </label>
          <div className="group seg">
            {(['metric', 'imperial'] as const).map((u) => <button key={u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>{u}</button>)}
          </div>
          <div className="group seg" title="Card background">
            {(['footage', 'dark', 'bright'] as const).map((b) => <button key={b} className={bg === b ? 'on' : ''} onClick={() => setBg(b)}>{b}</button>)}
          </div>
        </div>
      </header>
      {ride.meta.telemetry?.kind === 'phone' && <div className="banner">{ride.meta.telemetry.synchronization
        ? `Approximate phone/${ride.meta.telemetry.gpx ? 'GPX' : 'FIT'} sync. Clock offsets and drift on longer clips may affect alignment.`
        : ride.meta.telemetry.locationMode === 'timed'
          ? 'Recorded phone GPS is available. Speed and workout sensors require a matching FIT activity.'
          : 'Phone clip without FIT sensors. A clip geotag supplies no timed route or speed.'}</div>}
      {(ride.meta.telemetry?.kind === 'gpx' || Boolean(ride.meta.telemetry?.gpx)) && <div className="banner">GPX track: speed may use GPS interval estimates. Distance excludes recording gaps; sensor channels appear only when recorded.</div>}

      <Timeline ride={ride} clock={clock} moments={moments} />

      <main>
        <aside className="stage-col">
          <div className="stage-bar">
            <div className="group seg">
              {FORMATS.map((f) => <button key={f.id} className={format.id === f.id ? 'on' : ''} onClick={() => setFormatId(f.id)}>{f.label}</button>)}
            </div>
            {format.unsafe && <label className="check"><input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.target.checked)} /> Social safe zones</label>}
            <button className="link" onClick={() => setFramings({ ...framings, [format.id]: DEFAULT_FRAMING })}>Reset framing</button>
          </div>
          <Stage format={format} source={source} framing={framing} onFraming={(f) => setFramings({ ...framings, [format.id]: f })}
            clip={clip} fallbackPoster={clips[0]?.poster} frame={frame} playing={clock.playing}
            items={items} onItems={setItems} selected={selected} onSelect={setSelected} showSafe={showSafe} />
          <div className="inspector">
            {sel && selDef ? (
              <>
                <strong>{selDef.name}</strong>
                <label className="slider">Opacity <input type="range" min={0.1} max={1} step={0.05} value={sel.opacity} onChange={(e) => patchSel({ opacity: +e.target.value })} /><output>{Math.round(sel.opacity * 100)}%</output></label>
                <label className="slider">Size <input type="range" min={0.3} max={4} step={0.05} value={sel.scale} onChange={(e) => patchSel({ scale: +e.target.value })} /><output>{sel.scale.toFixed(2)}×</output></label>
                <button className="link" onClick={() => { setItems(items.filter((i) => i.uid !== selected)); setSelected(null); }}>Remove</button>
                <SettingsFields def={selDef} values={sel.settings} onChange={(settings) => patchSel({ settings })} />
              </>
            ) : (
              <span className="hint">Drag widgets to move · corner to resize · drag footage to reframe · scroll footage to zoom</span>
            )}
          </div>
        </aside>
        <Catalog frame={frame} families={families} bg={bg} poster={clip?.poster ?? clips[0]?.poster} onStage={onStage} onToggle={toggle} />
      </main>
    </div>
  );
}
