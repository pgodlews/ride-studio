import { memo, useEffect, useRef, useState } from 'react';
import { CHANNELS } from '../core/channels';
import { METRICS, type WidgetDefinition, type WidgetFrame } from '../core/widget';
import { WidgetView } from '../render/WidgetView';
import { registry } from '../widgets';

export type CardBg = 'footage' | 'dark' | 'bright';

interface Props {
  frame: WidgetFrame;
  families: string[];
  bg: CardBg;
  poster?: string;
  onStage: Set<string>;
  onToggle: (widgetId: string) => void;
}

const BG_POS = ['18% 30%', '80% 18%', '50% 85%', '8% 70%', '62% 45%'];

export function Catalog({ frame, families, bg, poster, onStage, onToggle }: Props) {
  let n = 0;
  return (
    <div className="catalog">
      {METRICS.map((m) => {
        const list = registry.byMetric(m.id).filter((w) => families.includes(w.family));
        if (!list.length) return null;
        return (
          <section key={m.id} id={`metric-${m.id}`}>
            <header>
              <h2>{m.label}</h2>
              <p>{m.blurb}</p>
            </header>
            <div className="cards">
              {list.map((w) => (
                <Card key={w.id} def={w} frame={frame} bg={bg} poster={poster} pos={BG_POS[n++ % BG_POS.length]}
                  added={onStage.has(w.id)} onToggle={onToggle} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const LiveWidget = memo(WidgetView, (a, b) => a.def === b.def && a.frame === b.frame);

const Card = memo(function Card({ def, frame, bg, poster, pos, added, onToggle }: {
  def: WidgetDefinition; frame: WidgetFrame; bg: CardBg; poster?: string; pos: string; added: boolean; onToggle: (id: string) => void;
}) {
  const fam = registry.families.find((f) => f.id === def.family);
  const style = bg === 'footage' && poster ? { backgroundImage: `url(${poster})`, backgroundPosition: pos } : undefined;
  const notes = def.requires.map((c) => CHANNELS[c].note).filter(Boolean);
  // Off-screen cards keep their last frame instead of re-rendering every tick.
  const el = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(true);
  const frozen = useRef(frame);
  if (visible) frozen.current = frame;
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '200px' });
    io.observe(el.current!);
    return () => io.disconnect();
  }, []);
  return (
    <article ref={el} className={`card ${added ? 'added' : ''}`}>
      <div className={`card-view bg-${bg}`} style={style}>
        <div className="fit" style={{ width: `min(100%, ${(150 * def.size.w) / def.size.h}px)`, aspectRatio: `${def.size.w} / ${def.size.h}` }}>
          <LiveWidget def={def} frame={frozen.current} />
        </div>
      </div>
      <footer>
        <div>
          <strong>{def.name}</strong>
          <span className={`fam fam-${def.family}`}>{fam?.name}</span>
          {notes.length > 0 && <small title={notes.join(' ')}>ⓘ</small>}
        </div>
        <button onClick={() => onToggle(def.id)}>{added ? 'On stage ✓' : 'Add to stage'}</button>
      </footer>
    </article>
  );
});
