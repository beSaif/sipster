/**
 * Sessions: opaque tokens stored hashed in D1, an HttpOnly cookie, the `requireUser` / `optionalUser`
 * middleware and the same-origin guard. Who the person is comes from Google (lib/google.ts,
 * routes/auth.ts). Ported from Tally.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, SessionUser } from '../env';
import { ApiError, unauthorized } from './http';

export const SESSION_COOKIE = 'sipster_session';
export const SESSION_DAYS = 30;
export const SESSION_RENEW_BELOW_DAYS = 15;
/** Keeps state, nonce and PKCE verifier between leaving for Google and coming back. */
export const OAUTH_COOKIE = 'sipster_oauth';
export const OAUTH_COOKIE_SECONDS = 10 * 60;
/** How long the one-time code in the post-sign-in redirect stays good. */
export const LOGIN_CODE_SECONDS = 2 * 60;

const enc = new TextEncoder();
const DAY_MS = 86_400_000;

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const b64url = (buf: ArrayBuffer | Uint8Array): string => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `bytes` random bytes as base64url: session tokens, login codes, OAuth state and nonce, the PKCE verifier. */
export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function constantTimeEqualString(a: string, b: string): boolean {
  return constantTimeEqual(enc.encode(a), enc.encode(b));
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const nowMs = (): number => Date.now();
export const uuid = (): string => crypto.randomUUID();

/** A `users` row as stored. */
export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  username: string | null;
  social_push: number;
  created_at: number;
}

export const toSessionUser = (r: Pick<UserRow, 'id' | 'email' | 'username' | 'social_push' | 'created_at'>): SessionUser => ({
  id: r.id,
  email: r.email,
  username: r.username,
  social_push: r.social_push === 1,
  created_at: r.created_at,
});

export interface SessionInfo {
  token: string;
  expiresAt: number;
}

export async function createSession(env: Env, userId: string, userAgent: string | null): Promise<SessionInfo> {
  const token = randomToken();
  const id = await sha256Hex(token);
  const now = nowMs();
  const expiresAt = now + SESSION_DAYS * DAY_MS;
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, now, expiresAt, userAgent)
    .run();
  return { token, expiresAt };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  const id = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

interface SessionJoinRow {
  expires_at: number;
  id: string;
  email: string;
  username: string | null;
  social_push: number;
  created_at: number;
}

/**
 * Resolves a cookie token to its user. Expired sessions are deleted. Sessions with fewer than
 * SESSION_RENEW_BELOW_DAYS left are extended (sliding expiry); the new expiry is returned so the
 * caller can refresh the cookie. A renewal costs a D1 write and a Set-Cookie, so it only happens
 * when it buys at least a day: at most one write per session and day.
 */
export async function resolveSession(env: Env, token: string): Promise<{ user: SessionUser; renewedExpiresAt: number | null } | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.id, u.email, u.username, u.social_push, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<SessionJoinRow>();
  if (!row) return null;
  const now = nowMs();
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  let renewedExpiresAt: number | null = null;
  const renewal = now + SESSION_DAYS * DAY_MS;
  if (row.expires_at - now < SESSION_RENEW_BELOW_DAYS * DAY_MS && renewal - row.expires_at >= DAY_MS) {
    renewedExpiresAt = renewal;
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(renewedExpiresAt, id).run();
  }
  return { user: toSessionUser(row), renewedExpiresAt };
}

const isHttps = (c: Context<AppEnv>): boolean => new URL(c.req.url).protocol === 'https:';

export function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c), httpOnly: true, sameSite: 'Lax' });
}

export function getSessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/** Puts `c.var.user` in place or answers 401. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getSessionToken(c);
  if (!token) throw unauthorized();
  const resolved = await resolveSession(c.env, token);
  if (!resolved) {
    clearSessionCookie(c);
    throw unauthorized();
  }
  c.set('user', resolved.user);
  c.set('sessionToken', token);
  if (resolved.renewedExpiresAt) setSessionCookie(c, token, resolved.renewedExpiresAt);
  await next();
};

/** Like `requireUser`, but a missing or stale session just means nobody is signed in. */
export const optionalUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getSessionToken(c);
  if (token) {
    const resolved = await resolveSession(c.env, token);
    if (resolved) {
      c.set('user', resolved.user);
      c.set('sessionToken', token);
      if (resolved.renewedExpiresAt) setSessionCookie(c, token, resolved.renewedExpiresAt);
    } else {
      clearSessionCookie(c);
    }
  }
  await next();
};

/** The signed-in user behind `optionalUser`, or null. */
export const currentUser = (c: Context<AppEnv>): SessionUser | null => (c.get('user') as SessionUser | undefined) ?? null;

/** Routes that need a chosen username (friends, leaderboard): 403 until the person picked one. */
export const requireUsername: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.user.username) throw new ApiError('forbidden', 'Pick a username first');
  await next();
};

/**
 * CSRF guard for mutating requests: when the browser sends an Origin it must match ours.
 * (Cookies are SameSite=Lax as well; this is belt and braces.)
 */
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') {
      const ours = new URL(c.req.url).origin;
      if (origin !== ours) throw new ApiError('forbidden', 'Cross-origin request refused');
    }
  }
  await next();
};
