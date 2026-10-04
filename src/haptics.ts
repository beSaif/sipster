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

let iosSwitch: HTMLLabelElement | null = null;

function iosTap(): void {
  if (!iosSwitch) {
    iosSwitch = document.createElement('label');
    iosSwitch.setAttribute('aria-hidden', 'true');
    iosSwitch.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    iosSwitch.append(input);
    document.body.append(iosSwitch);
  }
  iosSwitch.click();
}

/** Plays a haptic. Call it synchronously from a user gesture; iOS ignores it otherwise. */
export function haptic(kind: Haptic = 'tap'): void {
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(PATTERNS[kind]);
  } else if (isIOS()) {
    IOS_TAPS[kind].forEach((delay) => (delay ? setTimeout(iosTap, delay) : iosTap()));
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
