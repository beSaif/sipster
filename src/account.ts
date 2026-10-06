// Who is signed in, for the page. The answer comes from GET /api/auth/me and is cached in
// localStorage so the home screen can show the name and the unread badge before the network answers
// (or without it). Views subscribe with `onAccount`.

import type { Me, User } from '../shared/api';
import { api, isApiError, setUnauthorizedHandler } from './api';
import { currentSubscription } from './push';

export type AccountState = { status: 'loading' } | { status: 'out' } | { status: 'in'; user: User; unread: number };

const CACHE_KEY = 'sipster.account';
let state: AccountState = { status: 'loading' };
const listeners = new Set<(s: AccountState) => void>();

function readCache(): Me | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const me = raw ? (JSON.parse(raw) as Me) : null;
    return me && me.user && typeof me.user.id === 'string' ? me : null;
  } catch {
    return null;
  }
}

function writeCache(me: Me | null): void {
  try {
    if (me) localStorage.setItem(CACHE_KEY, JSON.stringify(me));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage can be blocked; the app still works for this session.
  }
}

function set(next: AccountState): void {
  state = next;
  listeners.forEach((fn) => fn(state));
}

/** The current account state. */
export function account(): AccountState {
  return state;
}

/** The signed-in user, or null. */
export function user(): User | null {
  return state.status === 'in' ? state.user : null;
}

/** Subscribe to changes; returns the unsubscribe function. The callback is not called immediately. */
export function onAccount(fn: (s: AccountState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function signedIn(me: Me): void {
  writeCache(me);
  set({ status: 'in', user: me.user, unread: me.unread });
}

function signedOut(): void {
  writeCache(null);
  set({ status: 'out' });
}

/** Asks the server who is signed in. Offline with a cached account: trust the cache. */
export async function loadAccount(): Promise<AccountState> {
  try {
    signedIn(await api.me({ quiet401: true }));
  } catch (err) {
    const cached = isApiError(err) && err.code !== 'unauthorized' ? readCache() : null;
    if (cached) set({ status: 'in', user: cached.user, unread: cached.unread });
    else signedOut();
  }
  return state;
}

/** Trades the one-time code from the sign-in redirect for a session in this browser context (docs/SOCIAL.md §5). */
export async function claimSession(code: string): Promise<boolean> {
  try {
    signedIn(await api.claim({ code }));
    return true;
  } catch {
    return false;
  }
}

/** Updates the cached user after a change (username, settings). */
export function setUser(next: User): void {
  if (state.status !== 'in') return;
  signedIn({ user: next, unread: state.unread });
}

export function setUnread(unread: number): void {
  if (state.status !== 'in') return;
  signedIn({ user: state.user, unread });
}

/** Re-reads the unread count (after notifications were read elsewhere, when the app comes back to the front). */
export async function refreshAccount(): Promise<void> {
  if (state.status !== 'in') return;
  try {
    signedIn(await api.me());
  } catch {
    // 401 is handled by the API layer; anything else keeps the current state.
  }
}

/** Ends the session; tells the server which phone this is so it stops sending social pushes here. */
export async function signOut(): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  await api.logout(sub ? { endpoint: sub.endpoint } : {}).catch(() => undefined);
  signedOut();
}

/** After the server deleted the account. */
export function forgetAccount(): void {
  signedOut();
}

setUnauthorizedHandler(() => {
  if (state.status === 'in') signedOut();
});
