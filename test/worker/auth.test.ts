import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import type { ApiErrorBody, Me, User, UsernameCheck } from '../../shared/api';
import { app } from '../../worker/index';
import {
  api,
  claim,
  claimCodeOf,
  claimsFor,
  cookieOf,
  count,
  finishSignIn,
  freshIdentity,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  idToken,
  me,
  mockTokenEndpoint,
  OAUTH_COOKIE,
  ORIGIN,
  sha256Hex,
  signup,
  startSignIn,
} from './helpers';

const CALLBACK = `${ORIGIN}/api/auth/google/callback`;
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const userOf = async (res: Response) => ((await res.json()) as { user: User }).user;

// The tests in a file share one database, so every name, endpoint and id is minted fresh.
let seq = 0;
/** A valid username nobody else in this file has: `base` plus a short unique tail, within 20 characters. */
const uniqueName = (base: string): string => `${base}${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`.slice(0, 20);
const freshEndpoint = (): string => `https://push.example/sub/${crypto.randomUUID()}`;

// A phone that turned nudges on, as /api/subscribe would store it, linked to `userId`.
async function insertDevice(endpoint: string, userId: string | null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO devices (id, endpoint, p256dh, auth, origin, tz, interval_min, start_min, end_min, smart, next_at, created_at, updated_at, user_id)
     VALUES (?, ?, 'p256dh', 'auth', ?, 'Europe/Zurich', 60, 480, 1320, 1, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(endpoint), endpoint, ORIGIN, now, now, now, userId)
    .run();
}
/** The account a device is linked to: a user id, null when unlinked, undefined when the row is gone. */
const linkedTo = async (endpoint: string) =>
  (await env.DB.prepare('SELECT user_id FROM devices WHERE id = ?').bind(await sha256Hex(endpoint)).first<{ user_id: string | null }>())?.user_id;

