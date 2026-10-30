import { useMemo, useState, type ReactNode } from 'react';
import { DETECTORS, type Moment, type MomentCategory } from '../core/highlights';
import type { Ride } from '../core/ride';
import { pad2 } from '../core/units';

export interface MomentInfo extends Moment {
  sourceFile?: string;
  front: number; // footage coverage 0–1
  rear: number;
  privacy: boolean; // inside the hidden start/finish zone
}

interface Props {
  photos?: ReactNode;
  ride: Ride;
  moments: MomentInfo[];
  sources: MomentInfo[];
  selected: string | null;
  inTimeline: Set<string>;
  onPreview: (m: MomentInfo) => void;
  onAdd: (m: MomentInfo) => void;
  onAuto: (count: number, seconds: number) => void;
}

const CATS: { id: MomentCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'effort', label: 'Effort' }, { id: 'terrain', label: 'Terrain' }, { id: 'story', label: 'Story' },
];

export function MomentsPanel({ ride, moments, sources, selected, inTimeline, onPreview, onAdd, onAuto, photos }: Props) {
  const [cat, setCat] = useState<MomentCategory | 'all'>('all');
  const [count, setCount] = useState(10);
  const [seconds, setSeconds] = useState(6);
  const groups = useMemo(() => [{ d: { id: 'source', icon: '▶', label: 'Source clips' }, list: sources }, ...DETECTORS
    .filter((d) => cat === 'all' || d.category === cat)
    .map((d) => ({ d, list: moments.filter((m) => m.detector === d.id) }))
    ].filter((g) => g.list.length), [moments, sources, cat]);
  const missing = DETECTORS.filter((d) => !d.requires.every((c) => ride.has(c)));
  const clock = (t: number) => {
    const lt = ride.localTime(t);
    return `${pad2(lt.h)}:${pad2(lt.m)}:${pad2(lt.s)}`;
  };
  return (
    <div className="moments-panel">
      <div className="auto">
        <div>
          <strong>Auto-edit</strong>
          <span>Best moment of each kind first, no overlaps, footage required, start/finish skipped.</span>
        </div>
        <div className="row">
          <label>Clips <select value={count} onChange={(e) => setCount(+e.target.value)}>{[5, 8, 10, 12, 15].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>Length <select value={seconds} onChange={(e) => setSeconds(+e.target.value)}>{[3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n} s</option>)}</select></label>
          <button className="primary" disabled={!moments.length} onClick={() => onAuto(count, seconds)}>Build timeline</button>
        </div>
      </div>
      <div className="group cats">
        {CATS.map((c) => <button key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>{c.label}</button>)}
      </div>
      <div className="list">
        {photos}
        {groups.map(({ d, list }) => (
          <section key={d.id}>
            <h3><span className="icon">{d.icon}</span>{d.label}</h3>
            {list.map((m) => (
              <div key={m.id} className={`moment ${selected === m.id ? 'sel' : ''} ${m.privacy ? 'private' : ''}`} onClick={() => onPreview(m)}>
                <div className="strength" style={{ height: `${Math.round(m.strength * 100)}%` }} />
                <div className="body">
                  <div className="top">
                    <span className="time">{clock(m.peakT)}</span>
                    <span className="label">{m.sourceFile ? m.label : m.rank === 1 ? 'Best' : `#${m.rank}`}</span>
                    <span className={`cam ${m.front > 0.9 ? 'ok' : m.front > 0 ? 'part' : ''}`} title="Front camera">F</span>
                    <span className={`cam ${m.rear > 0.9 ? 'ok' : m.rear > 0 ? 'part' : ''}`} title="Rear camera">R</span>
                  </div>
                  <div className="detail">{m.detail}{m.privacy ? ' · near start/finish' : ''}</div>
                </div>
                <button className={`add ${inTimeline.has(m.id) ? 'in' : ''}`} title="Add to timeline"
                  onClick={(e) => { e.stopPropagation(); onAdd(m); }}>{inTimeline.has(m.id) ? '✓' : '+'}</button>
              </div>
            ))}
          </section>
        ))}
        {missing.length > 0 && (
          <p className="missing">Not available on this ride: {missing.map((d) => d.label.toLowerCase()).join(', ')} (no {[...new Set(missing.flatMap((d) => d.requires.filter((c) => !ride.has(c))))].join(', ')} data).</p>
        )}
      </div>
    </div>
  );
}
