import { ICONS, drawGeralds, el } from '../dom';
import { IOS_STEPS, shotIOS } from './shots';

export function mountInstallGuide(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen guide">
      <header class="topbar start">
        <button class="icon-btn" type="button" aria-label="Back" data-back>${ICONS.back}</button>
        <span class="kicker">iPhone · Safari</span>
      </header>
      <h1 class="title">Add Sipster to your home screen</h1>
      <p class="body">iPhone only delivers reminders to apps on your home screen. Gerald has asked nicely. Twice.</p>
      <ol class="shots">
        ${IOS_STEPS.map((t, i) => `<li>${shotIOS(i + 1)}<p><span class="num">${i + 1}</span>${t}</p></li>`).join('')}
      </ol>
      <p class="note"><b>Older iPhone (iOS 18 or earlier)?</b> Tap the Share button in Safari’s bottom toolbar, then Add to Home Screen.</p>
      <p class="note"><b>Using Chrome on iPhone?</b> Tap Share in the address bar, then Add to Home Screen.</p>
      <button class="btn primary" type="button" data-back>Got it</button>
    </main>`);
  root.replaceChildren(view);
  const sprites = drawGeralds(view);
  view.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/'))),
  );
  return () => sprites.forEach((s) => s.destroy());
}
