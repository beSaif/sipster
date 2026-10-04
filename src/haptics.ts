// Taptic feedback. Android gets navigator.vibrate; iPhone has no vibrate API, but toggling a
// native `<input type="checkbox" switch>` (Safari 17.4+) plays the system switch haptic.

import { isIOS } from './platform';

export type Haptic = 'tap' | 'success' | 'warning';

const PATTERNS: Record<Haptic, number[]> = {
  tap: [10],
  success: [12, 80, 24],
  warning: [30, 60, 30, 60, 30],
};

// Gaps between iOS switch toggles, which only come in one strength.
const IOS_TAPS: Record<Haptic, number[]> = {
  tap: [0],
  success: [0, 120],
  warning: [0, 120, 240],
};

// A fresh switch per tap, clicked through its label, then removed. It has to stay rendered
// (no display:none) and must be clicked while the tap is still being handled.
function iosTap(): void {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  input.style.appearance = 'auto';
  label.append(input);
  document.body.append(label);
  try {
    label.click();
  } finally {
    label.remove();
  }
}

/** Plays a haptic. Call it synchronously from a user gesture; iOS ignores it otherwise. */
export function haptic(kind: Haptic = 'tap'): void {
  try {
    // Check iOS first: if Safari ever exposes a no-op navigator.vibrate we'd lose haptics there.
    if (isIOS()) {
      IOS_TAPS[kind].forEach((delay) => (delay ? setTimeout(iosTap, delay) : iosTap()));
    } else if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(PATTERNS[kind]);
    }
  } catch {
    // Haptics are a nicety; never let them break a tap.
  }
}

/** A light tap on every button, switch and link press. */
export function watchTaps(): void {
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const hit = (e.target as HTMLElement).closest('button:not(:disabled), a[href], [role="switch"], [role="radio"]');
      // Elements with their own haptic opt out with data-haptic="none".
      if (hit && !hit.closest('[data-haptic="none"]')) haptic('tap');
    },
    { capture: true },
  );
}

/** Blocks pinch zoom on iOS Safari, which ignores user-scalable=no. Double-tap zoom is off via touch-action in CSS. */
export function blockZoom(): void {
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}
