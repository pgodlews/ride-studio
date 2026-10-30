/**
 * Overlay placement shared by the editor stage and the video exporter. The layer is one
 * self-contained SVG (no HTML), so the same frame can be shown in the editor, captured by the
 * exporter, drawn onto a canvas or serialised as a standalone document.
 */
import { useId, type CSSProperties } from 'react';
import type { Format } from '../core/framing';
import type { OverlayItem } from '../core/project';
import type { WidgetDefinition, WidgetFrame } from '../core/widget';
import { registry } from '../widgets';
import { Boundary, HUD_SHADOWS, missingText, shadowAlpha } from './WidgetView';

/** Box of an overlay in output pixels (centre-anchored, normalised position). */
export function overlayBox(item: OverlayItem, def: WidgetDefinition, fmt: Format) {
  const w = def.size.w * item.scale;
  const h = def.size.h * item.scale;
  return { left: item.nx * fmt.w - w / 2, top: item.ny * fmt.h - h / 2, width: w, height: h };
}

/** Missing-data or error placeholder in the widget's box. */
function Notice({ w, h, text, error }: { w: number; h: number; text: string; error?: boolean }) {
  return (
    <g>
      <rect x={1} y={1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={10} fill="none" stroke="rgba(255,255,255,0.35)" strokeDasharray="4 4" />
      <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" fontFamily="'Inter Variable', sans-serif" fontSize={14}
        fill={error ? '#ff8080' : 'rgba(255,255,255,0.75)'}>{text}</text>
    </g>
  );
}

/** Non-interactive overlay layer at output resolution: the editor preview and every export frame. */
export function OverlayLayer({ items, fmt, frame, className, style }: { items: OverlayItem[]; fmt: Format; frame: WidgetFrame; className?: string; style?: CSSProperties }) {
  const shadowId = `hud-shadow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const a = shadowAlpha(frame.panelOpacity);
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={fmt.w} height={fmt.h} viewBox={`0 0 ${fmt.w} ${fmt.h}`} className={className} style={{ display: 'block', ...style }}>
      {a > 0 && (
        <defs>
          <filter id={shadowId} filterUnits="userSpaceOnUse" x={0} y={0} width={fmt.w} height={fmt.h} colorInterpolationFilters="sRGB">
            {HUD_SHADOWS.map((s, i) => (
              <feDropShadow key={i} in={i ? `s${i - 1}` : 'SourceGraphic'} result={`s${i}`} dx={0} dy={s.dy} stdDeviation={s.blur} floodColor="#000" floodOpacity={+(a * s.alpha).toFixed(2)} />
            ))}
          </filter>
        </defs>
      )}
      {items.map((it) => {
        const def = registry.get(it.widgetId);
        if (!def) return null;
        const box = overlayBox(it, def, fmt);
        const missing = missingText(def, frame);
        const C = def.Component;
        return (
          <g key={it.uid} opacity={it.opacity}>
            <g filter={a > 0 ? `url(#${shadowId})` : undefined}>
              {/* Whole-pixel origin, as the earlier HTML layer snapped it; size stays exact. */}
              <svg x={Math.round(box.left)} y={Math.round(box.top)} width={box.width} height={box.height} overflow="visible">
                {missing ? <Notice w={box.width} h={box.height} text={missing} /> : (
                  <Boundary fallback={(e) => <Notice w={box.width} h={box.height} text={`${def.id}: ${e}`} error />}>
                    <C {...frame} settings={{ ...def.defaults, ...it.settings }} />
                  </Boundary>
                )}
              </svg>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
