/**
 * Editor: pick moments (auto-detected or by hand), arrange and trim them on a timeline,
 * choose front / rear / picture-in-picture per clip, preview with the HUD, export.
 * The overlay layout, framing, format, units and opacity are shared with the gallery.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_FRAMING, FORMATS, type Framing } from '../core/framing';
import { autoPick, detectMoments, detectorById, type Moment } from '../core/highlights';
import { coverage, mediaCoverage, photoRideTime, photoSourceInfo, photoUrl, programAt, sourceWindows, totalDuration, type CameraMode, type MediaInfo, type PhotoFile, type Project, type TimelineClip } from '../core/project';
import type { Ride } from '../core/ride';
import { formatDuration, pad2, type UnitSystem } from '../core/units';
import type { WidgetFrame } from '../core/widget';
import { useClock } from '../gallery/clock';
import { usePersisted } from '../gallery/persist';
import { SettingsFields } from '../gallery/SettingsFields';
import { Stage, type StageItem } from '../gallery/Stage';
import { registry } from '../widgets';
import { EditTimeline } from './EditTimeline';
import { ExportDialog } from './ExportDialog';
import { previewAt, stageSource, useFootage } from './footage';
import { MapView } from './MapView';
import { MomentsPanel, type MomentInfo } from './MomentsPanel';
import { PhotosPanel, usePhotos } from './PhotosPanel';
import { MediaPanel, useMedia } from './MediaPanel';
import { SyncView, type SyncTarget } from './SyncView';

const FPS = 30;
const snap = (s: number) => Math.round(s * FPS) / FPS;
const uid = () => Math.random().toString(36).slice(2, 9);

export function Editor({ ride, nav }: { ride: Ride; nav: ReactNode }) {
  const [footageVersion, setFootageVersion] = useState(0);
  const footage = useFootage(ride.id, footageVersion);
  const files = footage?.files ?? [];
  const photoLibrary = usePhotos(ride.id);
  const mediaLibrary = useMedia(ride.id);

  // Shared with the gallery.
  const [items, setItems] = usePersisted<StageItem[]>('stage', []);
  const [framings, setFramings] = usePersisted<Record<string, Framing>>('framing', {});
  const [formatId, setFormatId] = usePersisted('format', '9x16');
  const [units, setUnits] = usePersisted<UnitSystem>('units', 'metric');
  const [opacity, setOpacity] = usePersisted('panelOpacity', 0.5);
  const [showSafe] = usePersisted('safe', true);
  // Editor project state.
  const [clips, setClips] = usePersisted<TimelineClip[]>(`timeline.${ride.id}`, []);
  const [name, setName] = usePersisted('projectName', 'Ride highlights');
  const [audioLevel, setAudioLevel] = usePersisted('audioLevel', 0.35);
  const [rearOffset, setRearOffset] = usePersisted('rearOffsetSec', -1);
  const [skipZone] = usePersisted('privacyZoneM', 500);

  const [mode, setMode] = useState<'program' | 'source' | 'map' | 'sync'>('program');
  const [syncTarget, setSyncTarget] = useState<SyncTarget | null>(null);
  const [mapSel, setMapSel] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [source, setSource] = useState<MomentInfo | null>(null);
  const [photoPreview, setPhotoPreview] = useState<{ id: string; rideT: number } | null>(null);
  const [sourceCam, setSourceCam] = useState<CameraMode>('front');
  const [selClip, setSelClip] = useState<string | null>(null);
  const [selItem, setSelItem] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const fmt = FORMATS.find((f) => f.id === formatId) ?? FORMATS[0];
  const total = totalDuration({ clips });
  const program = useClock(0, Math.max(total, 1 / FPS));
  const src = useClock(0, ride.duration);

  const moments: MomentInfo[] = useMemo(() => {
    const totalDist = ride.extent('distance')[1];
    return detectMoments(ride, { units }).map((m) => {
      const ms = ride.startMs + m.start * 1000;
      const d = ride.at('distance', m.peakT);
      return {
        ...m,
        front: coverage(files, 'front', ms, m.end - m.start, rearOffset),
        rear: coverage(files, 'rear', ms, m.end - m.start, rearOffset),
        privacy: Number.isFinite(d) && (d < skipZone || d > totalDist - skipZone),
      };
    });
  }, [ride, units, files, rearOffset, skipZone]);

  const sources: MomentInfo[] = useMemo(() => sourceWindows(files, ride.startMs, ride.duration, rearOffset).map(({ file, start, end }) => ({
    id: `source-${file.camera}-${file.name}`, detector: 'source', sourceFile: file.name,
    label: file.label ?? file.name, detail: `${(end - start).toFixed(1)} s · ${file.camera}`,
    peakT: start, start, end, rank: 1, strength: 1,
    front: file.camera === 'front' ? 1 : 0, rear: file.camera === 'rear' ? 1 : 0, privacy: false,
  })), [files, ride, rearOffset]);

  const project: Project = {
    version: 1, name, rideId: ride.id, formatId: fmt.id, units, panelOpacity: opacity,
    framing: framings[fmt.id] ?? DEFAULT_FRAMING, overlays: items, clips, audioLevel, rearOffsetSec: rearOffset,
  };

  // Which ride time and camera the stage shows.
  const at = programAt(project, program.t);
  const rideT = mode === 'source' && photoPreview ? photoPreview.rideT : mode === 'source' || (mode === 'map' && source) ? src.t : at?.rideT ?? 0;
  const activePhotoId = mode === 'source' ? photoPreview?.id : at?.clip.kind === 'photo' ? at.clip.photoId : undefined;
  const activePhoto = photoLibrary.photos.find((p) => p.id === activePhotoId);
  const cam: CameraMode = mode === 'source' ? sourceCam : at?.clip.camera ?? 'front';
  const playing = mode === 'source' ? src.playing : program.playing;
  const sourceMatchesCamera = sourceCam === 'rear' ? source?.rear : source?.front;
  const sourceFile = mode === 'source' ? (sourceMatchesCamera ? source?.sourceFile : undefined) : at?.clip.sourceFile;
  const main = activePhotoId ? null : previewAt(ride, files, cam === 'rear' ? 'rear' : 'front', rideT, rearOffset, sourceFile);
  const inset = !activePhotoId && cam === 'pip' ? previewAt(ride, files, 'rear', rideT, rearOffset) : null;
  const clipFraming = mode === 'program' ? at?.clip.framing : undefined;
  const framing = clipFraming ?? framings[fmt.id] ?? DEFAULT_FRAMING;
  const frame: WidgetFrame = { ride, t: rideT, units, panelOpacity: opacity };

  const fromMoment = (m: MomentInfo, seconds?: number): TimelineClip => {
    let start = m.start;
    let duration = m.end - m.start;
    if (seconds) {
      const ratio = (m.peakT - m.start) / Math.max(0.1, m.end - m.start);
      start = Math.max(0, m.peakT - ratio * seconds);
      duration = seconds;
    }
    const camera: CameraMode = m.front < 0.99 && m.rear >= 0.99 ? 'rear' : m.detector === 'braking' && m.rear >= 0.99 ? 'pip' : 'front';
    return { id: uid(), label: m.label, rideStart: snap(start), duration: snap(duration), camera, sourceFile: m.sourceFile, momentId: m.id, detector: m.detector };
  };

  const preview = (m: MomentInfo) => {
    setPhotoPreview(null);
    setSource(m);
    setMode('source');
    setSourceCam(m.front < 0.99 && m.rear >= 0.99 ? 'rear' : 'front');
    program.setPlaying(false);
    src.setT(Math.max(0, m.start - (m.sourceFile ? 0 : 1)));
    src.setLoop([Math.max(0, m.start - (m.sourceFile ? 0 : 1)), Math.min(ride.duration, m.end + (m.sourceFile ? 0 : 1))]);
    src.setPlaying(true);
  };
  const add = (m: MomentInfo, camera?: CameraMode) => {
    const c = fromMoment(m);
    if (camera) {
      c.camera = camera;
      if ((camera === 'rear' ? m.rear : m.front) < 0.99) c.sourceFile = undefined;
    }
    setClips([...clips, c]);
    setSelClip(c.id);
  };
  const addPhoto = (photo: PhotoFile) => {
    const c: TimelineClip = { id: uid(), label: photo.label, kind: 'photo', photoId: photo.id,
      rideStart: photoRideTime(photo, ride.startMs, ride.duration) ?? Math.max(0, Math.min(ride.duration, rideT)),
      duration: 5, camera: 'front', framing: { ...framing } };
    setClips([...clips, c]);
    setSelClip(c.id);
    setSelItem(null);
    setMode('program');
    src.setPlaying(false);
    program.setPlaying(false);
    program.setT(total);
  };
  const previewPhoto = (photo: PhotoFile) => {
    setPhotoPreview({ id: photo.id, rideT: photoRideTime(photo, ride.startMs, ride.duration) ?? Math.max(0, Math.min(ride.duration, rideT)) });
    setSource(null);
    setMode('source');
    src.setPlaying(false);
    program.setPlaying(false);
  };
  // Imported videos: preview/add use the clip's placed window (clamped to the activity for preview).
  const mediaMoment = (m: MediaInfo): MomentInfo | null => {
    const c = mediaCoverage(m, ride.startMs, ride.duration);
    if (!c) return null;
    const start = Math.max(0, c.start);
    const end = Math.min(ride.duration, c.end);
    return { id: `media-${m.id}`, detector: 'source', sourceFile: m.name, label: m.label, detail: `${m.duration.toFixed(1)} s · ${m.device ?? 'video'}`,
      peakT: start, start, end: Math.max(start, end), rank: 1, strength: 1, front: 1, rear: 0, privacy: false };
  };
  const previewMedia = (m: MediaInfo) => {
    const moment = mediaMoment(m);
    if (moment && moment.end > moment.start) preview(moment);
  };
  const addMedia = (m: MediaInfo) => {
    const c = mediaCoverage(m, ride.startMs, ride.duration);
    if (!c) return;
    const clip: TimelineClip = { id: uid(), label: m.label, rideStart: snap(c.start), duration: snap(m.duration), camera: 'front', sourceFile: m.name, detector: 'source' };
    setClips([...clips, clip]);
    setSelClip(clip.id);
  };
  const startSync = (target: SyncTarget) => {
    setSyncTarget(target);
    setMode('sync');
    src.setPlaying(false);
    program.setPlaying(false);
  };
  const pinVideo = async (m: MediaInfo, startUtc: string, device: boolean) => {
    const list = await mediaLibrary.sync(m.id, startUtc, device);
    setFootageVersion((v) => v + 1);
    const updated = list.find((x) => x.id === m.id);
    if (updated) previewMedia(updated);
  };
  /** Shift a placed clip against the telemetry (positive = video later). */
  const nudgeMedia = (m: MediaInfo, seconds: number) => {
    if (!m.startUtc) return;
    void mediaLibrary.sync(m.id, new Date(Date.parse(m.startUtc) + seconds * 1000).toISOString(), m.sync !== 'clock' && !!m.device && !!m.recordedUtc)
      .then((list) => {
        setFootageVersion((v) => v + 1);
        // Keep the previewed window on the shifted clip so "+ Add" takes the whole clip.
        const moved = list.find((x) => x.id === m.id);
        const moment = moved && mediaMoment(moved);
        if (moment && moment.end > moment.start && source?.id === moment.id) {
          setSource(moment);
          src.setLoop([moment.start, moment.end]);
        }
      });
  };
  const sourceMedia = mode === 'source' ? mediaLibrary.media.find((m) => m.name === source?.sourceFile) : undefined;
  const auto = (count: number, seconds: number) => {
    const picks = autoPick(moments, count, (m: Moment) => {
      const mi = m as MomentInfo;
      return !mi.privacy && (mi.front >= 0.99 || mi.rear >= 0.99);
    });
    setClips(picks.map((m) => fromMoment(m as MomentInfo, seconds)));
    setMode('program');
    src.setPlaying(false);
    program.setT(0);
    program.setPlaying(true);
  };
  const patchClip = (id: string, p: Partial<TimelineClip>) => setClips(clips.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const sel = clips.find((c) => c.id === selClip);

  // Custom clip marked on the map (start/end clicks), as a moment so preview/add reuse the same path.
  const custom: MomentInfo | null = (() => {
    if (mapSel.a === null || mapSel.b === null) return null;
    const start = Math.min(mapSel.a, mapSel.b);
    const end = Math.min(Math.max(mapSel.a, mapSel.b), start + 120);
    const ms = ride.startMs + start * 1000;
    const dist = ride.at('distance', end) - ride.at('distance', start);
    return {
      id: `custom-${start}-${end}`, detector: 'custom', label: 'Custom clip',
      detail: `${(end - start).toFixed(0)} s · ${(dist / 1000).toFixed(2)} km`, peakT: start, start, end, rank: 1, strength: 1,
      front: coverage(files, 'front', ms, end - start, rearOffset), rear: coverage(files, 'rear', ms, end - start, rearOffset), privacy: false,
    };
  })();
  const selOverlay = items.find((i) => i.uid === selItem);
  const selOverlayDef = selOverlay && registry.get(selOverlay.widgetId);
  const patchItem = (p: Partial<StageItem>) => setItems(items.map((i) => (i.uid === selItem ? { ...i, ...p } : i)));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea, video') || mode === 'sync') return;
      if (e.code === 'Space') {
        e.preventDefault();
        const c = mode === 'source' ? src : program;
        c.setPlaying(!c.playing);
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && selClip) {
        setClips(clips.filter((c) => c.id !== selClip));
        setSelClip(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const lt = ride.localTime(rideT);
  function clockOf(t: number) {
    const l = ride.localTime(t);
    return `${pad2(l.h)}:${pad2(l.m)}:${pad2(l.s)}`;
  }
  return (
    <div className="app editor">
      <header className="topbar">
        {nav}
        <input className="name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
        <div className="controls">
          <div className="group seg">
            {FORMATS.map((f) => <button key={f.id} className={fmt.id === f.id ? 'on' : ''} onClick={() => setFormatId(f.id)}>{f.label}</button>)}
          </div>
          <label className="slider">Panel <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} /><output>{Math.round(opacity * 100)}%</output></label>
          <div className="group seg">
            {(['metric', 'imperial'] as const).map((u) => <button key={u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>{u}</button>)}
          </div>
          <button className="primary" disabled={!clips.length} onClick={() => setExporting(true)}>Export…</button>
        </div>
      </header>

      <div className="editor-main">
        <MomentsPanel ride={ride} moments={moments} sources={sources} selected={mode === 'source' ? source?.id ?? null : null}
          inTimeline={new Set(clips.map((c) => c.momentId ?? ''))} onPreview={preview} onAdd={add} onAuto={auto}
          photos={<MediaPanel ride={ride} media={mediaLibrary.media} error={mediaLibrary.error}
            onImported={(m) => { mediaLibrary.imported(m); setFootageVersion((v) => v + 1); }} onPhotoImported={photoLibrary.imported}
            onPin={(m) => startSync({ kind: 'video', media: m })} onPreview={previewMedia} onAdd={addMedia}
            photos={<PhotosPanel ride={ride} photos={photoLibrary.photos} error={photoLibrary.error}
              onImported={photoLibrary.imported} onAdd={addPhoto} onPreview={previewPhoto} />} />} />

        <section className="monitor">
          <div className="monitor-bar">
            <div className="group seg">
              <button className={mode === 'program' ? 'on' : ''} onClick={() => { setMode('program'); src.setPlaying(false); }}>Program</button>
              <button className={mode === 'source' ? 'on' : ''} disabled={!source && !photoPreview} onClick={() => { setMode('source'); program.setPlaying(false); }}>Source</button>
              <button className={mode === 'map' ? 'on' : ''} onClick={() => { setMode('map'); program.setPlaying(false); src.setPlaying(false); }}>Map</button>
              {syncTarget && <button className={mode === 'sync' ? 'on' : ''} onClick={() => startSync(syncTarget)}>Pin sync</button>}
            </div>
            {mode !== 'map' && mode !== 'sync' && !(mode === 'source' && photoPreview) && <button className="play" onClick={() => (mode === 'source' ? src : program).setPlaying(!playing)}>{playing ? '❚❚' : '▶'}</button>}
            {mode === 'map' && (
              <div className="map-sel">
                {mapSel.a === null ? <span>Click the route to mark a clip start, then its end.</span> : (
                  <>
                    <span><b>In</b> {clockOf(Math.min(mapSel.a, mapSel.b ?? mapSel.a))}</span>
                    {mapSel.b !== null ? <span><b>Out</b> {clockOf(Math.max(mapSel.a, mapSel.b))}</span> : <span className="muted">click the end point…</span>}
                    {custom && (
                      <>
                        <span>{custom.detail}{Math.abs(mapSel.b! - mapSel.a) > 120 ? ' (capped at 120 s)' : ''}</span>
                        <span className={`cam ${custom.front > 0.99 ? 'ok' : ''}`}>F</span><span className={`cam ${custom.rear > 0.99 ? 'ok' : ''}`}>R</span>
                        <button className="small" onClick={() => preview(custom)}>Preview</button>
                        <button className="primary small" onClick={() => { add(custom); setMapSel({ a: null, b: null }); }}>+ Add to timeline</button>
                      </>
                    )}
                    <button className="link" onClick={() => setMapSel({ a: null, b: null })}>Clear</button>
                  </>
                )}
              </div>
            )}
            <span className="readout-inline">
              <strong>{`${pad2(lt.h)}:${pad2(lt.m)}:${pad2(lt.s)}`}</strong>
              {mode === 'program' ? ` · ${program.t.toFixed(1)} / ${total.toFixed(1)} s` : mode === 'source' ? activePhoto ? ` · ${activePhoto.label}` : ` · ${source?.label}: ${source?.detail}` : ''}
            </span>
            {mode === 'source' && source && (
              <>
                <div className="group seg">
                  {(['front', 'pip', 'rear'] as const).map((c) => <button key={c} className={sourceCam === c ? 'on' : ''} onClick={() => setSourceCam(c)}>{c === 'pip' ? 'F+R' : c}</button>)}
                </div>
                <button className="primary small" onClick={() => add(source, sourceCam)}>+ Add to timeline</button>
              </>
            )}
            {mode === 'source' && activePhoto && <button className="primary small" onClick={() => addPhoto(activePhoto)}>+ Add to timeline</button>}
            {sourceMedia && (
              <span className="nudge" title="Shift this clip against the telemetry; positive moves the video later. Applies to its camera when it was pinned.">Sync
                {[-1, -0.2, 0.2, 1].map((d) => <button key={d} onClick={() => nudgeMedia(sourceMedia, d)}>{d > 0 ? `+${d}` : d}s</button>)}
                <button onClick={() => startSync({ kind: 'video', media: sourceMedia })}>Re-pin</button>
              </span>
            )}
          </div>
          {!footage && <div className="banner">Indexing camera files on the media share…</div>}
          {mode !== 'sync' && main?.file.syncNotice && <div className="banner">{main.file.syncNotice}</div>}
          {mode !== 'sync' && activePhoto && <div className="banner" title={activePhoto.clockSource ?? undefined}>{activePhoto.gps ? `Photo location: ${activePhoto.gps.lat.toFixed(6)}, ${activePhoto.gps.lon.toFixed(6)}. ` : ''}HUD held at ride {rideT.toFixed(1)} s. {activePhoto.capturedUtc ? 'Capture-time alignment is approximate.' : 'Choose the ride time manually.'}</div>}
          {activePhotoId && !activePhoto && <div className="banner">This photo is unavailable. Restore its local import or remove the clip.</div>}
          {footage?.error && !activePhotoId && <div className="banner">Footage: {footage.error} ({footage.mediaRoot}). Moments still work; preview shows data only.</div>}
          {mode === 'sync' && syncTarget ? (
            <SyncView ride={ride} units={units} target={syncTarget.kind === 'video' ? { kind: 'video', media: mediaLibrary.media.find((m) => m.id === syncTarget.media.id) ?? syncTarget.media } : syncTarget}
              onClose={() => { setMode('program'); setSyncTarget(null); }}
              onPinVideo={(startUtc, device) => syncTarget.kind === 'video' ? pinVideo(syncTarget.media, startUtc, device) : Promise.resolve()}
              onPinPhoto={(t) => { if (syncTarget.kind === 'photo') patchClip(syncTarget.clipId, { rideStart: Math.max(0, Math.min(ride.duration, t)) }); setSyncTarget(null); setMode('program'); }} />
          ) : mode === 'map' ? (
            <MapView ride={ride} units={units} privacyTrim={skipZone} moments={moments} clips={clips} playheadT={rideT}
              selection={mapSel} onSelection={setMapSel} onMoment={preview} photos={photoLibrary.photos} onPhoto={previewPhoto} />
          ) : <Stage format={fmt} source={activePhoto ? photoSourceInfo(activePhoto) : stageSource(main?.file)} framing={framing}
            onFraming={(f) => (clipFraming && sel && at?.clip.id === sel.id ? patchClip(sel.id, { framing: f }) : setFramings({ ...framings, [fmt.id]: f }))}
            clip={activePhoto ? { kind: 'photo', src: photoUrl(activePhoto), startT: rideT, duration: 5 } : main} inset={inset} frame={frame} playing={playing}
            items={items} onItems={setItems} selected={selItem} onSelect={setSelItem} showSafe={showSafe} />}
          <div className="inspector" hidden={mode === 'sync'}>
            {selOverlay && selOverlayDef ? (
              <>
                <strong>{selOverlayDef.name}</strong>
                <label className="slider">Opacity <input type="range" min={0.1} max={1} step={0.05} value={selOverlay.opacity} onChange={(e) => patchItem({ opacity: +e.target.value })} /><output>{Math.round(selOverlay.opacity * 100)}%</output></label>
                <label className="slider">Size <input type="range" min={0.3} max={4} step={0.05} value={selOverlay.scale} onChange={(e) => patchItem({ scale: +e.target.value })} /><output>{selOverlay.scale.toFixed(2)}×</output></label>
                <SettingsFields def={selOverlayDef} values={selOverlay.settings} onChange={(settings) => patchItem({ settings })} />
                <button className="link" onClick={() => setSelItem(null)}>Done</button>
              </>
            ) : sel ? (
              <>
                <input className="clip-name" value={sel.label} onChange={(e) => patchClip(sel.id, { label: e.target.value })} />
                {sel.kind === 'photo' ? <>
                  <label>Display duration <input aria-label="Photo display duration" type="number" min={1 / FPS} max={120} step={1 / FPS} value={sel.duration} onChange={(e) => {
                    const value = e.target.valueAsNumber;
                    if (Number.isFinite(value)) patchClip(sel.id, { duration: snap(Math.max(1 / FPS, Math.min(120, value))) });
                  }} /> s</label>
                  <label>Ride time <input aria-label="Photo ride time" type="number" min={0} max={ride.duration} step={0.1} value={sel.rideStart} onChange={(e) => {
                    const value = e.target.valueAsNumber;
                    if (Number.isFinite(value)) patchClip(sel.id, { rideStart: Math.max(0, Math.min(ride.duration, value)) });
                  }} /> s</label>
                  <button className="small" onClick={() => startSync({ kind: 'photo', clipId: sel.id, photo: photoLibrary.photos.find((p) => p.id === sel.photoId), label: sel.label, rideT: sel.rideStart })}>Pin on map</button>
                </> : <div className="group seg">
                  {(['front', 'pip', 'rear'] as const).map((c) => <button key={c} className={sel.camera === c ? 'on' : ''} onClick={() => patchClip(sel.id, { camera: c, sourceFile: (c === 'rear') === (sel.camera === 'rear') ? sel.sourceFile : undefined })}>{c === 'pip' ? 'Front + rear' : c}</button>)}
                </div>}
                {sel.kind !== 'photo' && <span className="nudge">Slide
                  {[-1, -0.2, 0.2, 1].map((d) => <button key={d} onClick={() => patchClip(sel.id, { rideStart: snap(Math.max(0, sel.rideStart + d)) })}>{d > 0 ? `+${d}` : d}s</button>)}
                </span>}
                <label className="check"><input type="checkbox" checked={!!sel.framing} onChange={(e) => patchClip(sel.id, { framing: e.target.checked ? framing : undefined })} /> Own framing</label>
                <button className="link" onClick={() => { setClips(clips.filter((c) => c.id !== sel.id)); setSelClip(null); }}>Remove</button>
              </>
            ) : (
              <span className="hint">Click a moment to preview it · + adds it · drag clips to reorder, edges to trim · space plays</span>
            )}
          </div>
        </section>
      </div>

      <footer className="editor-foot">
        <div className="foot-bar">
          <strong>Timeline</strong>
          <span>{`${clips.length} clips · ${formatDuration(total).replace(/^0:/, '')}`}</span>
          {total > 90 && fmt.id === '9x16' && <span className="warn">Over 90 s — long for Reels</span>}
          <label className="slider">Camera audio <input type="range" min={0} max={1} step={0.05} value={audioLevel} onChange={(e) => setAudioLevel(+e.target.value)} /><output>{Math.round(audioLevel * 100)}%</output></label>
          <span className="nudge" title="Rear camera clock correction. Its burned-in clock read 1 s behind file time when checked.">Rear sync
            <button onClick={() => setRearOffset(Math.round((rearOffset - 0.1) * 10) / 10)}>−</button>
            <output>{rearOffset > 0 ? '+' : ''}{rearOffset.toFixed(1)} s</output>
            <button onClick={() => setRearOffset(Math.round((rearOffset + 0.1) * 10) / 10)}>+</button>
          </span>
          {clips.length > 0 && <button className="link" onClick={() => { setClips([]); setSelClip(null); }}>Clear</button>}
        </div>
        <EditTimeline clips={clips} selected={selClip} onSelect={setSelClip} onChange={setClips}
          programT={program.t} onSeek={(pt) => { setMode('program'); src.setPlaying(false); program.setT(pt); }}
          coverage={(c) => c.kind === 'photo' ? (photoLibrary.photos.some((p) => p.id === c.photoId) ? 1 : 0) : coverage(c.sourceFile ? files.filter((f) => f.name === c.sourceFile) : files, c.camera === 'rear' ? 'rear' : 'front', ride.startMs + c.rideStart * 1000, c.duration, rearOffset)}
          icon={(c) => c.kind === 'photo' ? '▧' : detectorById(c.detector ?? '')?.icon ?? '●'} />
      </footer>

      {exporting && <ExportDialog project={project} onClose={() => setExporting(false)} onFormat={setFormatId} />}
    </div>
  );
}
