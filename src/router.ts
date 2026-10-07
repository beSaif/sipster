// The hash router's helpers: `#/path?query` parsing and navigation. Routes are declared in main.ts.

export interface HashRoute {
  /** `#/friends` for `#/friends?x=1`. */
  path: string;
  query: URLSearchParams;
}

export function parseHash(hash: string = location.hash): HashRoute {
  const raw = hash || '#/';
  const i = raw.indexOf('?');
  return { path: i < 0 ? raw : raw.slice(0, i), query: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
}

/** The query part of the current hash, e.g. `error` after a failed sign-in. */
export function hashQuery(): URLSearchParams {
  return parseHash().query;
}

/** Navigates to a hash route (adds a history entry). */
export function go(path: string, query?: Record<string, string>): void {
  const q = query ? new URLSearchParams(query).toString() : '';
  location.hash = q ? `${path}?${q}` : path;
}

/** Rewrites the current hash without adding a history entry or re-routing (used to drop one-time parameters). */
export function replaceHash(path: string): void {
  history.replaceState(null, '', path);
}

/** Back when the previous entry is ours, else to `fallback`. */
export function back(fallback = '#/'): void {
  if (history.length > 1) history.back();
  else location.hash = fallback;
}
