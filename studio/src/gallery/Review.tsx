/**
 * Review route: `?review=<family|widget id,…>&t=<ride s>&scale=<n>&bg=footage|dark|bright&opacity=<0–1>`.
 * Renders widgets at a fixed frame, at design size × scale, for close inspection and
 * screenshot-based regression checks.
 */
import type { Ride } from '../core/ride';
import type { WidgetFrame } from '../core/widget';
import { WidgetView } from '../render/WidgetView';
import { registry } from '../widgets';

export function Review({ ride, poster, defaultT }: { ride: Ride; poster?: string; defaultT: number }) {
  const q = new URLSearchParams(location.search);
  const sel = (q.get('review') ?? '').split(',').filter(Boolean);
  const defs = registry.all().filter((w) => sel.includes(w.id) || sel.includes(w.family) || sel.includes(w.metric) || sel.includes('all'));
  const scale = Number(q.get('scale') ?? 1);
  const bg = q.get('bg') ?? 'footage';
  const frame: WidgetFrame = { ride, t: Number(q.get('t') ?? defaultT), units: q.get('units') === 'imperial' ? 'imperial' : 'metric', panelOpacity: Number(q.get('opacity') ?? 0.5) };
  return (
    <div className={`review bg-${bg}`} style={bg === 'footage' && poster ? { backgroundImage: `url(${poster})` } : undefined}>
      {defs.map((d) => (
        <figure key={d.id} style={{ width: d.size.w * scale, height: d.size.h * scale }}>
          <WidgetView def={d} frame={frame} />
          <figcaption>{d.id}</figcaption>
        </figure>
      ))}
    </div>
  );
}
