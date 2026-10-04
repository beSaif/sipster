import { inWindow, localMinutes } from '../../shared/schedule';
import { ICONS, el, esc, refs, toast } from '../dom';
import { haptic } from '../haptics';
import { lineFor, moodFor } from '../mood';
import { pushSupport } from '../platform';
import { enablePush, syncPush } from '../push';
import { addSip, deleteSip, getSettings, lastSip, sipsSince, startOfDay, type Settings, type Sip } from '../store';
import { createCage } from './cage';

const fmt = (n: number) => n.toLocaleString('en-US');
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const CUP_NAMES = ['Sip', 'Glass', 'Bottle'];
const CUP_ICONS = [ICONS.drop, ICONS.glass, ICONS.bottle];

export function mountHome(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen home">
      <header class="topbar">
        <div>
          <h1 class="logo">Sipster</h1>
          <p class="sub" data-ref="dayline"></p>
        </div>
        <a class="icon-btn" href="#/settings" aria-label="Settings">${ICONS.sliders}</a>
      </header>
      <div data-ref="cageSlot"></div>
      <section class="card status" aria-label="Today">
        <div class="status-top">
          <p class="amount"><span class="big" data-ref="ml"></span> <span class="of" data-ref="goal"></span></p>
          <span class="chip" data-ref="chip"></span>
        </div>
        <div class="meter" data-ref="meter" role="progressbar" aria-label="Daily goal" aria-valuemin="0" aria-valuemax="100">${'<i></i>'.repeat(20)}</div>
        <div class="status-bottom"><span data-ref="remaining"></span><span data-ref="pct"></span></div>
      </section>
      <div class="nudge-row" data-ref="nudge"></div>
      <div class="cups" data-ref="cups"></div>
      <div class="undo-row" data-ref="undoRow" hidden>
        <span data-ref="lastText"></span>
        <button class="link-btn" data-ref="undo" type="button">Undo</button>
      </div>
    </main>`);
  const r = refs(view);
  const cage = createCage();
  r.cageSlot.replaceWith(cage.root);
  root.replaceChildren(view);

  let settings: Settings | null = null;
  let today: Sip[] = [];
  let last: Sip | null = null;
  let sippingUntil = 0;
  let busy = false;

  function renderCups(s: Settings): void {
    r.cups.innerHTML = s.cups
      .map(
        (ml, i) => `
        <button class="cup btn" type="button" data-cup="${i}" data-haptic="none">
          ${CUP_ICONS[i]}
          <span class="cup-name">${CUP_NAMES[i]}</span>
          <span class="cup-ml">${fmt(ml)} ml</span>
        </button>`,
      )
      .join('');
  }

  function renderNudge(s: Settings, goalDone: boolean): void {
    const support = pushSupport();
    let text: string;
    let action = '';
    if (support === 'needs-install') {
      text = 'Add Sipster to your home screen to get nudges.';
      action = '<a class="nudge-action" href="#/install">How?</a>';
    } else if (support === 'unsupported') {
      text = 'This browser can’t send reminders. Gerald will just glare.';
    } else if (!s.pushEnabled) {
      text = 'Nudges are off.';
      action = '<button class="nudge-action" type="button" data-ref="enable">Turn on</button>';
    } else if (Notification.permission === 'denied') {
      text = 'Notifications are blocked in your browser settings.';
    } else if (goalDone) {
      text = 'Goal done. No nudges until tomorrow.';
    } else if (s.nextNudgeAt) {
      const mins = Math.round((s.nextNudgeAt - Date.now()) / 60000);
      text = mins <= 0 ? 'Nudge due any moment' : mins < 120 ? `Next nudge in ${mins} min` : `Next nudge at ${time(s.nextNudgeAt)}`;
      action = `<span class="nudge-meta">every ${s.intervalMin} min</span>`;
    } else {
      text = 'Nudges are on.';
    }
    r.nudge.innerHTML = `${ICONS.bell}<span class="nudge-text">${esc(text)}</span>${action}`;
    r.nudge.querySelector<HTMLButtonElement>('[data-ref="enable"]')?.addEventListener('click', async () => {
      const result = await enablePush();
      if (result === 'enabled') toast('Nudges on. Gerald will be in touch.');
      else if (result === 'denied') toast('Notifications were blocked. You can allow them in your browser settings.');
      else if (result === 'error') toast('Couldn’t reach Gerald’s server. Try again in a bit.');
      await refresh();
    });
  }

  function render(): void {
    const s = settings;
    if (!s) return;
    const now = Date.now();
    const ml = today.reduce((n, sip) => n + sip.ml, 0);
    const pct = ml / s.goalMl;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const mood = moodFor({
      ml,
      goalMl: s.goalMl,
      sipping: now < sippingUntil,
      asleep: !inWindow(localMinutes(now, tz), s.startMin, s.endMin),
      hoursSinceSip: last ? (now - last.at) / 3_600_000 : null,
    });

    const day = Math.max(1, Math.round((startOfDay(now) - new Date(`${s.firstDay}T00:00`).getTime()) / 86_400_000) + 1);
    r.dayline.textContent = `${new Date(now).toLocaleDateString('en-US', { weekday: 'long' })} · Gerald’s day ${day}`;

    cage.set({ wall: mood.wall, fill: pct, motion: mood.motion, bubble: lineFor(mood, ml), puddle: pct >= 1.3, zz: mood.key === 'sleep' });
    cage.hamster.set(mood.pose, mood.walk);

    r.ml.textContent = fmt(ml);
    r.goal.textContent = `/ ${fmt(s.goalMl)} ml`;
    r.chip.textContent = mood.label;
    r.chip.style.background = mood.chip;
    const filled = Math.round(Math.min(pct, 1) * 20);
    r.meter.querySelectorAll('i').forEach((seg, i) => {
      seg.classList.toggle('on', i < filled && pct <= 1);
      seg.classList.toggle('over', i < filled && pct > 1);
    });
    r.meter.setAttribute('aria-valuenow', String(Math.round(Math.min(pct, 1) * 100)));
    r.remaining.textContent =
      ml < s.goalMl ? `${fmt(s.goalMl - ml)} ml to go` : ml === s.goalMl ? 'Goal reached!' : `+${fmt(ml - s.goalMl)} ml over goal`;
    r.pct.textContent = `${Math.round(pct * 100)}%`;

    renderNudge(s, ml >= s.goalMl);

    const lastToday = today[today.length - 1];
    r.undoRow.hidden = !lastToday;
    if (lastToday) r.lastText.textContent = `Logged ${fmt(lastToday.ml)} ml at ${time(lastToday.at)}`;
  }

  async function refresh(): Promise<void> {
    const s = await getSettings();
    const cupsChanged = !settings || settings.cups.join() !== s.cups.join();
    settings = s;
    today = (await sipsSince(startOfDay())).sort((a, b) => a.at - b.at);
    last = await lastSip();
    if (cupsChanged) renderCups(s);
    render();
  }

  r.cups.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cup]');
    if (!btn || !settings || busy) return;
    busy = true;
    const ml = settings.cups[Number(btn.dataset.cup)];
    const before = today.reduce((n, sip) => n + sip.ml, 0);
    // Fire before any await so iOS still counts it as part of the tap.
    haptic(before < settings.goalMl && before + ml >= settings.goalMl ? 'success' : 'tap');
    try {
      await addSip(ml);
      sippingUntil = Date.now() + 1600;
      await refresh();
      setTimeout(render, 1650);
      void syncPush().then(refresh);
    } finally {
      busy = false;
    }
  });

  r.undo.addEventListener('click', async () => {
    const lastToday = today[today.length - 1];
    if (!lastToday?.id) return;
    await deleteSip(lastToday.id);
    sippingUntil = 0;
    await refresh();
    void syncPush().then(refresh);
  });

  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh();
  };
  const onMessage = (e: MessageEvent) => {
    if (e.data?.type === 'sips-changed') void refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onMessage);
  const tick = window.setInterval(() => void refresh(), 30_000);

  void refresh();
  return () => {
    clearInterval(tick);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.removeEventListener('message', onMessage);
    cage.destroy();
  };
}
