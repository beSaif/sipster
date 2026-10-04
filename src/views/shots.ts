// Drawn "screenshots" of Safari's Add to Home Screen flow (iOS 26). Red rings mark what to tap.

const RING = '0 0 0 2px #E5484D';

const page = `
  <div class="shot-page">
    <div class="shot-logo">Sipster</div>
    <div class="shot-cage"><div class="shot-floor"></div><span class="shot-gerald" data-gerald="idle" data-px="2" aria-hidden="true"></span></div>
    <div class="shot-bar"></div>
    <div class="shot-tiles"><i></i><i></i><i></i></div>
  </div>`;

const toolbar = (ringDots: boolean) => `
  <div class="shot-toolbar">
    <span class="shot-round">‹</span>
    <span class="shot-url">sipster.app</span>
    <span class="shot-round dots" style="box-shadow:${ringDots ? '0 0 0 3px #E5484D' : ''}">•••</span>
  </div>`;

const STEPS: Record<number, string> = {
  1: `${page}${toolbar(true)}<i class="shot-tap" style="right:6px;bottom:6px"></i>`,
  2: `${page}<div class="shot-dim"></div>${toolbar(false)}
    <div class="shot-menu">
      <div class="shot-row hit" style="box-shadow:${RING}">Share</div>
      <div class="shot-row">Add Bookmark</div>
      <div class="shot-row">Add to Favorites</div>
      <div class="shot-row">Find on Page</div>
    </div>`,
  3: `${page}<div class="shot-dim"></div>
    <div class="shot-sheet">
      <div class="shot-app"><span class="shot-icon"><span data-gerald="idle" data-px="0.9" aria-hidden="true"></span></span><span><b>Sipster</b><small>sipster.app</small></span></div>
      <div class="shot-targets"><i></i><i></i><i></i><i></i></div>
      <div class="shot-list">
        <div class="shot-row">Copy</div>
        <div class="shot-row">Add to Reading List</div>
        <div class="shot-row hit" style="box-shadow:${RING}">Add to Home Screen <b>⊞</b></div>
      </div>
    </div>`,
  4: `<div class="shot-dialog">
      <div class="shot-dialog-bar"><span class="blue">Cancel</span><b>Add to Home Screen</b><span class="blue hit" style="box-shadow:${RING}"><b>Add</b></span></div>
      <div class="shot-card"><span class="shot-icon big"><span data-gerald="idle" data-px="1.5" aria-hidden="true"></span></span><span><b class="shot-name">Sipster</b><small>sipster.app</small></span></div>
      <div class="shot-card between"><span>Open as Web App</span><span class="shot-switch"><i></i></span></div>
      <div class="shot-end"><span data-gerald="full" data-px="3" aria-hidden="true"></span></div>
    </div>`,
};

export const IOS_STEPS = [
  'Tap ••• next to the address bar',
  'Tap Share',
  'Tap Add to Home Screen (scroll or tap View More)',
  'Keep “Open as Web App” on, then tap Add',
];

export function shotIOS(step: number): string {
  return `<div class="shot" role="img" aria-label="Step ${step}: ${IOS_STEPS[step - 1]}">${STEPS[step]}</div>`;
}
