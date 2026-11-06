/**
 * Activities page: open an imported activity, drop FIT/GPX files, or read activities
 * straight from a Garmin over WebUSB (Chrome, read-only). Imported files go to the
 * studio server, which keeps the originals and uses the parity-tested TypeScript importers.
 */
import { useEffect, useRef, useState } from 'react';
import { formatDuration, pad2 } from '../core/units';
import { usePersisted } from './persist';
import { activityDate, MtpReader, type DeviceObject, type UsbLike } from '../usb/mtp';
import { pairedSidecar, uploadSidecar } from '../core/mediaImport';

interface RideSummary { id: string; name: string; startUtc: string; durationSec: number; distanceM: number | null; sport: string | null; gps: boolean }
interface UsbApi { requestDevice(o: { filters: { vendorId: number }[] }): Promise<UsbLike & { productName?: string }> }

const GARMIN_VENDOR = 0x091e;
const usb = (navigator as Navigator & { usb?: UsbApi }).usb;

export function openRide(id: string) {
  try { localStorage.setItem('studio.page', JSON.stringify('editor')); } catch { /* storage unavailable */ }
  location.href = `/?ride=${encodeURIComponent(id)}`;
}

async function uploadActivity(name: string, body: Blob | Uint8Array, sidecar?: File): Promise<{ rideId: string; existing: boolean; warnings: string[]; detection?: { kind: string; gpsStatus: string } }> {
  const camera = !/\.(fit|gpx)$/i.test(name);
  const paired = camera ? await uploadSidecar(sidecar) : '';
  const res = await fetch(`/api/${camera ? 'cameras' : 'activities'}?name=${encodeURIComponent(name)}${paired}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: body as BodyInit });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? `${name}: import failed`);
  return result;
}

export function Activities({ demo }: { demo: boolean }) {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void fetch('/api/capabilities').then(async (r) => {
      const capabilities = r.ok ? await r.json() : null;
      if (active && typeof capabilities?.desktop === 'boolean') setDesktop(capabilities.desktop);
    }).catch(() => { /* Capability unknown: keep device access disabled. */ });
    return () => { active = false; };
  }, []);
  const canUsb = desktop === false && !!usb;
  const [rides, setRides] = useState<RideSummary[] | null>(null);
  const [log, setLog] = useState<{ text: string; rideId?: string; error?: boolean }[]>([]);
  const [busy, setBusy] = useState('');
  const [over, setOver] = useState(false);
  const [device, setDevice] = useState<{ reader: MtpReader; name: string; files: DeviceObject[]; picked: Set<number> } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const refresh = () => fetch('/api/rides').then((r) => r.json()).then((j) => setRides(j.rides)).catch(() => setRides([]));
  useEffect(() => { void refresh(); }, []);
  const note = (text: string, extra: { rideId?: string; error?: boolean } = {}) => setLog((l) => [{ text, ...extra }, ...l].slice(0, 12));

  const importFiles = async (files: File[]) => {
    const wanted = files.filter((f) => /\.(fit|gpx|mp4|mov|m4v|webm|mkv|avi|mts|m2ts|3gp)$/i.test(f.name));
    if (!wanted.length) return note('Drop FIT/GPX activities or camera videos here. Still photos go into the editor.', { error: true });
    for (const [i, file] of wanted.entries()) {
      setBusy(`Importing ${file.name} (${i + 1}/${wanted.length})…`);
      try {
        const r = await uploadActivity(file.name, file, pairedSidecar(files, file));
        note(`${file.name}: ${r.existing ? 'already imported' : 'imported'}`, { rideId: r.rideId });
        if (r.detection) note(`${r.detection.kind === 'gopro' ? 'GoPro' : r.detection.kind === 'dji' ? 'DJI' : 'EXIF'} detected · ${r.detection.gpsStatus === 'usable' ? 'camera GPS available' : 'no usable camera GPS'}`, { rideId: r.rideId });
        for (const warning of r.warnings) note(warning);
      } catch (e) { note((e as Error).message, { error: true }); }
    }
    setBusy('');
    void refresh();
  };

  const connect = async () => {
    if (!canUsb) return;
    if (!usb) return;
    let reader: MtpReader | null = null;
    try {
      const dev = await usb.requestDevice({ filters: [{ vendorId: GARMIN_VENDOR }] });
      reader = new MtpReader(dev);
      setBusy('Reading the activity list from the Garmin…');
      await reader.open();
      const files = await reader.listActivities();
      setDevice({ reader, name: dev.productName ?? 'Garmin', files, picked: new Set(files.slice(0, 1).map((f) => f.handle)) });
    } catch (e) {
      await reader?.close();
      if ((e as Error).name !== 'NotFoundError') note((e as Error).message, { error: true });
    } finally { setBusy(''); }
  };
  const closeDevice = async () => {
    await device?.reader.close();
    setDevice(null);
  };
  const importPicked = async () => {
    if (!device) return;
    const files = device.files.filter((f) => device.picked.has(f.handle));
    for (const [i, file] of files.entries()) {
      setBusy(`Reading ${file.filename} from the Garmin (${i + 1}/${files.length})…`);
      try {
        const bytes = await device.reader.download(file);
        const r = await uploadActivity(file.filename, bytes);
        note(`${file.filename}: ${r.existing ? 'already imported' : 'imported'}`, { rideId: r.rideId });
      } catch (e) { note((e as Error).message, { error: true }); }
    }
    setBusy('');
    await closeDevice();
    void refresh();
  };

  return (
    <div className={`activities ${over ? 'drop' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void importFiles([...e.dataTransfer.files]); }}>
      <header className="topbar">
        <nav className="pages"><span className="dot" /><button className="on">Activities</button>{demo && <a className="link" href="/">Demo ride</a>}</nav>
        <div className="controls">
          <button className="primary" disabled={!!busy} onClick={() => picker.current?.click()}>Import activity / video…</button>
          <button className="primary" disabled={!!busy || !canUsb} title={desktop ? 'Desktop USB is unavailable. Import saved FIT/GPX files instead.' : 'Read activities in Chrome on localhost (read-only)'} onClick={() => void connect()}>Connect Garmin (USB)</button>
        </div>
        <input ref={picker} type="file" multiple accept=".fit,.gpx,.srt,video/*,.mkv,.avi,.mts,.m2ts,.3gp" hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void importFiles(f); }} />
      </header>
      <main className="activities-main">
        {desktop && <p className="hint">USB access is unavailable in the desktop alpha. Import saved FIT/GPX files instead.</p>}
        <p className="hint">Drop FIT/GPX activities or camera videos here. GoPro, DJI and EXIF metadata are detected automatically; recorded camera GPS supplies a route when available. Include a matching DJI SRT alongside its video. For workout sensors or clips without GPS, open a matching activity and add your videos and photos in the editor.</p>
        {busy && <div className="banner">{busy}</div>}
        {log.map((l, i) => (
          <div key={i} className={`import-note ${l.error ? 'warn' : ''}`}>{l.text}{l.rideId && <button className="link" onClick={() => openRide(l.rideId!)}>Open</button>}</div>
        ))}
        <AppleHealthPanel onImported={(text, rideId) => { note(text, { rideId }); void refresh(); }} />
        <section className="ride-list">
          {rides === null && <p className="hint">Loading activities…</p>}
          {rides?.length === 0 && <p className="hint">No activities yet.</p>}
          {rides?.map((r) => (
            <button key={r.id} className={`ride-card ${r.gps ? '' : 'no-gps'}`} onClick={() => openRide(r.id)} title={r.gps ? 'Open in the editor' : 'No GPS track: clips cannot be pinned on a map'}>
              <strong>{r.name}</strong>
              <span>{new Date(r.startUtc).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <span>{[r.sport, formatDuration(r.durationSec), r.distanceM !== null ? `${(r.distanceM / 1000).toFixed(2)} km` : null].filter(Boolean).join(' · ')}{r.gps ? '' : ' · no GPS'}</span>
            </button>
          ))}
        </section>
      </main>
      {device && (
        <div className="usb-overlay" role="dialog" aria-label="Garmin activities">
          <div className="modal-box">
            <h3>{device.name}: {device.files.length} activities</h3>
            <p className="hint">Read-only: only the selected FIT files are read from the device. Nothing on the Garmin is changed.</p>
            <div className="usb-list">
              {device.files.map((f) => (
                <label key={f.handle} className="check">
                  <input type="checkbox" checked={device.picked.has(f.handle)} onChange={(e) => {
                    const picked = new Set(device.picked);
                    if (e.target.checked) picked.add(f.handle); else picked.delete(f.handle);
                    setDevice({ ...device, picked });
                  }} />
                  <span>{activityDate(f.filename) ?? f.filename}</span><em>{f.filename} · {(f.size / 1024).toFixed(0)} KB</em>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="link" disabled={!!busy} onClick={() => void closeDevice()}>Cancel</button>
              <button className="primary" disabled={!!busy || !device.picked.size} onClick={() => void importPicked()}>{busy || `Import ${device.picked.size} selected`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AppleWorkout {
  id: string; type: string; sport: string; startUtc: string; endUtc: string; tzOffsetSec: number; durationMin: number;
  distanceM: number | null; avgHeartRate: number | null; source: string; device: string | null; hasRoute: boolean; matches: string[]; rideId: string | null;
}

/** Local wall-clock text using the workout's recorded UTC offset. */
function workoutClock(w: AppleWorkout): string {
  const d = new Date(Date.parse(w.startUtc) + w.tzOffsetSec * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * Apple Health export (read-only, stays where it is): list Apple Watch workouts, flag those
 * overlapping your clips and photos, import one as an activity.
 */
function AppleHealthPanel({ onImported }: { onImported: (text: string, rideId: string) => void }) {
  const [path, setPath] = usePersisted('appleHealthPath', '');
  const [filter, setFilter] = usePersisted<'matches' | 'routes'>('appleHealthFilter', 'matches');
  const [result, setResult] = useState<{ exportDate: string | null; workouts: AppleWorkout[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? 'Request failed');
    return j;
  };
  const scan = async () => {
    setBusy('Reading export.xml (about 10 s per GB the first time)…');
    setError('');
    try { setResult(await post('/api/apple-health/scan', { path })); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const importWorkout = async (w: AppleWorkout) => {
    setBusy(`Importing ${w.type} ${workoutClock(w)}…`);
    setError('');
    try {
      const r = await post('/api/apple-health/import', { path, workoutId: w.id });
      setResult((cur) => cur && { ...cur, workouts: cur.workouts.map((x) => (x.id === w.id ? { ...x, rideId: r.rideId } : x)) });
      onImported(`${w.type} ${workoutClock(w)}: ${r.existing ? 'already imported' : 'imported from Apple Health'}`, r.rideId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const routes = result?.workouts.filter((w) => w.hasRoute) ?? [];
  const shown = filter === 'matches' ? routes.filter((w) => w.matches.length) : routes;
  return (
    <section className="apple-panel">
      <h3>Apple Health export</h3>
      <p className="hint">Export from the Health app (profile → Export All Health Data), unzip, and enter the folder. Apple Watch workouts with a route can be imported; the export is only read.</p>
      <div className="apple-row">
        <input aria-label="Apple Health export folder" placeholder="/Users/you/Downloads/apple_health_export" value={path} onChange={(e) => setPath(e.target.value)} />
        <button className="primary" disabled={!path || !!busy} onClick={() => void scan()}>{result ? 'Rescan' : 'Scan export'}</button>
      </div>
      {busy && <div className="banner">{busy}</div>}
      {error && <p role="alert" className="warn">{error}</p>}
      {result && (
        <>
          <div className="apple-row">
            <span className="hint">{`${result.workouts.length} workouts · ${routes.length} Apple Watch workouts with a route · export ${result.exportDate?.slice(0, 10) ?? ''}`}</span>
            <div className="group seg">
              <button className={filter === 'matches' ? 'on' : ''} onClick={() => setFilter('matches')}>With your clips</button>
              <button className={filter === 'routes' ? 'on' : ''} onClick={() => setFilter('routes')}>All with routes</button>
            </div>
          </div>
          {!shown.length && <p className="hint">{filter === 'matches' ? 'No route workout overlaps your camera files, imported videos or photos by recorded time. Camera clocks can be off: try All with routes.' : 'No workouts with routes.'}</p>}
          <div className="apple-list">
            {shown.map((w) => (
              <div key={w.id} className="apple-workout">
                <strong>{`${workoutClock(w)} · ${w.type}`}</strong>
                <span>{[`${w.durationMin.toFixed(0)} min`, w.distanceM !== null ? `${(w.distanceM / 1000).toFixed(2)} km` : null, w.avgHeartRate !== null ? `${w.avgHeartRate.toFixed(0)} bpm avg` : null, w.device].filter(Boolean).join(' · ')}</span>
                {w.matches.length > 0 && <span className="match" title={w.matches.join('\n')}>{`▶ ${w.matches.length} overlapping clip${w.matches.length > 1 ? 's' : ''}/photo${w.matches.length > 1 ? 's' : ''}`}</span>}
                {w.rideId ? <button className="small" onClick={() => openRide(w.rideId!)}>Open</button>
                  : <button className="small" disabled={!!busy} onClick={() => void importWorkout(w)}>Import</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
