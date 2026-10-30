/**
 * Program timeline: clips in play order. Drag a clip to reorder, drag its edges to trim
 * (edges move the in/out point in ride time), click the camera badge to cycle
 * front → front + rear inset → rear.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { totalDuration, type CameraMode, type TimelineClip } from '../core/project';

const FPS = 30;
const snap = (s: number) => Math.round(s * FPS) / FPS;
const CAM_LABEL: Record<CameraMode, string> = { front: 'Front', pip: 'Front + rear', rear: 'Rear' };
const NEXT_CAM: Record<CameraMode, CameraMode> = { front: 'pip', pip: 'rear', rear: 'front' };

interface Props {
  clips: TimelineClip[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (clips: TimelineClip[]) => void;
  programT: number;
  onSeek: (pt: number) => void;
  coverage: (c: TimelineClip) => number;
  icon: (c: TimelineClip) => string;
}

export function EditTimeline({ clips, selected, onSelect, onChange, programT, onSeek, coverage, icon }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setWidth(host.current!.clientWidth));
    ro.observe(host.current!);
    return () => ro.disconnect();
  }, []);
  const total = totalDuration({ clips });
  const pxs = Math.max(6, (width - 32) / Math.max(total, 20));
  const starts: number[] = [];
  clips.reduce((acc, c) => (starts.push(acc), acc + c.duration), 0);

  const track = (e: RPE, move: (dx: number) => void, done?: (dx: number) => void) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    let last = 0;
    const mv = (ev: PointerEvent) => { last = ev.clientX - x0; move(last); };
    const up = () => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      done?.(last);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };

  const patch = (id: string, p: Partial<TimelineClip>) => onChange(clips.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const reorder = (id: string, dx: number) => {
    const i = clips.findIndex((c) => c.id === id);
    const centre = (starts[i] + clips[i].duration / 2) * pxs + dx;
    const rest = clips.filter((c) => c.id !== id);
    let at = 0;
    let acc = 0;
    for (const c of rest) {
      if (centre > (acc + c.duration / 2) * pxs) at++;
      acc += c.duration;
    }
    const next = [...rest];
    next.splice(at, 0, clips[i]);
    onChange(next);
  };

  const ticks = [];
  for (let s = 0; s <= Math.max(total, 20); s += total > 60 ? 10 : 5) ticks.push(s);

  return (
    <div className="edit-timeline" ref={host}>
      <div className="ruler" onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(Math.max(0, Math.min(total, (e.clientX - r.left - 16) / pxs)));
      }}>
        {ticks.map((s) => <span key={s} style={{ left: 16 + s * pxs }}>{s}s</span>)}
      </div>
      <div className="track">
        {clips.length === 0 && <div className="empty">Add moments with + or use Auto-edit to build a timeline.</div>}
        {clips.map((c, i) => {
          const cov = coverage(c);
          const isDrag = drag?.id === c.id;
          return (
            <div key={c.id} className={`tclip cam-${c.camera} ${c.kind === 'photo' ? 'photo' : ''} ${selected === c.id ? 'sel' : ''} ${isDrag ? 'drag' : ''} ${cov < 0.99 ? 'gap' : ''}`}
              style={{ left: 16 + starts[i] * pxs, width: Math.max(4, c.duration * pxs - 3), transform: isDrag ? `translateX(${drag.dx}px)` : undefined }}
              onPointerDown={(e) => {
                onSelect(c.id);
                onSeek(starts[i] + 0.01);
                track(e, (dx) => Math.abs(dx) > 4 && setDrag({ id: c.id, dx }), (dx) => {
                  setDrag(null);
                  if (Math.abs(dx) > 4) reorder(c.id, dx);
                });
              }}>
              <div className="handle l" onPointerDown={(e) => {
                if (c.kind === 'photo') return;
                const { rideStart, duration } = c;
                track(e, (dx) => {
                  const d = Math.min(duration - 1, dx / pxs);
                  patch(c.id, { rideStart: snap(rideStart + d), duration: snap(duration - d) });
                });
              }} />
              <div className="inner">
                <span className="ico">{icon(c)}</span>
                <span className="name">{c.label}</span>
                <span className="dur">{c.duration.toFixed(1)}s</span>
              </div>
              <button className="cam" disabled={c.kind === 'photo'} title={c.kind === 'photo' ? 'Still photo' : `Camera: ${CAM_LABEL[c.camera]} (click to change)`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => patch(c.id, { camera: NEXT_CAM[c.camera] })}>
                {c.kind === 'photo' ? 'Photo' : c.camera === 'front' ? 'F' : c.camera === 'rear' ? 'R' : 'F+R'}
              </button>
              {cov < 0.99 && <span className="warn" title="Part of this clip has no footage for the chosen camera">!</span>}
              <div className="handle r" onPointerDown={(e) => {
                const { duration } = c;
                track(e, (dx) => patch(c.id, { duration: snap(Math.max(c.kind === 'photo' ? 1 / FPS : 1, Math.min(c.kind === 'photo' ? 120 : 60, duration + dx / pxs))) }));
              }} />
            </div>
          );
        })}
        <div className="playhead" style={{ left: 16 + programT * pxs }} />
      </div>
    </div>
  );
}
