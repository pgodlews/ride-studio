import { useEffect, useState } from 'react';
import { FORMATS } from '../core/framing';
import { totalDuration, type Project } from '../core/project';

interface Job {
  id: string;
  status: 'queued' | 'hud' | 'video' | 'done' | 'error';
  progress: number;
  message: string;
  url?: string;
  output?: string;
  checks?: Record<string, string | number>;
  log: string[];
  startedAt: number;
  finishedAt?: number;
}

/** Social targets → output format; all encode H.264 high / AAC 48 kHz, 30 fps, fast start. */
export const PRESETS = [
  { id: 'reels', label: 'Reels · TikTok · Shorts', formatId: '9x16', limit: 90, note: 'Shorts ≤ 60 s · Reels ≤ 90 s for full reach' },
  { id: 'feed', label: 'Instagram feed', formatId: '4x5', limit: 60 },
  { id: 'square', label: 'Square', formatId: '1x1', limit: 60 },
  { id: 'youtube', label: 'YouTube · Strava', formatId: '16x9', limit: 600 },
];

export function ExportDialog({ project, onClose, onFormat }: { project: Project; onClose: () => void; onFormat: (id: string) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const total = totalDuration(project);
  const photoCount = project.clips.filter((c) => c.kind === 'photo').length;
  const fmt = FORMATS.find((f) => f.id === project.formatId) ?? FORMATS[0];

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;
    const t = setInterval(async () => {
      let r: Response;
      try {
        r = await fetch(`/api/export/${job.id}`);
      } catch {
        setJob({ ...job, status: 'error', message: 'Lost connection to the studio server (stopped or restarted). Start it with npm run dev and export again.' });
        return;
      }
      if (r.ok) setJob(await r.json());
      else if (r.status === 404) setJob({ ...job, status: 'error', message: 'Export job lost — the studio server restarted. Export again.' });
    }, 700);
    return () => clearInterval(t);
  }, [job]);

  const start = async () => {
    setErr(null);
    const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
    const body = await r.json();
    if (!r.ok) return setErr(body.error ?? 'Export failed to start');
    setJob({ id: body.id, status: 'queued', progress: 0, message: 'Queued', log: [], startedAt: Date.now() });
  };

  const busy = job && job.status !== 'done' && job.status !== 'error';
  const phase = job?.status === 'hud' ? 'Starting HUD renderer (Chrome)' : job?.message;
  const overall = job ? (job.status === 'video' ? 0.05 + job.progress * 0.95 : job.status === 'done' ? 1 : job.status === 'hud' ? 0.02 : 0) : 0;

  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Export</h2>
          <button className="link" onClick={onClose} disabled={!!busy}>Close</button>
        </header>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.id} className={`preset ${project.formatId === p.formatId ? 'on' : ''}`} disabled={!!busy} onClick={() => onFormat(p.formatId)}>
              <strong>{p.label}</strong>
              <span>{FORMATS.find((f) => f.id === p.formatId)!.label} · {FORMATS.find((f) => f.id === p.formatId)!.w}×{FORMATS.find((f) => f.id === p.formatId)!.h}</span>
              {total > p.limit && <em>{Math.round(total)} s is over {p.limit} s</em>}
            </button>
          ))}
        </div>
        <dl className="summary">
          <dt>Output</dt><dd>{fmt.w}×{fmt.h}, 30 fps, H.264 + AAC, MP4 (fast start)</dd>
          <dt>Length</dt><dd>{total.toFixed(1)} s · {project.clips.length} clips</dd>
          <dt>Source</dt><dd>{photoCount === project.clips.length ? 'Imported photos' : photoCount ? 'Original camera footage and imported photos' : 'Original full-resolution camera files'}; HUD from the same widgets as the preview</dd>
          <dt>Overlays</dt><dd>{project.overlays.length} widgets · panel opacity {Math.round(project.panelOpacity * 100)}%</dd>
        </dl>
        {job && (
          <div className="job">
            <div className="bar"><div style={{ width: `${Math.round(overall * 100)}%` }} className={job.status} /></div>
            <div className="msg">{job.status === 'error' ? `Failed: ${job.message}` : job.status === 'done' ? job.message : `${phase} · ${Math.round(job.progress * 100)}%`}</div>
            {job.status === 'done' && job.url && (
              <div className="result">
                <video src={job.url} controls playsInline />
                <div>
                  <a className="primary" href={job.url} download>Download MP4</a>
                  <code title="Saved on this Mac">{job.output}</code>
                  {job.checks && <small>{`${job.checks.width}×${job.checks.height} · ${job.checks.frames} frames · ${Number(job.checks.seconds).toFixed(2)} s · ${job.checks.sizeMB} MB · took ${Math.round(((job.finishedAt ?? 0) - job.startedAt) / 1000)} s`}</small>}
                </div>
              </div>
            )}
            {job.status === 'error' && <details><summary>Log</summary><pre>{job.log.join('\n\n')}</pre></details>}
          </div>
        )}
        {err && <p className="error">{err}</p>}
        <footer>
          <button className="primary" disabled={!!busy || !project.clips.length} onClick={start}>{job?.status === 'done' ? 'Export again' : 'Export MP4'}</button>
        </footer>
      </div>
    </div>
  );
}
