import { ICONS, drawGeralds, el, esc, refs, toast } from '../dom';
import type { Hamster } from '../hamster';
import { canPromptInstall, isAndroid, isIOS, isStandalone, onInstallPromptChange, promptInstall, pushSupport } from '../platform';
import { enablePush } from '../push';
import { saveSettings } from '../store';
import { createCage } from './cage';
import { IOS_STEPS, shotIOS } from './shots';

type StepKind = 'story' | 'install-ios' | 'install-android' | 'nudges';

interface Step {
  kind: StepKind;
  chapter: string;
  title: string;
  body: string;
  cage?: { pose: 'idle' | 'parched' | 'sip' | 'full'; walk?: boolean; motion: string; wall: string; floor?: string; fill: number; bubble: string; sparkles?: boolean };
}

const STORY: Step[] = [
  {
    kind: 'story', chapter: 'Chapter 1 · The before times', title: 'This is Gerald.',
    body: 'A regular hamster. Hobbies: hoarding sunflower seeds, running nowhere at great speed, and judging you silently.',
    cage: { pose: 'idle', walk: true, motion: 'spot-walk stroll', wall: '#DDF1EE', fill: 0.45, bubble: 'Seeds. Mine. All mine.' },
  },
  {
    kind: 'story', chapter: 'Chapter 2 · The drought', title: 'Then the bottle ran dry.',
    body: 'Gerald has no thumbs. Gerald cannot refill a bottle. Gerald became very, very crunchy.',
    cage: { pose: 'parched', motion: 'spot-mid', wall: '#F3E6CC', floor: '#E9C98C', fill: 0, bubble: '…hello? Anyone with thumbs?' },
  },
  {
    kind: 'story', chapter: 'Chapter 3 · The pact', title: 'So Gerald made a deal.',
    body: 'Every time you drink water and log it here, Gerald gets a sip too. Your hydration is now his hydration. No pressure.',
    cage: { pose: 'sip', motion: 'spot-bottle hop', wall: '#DDF1EE', fill: 0.7, bubble: 'You drink. I drink. Deal?' },
  },
  {
    kind: 'story', chapter: 'Chapter 4 · The legend', title: 'Gerald is now Sipster.',
    body: 'Half sip, half hamster, entirely dependent on you. Now let’s move him in properly.',
    cage: { pose: 'full', motion: 'spot-mid bob', wall: '#D6E9FF', fill: 1, bubble: 'Call me… SIPSTER.', sparkles: true },
  },
];

function buildSteps(): Step[] {
  const steps = [...STORY];
  if (!isStandalone()) {
    if (isIOS()) {
      steps.push({
        kind: 'install-ios', chapter: 'Step 5 · A real home', title: 'Put Gerald on your home screen.',
        body: 'iPhone only sends reminders to apps on your home screen. Ten seconds:',
      });
    } else if (isAndroid() || canPromptInstall()) {
      steps.push({
        kind: 'install-android', chapter: 'Step 5 · A real home', title: 'Give Gerald a real home.',
        body: 'Install Sipster like an app: its own icon, full screen, and reminders that actually show up.',
        cage: { pose: 'idle', motion: 'spot-mid bob', wall: '#DDF1EE', fill: 0.7, bubble: 'Tap the button. I’ll wait. Dramatically.' },
      });
    }
  }
  const support = pushSupport();
  steps.push({
    kind: 'nudges', chapter: `Step ${steps.length + 1} · Nudges`, title: 'Let Gerald nudge you.',
    body:
      support === 'supported'
        ? 'He can’t knock on your door, so he’ll send a notification when it’s been a while. Only during your active hours — change how often in Settings.'
        : support === 'needs-install'
          ? 'Once Gerald is on your home screen, open Sipster from there and he’ll ask to send you nudges. iPhone rules, not his.'
          : 'This browser can’t send notifications, so Gerald will just have to wait for you to visit. He’s good at waiting. Mostly.',
  });
  return steps;
}

