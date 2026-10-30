/**
 * Media panel: drop or pick any videos and photos for the open activity. Videos show how
 * they are placed (map pin, camera offset, recorded clock, or not yet) and how much of
 * each clip falls inside the activity; clips outside are allowed, with a warning.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { mediaCoverage, type MediaInfo, type PhotoFile } from '../core/project';
import type { Ride } from '../core/ride';
import { pad2 } from '../core/units';
import { pairedSidecar, uploadSidecar } from '../core/mediaImport';

const PHOTO_EXT = /\.(jpe?g|png|webp|tiff?|heic|heif)$/i;
const SYNC_LABEL: Record<MediaInfo['sync'], string> = { pin: 'Pinned', device: 'Camera offset', clock: 'Camera clock', none: 'Not placed' };

export function useMedia(rideId: string) {
  const [media, setMedia] = useState<MediaInfo[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setMedia([]);
    fetch(`/api/media?rideId=${encodeURIComponent(rideId)}`).then(async (r) => {
      const result = await r.json();
      if (!r.ok) throw new Error(result.error ?? 'Could not load videos');
      if (active) setMedia(result.media);
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rideId]);
  /** Pin (or clear) a clip's playback-zero UTC; the server returns the updated list. */
  const sync = async (id: string, startUtc: string | null, device = false) => {
    const r = await fetch(`/api/media/${id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startUtc, device }) });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error ?? 'Sync failed');
    setMedia(result.media);
    return result.media as MediaInfo[];
  };
  return { media, error, imported: (m: MediaInfo) => setMedia((current) => [...current, m]), sync };
}

export function rideClock(ride: Ride, t: number): string {
  const l = ride.localTime(t);
  return `${pad2(l.h)}:${pad2(l.m)}:${pad2(l.s)}`;
}

/** "Inside the activity" summary for a placed clip, with a warning level. */
export function coverageText(ride: Ride, m: MediaInfo): { text: string; warn: boolean } {
  const c = mediaCoverage(m, ride.startMs, ride.duration);
  if (!c) return { text: 'Pin a moment on the map to place it', warn: true };
  if (c.inside <= 0) return { text: `Outside the activity (${c.end <= 0 ? 'before' : 'after'} it): no telemetry for this clip`, warn: true };
  const span = `${rideClock(ride, Math.max(0, c.start))}–${rideClock(ride, Math.min(ride.duration, c.end))}`;
  return c.inside < 0.999 ? { text: `${span} · only ${Math.round(c.inside * 100)}% inside the activity`, warn: true } : { text: span, warn: false };
}

export function MediaPanel({ ride, media, error, onImported, onPhotoImported, onPin, onPreview, onAdd, photos }: {
  ride: Ride; media: MediaInfo[]; error: string;
  onImported: (m: MediaInfo) => void;
  onPhotoImported: (p: PhotoFile) => void;
  onPin: (m: MediaInfo) => void;
  onPreview: (m: MediaInfo) => void;
  onAdd: (m: MediaInfo) => void;
  /** The photo list (rendered below the videos). */
  photos: ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [over, setOver] = useState(false);

  const upload = async (files: File[]) => {
    setFailures([]);
    const mediaFiles = files.filter((f) => !/\.srt$/i.test(f.name));
    if (!mediaFiles.length) { setFailures(['Select the SRT together with its matching video.']); return; }
    for (const [i, file] of mediaFiles.entries()) {
      const photo = PHOTO_EXT.test(file.name);
      setBusy(`${photo ? 'Importing' : 'Importing and probing'} ${file.name} (${i + 1}/${mediaFiles.length})…`);
      try {
        const sidecar = photo ? '' : await uploadSidecar(pairedSidecar(files, file));
        const r = await fetch(`/api/${photo ? 'photos' : 'media'}?rideId=${encodeURIComponent(ride.id)}&name=${encodeURIComponent(file.name)}${sidecar}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        const result = await r.json();
        if (!r.ok) throw new Error(`${file.name}: ${result.error ?? 'import failed'}`);
        if (photo) onPhotoImported(result); else onImported(result);
      } catch (e) {
        setFailures((f) => [...f, (e as Error).message]);
      }
    }
    setBusy('');
  };

  return (
    <section className={`media-panel ${over ? 'drop' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]); }}>
      <h3>Videos &amp; photos <button className="small" disabled={!!busy} onClick={() => picker.current?.click()}>{busy ? 'Importing…' : 'Import…'}</button></h3>
      <input ref={picker} type="file" multiple accept="video/*,image/*,.srt,.mkv,.avi,.mts,.m2ts,.3gp,.heic,.heif" hidden onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length) void upload(files);
      }} />
      <div className="drop-hint">{busy || 'Drop videos or photos here: any camera, no GPS needed.'}</div>
      {(error || failures.length > 0) && <p role="alert" className="warn">{[error, ...failures].filter(Boolean).join(' · ')}</p>}
      {media.map((m) => {
        const cov = coverageText(ride, m);
        const inside = mediaCoverage(m, ride.startMs, ride.duration)?.inside ?? 0;
        return (
          <div className="media-card" key={m.id}>
            <strong title={m.label}>{m.label}</strong>
            <span>{`${m.duration.toFixed(1)} s · ${m.device ?? 'unknown camera'}`}</span>
            {m.detection && <span>{`${m.detection.kind === 'gopro' ? 'GoPro' : m.detection.kind === 'dji' ? 'DJI' : 'EXIF'} · ${m.detection.gpsStatus === 'usable' ? `${m.detection.gpsSamples.toLocaleString()} GPS fixes` : m.detection.gpsStatus === 'unsupported' ? 'GPS format unsupported' : 'no usable camera GPS'}`}</span>}
            {m.warnings.length > 0 && <span className="warn">{m.warnings.join(' ')}</span>}
            <span className={`sync sync-${m.sync}`}>{SYNC_LABEL[m.sync]}</span>
            <span className={cov.warn ? 'warn' : ''}>{cov.text}</span>
            <div className="media-actions">
              <button className="small" onClick={() => onPin(m)}>{m.sync === 'pin' ? 'Re-pin on map' : 'Pin on map'}</button>
              <button className="small" disabled={inside <= 0} onClick={() => onPreview(m)}>Preview</button>
              <button className="small" disabled={!m.startUtc} title={inside < 0.999 ? 'Parts outside the activity show no telemetry' : undefined} onClick={() => onAdd(m)}>+ Add</button>
            </div>
          </div>
        );
      })}
      {photos}
    </section>
  );
}
