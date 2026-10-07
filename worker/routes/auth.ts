// Sign in with Google, sessions, the one-time claim code, username, settings and account deletion.
// docs/SOCIAL.md §4 "Account" is the contract and §5 the flow; ported from Tally.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Me, SignInError, User, UsernameCheck } from '../../shared/api';
import { isValidUsername, usernameProblem } from '../../shared/username';
import type { AppEnv, Env, SessionUser } from '../env';
import {
  clearSessionCookie,
  constantTimeEqualString,
  createSession,
  deleteSession,
  getSessionToken,
  LOGIN_CODE_SECONDS,
  nowMs,
  OAUTH_COOKIE,
  OAUTH_COOKIE_SECONDS,
  randomToken,
  requireUser,
  resolveSession,
  setSessionCookie,
  sha256Hex,
  toSessionUser,
  uuid,
  type UserRow,
} from '../lib/auth';
import { authorizeUrl, exchangeCode, googleClient, identityFromIdToken, pkceChallenge, type GoogleIdentity } from '../lib/google';
import { ApiError, optionalBool, readJson, stringField, validation, type JsonObject } from '../lib/http';
import { checkEndpoint, deviceId } from '../push';

export const authRoutes = new Hono<AppEnv>();

const CALLBACK_PATH = '/api/auth/google/callback';
/** The pending-sign-in cookie is only ever sent back to the callback. */
const OAUTH_COOKIE_PATH = '/api/auth/google';
/** Where the browser lands after Google: the account page claims the code or explains the error. */
const ACCOUNT_PAGE = '/#/account';
/** Session tokens and claim codes are 32 random bytes as base64url (`randomToken`). */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

/** What the browser keeps between leaving for Google and coming back, as `state.nonce.verifier`. */
interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
}

const encodePending = (p: PendingSignIn): string => [p.state, p.nonce, p.verifier].join('.');

function decodePending(raw: string | undefined): PendingSignIn | null {
  const [state, nonce, verifier, ...rest] = raw?.split('.') ?? [];
  if (!state || !nonce || !verifier || rest.length) return null;
  return { state, nonce, verifier };
}

const isHttps = (c: Context<AppEnv>): boolean => new URL(c.req.url).protocol === 'https:';
const callbackUri = (c: Context<AppEnv>): string => new URL(CALLBACK_PATH, c.req.url).toString();
const notConfigured = () => new ApiError('internal', 'Sign in with Google is not set up on this server');
const linkExpired = () => new ApiError('unauthorized', 'This sign-in link has expired');
/** D1 reports constraint failures in the message, e.g. "D1_ERROR: UNIQUE constraint failed: users.username". */
const isUniqueViolation = (err: unknown): boolean => String(err).includes('UNIQUE');
/** Back to the account page, which explains the code. */
const signInFailed = (c: Context<AppEnv>, error: SignInError) => c.redirect(`${ACCOUNT_PAGE}?error=${error}`, 302);

/** The API shape of a user: exactly the fields in shared/api.ts, `social_push` as a boolean. */
const toUser = (u: SessionUser): User => ({ id: u.id, email: u.email, username: u.username, social_push: u.social_push, created_at: u.created_at });

/** `Me`: the user plus how many notifications they have not read (the badge on the home screen). */
async function meOf(env: Env, user: SessionUser): Promise<Me> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id).first<{ n: number }>();
  return { user: toUser(user), unread: row?.n ?? 0 };
}

async function loadUser(env: Env, id: string): Promise<SessionUser | null> {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  return row ? toSessionUser(row) : null;
}

// ---- Sign in with Google ------------------------------------------------------

// Step 1: remember state, nonce and PKCE verifier in a short-lived cookie, send the browser to Google.
authRoutes.get('/google/start', async (c) => {
  const client = googleClient(c.env);
  if (!client) throw notConfigured();
  const pending: PendingSignIn = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
  setCookie(c, OAUTH_COOKIE, encodePending(pending), {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_SECONDS,
  });
  const url = authorizeUrl(client, {
    redirectUri: callbackUri(c),
    state: pending.state,
    nonce: pending.nonce,
    codeChallenge: await pkceChallenge(pending.verifier),
  });
  return c.redirect(url, 302);
});

