/**
 * Export HUD page, driven by server/hud.ts: renders the editor's SVG OverlayLayer for one
 * output frame at a time on a transparent page, which the exporter screenshots as PNG.
 */
import type { SVGProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/saira';
import '@fontsource-variable/space-grotesk';
import '@fontsource/bebas-neue';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700-italic.css';
import '@fontsource/barlow-condensed/800-italic.css';
import { FORMATS } from '../core/framing';
import { programAt, type Project } from '../core/project';
import { Ride, type RideJson } from '../core/ride';
import { AssetContext, DEFAULT_TILE_ATTRIBUTION } from '../render/assets';
import { OverlayLayer } from '../render/OverlayLayer';

const FPS = 30;
const FONT_PROBES = ['600 40px "Inter Variable"', '600 40px "Saira Variable"', '700 40px "Space Grotesk Variable"', '40px "Bebas Neue"', 'italic 800 40px "Barlow Condensed"', '600 40px "Barlow Condensed"'];
const TILE_TIMEOUT_MS = 60_000;

// A frame is held until every map tile it shows has loaded (or failed), so maps are never half-drawn.
const settled = new Set<string>();
const waiting = new Map<string, { promise: Promise<void>; done: () => void }>();
const settle = (href: string) => {
  settled.add(href);
  waiting.get(href)?.done();
  waiting.delete(href);
};

function TrackedImage(p: SVGProps<SVGImageElement>) {
  const href = String(p.href);
  if (!settled.has(href) && !waiting.has(href)) {
    let done = () => {};
    const promise = new Promise<void>((r) => { done = r; });
    waiting.set(href, { promise, done });
  }
  return <image {...p} onLoad={() => settle(href)} onError={() => settle(href)} />;
}

let state: { project: Project; ride: Ride; tileBase: string; tileAttribution: string; root: Root } | null = null;

async function setup(project: Project, rideJson: RideJson, tileBase: string, tileAttribution = DEFAULT_TILE_ATTRIBUTION) {
  await Promise.all(FONT_PROBES.map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  state = { project, ride: new Ride(rideJson), tileBase, tileAttribution, root: createRoot(document.getElementById('root')!) };
}

async function renderFrame(frame: number) {
  if (!state) throw new Error('HUD page not set up');
  const { project, ride, tileBase, tileAttribution, root } = state;
  const fmt = FORMATS.find((f) => f.id === project.formatId) ?? FORMATS[0];
  const at = programAt(project, frame / FPS);
  flushSync(() => root.render(at && (
    <AssetContext.Provider value={{ tileBase, tileAttribution, Image: TrackedImage }}>
      <OverlayLayer items={project.overlays} fmt={fmt} frame={{ ride, t: at.rideT, units: project.units, panelOpacity: project.panelOpacity }} />
    </AssetContext.Provider>
  )));
  // Only the tiles in this frame matter; one that left the DOM before loading is not awaited.
  const hrefs = [...new Set(Array.from(document.querySelectorAll('image'), (i) => i.getAttribute('href') ?? ''))];
  const pending = hrefs.flatMap((h) => waiting.get(h)?.promise ?? []);
  if (pending.length) {
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`Map tile did not load within ${TILE_TIMEOUT_MS / 1000} s (frame ${frame})`)), TILE_TIMEOUT_MS);
    });
    await Promise.race([Promise.all(pending), timeout]).finally(() => clearTimeout(timer));
  }
}

Object.assign(window, { hudSetup: setup, hudFrame: renderFrame, hudReady: true });
