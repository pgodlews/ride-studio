import { useRef } from 'react';
import type { Ride } from '../core/ride';
import { formatDuration, pad2 } from '../core/units';
import type { Clock } from './clock';

export interface Moment {
  id: string;
  label: string;
  kind: 'clip' | 'climb';
  start: number;
  end: number;
}

export function Timeline({ ride, clock, moments }: { ride: Ride; clock: Clock; moments: Moment[] }) {
  const bar = useRef<HTMLDivElement>(null);
  const D = ride.duration;
  const pct = (t: number) => `${(100 * t) / D}%`;
  const seek = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    clock.setT(((clientX - r.left) / r.width) * D);
  };
  const lt = ride.localTime(clock.t);
  const active = moments.find((m) => clock.loop && m.start === clock.loop[0] && m.end === clock.loop[1]);
  return (
    <div className="timeline">
      <div className="transport">
        <button className="play" onClick={() => clock.setPlaying(!clock.playing)} aria-label={clock.playing ? 'Pause' : 'Play'}>
          {clock.playing ? '❚❚' : '▶'}
        </button>
        <div className="readout">
          <strong>{`${pad2(lt.h)}:${pad2(lt.m)}:${pad2(lt.s)}`}</strong>
          <span>{`${lt.label} · ${formatDuration(clock.t)} elapsed`}</span>
        </div>
        <div className="moments">
          {moments.map((m) => (
            <button key={m.id} className={`chip ${m.kind} ${active?.id === m.id ? 'on' : ''}`}
              onClick={() => { clock.setT(m.start); clock.setLoop([m.start, m.end]); clock.setPlaying(true); }}>
              {m.label}
            </button>
          ))}
          <button className={`chip ${clock.loop ? '' : 'on'}`} onClick={() => clock.setLoop(null)}>Whole ride</button>
        </div>
      </div>
      <div className="scrub" ref={bar}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons) seek(e.clientX); }}>
        {moments.map((m) => (
          <div key={m.id} className={`mark ${m.kind}`} style={{ left: pct(m.start), width: pct(m.end - m.start) }} title={m.label} />
        ))}
        {clock.loop && <div className="loop" style={{ left: pct(clock.loop[0]), width: pct(clock.loop[1] - clock.loop[0]) }} />}
        <div className="head" style={{ left: pct(clock.t) }} />
      </div>
    </div>
  );
}