describe('sign in with Google', () => {
  it('sends the browser to Google with PKCE, a state and a nonce, and keeps them in a cookie', async () => {
    const res = await api('/api/auth/google/start');
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location') ?? '');
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = to.searchParams;
    expect(q.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(CALLBACK);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('state')).toMatch(/^[\w-]{43}$/);
    expect(q.get('nonce')).toMatch(/^[\w-]{43}$/);
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);

    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^sipster_oauth=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/Path=\/api\/auth\/google(;|$)/);
    expect(set).toMatch(/Max-Age=600/);
    // The cookie carries what Google will echo back and the verifier behind the challenge, nothing else.
    const parts = decodeURIComponent(cookieOf(res, OAUTH_COOKIE).slice(OAUTH_COOKIE.length + 1)).split('.');
    expect(parts).toHaveLength(3);
    const [state, nonce, verifier] = parts;
    expect(state).toBe(q.get('state'));
    expect(nonce).toBe(q.get('nonce'));
    expect(await sha256(verifier ?? '')).toBe(q.get('code_challenge'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 500 while the Google client is not configured', async () => {
    const bare = { ...env, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
    for (const path of ['/api/auth/google/start', '/api/auth/google/callback?code=c&state=s']) {
      const res = await app.fetch(new Request(`${ORIGIN}${path}`), bare, createExecutionContext());
      expect(res.status, path).toBe(500);
      expect((await errorOf(res)).code).toBe('internal');
    }
  });

  it('creates a nameless account on the first sign-in, signs the browser in and hands it a claim code', async () => {
    const who = freshIdentity('first');
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ ...who, nonce: start.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'the-code', state: start.state }, start.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^\/#\/account\?claim=[\w-]{43}$/);

      // The code went to Google with the client secret and the verifier behind the challenge.
      expect(google.calls).toHaveLength(1);
      const sent = google.calls[0]!;
      expect(sent.get('grant_type')).toBe('authorization_code');
      expect(sent.get('code')).toBe('the-code');
      expect(sent.get('client_id')).toBe(GOOGLE_CLIENT_ID);
      expect(sent.get('client_secret')).toBe(GOOGLE_CLIENT_SECRET);
      expect(sent.get('redirect_uri')).toBe(CALLBACK);
      expect(await sha256(sent.get('code_verifier') ?? '')).toBe(start.codeChallenge);

      // Signed in: a session cookie with the right flags, and the pending cookie is dropped.
      const set = res.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/sipster_oauth=;[^,]*Max-Age=0/i);
      const session = set.slice(set.indexOf('sipster_session='));
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).toMatch(/Secure/i);
      expect(session).toMatch(/Path=\//);

      const body = await me(cookieOf(res));
      expect(body.user.email).toBe(who.email);
      expect(body.user.username).toBeNull();
      expect(body.user.social_push).toBe(true);
      expect(body.unread).toBe(0);
      expect(Object.keys(body).sort()).toEqual(['unread', 'user']);
      expect(Object.keys(body.user).sort()).toEqual(['created_at', 'email', 'id', 'social_push', 'username']);
      const row = await env.DB.prepare('SELECT google_sub, username, social_push FROM users WHERE id = ?')
        .bind(body.user.id)
        .first<{ google_sub: string; username: string | null; social_push: number }>();
      expect(row).toEqual({ google_sub: who.sub, username: null, social_push: 1 });

      // The claim code is stored hashed and good for two minutes.
      const code = claimCodeOf(res) ?? '';
      const stored = await env.DB.prepare('SELECT user_id, expires_at FROM login_codes WHERE id = ?')
        .bind(await sha256Hex(code))
        .first<{ user_id: string; expires_at: number }>();
      expect(stored?.user_id).toBe(body.user.id);
      expect((stored?.expires_at ?? 0) - Date.now()).toBeGreaterThan(100_000);
      expect((stored?.expires_at ?? 0) - Date.now()).toBeLessThanOrEqual(120_000);
    } finally {
      google.restore();
    }
  });

  it('recognises the account next time, follows a changed address, and replaces the session it signs in over', async () => {
    const first = await signup();
    const again = await signup({ sub: first.sub, email: first.email });
    expect(again.userId).toBe(first.userId);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?', first.sub)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', first.userId)).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?', first.userId)).toBe(2);

    // The person renamed their Google account; this browser already held `again`'s session.
    const moved = await signup({ sub: first.sub, email: `new-${first.email}`, cookie: again.cookie });
    expect(moved.userId).toBe(first.userId);
    expect((await me(moved.cookie)).user.email).toBe(`new-${first.email}`);
    expect((await api('/api/auth/me', { cookie: again.cookie })).status).toBe(401);
    expect((await api('/api/auth/me', { cookie: first.cookie })).status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', first.userId)).toBe(2);
  });

  it('keeps its address when the new one already belongs to another account', async () => {
    const a = await signup();
    const b = await signup();
    const again = await signup({ sub: a.sub, email: b.email });
    expect(again.userId).toBe(a.userId);
    expect((await me(again.cookie)).user.email).toBe(a.email);
    expect((await me(b.cookie)).user.email).toBe(b.email);
  });

  it('stores the address trimmed and lower-cased', async () => {
    const who = freshIdentity('case');
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ sub: who.sub, email: ` ${who.email.toUpperCase()} `, nonce: start.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
      expect((await me(cookieOf(res))).user.email).toBe(who.email);
    } finally {
      google.restore();
    }
  });

  it('never hands an address that belongs to one account to another Google account', async () => {
    const owner = await signup();
    const other = freshIdentity('other');
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ sub: other.sub, email: owner.email, nonce: start.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
      expect(res.headers.get('location')).toBe('/#/account?error=failed');
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sipster_session=/);
      expect(await count('SELECT COUNT(*) AS n FROM users WHERE email = ?', owner.email)).toBe(1);
      expect(await count('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?', other.sub)).toBe(0);
    } finally {
      google.restore();
    }
  });

  it('refuses a callback without its cookie, with a broken cookie, a foreign state, no code, or after a cancel at Google', async () => {
    const start = await startSignIn();
    const google = mockTokenEndpoint(() => ({ status: 500, body: { error: 'must not be asked' } }));
    try {
      const noCookie = await finishSignIn({ code: 'c', state: start.state }, '');
      expect(noCookie.status).toBe(302);
      expect(noCookie.headers.get('location')).toBe('/#/account?error=failed');
      const shortCookie = await finishSignIn({ code: 'c', state: start.state }, `${OAUTH_COOKIE}=${start.state}.nonce-only`);
      expect(shortCookie.headers.get('location')).toBe('/#/account?error=failed');
      const longCookie = await finishSignIn({ code: 'c', state: start.state }, `${OAUTH_COOKIE}=${start.state}.n.v.extra`);
      expect(longCookie.headers.get('location')).toBe('/#/account?error=failed');
      const wrongState = await finishSignIn({ code: 'c', state: 'someone-elses' }, start.cookie);
      expect(wrongState.headers.get('location')).toBe('/#/account?error=failed');
      const noCode = await finishSignIn({ state: start.state }, start.cookie);
      expect(noCode.headers.get('location')).toBe('/#/account?error=failed');
      const cancelled = await finishSignIn({ error: 'access_denied', state: start.state }, start.cookie);
      expect(cancelled.headers.get('location')).toBe('/#/account?error=cancelled');
      for (const res of [noCookie, shortCookie, longCookie, wrongState, noCode, cancelled]) {
        expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sipster_session=/);
        expect(res.headers.get('set-cookie') ?? '').toMatch(/sipster_oauth=;[^,]*Max-Age=0/i);
      }
      expect(google.calls).toHaveLength(0);
    } finally {
      google.restore();
    }
  });

  it('refuses an ID token that is not for us, stale, for another sign-in, or without a verified address', async () => {
    const who = freshIdentity('bad');
    const cases: Array<[string, (good: Record<string, unknown>) => Record<string, unknown>]> = [
      ['another audience', (g) => ({ ...g, aud: 'someone-else' })],
      ['another issuer', (g) => ({ ...g, iss: 'https://accounts.evil.example' })],
      ['expired', (g) => ({ ...g, exp: Math.floor(Date.now() / 1000) - 1 })],
      ['another nonce', (g) => ({ ...g, nonce: 'not-this-sign-in' })],
      ['unverified address', (g) => ({ ...g, email_verified: false })],
      ['no subject', (g) => ({ ...g, sub: '' })],
      ['no address', (g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'email'))],
    ];
    for (const [name, mutate] of cases) {
      const start = await startSignIn();
      const google = mockTokenEndpoint(() => ({ body: { id_token: idToken(mutate(claimsFor({ ...who, nonce: start.nonce }))) } }));
      try {
        const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
        expect(res.headers.get('location'), name).toBe('/#/account?error=failed');
        expect(res.headers.get('set-cookie') ?? '', name).not.toMatch(/sipster_session=/);
      } finally {
        google.restore();
      }
    }
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE email = ?', who.email)).toBe(0);
  });

  it('fails cleanly when Google refuses the code or answers nonsense', async () => {
    for (const answer of [{ status: 400, body: { error: 'invalid_grant' } }, { body: { id_token: 'not.a.jwt' } }, { body: 'plain text' }]) {
      const start = await startSignIn();
      const google = mockTokenEndpoint(() => answer);
      try {
        const res = await finishSignIn({ code: 'c', state: start.state }, start.cookie);
        expect(res.headers.get('location')).toBe('/#/account?error=failed');
      } finally {
        google.restore();
      }
    }
  });
});

