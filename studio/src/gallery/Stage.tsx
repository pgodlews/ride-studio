/**
 * Stage: the output frame at its real pixel size (scaled to fit), with the framed
 * footage behind and the export's SVG overlay layer on top. Drag widgets to move, the corner to resize,
 * the footage to reframe; scroll over footage to zoom the crop.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPE, type RefObject } from 'react';
import { cropRect, type Format, type Framing, type SourceInfo } from '../core/framing';
import type { OverlayItem } from '../core/project';
import type { WidgetFrame } from '../core/widget';
import { OverlayLayer } from '../render/OverlayLayer';
import { registry } from '../widgets';

/** A placed widget (same shape as a project overlay). */
export type StageItem = OverlayItem;

export interface ClipRef {
  kind?: 'video' | 'photo';
  src: string;
  poster?: string;
  /** Ride time at video position 0. */
  startT: number;
  duration: number;
}

/** Keeps a <video> on the ride clock: seek when drifting, play/pause with the clock. */
function useVideoSync(ref: RefObject<HTMLVideoElement | null>, want: number, playing: boolean, src?: string) {
  useEffect(() => {
    const v = ref.current;
    if (!v || !Number.isFinite(want)) return;
    if (playing) {
      if (v.paused) v.play().catch(() => undefined);
      if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    } else {
      v.pause();
      if (Math.abs(v.currentTime - want) > 0.02) v.currentTime = want;
    }
  }, [ref, want, playing, src]);
}

interface Props {
  format: Format;
  source: SourceInfo;
  framing: Framing;
  onFraming: (f: Framing) => void;
  clip: ClipRef | null;
  /** Optional picture-in-picture inset (rear camera), synced to the same ride time. */
  inset?: ClipRef | null;
  fallbackPoster?: string;
  frame: WidgetFrame;
  playing: boolean;
  items: StageItem[];
  onItems: (items: StageItem[]) => void;
  selected: string | null;
  onSelect: (uid: string | null) => void;
  showSafe: boolean;
}

export function Stage(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [box, setBox] = useState({ w: 400, h: 700 });
  const { format: fmt } = p;

  useLayoutEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = Math.min(box.w / fmt.w, box.h / fmt.h);

  // The ride clock drives the video, never the other way round.
  const want = p.clip ? p.frame.t - p.clip.startT : NaN;
  useVideoSync(video, want, p.playing, p.clip?.src);
  const insetVideo = useRef<HTMLVideoElement>(null);
  const insetWant = p.inset ? p.frame.t - p.inset.startT : NaN;
  useVideoSync(insetVideo, insetWant, p.playing, p.inset?.src);

  const crop = cropRect(p.source, fmt, p.framing);
  const s = fmt.w / crop.w;
  const media = { left: -crop.x * s, top: -crop.y * s, width: p.source.w * s, height: p.source.h * s };
  // Footage is laid out at on-screen size (not output size then CSS-scaled) to keep video layers small.
  const shown = { left: media.left * k, top: media.top * k, width: media.width * k, height: media.height * k };

  const drag = (e: RPE, onMove: (dx: number, dy: number) => void) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => onMove((ev.clientX - x0) / k, (ev.clientY - y0) / k);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const update = (uid: string, patch: Partial<StageItem>) =>
    p.onItems(p.items.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));

  const panFootage = (e: RPE) => {
    p.onSelect(null);
    const start = p.framing;
    drag(e, (dx, dy) => {
      const cx = start.cx - dx / s / p.source.w;
      const cy = start.cy - dy / s / p.source.h;
      const c = cropRect(p.source, fmt, { ...start, cx, cy });
      p.onFraming({ ...start, cx: (c.x + c.w / 2) / p.source.w, cy: (c.y + c.h / 2) / p.source.h });
    });
  };

  return (
    <div className="stage-host" ref={host}>
      <div className="stage" style={{ width: fmt.w * k, height: fmt.h * k }}>
        <div className="footage" onPointerDown={panFootage}
            onWheel={(e) => p.onFraming({ ...p.framing, zoom: Math.min(2.5, Math.max(1, p.framing.zoom * Math.exp(-e.deltaY * 0.0015))) })}>
            {p.clip?.kind === 'photo' ? <img src={p.clip.src} alt="Imported photo" draggable={false} style={shown} /> : p.clip ? (
              <video key={p.clip.src} ref={video} src={p.clip.src} poster={p.clip.poster} muted playsInline preload="auto"
                style={shown} onLoadedData={(e) => { e.currentTarget.currentTime = Math.max(0, want); }} />
            ) : (
              p.fallbackPoster && <img src={p.fallbackPoster} alt="" style={{ ...shown, filter: 'grayscale(0.6) brightness(0.45)' }} />
            )}
            {!p.clip && <div className="no-footage">No footage at this moment · data only</div>}
          </div>
        <div className="stage-inner" style={{ width: fmt.w, height: fmt.h, transform: `scale(${k})` }}>
          {p.inset && (() => {
            const iw = fmt.w * (fmt.w < fmt.h ? 0.42 : 0.3);
            const m = fmt.w * 0.04;
            return (
              <div className="inset" style={{ width: iw, height: (iw * 9) / 16, left: fmt.w - iw - m, top: (fmt.unsafe?.top ?? 0) + m }}>
                <video key={p.inset.src} ref={insetVideo} src={p.inset.src} muted playsInline preload="auto"
                  onLoadedData={(e) => { e.currentTarget.currentTime = Math.max(0, insetWant); }} />
              </div>
            );
          })()}
          {p.showSafe && fmt.unsafe && (
            <div className="safe">
              <div style={{ top: 0, left: 0, right: 0, height: fmt.unsafe.top }} />
              <div style={{ bottom: 0, left: 0, right: 0, height: fmt.unsafe.bottom }} />
              <div style={{ top: fmt.unsafe.top, bottom: fmt.unsafe.bottom, right: 0, width: fmt.unsafe.right }} />
            </div>
          )}
          {/* The same SVG layer the exporter renders; the boxes below only take pointer input. */}
          <OverlayLayer items={p.items} fmt={fmt} frame={p.frame} style={{ position: 'absolute', left: 0, top: 0 }} />
          {p.items.map((it) => {
            const def = registry.get(it.widgetId);
            if (!def) return null;
            const w = def.size.w * it.scale;
            const h = def.size.h * it.scale;
            const sel = p.selected === it.uid;
            return (
              <div key={it.uid} className={`placed ${sel ? 'sel' : ''}`}
                style={{ left: it.nx * fmt.w - w / 2, top: it.ny * fmt.h - h / 2, width: w, height: h }}
                onPointerDown={(e) => {
                  p.onSelect(it.uid);
                  const { nx, ny } = it;
                  drag(e, (dx, dy) => update(it.uid, {
                    nx: Math.min(1, Math.max(0, nx + dx / fmt.w)),
                    ny: Math.min(1, Math.max(0, ny + dy / fmt.h)),
                  }));
                }}>
                {sel && (
                  <div className="resize" style={{ transform: `scale(${1 / k})` }}
                    onPointerDown={(e) => {
                      const s0 = it.scale;
                      drag(e, (dx) => update(it.uid, { scale: Math.min(4, Math.max(0.3, s0 * (1 + dx / (w / 2)))) }));
                    }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="stage-meta">
        {`${fmt.w}×${fmt.h} · crop ${Math.round((crop.w * p.source.originalW) / p.source.w)} px of source → scale ×${crop.upscale.toFixed(2)}`}
        {p.framing.zoom > 1.25 && <span className="warn"> · soft at this zoom</span>}
      </div>
    </div>
  );
}