// Step 2: Google sent the browser back. Check the state, swap the code, read the identity, sign in,
// then send the browser to the account page with a one-time code: on an iPhone home-screen app the
// sheet that talked to Google has its own cookies, so the app claims the code instead (§5).
authRoutes.get('/google/callback', async (c) => {
  const client = googleClient(c.env);
  if (!client) throw notConfigured();
  const pending = decodePending(getCookie(c, OAUTH_COOKIE));
  deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH, secure: isHttps(c), httpOnly: true, sameSite: 'Lax' });
  // `error=access_denied`: the person backed out of Google's account chooser.
  if (c.req.query('error')) return signInFailed(c, 'cancelled');
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!pending || !code || !state || !constantTimeEqualString(state, pending.state)) return signInFailed(c, 'failed');
  const idToken = await exchangeCode(client, { code, redirectUri: callbackUri(c), codeVerifier: pending.verifier });
  const identity = idToken ? identityFromIdToken(idToken, { clientId: client.clientId, nonce: pending.nonce }) : null;
  if (!identity) return signInFailed(c, 'failed');
  const found = await findOrCreateUser(c.env, identity);
  if ('error' in found) return signInFailed(c, found.error);
  // Signing in over an existing session replaces it.
  const previous = getSessionToken(c);
  if (previous) await deleteSession(c.env, previous);
  const session = await createSession(c.env, found.user.id, c.req.header('user-agent') ?? null);
  setSessionCookie(c, session.token, session.expiresAt);
  const claim = await mintLoginCode(c.env, found.user.id);
  return c.redirect(`${ACCOUNT_PAGE}?claim=${claim}`, 302);
});

type Found = { user: SessionUser } | { error: SignInError };

/** The account for this Google identity, created nameless on the first sign-in unless sign-ups are closed. */
async function findOrCreateUser(env: Env, who: GoogleIdentity): Promise<Found> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(who.sub).first<UserRow>();
  if (existing) return { user: await followEmail(env, existing, who.email) };
  if ((env.SIGNUPS_ENABLED ?? 'true').toLowerCase() === 'false') return { error: 'signups_disabled' };
  const now = nowMs();
  const id = uuid();
  try {
    await env.DB.prepare('INSERT INTO users (id, google_sub, email, username, social_push, created_at) VALUES (?, ?, ?, NULL, 1, ?)')
      .bind(id, who.sub, who.email, now)
      .run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Two first sign-ins racing: the other one made the account, use it. The only other way here is
    // an address that already belongs to a different Google account; that sign-in fails rather than
    // handing over someone else's account.
    const made = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(who.sub).first<UserRow>();
    if (!made) {
      console.error('Sign-in refused: the address belongs to another account');
      return { error: 'failed' };
    }
    return { user: toSessionUser(made) };
  }
  return { user: { id, email: who.email, username: null, social_push: true, created_at: now } };
}

/** The address on the Google account changed: follow it, unless another account already has it. */
async function followEmail(env: Env, row: UserRow, email: string): Promise<SessionUser> {
  if (row.email === email) return toSessionUser(row);
  const moved = await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
    .bind(email, row.id)
    .run()
    .then(
      () => true,
      (err: unknown) => {
        if (!isUniqueViolation(err)) throw err;
        return false;
      },
    );
  return toSessionUser({ ...row, email: moved ? email : row.email });
}

/**
 * A one-time code for `POST /claim`, stored hashed like a session token and good for two minutes. It
 * travels in the URL fragment, so it never reaches a server log.
 */
async function mintLoginCode(env: Env, userId: string): Promise<string> {
  const code = randomToken();
  await env.DB.prepare('INSERT INTO login_codes (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(code), userId, nowMs() + LOGIN_CODE_SECONDS * 1000)
    .run();
  return code;
}

// Step 3: the account page hands the code back; it is good once. A browser that already holds a
// session for this person keeps it; any other session on the request is replaced.
authRoutes.post('/claim', async (c) => {
  const body = await readJson(c);
  const code = body.code;
  if (typeof code !== 'string') throw validation('code: expected a string');
  if (!TOKEN_RE.test(code)) throw linkExpired();
  // Deleting and reading in one statement makes the code single-use even for two claims at once.
  const row = await c.env.DB.prepare('DELETE FROM login_codes WHERE id = ? RETURNING user_id, expires_at')
    .bind(await sha256Hex(code))
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at <= nowMs()) throw linkExpired();

  const token = getSessionToken(c);
  const current = token ? await resolveSession(c.env, token) : null;
  if (token && current && current.user.id === row.user_id) {
    // The callback's cookie worked: nothing to do but answer.
    if (current.renewedExpiresAt) setSessionCookie(c, token, current.renewedExpiresAt);
    return c.json(await meOf(c.env, current.user));
  }
  const user = await loadUser(c.env, row.user_id);
  if (!user) throw linkExpired();
  if (token) await deleteSession(c.env, token);
  const session = await createSession(c.env, user.id, c.req.header('user-agent') ?? null);
  setSessionCookie(c, session.token, session.expiresAt);
  return c.json(await meOf(c.env, user));
});

