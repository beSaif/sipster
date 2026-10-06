// Sign in with Google, pick a username, manage the account. docs/SOCIAL.md §5 and §6.
// The screen renders from `account()` and re-renders when the account changes; what the user is
// typing survives changes that don't touch the account itself (a new unread count, say).

import type { SignInError, User } from '../../shared/api';
import { USERNAME_MAX, USERNAME_MIN, usernameProblem } from '../../shared/username';
import { account, forgetAccount, onAccount, setUser, signOut, user, type AccountState } from '../account';
import { api, isApiError } from '../api';
import { ICONS, el, esc, refs, toast } from '../dom';
import { back, go, hashQuery, replaceHash } from '../router';

const SIGN_IN_ERRORS: Record<SignInError, string> = {
  cancelled: 'You backed out at Google. No hard feelings.',
  failed: 'Google and Gerald couldn’t agree. Try again.',
  signups_disabled: 'Sign-ups are closed right now.',
};

const RULES = `${USERNAME_MIN}–${USERNAME_MAX} letters, numbers or underscores.`;
const TAKEN = 'Taken. Gerald suggests adding a number.';
const SIGN_IN_LABEL = 'Sign in with Google';

/** A chunky pixel "G" on a white tile, in Google's four colours. */
export const GOOGLE_G =
  '<svg class="g-mark" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true">' +
  '<path fill="#fff" d="M0 0h10v10H0z"/>' +
  '<path fill="#ea4335" d="M2 1h6v1H2z M1 2h2v1H1z M7 2h2v1H7z"/>' +
  '<path fill="#fbbc05" d="M1 3h2v4H1z"/>' +
  '<path fill="#34a853" d="M1 7h2v1H1z M2 8h6v1H2z"/>' +
  '<path fill="#4285f4" d="M5 4h4v2H5z M7 6h2v2H7z"/></svg>';

// A real link, not a fetch: the Worker sends the browser on to Google and back (docs/SOCIAL.md §5).
const SIGN_IN_BUTTON = `<a class="btn primary signin" href="${api.googleSignInUrl}" data-ref="google">${GOOGLE_G}<span data-ref="googleLabel">${SIGN_IN_LABEL}</span></a>`;
const NOT_SET_UP = '<p class="note">Sign-in isn’t set up on this server yet.</p>';

// Remembered for this page load once the server has said sign-in is configured; a 500 is probed again next time.
let signInReady = false;

/** Asks the Worker whether Sign in with Google is configured: a redirect means yes, a 500 means no, null when we couldn't tell. */
async function probeSignIn(): Promise<boolean | null> {
  if (signInReady) return true;
  try {
    const res = await fetch(api.googleSignInUrl, { method: 'GET', redirect: 'manual', cache: 'no-store' });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return (signInReady = true);
    return res.status >= 500 ? false : null;
  } catch {
    return null;
  }
}

/** What to tell the user when a call fails, in Gerald's words. */
export function errorText(err: unknown): string {
  if (!isApiError(err)) return 'Something went wrong. Gerald is confused.';
  switch (err.code) {
    case 'offline':
      return 'You’re offline. Gerald can’t reach his server.';
    case 'unauthorized':
      return 'Your session ended. Sign in again.';
    case 'rate_limited':
      return 'Gerald needs a moment. Try again in a bit.';
    case 'internal':
    case 'http':
      return 'Gerald’s server hiccuped. Try again in a bit.';
    default:
      return err.message;
  }
}

/** What the account screens render from: the status and the parts of the user they show. */
export function accountKey(s: AccountState): string {
  return s.status === 'in' ? ['in', s.user.id, s.user.username ?? '', s.user.email, s.user.social_push].join('|') : s.status;
}

/** Back, unless this page was loaded from Google's sign-in: then home, so "back" never lands on the consent screen again. */
function leave(): void {
  let fromGoogle = false;
  try {
    const host = document.referrer ? new URL(document.referrer).hostname : '';
    fromGoogle = host === 'google.com' || host.endsWith('.google.com');
  } catch {
    fromGoogle = false;
  }
  if (fromGoogle) go('#/');
  else back('#/');
}

