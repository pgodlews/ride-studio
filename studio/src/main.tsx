import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/saira';
import '@fontsource-variable/space-grotesk';
import '@fontsource/bebas-neue';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700-italic.css';
import '@fontsource/barlow-condensed/800-italic.css';
import './gallery/gallery.css';
import './editor/editor.css';
import { App } from './gallery/App';
import { AssetProvider } from './render/assets';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AssetProvider><App /></AssetProvider>
  </StrictMode>,
);
