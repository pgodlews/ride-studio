/**
 * External images used by widgets (map tiles). The preview loads them normally; the
 * exporter swaps in an implementation that holds the frame until each image has loaded,
 * so no exported frame shows a half-drawn map.
 */
import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';

// Injected into both Vite builds from the tile provider's server configuration.
declare const __STUDIO_TILE_ATTRIBUTION__: string;
export const DEFAULT_TILE_ATTRIBUTION = typeof __STUDIO_TILE_ATTRIBUTION__ === 'string'
  ? __STUDIO_TILE_ATTRIBUTION__ : '© OpenStreetMap contributors';

export interface AssetEnv {
  /** Origin that serves /tiles/z/x/y.png (empty = same origin as the page). */
  tileBase: string;
  tileAttribution?: string;
  Image: ComponentType<SVGProps<SVGImageElement>>;
}

const PlainImage = (p: SVGProps<SVGImageElement>) => <image {...p} />;

export const AssetContext = createContext<AssetEnv>({ tileBase: '', Image: PlainImage });
/** Packaged apps can change tile providers at runtime without rebuilding their UI. */
export function AssetProvider({ children }: { children: ReactNode }) {
  const [attribution, setAttribution] = useState(DEFAULT_TILE_ATTRIBUTION);
  useEffect(() => {
    let active = true;
    void fetch('/api/tiles/config').then((r) => r.ok ? r.json() : null).then((j) => {
      if (active && typeof j?.attribution === 'string') setAttribution(j.attribution);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <AssetContext.Provider value={{ tileBase: '', tileAttribution: attribution, Image: PlainImage }}>{children}</AssetContext.Provider>;
}
export const useAssets = () => {
  const env = useContext(AssetContext);
  return { ...env, tileAttribution: env.tileAttribution ?? DEFAULT_TILE_ATTRIBUTION };
};
export const tileUrl = (base: string, z: number, x: number, y: number) => `${base}/tiles/${z}/${x}/${y}.png`;
