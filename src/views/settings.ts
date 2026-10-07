import { account, onAccount, setUser, signOut, user } from '../account';
import { api } from '../api';
import { ICONS, el, esc, refs, toast } from '../dom';
import { haptic } from '../haptics';
import { canPromptInstall, isIOS, isStandalone, onInstallPromptChange, promptInstall, pushSupport } from '../platform';
import { disablePush, enablePush, sendTestNudge, syncPush } from '../push';
import { syncTotals } from '../social';
import {
  deleteSipsSince,
  exportBackup,
  getSettings,
  importBackup,
  saveSettings,
  startOfDay,
  type Settings,
} from '../store';
import { GOOGLE_G, accountKey, errorText } from './account';

const INTERVALS = [30, 45, 60, 90];
const CUP_NAMES = ['Sip', 'Glass', 'Bottle'];
const fmt = (n: number) => n.toLocaleString('en-US');
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromTime = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

function toggle(id: string, on: boolean, label: string): string {
  return `<button class="switch" type="button" role="switch" id="${id}" aria-checked="${on}" aria-label="${esc(label)}"><span class="track"><span class="knob"></span></span></button>`;
}

/** The Account card: a sign-in link, or who is signed in with the friend-notifications switch. */
function accountCard(pushOn: boolean): string {
  const a = account();
  if (a.status === 'loading') return '<section class="card"><h2>Account</h2><p class="help">Gerald is checking who’s here…</p></section>';
  if (a.status === 'out') {
    return `
      <section class="card">
        <h2>Account</h2>
        <p class="help">Pick a username, add friends and see who’s leading.</p>
        <a class="btn secondary" href="#/account">${GOOGLE_G} Sign in with Google</a>
      </section>`;
  }
  const u = a.user;
  return `
    <section class="card">
      <h2>Account</h2>
      <div class="acct-row">
        <p class="acct-name">${u.username ? `@${esc(u.username)}` : 'No username yet'}</p>
        <p class="help">${esc(u.email)}</p>
      </div>
      <div class="setting">
        <div>
          <p class="label">Friend notifications</p>
          <p class="help">A push when someone adds you, accepts, or hits their goal.${pushOn ? '' : ' Turn on push notifications above to get them on this phone.'}</p>
        </div>
        ${toggle('social', u.social_push, 'Friend notifications')}
      </div>
      <div class="two-col">
        <a class="btn secondary" href="#/account">${u.username ? 'Manage account' : 'Pick a username'}</a>
        <button class="btn secondary" type="button" data-act="signout">Sign out</button>
      </div>
    </section>`;
}

