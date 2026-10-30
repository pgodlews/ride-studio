/** Controls generated from a widget's `settings` schema (works for every widget). */
import type { WidgetDefinition } from '../core/widget';

export function SettingsFields({ def, values, onChange }: { def: WidgetDefinition; values?: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  if (!def.settings?.length) return null;
  const v = { ...def.defaults, ...values } as Record<string, unknown>;
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <div className="settings">
      {def.settings.map((field) => {
        const cur = v[field.key];
        if (field.type === 'select') {
          return (
            <div key={field.key} className="field">
              <span>{field.label}</span>
              <div className="group seg">
                {field.options!.map((o) => <button key={o.value} className={cur === o.value ? 'on' : ''} onClick={() => set(field.key, o.value)}>{o.label}</button>)}
              </div>
            </div>
          );
        }
        if (field.type === 'boolean') {
          return <label key={field.key} className="check field"><input type="checkbox" checked={!!cur} onChange={(e) => set(field.key, e.target.checked)} /> {field.label}</label>;
        }
        if (field.type === 'number') {
          const n = Number(cur);
          return (
            <label key={field.key} className="slider field">
              {field.label}
              <input type="range" min={field.min} max={field.max} step={field.step ?? 1} value={n} onChange={(e) => set(field.key, Number(e.target.value))} />
              <output>{Number.isInteger(field.step ?? 1) ? n : n.toFixed(2)}</output>
            </label>
          );
        }
        return null;
      })}
    </div>
  );
}