export function mountIntro(root: HTMLElement): () => void {
  const steps = buildSteps();
  let index = 0;
  let shot = 1;
  let shotTimer: number | undefined;
  let sprites: Hamster[] = [];

  const view = el(`
    <main class="screen intro">
      <header class="topbar">
        <span class="kicker">The Sipster origin story</span>
        <button class="link-btn" type="button" data-ref="skip">Skip</button>
      </header>
      <div class="intro-art" data-ref="art"></div>
      <section class="intro-text">
        <p class="chapter" data-ref="chapter"></p>
        <h1 class="title" data-ref="title" tabindex="-1"></h1>
        <p class="body" data-ref="body"></p>
        <ol class="steps" data-ref="list" hidden></ol>
      </section>
      <div class="spacer"></div>
      <div class="dots" data-ref="dots" aria-hidden="true"></div>
      <div class="intro-actions" data-ref="actions"></div>
    </main>`);
  const r = refs(view);
  root.replaceChildren(view);

  const cage = createCage('Story illustration');

  async function finish(): Promise<void> {
    await saveSettings({ introDone: true });
    location.hash = '#/';
  }

  function go(i: number): void {
    index = Math.max(0, Math.min(steps.length - 1, i));
    render();
    r.title.focus({ preventScroll: true });
  }

  function renderArt(step: Step): void {
    clearInterval(shotTimer);
    sprites.forEach((s) => s.destroy());
    sprites = [];
    if (step.cage) {
      const c = step.cage;
      cage.set({ wall: c.wall, floor: c.floor ?? '#F1D29A', fill: c.fill, motion: c.motion, bubble: c.bubble, sparkles: !!c.sparkles, puddle: false, zz: false });
      cage.hamster.set(c.pose, !!c.walk);
      if (cage.root.parentElement !== r.art) r.art.replaceChildren(cage.root);
      return;
    }
    if (step.kind === 'install-ios') {
      shot = 1;
      const draw = () => {
        sprites.forEach((s) => s.destroy());
        r.art.innerHTML = `<div class="art-panel blue"><span class="art-chip">Step ${shot} of 4</span>${shotIOS(shot)}<span class="art-gerald" data-gerald="idle" data-px="3" aria-hidden="true"></span></div>`;
        sprites = drawGeralds(r.art);
        r.list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === shot - 1));
      };
      draw();
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        shotTimer = window.setInterval(() => {
          shot = (shot % 4) + 1;
          draw();
        }, 1800);
      }
      return;
    }
    // nudges
    r.art.innerHTML = `
      <div class="art-panel night">
        <i class="star" style="left:10%;top:24px"></i><i class="star" style="left:86%;top:40px"></i><i class="star" style="left:51%;top:14px"></i><i class="star" style="left:91%;top:220px"></i>
        <div class="mini-notif">
          <span class="mini-icon"><span data-gerald="thirsty" data-px="1.5" aria-hidden="true"></span></span>
          <span class="mini-text"><span class="mini-app">SIPSTER <small>now</small></span><b>Gerald is staring at you.</b><span>It’s been 2 hours since your last sip.</span></span>
        </div>
        <span class="art-gerald center slump" data-gerald="thirsty" data-px="5" aria-hidden="true"></span>
      </div>`;
    sprites = drawGeralds(r.art);
  }

  function renderActions(step: Step): void {
    const last = index === steps.length - 1;
    const back = index > 0 ? '<button class="btn secondary" type="button" data-act="back">Back</button>' : '';
    if (step.kind === 'story') {
      r.actions.innerHTML = `<div class="btn-row">${back}<button class="btn primary grow" type="button" data-act="next">Next</button></div>`;
    } else if (step.kind === 'install-ios') {
      r.actions.innerHTML = `
        <div class="btn-row">${back}<button class="btn primary grow" type="button" data-act="next">Done — he’s home</button></div>
        <a class="link-btn center" href="#/install">Show me bigger screenshots</a>`;
    } else if (step.kind === 'install-android') {
      const can = canPromptInstall();
      r.actions.innerHTML = `
        <div class="btn-row">${back}
          ${
            can
              ? `<button class="btn primary grow" type="button" data-act="install">${ICONS.install} Install Sipster</button>`
              : '<button class="btn primary grow" type="button" data-act="next">Next</button>'
          }
        </div>
        <p class="hint">${can ? '' : 'No install button? In Chrome, tap ⋮ then <b>Install app</b> (or <b>Add to home screen</b>).'}</p>
        ${can ? '<button class="link-btn center" type="button" data-act="next">Maybe later</button>' : ''}`;
    } else if (pushSupport() === 'supported') {
      r.actions.innerHTML = `
        <button class="btn primary" type="button" data-act="allow">${ICONS.bell} Allow notifications</button>
        <button class="link-btn center" type="button" data-act="finish">Not now — I’ll remember on my own</button>`;
    } else {
      r.actions.innerHTML = `<div class="btn-row">${back}<button class="btn primary grow" type="button" data-act="finish">Let’s go</button></div>`;
    }
    if (last && step.kind !== 'nudges') r.actions.querySelector('[data-act="next"]')?.setAttribute('data-act', 'finish');
  }

  function render(): void {
    const step = steps[index];
    r.chapter.textContent = step.chapter;
    r.title.textContent = step.title;
    r.body.textContent = step.body;
    r.list.hidden = step.kind !== 'install-ios';
    r.list.innerHTML = step.kind === 'install-ios' ? IOS_STEPS.map((t, i) => `<li><span class="num">${i + 1}</span>${esc(t)}</li>`).join('') : '';
    r.dots.innerHTML = steps.map((_, i) => `<i class="${i === index ? 'on' : ''}"></i>`).join('');
    renderArt(step);
    renderActions(step);
  }

  r.skip.addEventListener('click', () => void finish());
  r.actions.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'next') go(index + 1);
    else if (act === 'back') go(index - 1);
    else if (act === 'finish') await finish();
    else if (act === 'install') {
      const installed = await promptInstall();
      if (installed) toast('Gerald has moved in. Open Sipster from your home screen.');
      go(index + 1);
    } else if (act === 'allow') {
      const result = await enablePush();
      if (result === 'enabled') toast('Nudges on. Gerald will be in touch.');
      else if (result === 'denied') toast('No nudges then. You can turn them on later in Settings.');
      else if (result === 'error') toast('Couldn’t reach Gerald’s server. Try again from Settings.');
      await finish();
    }
  });

  const off = onInstallPromptChange(() => {
    if (steps[index].kind === 'install-android') renderActions(steps[index]);
  });

  render();
  return () => {
    off();
    clearInterval(shotTimer);
    sprites.forEach((s) => s.destroy());
    cage.destroy();
  };
}
