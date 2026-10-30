/** Renders one widget definition for a frame; shared by gallery, editor and export. */
import { Component, type ReactNode } from 'react';
import type { WidgetDefinition, WidgetFrame } from '../core/widget';

export class Boundary extends Component<{ children: ReactNode; fallback: (error: string) => ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    if (this.state.error) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

/**
 * As the backing panel fades, a soft shadow keeps text and marks legible on bright footage:
 * two chained drop shadows. `blur` is used as-is by CSS drop-shadow() and as SVG stdDeviation,
 * which Chrome renders identically (measured).
 */
export const HUD_SHADOWS = [{ dy: 1, blur: 1.5, alpha: 1 }, { dy: 0, blur: 6, alpha: 0.5 }] as const;
export const shadowAlpha = (panelOpacity: number) => Math.max(0, 0.6 - panelOpacity) * 1.1;

export const missingText = (def: WidgetDefinition, frame: WidgetFrame) => {
  const missing = def.requires.filter((c) => !frame.ride.has(c));
  return missing.length ? `No ${missing.join(', ')} data on this ride` : null;
};

/** One widget as HTML, for gallery cards; the editor stage and exports use the SVG OverlayLayer. */
export function WidgetView({ def, frame, settings }: { def: WidgetDefinition; frame: WidgetFrame; settings?: Record<string, unknown> }) {
  const missing = missingText(def, frame);
  if (missing) return <div className="widget-missing">{missing}</div>;
  const C = def.Component;
  const a = shadowAlpha(frame.panelOpacity);
  const style = a > 0 ? { filter: HUD_SHADOWS.map((s) => `drop-shadow(0 ${s.dy}px ${s.blur}px rgba(0,0,0,${(a * s.alpha).toFixed(2)}))`).join(' ') } : undefined;
  return (
    <Boundary fallback={(e) => <div className="widget-error">{def.id}: {e}</div>}>
      <div className="widget" style={{ width: '100%', height: '100%', ...style }}>
        <C {...frame} settings={{ ...def.defaults, ...settings }} />
      </div>
    </Boundary>
  );
}