// ---- Session ------------------------------------------------------------------

authRoutes.get('/me', requireUser, async (c) => c.json(await meOf(c.env, c.var.user)));

// Signing out works with or without a session, and with or without a body: the person wants out.
authRoutes.post('/logout', async (c) => {
  const body = await readOptionalJson(c);
  const token = getSessionToken(c);
  const userId = token ? await sessionOwner(c.env, token) : null;
  if (token) await deleteSession(c.env, token);
  clearSessionCookie(c);
  // This phone stops getting the account's social pushes; its nudges keep coming.
  const endpoint = userId ? pushEndpoint(body.endpoint, c.env) : null;
  if (userId && endpoint) {
    await c.env.DB.prepare('UPDATE devices SET user_id = NULL WHERE id = ? AND user_id = ?').bind(await deviceId(endpoint), userId).run();
  }
  return c.body(null, 204);
});

/** Logout's body is optional: no body, no content type or a body that is not a JSON object all mean `{}`. */
async function readOptionalJson(c: Context<AppEnv>): Promise<JsonObject> {
  try {
    return await readJson(c);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) return {};
    throw err;
  }
}

/** Who a session cookie belongs to while it is still good. Unlike `resolveSession` it renews nothing: the session is about to go. */
async function sessionOwner(env: Env, token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
    .bind(await sha256Hex(token))
    .first<{ user_id: string; expires_at: number }>();
  return row && row.expires_at > nowMs() ? row.user_id : null;
}

/** The push endpoint in a logout body, or null when there is none or it is not one (signing out still goes through). */
function pushEndpoint(raw: unknown, env: Env): string | null {
  if (typeof raw !== 'string') return null;
  try {
    return checkEndpoint(raw, env);
  } catch {
    return null;
  }
}

// ---- Username and settings ----------------------------------------------------

authRoutes.put('/username', requireUser, async (c) => {
  const body = await readJson(c);
  const raw = body.username;
  if (typeof raw !== 'string') throw validation('username: expected a string');
  const username = raw.trim();
  if (!isValidUsername(username)) throw validation(usernameProblem(username) ?? 'That name won’t do');
  try {
    // The column is UNIQUE COLLATE NOCASE, so the database is the one judge of "taken". Changing the
    // case of your own name only collides with yourself, which is no collision.
    await c.env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, c.var.user.id).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new ApiError('conflict', 'That name is taken');
  }
  return c.json({ user: toUser({ ...c.var.user, username }) });
});

authRoutes.get('/username/check', requireUser, async (c) => {
  const username = (c.req.query('username') ?? '').trim();
  const valid = isValidUsername(username);
  let available = false;
  if (valid) {
    const owner = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first<{ id: string }>();
    available = !owner || owner.id === c.var.user.id;
  }
  const body: UsernameCheck = { valid, available };
  return c.json(body);
});

authRoutes.put('/settings', requireUser, async (c) => {
  const body = await readJson(c);
  const socialPush = optionalBool(body, 'social_push');
  let user = c.var.user;
  if (socialPush !== undefined) {
    await c.env.DB.prepare('UPDATE users SET social_push = ? WHERE id = ?').bind(socialPush ? 1 : 0, user.id).run();
    user = { ...user, social_push: socialPush };
  }
  return c.json({ user: toUser(user) });
});

// ---- Account ------------------------------------------------------------------

authRoutes.delete('/account', requireUser, async (c) => {
  const body = await readJson(c);
  // Typed again as confirmation (the app keeps the button disabled until it matches).
  const email = stringField(body, 'email');
  if (email.toLowerCase() !== c.var.user.email.toLowerCase()) throw validation('That is not this account’s email');
  // Foreign keys cascade: sessions, claim codes, totals, friendships, notifications. Devices stay and are unlinked.
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.var.user.id).run();
  clearSessionCookie(c);
  return c.body(null, 204);
});
