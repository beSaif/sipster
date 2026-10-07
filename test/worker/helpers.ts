// Helpers for the Worker suites: a fetch against the Worker, the Google sign-in flow against a
// stand-in token endpoint, and shortcuts for the things most tests start with (an account, a username).
// Ported from Tally.
import { vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { Me, User } from '../../shared/api';

export const ORIGIN = 'https://sipster.test';
/** Must match TEST_GOOGLE in vitest.config.ts. */
export const GOOGLE_CLIENT_ID = 'sipster-test-client';
export const GOOGLE_CLIENT_SECRET = 'sipster-test-secret';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SESSION_COOKIE = 'sipster_session';
export const OAUTH_COOKIE = 'sipster_oauth';

export interface Session {
  cookie: string;
  userId: string;
  email: string;
  /** The Google account id this session signed in with. */
  sub: string;
  /** The one-time code from the callback's redirect (`/#/account?claim=…`), not yet claimed. */
  claimCode: string;
}

/** Fetch against the Worker with JSON body and (optionally) cookies. Redirects are returned, not followed. */
export async function api(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: BodyInit } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Origin: ORIGIN, ...(init.headers ?? {}) };
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  if (init.cookie) headers['Cookie'] = init.cookie;
  return SELF.fetch(`${ORIGIN}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
}

/** One cookie a response sets, as `name=value` (the session cookie by default). */
export function cookieOf(res: Response, name = SESSION_COOKIE): string {
  const set = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${name}=([^;]+)`).exec(set);
  if (!m) throw new Error(`no ${name} cookie in: ${set}`);
  return `${name}=${m[1]}`;
}

/** sha256 as hex: how the Worker stores session tokens, claim codes and device ids. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `SELECT COUNT(*) AS n …` → n, or -1 when the query gave no row. */
export async function count(sql: string, ...args: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? -1;
}

const b64url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** An ID token as Google mints it, minus a real signature: the Worker trusts the channel, not the signature. */
export function idToken(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'test', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('signature')}`;
}

export interface ClaimOptions {
  sub: string;
  email: string;
  nonce: string;
}

/** The claims of a good token for this sign-in. */
export function claimsFor(o: ClaimOptions): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: o.sub, email: o.email, email_verified: true, nonce: o.nonce, iat: now, exp: now + 3600 };
}

export interface Started {
  location: URL;
  /** The pending-sign-in cookie, as the browser would send it back. */
  cookie: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Step 1 of a sign-in: where the Worker sends the browser, and the cookie it hands it. */
export async function startSignIn(init: { cookie?: string } = {}): Promise<Started> {
  const res = await api('/api/auth/google/start', { cookie: init.cookie });
  if (res.status !== 302) throw new Error(`start: ${res.status} ${await res.text()}`);
  const location = new URL(res.headers.get('location') ?? '');
  const q = location.searchParams;
  return { location, cookie: cookieOf(res, OAUTH_COOKIE), state: q.get('state') ?? '', nonce: q.get('nonce') ?? '', codeChallenge: q.get('code_challenge') ?? '' };
}

export interface TokenAnswer {
  status?: number;
  body: unknown;
}
export interface TokenEndpoint {
  /** What the Worker posted, one entry per exchange. */
  calls: URLSearchParams[];
  restore(): void;
}

/** Stands in for Google's token endpoint, the Worker's only outbound call during a sign-in, until restored. */
export function mockTokenEndpoint(answer: (sent: URLSearchParams) => TokenAnswer): TokenEndpoint {
  const calls: URLSearchParams[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch during sign-in: ${url}`);
    const sent = new URLSearchParams(String(init?.body ?? ''));
    calls.push(sent);
    const a = answer(sent);
    return Response.json(a.body, { status: a.status ?? 200 });
  });
  return { calls, restore: () => spy.mockRestore() };
}

/** Step 2: the browser comes back from Google. `cookies` is what it holds (the pending cookie, maybe a session). */
export function finishSignIn(params: Record<string, string>, cookies: string): Promise<Response> {
  return api(`/api/auth/google/callback?${new URLSearchParams(params).toString()}`, { cookie: cookies || undefined });
}

/** The one-time code in a callback's redirect (`/#/account?claim=<code>`), or null for any other answer. */
export function claimCodeOf(res: Response): string | null {
  const m = /^\/#\/account\?claim=([A-Za-z0-9_-]+)$/.exec(res.headers.get('location') ?? '');
  return m?.[1] ?? null;
}

let counter = 0;
/** A Google account nobody has signed in with yet. */
export function freshIdentity(tag = 'user'): { sub: string; email: string } {
  counter += 1;
  return { sub: `sub-${tag}-${counter}-${Date.now()}`, email: `${tag}${counter}-${Date.now()}@example.com` };
}

/**
 * Signs in through the whole flow against a stand-in token endpoint. A brand-new Google account by
 * default, so this creates the Sipster account too, which is what most tests want. The claim code
 * is returned unclaimed; pass `username` to pick one right away.
 */
export async function signup(opts: { email?: string; sub?: string; cookie?: string; username?: string } = {}): Promise<Session> {
  const fresh = freshIdentity();
  const sub = opts.sub ?? fresh.sub;
  const email = opts.email ?? fresh.email;
  const start = await startSignIn({ cookie: opts.cookie });
  const google = mockTokenEndpoint(() => ({
    body: { id_token: idToken(claimsFor({ sub, email, nonce: start.nonce })), access_token: 'x', token_type: 'Bearer', expires_in: 3600 },
  }));
  let session: Session;
  try {
    const res = await finishSignIn({ code: `code-${counter}`, state: start.state }, [start.cookie, opts.cookie].filter(Boolean).join('; '));
    const claimCode = res.status === 302 ? claimCodeOf(res) : null;
    if (!claimCode) throw new Error(`sign-in failed: ${res.status} → ${res.headers.get('location')} ${await res.text()}`);
    const cookie = cookieOf(res);
    session = { cookie, userId: (await me(cookie)).user.id, email, sub, claimCode };
  } finally {
    google.restore();
  }
  if (opts.username) await setUsername(session.cookie, opts.username);
  return session;
}

/** `POST /api/auth/claim` with the code, from a browser holding `cookie` (none by default). */
export function claim(code: string, cookie?: string): Promise<Response> {
  return api('/api/auth/claim', { body: { code }, cookie });
}

/** `GET /api/auth/me` for a session that must be good. */
export async function me(cookie: string): Promise<Me> {
  const res = await api('/api/auth/me', { cookie });
  if (res.status !== 200) throw new Error(`me: ${res.status} ${await res.text()}`);
  return (await res.json()) as Me;
}

/** `PUT /api/auth/username`, which must succeed. */
export async function setUsername(cookie: string, username: string): Promise<User> {
  const res = await api('/api/auth/username', { method: 'PUT', body: { username }, cookie });
  if (res.status !== 200) throw new Error(`username ${username}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { user: User }).user;
}