describe('the one-time claim code', () => {
  it('gives a browser without the cookie its own session, once', async () => {
    const s = await signup();
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(1);
    const res = await claim(s.claimCode);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Me;
    expect(body.user.id).toBe(s.userId);
    expect(body.unread).toBe(0);
    const cookie = cookieOf(res);
    expect(cookie).not.toBe(s.cookie);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(2);
    expect((await api('/api/auth/me', { cookie })).status).toBe(200);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(200);

    // Spent.
    expect(await count('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?', s.userId)).toBe(0);
    const again = await claim(s.claimCode);
    expect(again.status).toBe(401);
    expect(await errorOf(again)).toEqual({ code: 'unauthorized', message: 'This sign-in link has expired' });
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(2);
  });

  it('is a no-op for the browser that already holds the session', async () => {
    const s = await signup();
    const res = await claim(s.claimCode, s.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).user.id).toBe(s.userId);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?', s.userId)).toBe(0);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(200);
  });

  it('replaces a session that belongs to somebody else', async () => {
    const other = await signup();
    const s = await signup();
    const res = await claim(s.claimCode, other.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).user.id).toBe(s.userId);
    const cookie = cookieOf(res);
    expect((await me(cookie)).user.id).toBe(s.userId);
    expect((await api('/api/auth/me', { cookie: other.cookie })).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', other.userId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(2);
  });

  it('refuses an expired code and forgets it', async () => {
    const s = await signup();
    await env.DB.prepare('UPDATE login_codes SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1, s.userId).run();
    const res = await claim(s.claimCode);
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('unauthorized');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?', s.userId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(1);
  });

  it('refuses codes it never issued and bodies that are not a code', async () => {
    const s = await signup();
    expect((await claim('nope')).status).toBe(401);
    expect((await claim('A'.repeat(43))).status).toBe(401);
    expect((await claim(s.claimCode.slice(1))).status).toBe(401);
    const number = await api('/api/auth/claim', { body: { code: 42 } });
    expect(number.status).toBe(400);
    expect((await errorOf(number)).code).toBe('validation');
    expect((await api('/api/auth/claim', { body: {} })).status).toBe(400);
    expect((await api('/api/auth/claim', { method: 'POST' })).status).toBe(400);
    expect((await api('/api/auth/claim', { method: 'POST', raw: 'code=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status).toBe(400);
    // Still good: nothing above was the real code.
    expect(await count('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?', s.userId)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(1);
  });
});

describe('sessions', () => {
  it('answers /me and logs out', async () => {
    const s = await signup();
    expect((await me(s.cookie)).user.email).toBe(s.email);
    const out = await api('/api/auth/logout', { method: 'POST', body: {}, cookie: s.cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/sipster_session=;/);
    expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', s.userId)).toBe(0);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(401);
  });

  it('logs out without a session, without a body, and with a body that is not JSON', async () => {
    const bare = await api('/api/auth/logout', { method: 'POST' });
    expect(bare.status).toBe(204);
    expect(bare.headers.get('set-cookie')).toMatch(/sipster_session=;/);
    const s = await signup();
    const text = await api('/api/auth/logout', { method: 'POST', raw: 'bye', headers: { 'Content-Type': 'text/plain' }, cookie: s.cookie });
    expect(text.status).toBe(204);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(401);
    const stale = await api('/api/auth/logout', { method: 'POST', body: {}, cookie: s.cookie });
    expect(stale.status).toBe(204);
  });

  it('renews a session that runs low once, not on every request', async () => {
    const DAY = 86_400_000;
    const s = await signup();
    const expiry = async () => (await env.DB.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').bind(s.userId).first<{ expires_at: number }>())?.expires_at;

    // Twenty days left: nothing to do.
    const plenty = Date.now() + 20 * DAY;
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(plenty, s.userId).run();
    const untouched = await api('/api/auth/me', { cookie: s.cookie });
    expect(untouched.status).toBe(200);
    expect(untouched.headers.get('set-cookie')).toBeNull();
    expect(await expiry()).toBe(plenty);

    // Ten days left: renewed to thirty, cookie included…
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(Date.now() + 10 * DAY, s.userId).run();
    const renewed = await api('/api/auth/me', { cookie: s.cookie });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('set-cookie')).toMatch(/sipster_session=/);
    const after = await expiry();
    expect(after).toBeGreaterThan(Date.now() + 29 * DAY);

    // …and the next request the same day writes nothing.
    const next = await api('/api/auth/me', { cookie: s.cookie });
    expect(next.status).toBe(200);
    expect(next.headers.get('set-cookie')).toBeNull();
    expect(await expiry()).toBe(after);
  });

  it('refuses cross-origin mutations', async () => {
    const s = await signup();
    const res = await api('/api/auth/logout', { method: 'POST', body: {}, cookie: s.cookie, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(200);
  });

  it('counts unread notifications in /me', async () => {
    const s = await signup();
    const friend = await signup({ username: uniqueName('Friend') });
    const now = Date.now();
    const insert = 'INSERT INTO notifications (id, user_id, kind, actor_id, ref, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await env.DB.batch([
      env.DB.prepare(insert).bind(crypto.randomUUID(), s.userId, 'friend_request', friend.userId, null, now - 3000, null),
      env.DB.prepare(insert).bind(crypto.randomUUID(), s.userId, 'goal_reached', friend.userId, '2026-10-05', now - 2000, null),
      env.DB.prepare(insert).bind(crypto.randomUUID(), s.userId, 'friend_accepted', friend.userId, null, now - 1000, now),
      env.DB.prepare(insert).bind(crypto.randomUUID(), friend.userId, 'friend_request', s.userId, null, now, null),
    ]);
    expect((await me(s.cookie)).unread).toBe(2);
    expect((await me(friend.cookie)).unread).toBe(1);
  });
});

describe('username', () => {
  it('is null after the first sign-in and shows up everywhere once chosen', async () => {
    const s = await signup();
    const name = uniqueName('Gerald_');
    expect((await me(s.cookie)).user.username).toBeNull();
    const res = await api('/api/auth/username', { method: 'PUT', body: { username: name }, cookie: s.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: User };
    expect(Object.keys(body)).toEqual(['user']);
    expect(body.user.id).toBe(s.userId);
    expect(body.user.username).toBe(name);
    expect((await me(s.cookie)).user.username).toBe(name);
    const row = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(s.userId).first<{ username: string }>();
    expect(row?.username).toBe(name);
    expect((await api('/api/auth/username', { method: 'PUT', body: { username: uniqueName('Nobody') } })).status).toBe(401);
  });

  it('applies the rules from shared/username.ts', async () => {
    const s = await signup();
    const cases: Array<[string, string]> = [
      ['ab', 'At least 3 characters'],
      ['a'.repeat(21), 'At most 20 characters'],
      ['gerald hamster', 'Letters, numbers and underscores only.'],
      ['gérald', 'Letters, numbers and underscores only.'],
      ['gerald!', 'Letters, numbers and underscores only.'],
    ];
    for (const [username, problem] of cases) {
      const res = await api('/api/auth/username', { method: 'PUT', body: { username }, cookie: s.cookie });
      expect(res.status, username).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('validation');
      expect(error.message, username).toContain(problem);
    }
    expect((await api('/api/auth/username', { method: 'PUT', body: { username: 42 }, cookie: s.cookie })).status).toBe(400);
    expect((await api('/api/auth/username', { method: 'PUT', body: {}, cookie: s.cookie })).status).toBe(400);
    expect((await me(s.cookie)).user.username).toBeNull();
    // Stray spaces are forgiven.
    const name = uniqueName('Gerald');
    const padded = await api('/api/auth/username', { method: 'PUT', body: { username: `  ${name}  ` }, cookie: s.cookie });
    expect(padded.status).toBe(200);
    expect((await userOf(padded)).username).toBe(name);
  });

  it('is unique whatever the case, except against yourself', async () => {
    const name = uniqueName('Gerald');
    const a = await signup({ username: name });
    const b = await signup();
    for (const username of [name, name.toLowerCase(), name.toUpperCase()]) {
      const res = await api('/api/auth/username', { method: 'PUT', body: { username }, cookie: b.cookie });
      expect(res.status, username).toBe(409);
      expect(await errorOf(res)).toEqual({ code: 'conflict', message: 'That name is taken' });
    }
    expect((await me(b.cookie)).user.username).toBeNull();
    // Your own name, in any case, is fine, and the new spelling is kept.
    const own = await api('/api/auth/username', { method: 'PUT', body: { username: name.toUpperCase() }, cookie: a.cookie });
    expect(own.status).toBe(200);
    expect((await me(a.cookie)).user.username).toBe(name.toUpperCase());
    const same = await api('/api/auth/username', { method: 'PUT', body: { username: name.toUpperCase() }, cookie: a.cookie });
    expect(same.status).toBe(200);
  });

  it('checks availability without saving anything', async () => {
    const taken = uniqueName('Hamster');
    const free = uniqueName('Wheel_');
    const a = await signup({ username: taken });
    const b = await signup();
    const check = async (cookie: string, username: string): Promise<UsernameCheck> => {
      const res = await api(`/api/auth/username/check?username=${encodeURIComponent(username)}`, { cookie });
      expect(res.status, username).toBe(200);
      return (await res.json()) as UsernameCheck;
    };
    expect(await check(b.cookie, free)).toEqual({ valid: true, available: true });
    expect(await check(b.cookie, taken.toLowerCase())).toEqual({ valid: true, available: false });
    expect(await check(b.cookie, taken.toUpperCase())).toEqual({ valid: true, available: false });
    expect(await check(a.cookie, taken.toUpperCase())).toEqual({ valid: true, available: true });
    expect(await check(b.cookie, 'no')).toEqual({ valid: false, available: false });
    expect(await check(b.cookie, 'no way')).toEqual({ valid: false, available: false });
    const missing = await api('/api/auth/username/check', { cookie: b.cookie });
    expect(missing.status).toBe(200);
    expect((await missing.json()) as UsernameCheck).toEqual({ valid: false, available: false });
    expect((await api(`/api/auth/username/check?username=${free}`)).status).toBe(401);
    expect((await me(b.cookie)).user.username).toBeNull();
    expect((await me(a.cookie)).user.username).toBe(taken);
  });
});

describe('settings', () => {
  it('turns push for friend news off and on', async () => {
    const s = await signup();
    const socialPush = async () => (await env.DB.prepare('SELECT social_push FROM users WHERE id = ?').bind(s.userId).first<{ social_push: number }>())?.social_push;
    const off = await api('/api/auth/settings', { method: 'PUT', body: { social_push: false }, cookie: s.cookie });
    expect(off.status).toBe(200);
    expect((await userOf(off)).social_push).toBe(false);
    expect(await socialPush()).toBe(0);
    expect((await me(s.cookie)).user.social_push).toBe(false);

    const nothing = await api('/api/auth/settings', { method: 'PUT', body: {}, cookie: s.cookie });
    expect(nothing.status).toBe(200);
    expect((await userOf(nothing)).social_push).toBe(false);
    const bad = await api('/api/auth/settings', { method: 'PUT', body: { social_push: 'yes' }, cookie: s.cookie });
    expect(bad.status).toBe(400);
    expect(await socialPush()).toBe(0);

    const on = await api('/api/auth/settings', { method: 'PUT', body: { social_push: true }, cookie: s.cookie });
    expect(on.status).toBe(200);
    expect((await userOf(on)).social_push).toBe(true);
    expect(await socialPush()).toBe(1);
    expect((await api('/api/auth/settings', { method: 'PUT', body: { social_push: true } })).status).toBe(401);
  });
});

describe('signing out and the phone', () => {
  it('unlinks the device that signed out, and nobody else’s', async () => {
    const a = await signup();
    const b = await signup();
    const phoneA = freshEndpoint();
    const phoneB = freshEndpoint();
    await insertDevice(phoneA, a.userId);
    await insertDevice(phoneB, b.userId);

    // A names B's endpoint: B's phone is left alone.
    const sneaky = await api('/api/auth/logout', { method: 'POST', body: { endpoint: phoneB }, cookie: a.cookie });
    expect(sneaky.status).toBe(204);
    expect(await linkedTo(phoneB)).toBe(b.userId);
    expect(await linkedTo(phoneA)).toBe(a.userId);
    // Nobody signed in: nothing to unlink either.
    const anon = await api('/api/auth/logout', { method: 'POST', body: { endpoint: phoneA } });
    expect(anon.status).toBe(204);
    expect(await linkedTo(phoneA)).toBe(a.userId);
    // B signs out on their phone.
    const out = await api('/api/auth/logout', { method: 'POST', body: { endpoint: phoneB }, cookie: b.cookie });
    expect(out.status).toBe(204);
    expect(await linkedTo(phoneB)).toBeNull();
    expect(await linkedTo(phoneA)).toBe(a.userId);
    expect((await api('/api/auth/me', { cookie: b.cookie })).status).toBe(401);
  });

  it('still signs out when the endpoint is not one', async () => {
    const a = await signup();
    const phone = freshEndpoint();
    await insertDevice(phone, a.userId);
    const res = await api('/api/auth/logout', { method: 'POST', body: { endpoint: 'not a url' }, cookie: a.cookie });
    expect(res.status).toBe(204);
    expect((await api('/api/auth/me', { cookie: a.cookie })).status).toBe(401);
    expect(await linkedTo(phone)).toBe(a.userId);
  });
});

describe('deleting the account', () => {
  it('needs the email typed right, then takes everything with it but the phone', async () => {
    const leaving = uniqueName('Leaving');
    const staying = uniqueName('Staying');
    const s = await signup({ username: leaving });
    const friend = await signup({ username: staying });
    const phone = freshEndpoint();
    const sent = crypto.randomUUID();
    const now = Date.now();
    await insertDevice(phone, s.userId);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO daily_totals (user_id, day, ml, goal_ml, updated_at) VALUES (?, ?, 1500, 2000, ?)').bind(s.userId, '2026-10-05', now),
      env.DB.prepare("INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, 'accepted', ?, ?)").bind(s.userId, friend.userId, now, now),
      env.DB.prepare("INSERT INTO notifications (id, user_id, kind, actor_id, ref, created_at, read_at) VALUES (?, ?, 'friend_accepted', ?, NULL, ?, NULL)").bind(crypto.randomUUID(), s.userId, friend.userId, now),
      env.DB.prepare("INSERT INTO notifications (id, user_id, kind, actor_id, ref, created_at, read_at) VALUES (?, ?, 'friend_request', ?, NULL, ?, NULL)").bind(sent, friend.userId, s.userId, now),
    ]);
    expect(await count('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?', s.userId)).toBe(1);

    const wrong = await api('/api/auth/account', { method: 'DELETE', body: { email: 'someone@else.example' }, cookie: s.cookie });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).code).toBe('validation');
    const missing = await api('/api/auth/account', { method: 'DELETE', body: {}, cookie: s.cookie });
    expect(missing.status).toBe(400);
    const notJson = await api('/api/auth/account', { method: 'DELETE', raw: 'email=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cookie: s.cookie });
    expect(notJson.status).toBe(400);
    expect((await api('/api/auth/account', { method: 'DELETE', body: { email: s.email } })).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', s.userId)).toBe(1);

    const res = await api('/api/auth/account', { method: 'DELETE', body: { email: ` ${s.email.toUpperCase()} ` }, cookie: s.cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/sipster_session=;/);
    for (const [table, column] of [
      ['users', 'id'],
      ['sessions', 'user_id'],
      ['login_codes', 'user_id'],
      ['daily_totals', 'user_id'],
      ['notifications', 'user_id'],
    ]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, s.userId), table).toBe(0);
    }
    expect(await count('SELECT COUNT(*) AS n FROM friendships WHERE requester_id = ? OR addressee_id = ?', s.userId, s.userId)).toBe(0);
    // The request they once sent the friend goes too (actor cascade); the friend keeps everything else.
    expect(await count('SELECT COUNT(*) AS n FROM notifications WHERE id = ?', sent)).toBe(0);
    expect((await me(friend.cookie)).user.username).toBe(staying);
    // The phone keeps its nudges, linked to nobody.
    expect(await linkedTo(phone)).toBeNull();
    expect((await api('/api/auth/me', { cookie: s.cookie })).status).toBe(401);
    // The name is free again.
    const next = await signup();
    expect((await api('/api/auth/username', { method: 'PUT', body: { username: leaving.toLowerCase() }, cookie: next.cookie })).status).toBe(200);
  });
});
