import '@fontsource/nunito/400.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';

import { blockZoom, watchTaps } from './haptics';
import { watchInstallPrompt } from './platform';
import { syncPush } from './push';
import { getSettings } from './store';
import { mountHome } from './views/home';
import { mountInstallGuide } from './views/installGuide';
import { mountIntro } from './views/intro';
import { mountSettings } from './views/settings';

const ROUTES: Record<string, (root: HTMLElement) => () => void> = {
  '#/': mountHome,
  '#/intro': mountIntro,
  '#/settings': mountSettings,
  '#/install': mountInstallGuide,
};

const app = document.getElementById('app')!;
let unmount: (() => void) | null = null;

async function route(): Promise<void> {
  let hash = ROUTES[location.hash] ? location.hash : '#/';
  const settings = await getSettings();
  if (!settings.introDone && hash !== '#/intro' && hash !== '#/install') hash = '#/intro';
  if (location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
  unmount?.();
  unmount = ROUTES[hash](app);
  window.scrollTo(0, 0);
}

watchInstallPrompt();
watchTaps();
blockZoom();
window.addEventListener('hashchange', () => void route());
void route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').then(() => syncPush());
}
// Ask the browser not to evict Gerald's data under storage pressure.
void navigator.storage?.persist?.();
