/**
 * Sign in with Google: OpenID Connect, authorization-code flow with PKCE, run by the Worker so the
 * page loads no Google script. The Worker sends the browser to Google (`authorizeUrl`), Google sends
 * it back with a code, the Worker swaps the code for an ID token (`exchangeCode`) and reads who the
 * person is from its claims (`identityFromIdToken`). Ported from Tally.
 *
 * The ID token's signature is not checked: the token arrives straight from Google's token endpoint
 * over TLS, in exchange for the client secret, which is the case where Google's sign-in guide and
 * OpenID Connect Core §3.1.3.7 let the channel vouch for it. Every claim is still validated.
 */
import type { Env } from '../env';
import { b64url } from './auth';

const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS: ReadonlySet<string> = new Set(['https://accounts.google.com', 'accounts.google.com']);
const enc = new TextEncoder();

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
}

/** The configured client, or null when the secrets are missing (sign-in is then unavailable). */
export function googleClient(env: Env): GoogleClient | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    authUrl: env.GOOGLE_AUTH_URL || DEFAULT_AUTH_URL,
    tokenUrl: env.GOOGLE_TOKEN_URL || DEFAULT_TOKEN_URL,
  };
}

/** PKCE: S256 challenge for a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Where to send the browser. Only the OpenID scopes: Sipster learns the account id and the email. */
export function authorizeUrl(client: GoogleClient, p: AuthorizeParams): string {
  const url = new URL(client.authUrl);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** Swaps the authorization code for Google's ID token; null when Google refuses or is unreachable. */
export async function exchangeCode(client: GoogleClient, p: { code: string; redirectUri: string; codeVerifier: string }): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  });
  let res: Response;
  try {
    res = await fetch(client.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (err) {
    console.error('Google token endpoint unreachable', err);
    return null;
  }
  if (!res.ok) {
    console.error('Google token endpoint answered', res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  return typeof data?.id_token === 'string' ? data.id_token : null;
}

export interface GoogleIdentity {
  /** Google's stable id for the account (the `sub` claim). */
  sub: string;
  /** The account's verified address, lower-cased. */
  email: string;
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

function decodeClaims(idToken: string): IdTokenClaims | null {
  const parts = idToken.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === 'object' ? (claims as IdTokenClaims) : null;
  } catch {
    return null;
  }
}

/**
 * Who signed in, provided the token is Google's, meant for this client, not expired, bound to this
 * sign-in (nonce) and names a verified address. Anything else is nobody.
 */
export function identityFromIdToken(idToken: string, expected: { clientId: string; nonce: string; now?: number }): GoogleIdentity | null {
  const c = decodeClaims(idToken);
  if (!c) return null;
  if (typeof c.iss !== 'string' || !ISSUERS.has(c.iss)) return null;
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!audiences.includes(expected.clientId)) return null;
  if (typeof c.exp !== 'number' || c.exp * 1000 <= (expected.now ?? Date.now())) return null;
  if (typeof c.nonce !== 'string' || c.nonce !== expected.nonce) return null;
  if (typeof c.sub !== 'string' || !c.sub) return null;
  if (typeof c.email !== 'string' || !c.email.trim() || c.email_verified !== true) return null;
  return { sub: c.sub, email: c.email.trim().toLowerCase() };
}
