import { Hamster } from '../hamster';

/** The pixel cage: wall, wood shavings, water bottle and Gerald. Used on the home screen and in the intro. */
export interface Cage {
  root: HTMLElement;
  hamster: Hamster;
  set(opts: { wall?: string; floor?: string; fill?: number; motion?: string; bubble?: string; puddle?: boolean; zz?: boolean; sparkles?: boolean }): void;
  destroy(): void;
}

const SPECKS = [
  [30, 34, 8], [92, 14, 12], [160, 28, 8], [222, 10, 12], [280, 38, 8], [318, 16, 8],
]
  .map(([x, y, w]) => `<i class="speck" style="left:${(x / 350) * 100}%;bottom:${y}px;width:${w}px"></i>`)
  .join('');

const SPARKLES = [
  [20, 112, 16], [77, 18, 16], [72, 140, 12],
]
  .map(([x, y, s]) => `<i class="sparkle" style="left:${x}%;top:${y}px;--s:${s}px"></i>`)
  .join('');

export function createCage(label = 'Gerald’s cage'): Cage {
  const root = document.createElement('section');
  root.className = 'cage';
  root.setAttribute('aria-label', label);
  root.innerHTML = `
    <div class="floor"></div>${SPECKS}
    <div class="bottle" aria-hidden="true"><div class="cap"></div><div class="tank"><div class="water"></div><div class="shine"></div></div><div class="tube"></div><div class="tip"></div></div>
    <div class="sparkles" hidden>${SPARKLES}</div>
    <div class="puddle" hidden></div>
    <div class="ham spot-walk"></div>
    <div class="zz" hidden aria-hidden="true">z Z</div>
    <p class="bubble" aria-live="polite"></p>`;
  const hamster = new Hamster(6);
  const ham = root.querySelector<HTMLElement>('.ham')!;
  ham.append(hamster.canvas);

  // Gerald walks between the left wall and the bottle, and drinks from its spout.
  const ro = new ResizeObserver(() => {
    const w = root.clientWidth;
    root.style.setProperty('--range', `${Math.max(0, w - 60 - 144 - 28)}px`);
    // Nose just left of the spout tip, so he licks it instead of headbutting the tube.
    root.style.setProperty('--bottle-left', `${w - 184}px`);
    root.style.setProperty('--mid-left', `${Math.max(14, Math.round((w - 60 - 144) / 2))}px`);
  });
  ro.observe(root);

  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  return {
    root,
    hamster,
    set(o) {
      if (o.wall) root.style.setProperty('--wall', o.wall);
      if (o.floor) root.style.setProperty('--floor', o.floor);
      if (o.fill !== undefined) q('.water').style.height = `${Math.round(Math.max(0, Math.min(1, o.fill)) * 100)}%`;
      if (o.motion !== undefined && ham.className !== `ham ${o.motion}`) ham.className = `ham ${o.motion}`;
      if (o.bubble !== undefined) {
        q('.bubble').textContent = o.bubble;
        q('.bubble').hidden = !o.bubble;
      }
      if (o.puddle !== undefined) q('.puddle').hidden = !o.puddle;
      if (o.zz !== undefined) q('.zz').hidden = !o.zz;
      if (o.sparkles !== undefined) q('.sparkles').hidden = !o.sparkles;
    },
    destroy() {
      ro.disconnect();
      hamster.destroy();
    },
  };
}
