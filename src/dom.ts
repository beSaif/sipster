import type { Pose } from '../shared/sprite';
import { Hamster } from './hamster';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Parses markup into a single element. */
export function el<T extends HTMLElement = HTMLElement>(markup: string): T {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as T;
}

/** Elements marked `data-ref="name"`, by name. */
export function refs(root: HTMLElement): Record<string, HTMLElement> {
  const out: Record<string, HTMLElement> = {};
  root.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (out[n.dataset.ref!] = n));
  return out;
}

/** Replaces `<span data-gerald="pose" data-px="2">` placeholders with drawn sprites. */
export function drawGeralds(root: HTMLElement): Hamster[] {
  const made: Hamster[] = [];
  root.querySelectorAll<HTMLElement>('[data-gerald]').forEach((slot) => {
    const h = new Hamster(Number(slot.dataset.px ?? 2), slot.dataset.gerald as Pose, slot.getAttribute('aria-label') ?? 'Gerald');
    if (slot.hasAttribute('aria-hidden')) h.canvas.setAttribute('aria-hidden', 'true');
    slot.replaceWith(h.canvas);
    made.push(h);
  });
  return made;
}

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const t = el(`<div class="toast" role="status">${esc(message)}</div>`);
  document.body.append(t);
  setTimeout(() => t.remove(), 3600);
}

export const ICONS = {
  sliders: '<svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M1 2h8v1h-8z M1 5h8v1h-8z M1 8h8v1h-8z M3 1h2v3h-2z M6 4h2v3h-2z M2 7h2v3h-2z"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M4 2h1v1h-1z M3 3h1v1h-1z M2 4h7v2h-7z M3 6h1v1h-1z M4 7h1v1h-1z"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M4 1h2v1h1v1h1v4h1v1h-8v-1h1v-4h1v-1h1z M4 9h2v1h-2z"/></svg>',
  install: '<svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M4 0h2v5h2v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h2z M0 8h10v2h-10z"/></svg>',
  drop: '<svg width="24" height="24" viewBox="0 0 10 10" aria-hidden="true"><path fill="#2A86D6" d="M4 1h2v2h1v2h1v3h-1v1h-4v-1h-1v-3h1v-2h1z"/><path fill="#fff" d="M3 5h1v2h-1z"/></svg>',
  glass: '<svg width="24" height="24" viewBox="0 0 10 10" aria-hidden="true"><path fill="#23202E" d="M2 1h6v8h-6z"/><path fill="#F4FBFF" d="M3 2h4v6h-4z"/><path fill="#2A86D6" d="M3 5h4v3h-4z"/></svg>',
  bottle: '<svg width="24" height="24" viewBox="0 0 10 10" aria-hidden="true"><path fill="#23202E" d="M4 0h2v2h1v1h1v7h-6v-7h1v-1h1z"/><path fill="#F4FBFF" d="M3 4h4v5h-4z"/><path fill="#2A86D6" d="M3 6h4v3h-4z"/></svg>',
};