export function mountSettings(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen settings">
      <header class="topbar start">
        <a class="icon-btn" href="#/" aria-label="Back to today">${ICONS.back}</a>
        <h1 class="logo">Settings</h1>
      </header>
      <div data-ref="content" class="settings-list"></div>
      <input type="file" accept="application/json,.json" data-ref="file" hidden>
    </main>`);
  const r = refs(view);
  root.replaceChildren(view);

  let s: Settings;
  let accountBusy = false; // a sign-out or settings call is in flight
  let shownAccount = ''; // accountKey() of the Account card on screen

  function render(): void {
    shownAccount = accountKey(account());
    const support = pushSupport();
    const pushOn = s.pushEnabled && support === 'supported';
    const pushStatus =
      support === 'needs-install'
        ? 'Add Sipster to your home screen first'
        : support === 'unsupported'
          ? 'Not supported in this browser'
          : pushOn
            ? Notification.permission === 'denied' ? 'Blocked in browser settings' : 'On for this phone'
            : 'Off';
    const showInstall = !isStandalone() && (isIOS() || canPromptInstall());

    r.content.innerHTML = `
      <section class="card">
        <h2>Daily goal</h2>
        <div class="stepper">
          <button class="square-btn" type="button" data-act="goal-" aria-label="Decrease goal">−</button>
          <p class="amount"><span class="big">${fmt(s.goalMl)}</span> <span class="of">ml</span></p>
          <button class="square-btn" type="button" data-act="goal+" aria-label="Increase goal">+</button>
        </div>
        <p class="help">About ${Math.round(s.goalMl / 250)} glasses. Gerald will judge you either way.</p>
      </section>

      <section class="card">
        <h2>Reminders</h2>
        <div class="setting">
          <div><p class="label">Push notifications</p><p class="help ${pushOn ? 'ok' : ''}">${esc(pushStatus)}</p></div>
          ${support === 'supported' ? toggle('push', pushOn, 'Push notifications') : support === 'needs-install' ? '<a class="nudge-action" href="#/install">How?</a>' : ''}
        </div>
        <div class="field">
          <p class="label" id="every-label">Nudge me every</p>
          <div class="segmented" role="radiogroup" aria-labelledby="every-label">
            ${INTERVALS.map((m) => `<button type="button" role="radio" aria-checked="${s.intervalMin === m}" data-interval="${m}">${m}m</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <p class="label">Active hours</p>
          <div class="time-row">
            <label>From<input type="time" data-ref="start" value="${toTime(s.startMin)}"></label>
            <label>Until<input type="time" data-ref="end" value="${toTime(s.endMin)}"></label>
          </div>
          <p class="help">Outside these hours Gerald sleeps. Quietly.</p>
        </div>
        <div class="setting">
          <div><p class="label">Smart nudges</p><p class="help">Count from your last drink, so a nudge never lands right after you’ve had one.</p></div>
          ${toggle('smart', s.smart, 'Smart nudges')}
        </div>
        <button class="btn note-btn" type="button" data-act="test" ${pushOn ? '' : 'disabled'}>${ICONS.bell} Send a test nudge</button>
      </section>

      ${accountCard(pushOn)}

      <section class="card">
        <h2>Cup sizes</h2>
        <div class="cup-edit">
          ${s.cups
            .map(
              (ml, i) => `
            <label><span>${CUP_NAMES[i]}</span>
              <span class="ml-input"><input type="number" inputmode="numeric" min="20" max="2000" step="10" value="${ml}" data-cup="${i}"> ml</span>
            </label>`,
            )
            .join('')}
        </div>
      </section>

      ${
        showInstall
          ? `<section class="card">
              <h2>Home screen</h2>
              <p class="help">Install Sipster for its own icon, full screen and reliable nudges.</p>
              ${isIOS() ? '<a class="btn secondary" href="#/install">Show me how</a>' : `<button class="btn secondary" type="button" data-act="install">${ICONS.install} Install Sipster</button>`}
            </section>`
          : ''
      }

      <section class="card">
        <h2>Your data</h2>
        <p class="body small">Everything still lives on this phone: your drinks, your settings, no tracking. The reminder server only knows your schedule and when you last drank. With an account, your daily totals (ml and goal per day) are stored on the server and shown to accepted friends — the drinks themselves never leave. Clearing your browser data clears Gerald too, so export first.</p>
        <div class="two-col">
          <button class="btn secondary" type="button" data-act="export">Export backup</button>
          <button class="btn secondary" type="button" data-act="import">Import backup</button>
          <button class="btn secondary" type="button" data-act="intro">Replay intro</button>
          <button class="btn danger" type="button" data-act="reset" data-haptic="none">Reset today</button>
        </div>
      </section>`;
  }

  async function update(patch: Partial<Settings>, opts: { sync?: boolean } = {}): Promise<void> {
    s = await saveSettings(patch);
    render();
    if (opts.sync) void syncPush();
  }

  async function toggleSocialPush(): Promise<void> {
    const u = user();
    if (!u || accountBusy) return;
    accountBusy = true;
    try {
      const { user: next } = await api.updateAccountSettings({ social_push: !u.social_push });
      setUser(next); // the card re-renders through onAccount
      toast(next.social_push ? 'Friend notifications on. Gerald will pass notes.' : 'Friend notifications off. Gerald keeps the gossip to himself.');
    } catch (err) {
      toast(errorText(err));
    } finally {
      accountBusy = false;
    }
  }

  async function signOutHere(btn: HTMLButtonElement): Promise<void> {
    if (accountBusy) return;
    accountBusy = true;
    btn.disabled = true;
    try {
      await signOut();
      toast('Signed out. Gerald will keep your drinks safe here.');
    } finally {
      accountBusy = false;
    }
  }

  r.content.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const sw = target.closest<HTMLElement>('.switch');
    if (sw?.id === 'smart') return update({ smart: !s.smart }, { sync: true });
    if (sw?.id === 'social') return toggleSocialPush();
    if (sw?.id === 'push') {
      if (s.pushEnabled) {
        await disablePush();
        s = await getSettings();
        render();
        toast('Nudges off. Gerald is sulking.');
      } else {
        const result = await enablePush();
        s = await getSettings();
        render();
        if (result === 'enabled') toast('Nudges on. Gerald will be in touch.');
        else if (result === 'denied') toast('Notifications are blocked. Allow them in your browser settings.');
        else toast('Couldn’t reach Gerald’s server. Try again in a bit.');
      }
      return;
    }
    const interval = target.closest<HTMLElement>('[data-interval]')?.dataset.interval;
    if (interval) return update({ intervalMin: Number(interval) }, { sync: true });

    const act = target.closest<HTMLButtonElement>('[data-act]');
    switch (act?.dataset.act) {
      case 'goal-':
        await update({ goalMl: Math.max(500, s.goalMl - 250) }, { sync: true });
        void syncTotals();
        return;
      case 'goal+':
        await update({ goalMl: Math.min(6000, s.goalMl + 250) }, { sync: true });
        void syncTotals();
        return;
      case 'signout':
        return signOutHere(act);
      case 'test':
        return toast(await sendTestNudge());
      case 'install':
        if (await promptInstall()) toast('Gerald has moved in. Open Sipster from your home screen.');
        return render();
      case 'export': {
        const blob = new Blob([JSON.stringify(await exportBackup(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sipster-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      case 'import':
        return r.file.click();
      case 'intro':
        await saveSettings({ introDone: false });
        location.hash = '#/intro';
        return;
      case 'reset':
        haptic('warning');
        if (confirm('Delete everything you logged today? Gerald will act like nothing happened.')) {
          await deleteSipsSince(startOfDay());
          void syncPush();
          void syncTotals();
          toast('Today is wiped. Fresh start.');
        }
        return;
    }
  });

  r.content.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input === r.content.querySelector('[data-ref="start"]') || input === r.content.querySelector('[data-ref="end"]')) {
      const start = fromTime((r.content.querySelector('[data-ref="start"]') as HTMLInputElement).value);
      const end = fromTime((r.content.querySelector('[data-ref="end"]') as HTMLInputElement).value);
      if (start !== null && end !== null) await update({ startMin: start, endMin: end }, { sync: true });
      return;
    }
    if (input.dataset.cup !== undefined) {
      const ml = Math.round(Number(input.value));
      if (!Number.isFinite(ml) || ml < 20 || ml > 2000) {
        toast('Pick something between 20 and 2,000 ml.');
        return render();
      }
      const cups = [...s.cups] as Settings['cups'];
      cups[Number(input.dataset.cup)] = ml;
      await update({ cups });
    }
  });

  r.file.addEventListener('change', async () => {
    const file = (r.file as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      await importBackup(JSON.parse(await file.text()));
      s = await getSettings();
      render();
      void syncPush();
      void syncTotals({ full: true });
      toast('Backup restored. Gerald remembers everything.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That file didn’t work.');
    }
    (r.file as HTMLInputElement).value = '';
  });

  const offInstall = onInstallPromptChange(() => render());
  // Only the Account card depends on the account; skip changes that don't touch what it shows (an unread count).
  const offAccount = onAccount((a) => {
    if (s && accountKey(a) !== shownAccount) render();
  });
  void getSettings().then((loaded) => {
    s = loaded;
    render();
  });
  return () => {
    offInstall();
    offAccount();
  };
}
