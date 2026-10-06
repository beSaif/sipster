import '@fontsource/nunito/400.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';
import './styles-account.css';
import './styles-social.css';

import { claimSession, loadAccount, onAccount, refreshAccount } from './account';
import { blockZoom, watchTaps } from './haptics';
import { watchInstallPrompt } from './platform';
import { syncPush } from './push';
import { parseHash, replaceHash } from './router';
import { setTotalsEnabled, syncTotals } from './social';
import { getSettings } from './store';
import { mountAccount } from './views/account';
import { mountFriends } from './views/friends';
import { mountHome } from './views/home';
import { mountInbox } from './views/inbox';
import { mountInstallGuide } from './views/installGuide';
import { mountIntro } from './views/intro';
import { mountPrivacy } from './views/privacy';
import { mountSettings } from './views/settings';

const ROUTES: Record<string, (root: HTMLElement) => () => void> = {
  '#/': mountHome,
  '#/intro': mountIntro,
  '#/settings': mountSettings,
  '#/install': mountInstallGuide,
  '#/account': mountAccount,
  '#/friends': mountFriends,
  '#/inbox': mountInbox,
  '#/privacy': mountPrivacy,
};

// Screens that make sense before the intro: the install guide, the privacy policy (Google links to
// it) and the account screen, where a sign-in redirect lands.
const BEFORE_INTRO = new Set(['#/intro', '#/install', '#/privacy', '#/account']);

// Plain paths (e.g. /privacy from Google's consent screen) become hash routes.
if (location.pathname !== '/') {
  history.replaceState(null, '', `/${location.pathname === '/privacy' ? '#/privacy' : location.hash || '#/'}`);
}

const app = document.getElementById('app')!;
let unmount: (() => void) | null = null;

async function route(): Promise<void> {
  const { path, query } = parseHash();
  let hash = ROUTES[path] ? path : '#/';
  // Back from Google: trade the one-time code for a session, then drop it from the URL.
  const claim = query.get('claim');
  if (claim) {
    const claimed = await claimSession(claim);
    query.delete('claim');
    // An expired code is only a problem when this browser holds no session either.
    if (!claimed && (await loadAccount()).status !== 'in') query.set('error', 'failed');
    const rest = query.toString();
    replaceHash(rest ? `${hash}?${rest}` : hash);
  }
  const settings = await getSettings();
  if (!settings.introDone && !BEFORE_INTRO.has(hash)) hash = '#/intro';
  if (parseHash().path !== hash) {
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

// Account: keep daily totals flowing while signed in; probe the session once the first route (and
// any sign-in claim in it) has settled.
onAccount((s) => {
  setTotalsEnabled(s.status === 'in');
  if (s.status === 'in') void syncTotals({ full: true });
});
void route().then(() => loadAccount());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshAccount();
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').then(() => syncPush());
  // A tap on a social notification asks the page to open a screen.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'open' && typeof e.data.hash === 'string' && e.data.hash.startsWith('#/')) location.hash = e.data.hash;
  });
}
// Ask the browser not to evict Gerald's data under storage pressure.
void navigator.storage?.persist?.();