export function mountAccount(root: HTMLElement): () => void {
  const view = el(`
    <main class="screen account">
      <header class="topbar start">
        <button class="icon-btn" type="button" aria-label="Back" data-ref="back">${ICONS.back}</button>
        <h1 class="logo">Account</h1>
      </header>
      <div class="account-body" data-ref="content"></div>
    </main>`);
  const r = refs(view);
  root.replaceChildren(view);

  // The outcome of a sign-in attempt rides in on the hash (`#/account?error=cancelled`); show it once.
  const errorParam = hashQuery().get('error');
  const signInError = errorParam && Object.hasOwn(SIGN_IN_ERRORS, errorParam) ? SIGN_IN_ERRORS[errorParam as SignInError] : null;
  if (errorParam) replaceHash('#/account');

  let shown = ''; // key of the state on screen
  let editing = false; // the username picker is open over the account card
  let confirming = false; // the delete-account form is open
  let busy = false; // a request is in flight; its button stays disabled
  let live = true;
  let checkTimer = 0;
  let checkSeq = 0;
  let probeTimer = 0;

  const q = <T extends HTMLElement>(ref: string) => r.content.querySelector<T>(`[data-ref="${ref}"]`);

  function hint(text: string, kind: '' | 'ok' | 'bad' = ''): void {
    const h = q('hint');
    if (!h) return;
    h.textContent = text;
    h.className = kind ? `help ${kind}` : 'help';
  }

  function render(): void {
    const s = account();
    shown = accountKey(s);
    clearTimeout(checkTimer);
    checkSeq++;
    if (s.status === 'loading') r.content.innerHTML = '<p class="help acct-quiet">Gerald is checking who’s here…</p>';
    else if (s.status === 'out') renderSignedOut();
    else if (!s.user.username || editing) renderPicker(s.user);
    else renderCard(s.user);
  }

  function renderSignedOut(): void {
    r.content.innerHTML = `
      <section class="card acct-card">
        <h2>Friends &amp; leaderboard</h2>
        <p class="body small">Sign in to pick a username, add friends and see who’s leading. Your drinks still stay on your phone; only your daily totals are shared with friends.</p>
        ${signInError ? `<p class="form-error" role="alert">${esc(signInError)}</p>` : ''}
        <div class="signin-slot" data-ref="slot"><p class="help">One moment…</p></div>
        <p class="help">Google only tells Gerald your email. No contacts, no calendar, no nothing.</p>
      </section>
      <a class="link-btn center" href="#/privacy">How Gerald handles your data</a>`;
    void placeSignIn();
  }

  /** Fills the sign-in slot with the button, or with a note when the server has no Google credentials yet. */
  async function placeSignIn(): Promise<void> {
    const show = (configured: boolean) => {
      const slot = q('slot');
      const state = configured ? 'ready' : 'missing';
      if (!live || !slot || slot.dataset.state === state) return;
      slot.dataset.state = state;
      slot.innerHTML = configured ? SIGN_IN_BUTTON : NOT_SET_UP;
    };
    clearTimeout(probeTimer);
    // A slow server shouldn't hide the button; a late 500 still swaps in the note.
    probeTimer = window.setTimeout(() => show(true), 2500);
    const ok = await probeSignIn();
    clearTimeout(probeTimer);
    show(ok !== false);
  }

  function renderPicker(u: User): void {
    const current = u.username ?? '';
    r.content.innerHTML = `
      <section class="card acct-card">
        <h2>${current ? 'Change your username' : 'Pick a username'}</h2>
        <p class="body small">Friends find you by this name, so make it memorable. ${RULES}</p>
        <form class="acct-form" data-ref="pick" novalidate>
          <label class="field">
            <span class="label">Username</span>
            <span class="at-input"><span class="at" aria-hidden="true">@</span><input type="text" name="username" data-ref="name" value="${esc(current)}" maxlength="${USERNAME_MAX}" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="gerald_fan"></span>
          </label>
          <p class="help" data-ref="hint" aria-live="polite">${current ? 'That’s your name now.' : RULES}</p>
          <div class="btn-row">
            ${current ? '<button class="btn secondary" type="button" data-act="cancel-edit">Cancel</button>' : ''}
            <button class="btn primary grow" type="submit" data-ref="save" disabled>Save</button>
          </div>
        </form>
      </section>`;
    q<HTMLInputElement>('name')?.focus();
  }

  function confirmForm(): string {
    return `
      <form class="acct-confirm" data-ref="confirm" novalidate>
        <p class="note"><b>Last chance.</b> This deletes your username, friends, daily totals and notifications from the server. For good. Your drinks stay on this phone.</p>
        <label class="field">
          <span class="label">Type your email to confirm</span>
          <input class="acct-input" type="email" data-ref="confirmEmail" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email" placeholder="you@example.com">
        </label>
        <div class="acct-confirm-row">
          <button class="btn secondary" type="button" data-act="cancel-delete">Keep it</button>
          <button class="btn danger" type="submit" data-ref="confirmBtn" disabled>Delete for good</button>
        </div>
      </form>`;
  }

  function renderCard(u: User): void {
    r.content.innerHTML = `
      <section class="card acct-card">
        <p class="kicker">Signed in as</p>
        <div class="acct-who">
          <p class="acct-name">@${esc(u.username)}</p>
          <button class="link-btn" type="button" data-act="edit">Change</button>
        </div>
        <p class="help acct-email">${esc(u.email)}</p>
        <div class="acct-actions">
          <a class="btn secondary" href="#/friends">Friends &amp; leaderboard</a>
          <button class="btn secondary" type="button" data-act="signout">Sign out</button>
          ${confirming ? confirmForm() : '<button class="btn danger" type="button" data-act="delete">Delete account</button>'}
        </div>
      </section>
      <a class="link-btn center" href="#/privacy">Privacy policy</a>`;
  }

  function onGoogleClick(e: Event, link: HTMLElement): void {
    if (!navigator.onLine) {
      e.preventDefault();
      toast('You’re offline. Google is not.');
      return;
    }
    // A second tap simply navigates again; nothing to guard.
    link.setAttribute('aria-busy', 'true');
    const label = link.querySelector('[data-ref="googleLabel"]');
    if (label) label.textContent = 'Off to Google…';
  }

  // Back from Google without signing in, the page can be restored from the cache as it was left: un-busy the button.
  function onPageShow(): void {
    const link = q('google');
    if (!link) return;
    link.removeAttribute('aria-busy');
    const label = link.querySelector('[data-ref="googleLabel"]');
    if (label) label.textContent = SIGN_IN_LABEL;
  }

  /** Live validation while typing, then (after a pause) the server's word on availability. */
  function checkName(name: string): void {
    clearTimeout(checkTimer);
    const seq = ++checkSeq;
    const save = q<HTMLButtonElement>('save');
    if (!save) return;
    save.disabled = true;
    if (!name) return hint(RULES);
    const problem = usernameProblem(name);
    if (problem) return hint(problem);
    if (name === user()?.username) return hint('That’s your name now.');
    hint('Checking…');
    checkTimer = window.setTimeout(async () => {
      try {
        const res = await api.checkUsername(name);
        if (seq !== checkSeq) return; // typed on, or the screen changed
        if (!res.valid) return hint(usernameProblem(name) ?? 'Letters, numbers and underscores only.');
        if (!res.available) return hint(TAKEN, 'bad');
        hint('Available', 'ok');
        save.disabled = false;
      } catch (err) {
        if (seq === checkSeq) hint(errorText(err), 'bad');
      }
    }, 300);
  }

  async function savePick(form: HTMLFormElement): Promise<void> {
    const input = form.querySelector<HTMLInputElement>('[data-ref="name"]');
    const save = form.querySelector<HTMLButtonElement>('[data-ref="save"]');
    if (!input || !save || save.disabled || busy) return;
    const name = input.value.trim();
    const first = !user()?.username;
    busy = true;
    save.disabled = true;
    save.setAttribute('aria-busy', 'true');
    save.textContent = 'Saving…';
    try {
      const { user: next } = await api.setUsername({ username: name });
      editing = false;
      setUser(next); // re-renders the card
      toast(`Hello, @${next.username ?? name}. Gerald approves.`);
      if (first) go('#/friends');
    } catch (err) {
      const taken = isApiError(err) && err.code === 'conflict';
      if (taken) hint(TAKEN, 'bad');
      else toast(errorText(err));
      save.textContent = 'Save';
      save.removeAttribute('aria-busy');
      save.disabled = taken;
    } finally {
      busy = false;
    }
  }

  async function deleteAccount(form: HTMLFormElement): Promise<void> {
    const input = form.querySelector<HTMLInputElement>('[data-ref="confirmEmail"]');
    const btn = form.querySelector<HTMLButtonElement>('[data-ref="confirmBtn"]');
    const u = user();
    if (!input || !btn || !u || busy) return;
    const email = input.value.trim();
    if (email.toLowerCase() !== u.email.toLowerCase()) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await api.deleteAccount({ email });
      confirming = false;
      forgetAccount();
      toast('Account deleted. Gerald remembers nothing.');
      go('#/');
    } catch (err) {
      toast(errorText(err));
      btn.textContent = 'Delete for good';
      btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  async function doSignOut(btn: HTMLButtonElement): Promise<void> {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Signing out…';
    try {
      await signOut(); // the signed-out screen renders through onAccount
      toast('Signed out. Gerald will keep your drinks safe here.');
    } finally {
      busy = false;
    }
  }

  r.back.addEventListener('click', leave);
  r.content.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const google = target.closest<HTMLElement>('[data-ref="google"]');
    if (google) return onGoogleClick(e, google);
    const btn = target.closest<HTMLButtonElement>('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'edit':
        editing = true;
        return render();
      case 'cancel-edit':
        editing = false;
        return render();
      case 'delete':
        confirming = true;
        render();
        return q<HTMLInputElement>('confirmEmail')?.focus();
      case 'cancel-delete':
        confirming = false;
        return render();
      case 'signout':
        return void doSignOut(btn);
    }
  });
  r.content.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.ref === 'name') checkName(input.value.trim());
    else if (input.dataset.ref === 'confirmEmail') {
      const btn = q<HTMLButtonElement>('confirmBtn');
      const u = user();
      if (btn) btn.disabled = busy || !u || input.value.trim().toLowerCase() !== u.email.toLowerCase();
    }
  });
  r.content.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    if (form.dataset.ref === 'pick') void savePick(form);
    else if (form.dataset.ref === 'confirm') void deleteAccount(form);
  });
  window.addEventListener('pageshow', onPageShow);

  const off = onAccount((s) => {
    if (accountKey(s) === shown) return;
    if (s.status !== 'in') {
      editing = false;
      confirming = false;
    }
    render();
  });
  render();

  return () => {
    live = false;
    off();
    clearTimeout(checkTimer);
    clearTimeout(probeTimer);
    window.removeEventListener('pageshow', onPageShow);
  };
}
