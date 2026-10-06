import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { sha256Hex } from '../../worker/lib/auth';

const ORIGIN = 'https://sipster.test';
const schedule = { intervalMin: 60, startMin: 480, endMin: 1320, tz: 'Europe/Zurich', smart: true };

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  return SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** A subscription as a browser would hand it over: an uncompressed P-256 point and a 16-byte secret. */
async function subscription(endpoint: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { endpoint, keys: { p256dh, auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

let n = 0;
/** A signed-in person, made directly in D1 (the sign-in routes have their own tests). */
async function signedIn(): Promise<{ id: string; cookie: string }> {
  n += 1;
  const id = `u-${n}-${Date.now()}`;
  const token = `tok-${n}-${'x'.repeat(40)}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, `sub-${id}`, `${id}@example.com`, `user_${n}`, now),
    env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256Hex(token), id, now, now + 86_400_000),
  ]);
  return { id, cookie: `sipster_session=${token}` };
}

const linkedTo = async (endpoint: string) =>
  (await env.DB.prepare('SELECT user_id FROM devices WHERE endpoint = ?').bind(endpoint).first<{ user_id: string | null }>())?.user_id;

describe('devices and accounts', () => {
  it('subscribes without an account, as before', async () => {
    const sub = await subscription('https://push.example/anon');
    const res = await post('/api/subscribe', { subscription: sub, schedule, state: {} });
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { nextAt: number }).nextAt).toBe('number');
    expect(await linkedTo(sub.endpoint)).toBeNull();
  });

  it('links the phone to the account that is signed in when it subscribes or syncs, and unlinks when nobody is', async () => {
    const me = await signedIn();
    const sub = await subscription('https://push.example/mine');
    expect((await post('/api/subscribe', { subscription: sub, schedule, state: {} }, me.cookie)).status).toBe(200);
    expect(await linkedTo(sub.endpoint)).toBe(me.id);

    // Signed out (no cookie): the next sync drops the link.
    expect((await post('/api/sync', { endpoint: sub.endpoint, state: {} })).status).toBe(200);
    expect(await linkedTo(sub.endpoint)).toBeNull();

    // Another account on the same phone takes the device over.
    const other = await signedIn();
    expect((await post('/api/sync', { endpoint: sub.endpoint, state: {} }, other.cookie)).status).toBe(200);
    expect(await linkedTo(sub.endpoint)).toBe(other.id);
  });

  it('ignores a stale session cookie instead of failing the sync', async () => {
    const sub = await subscription('https://push.example/stale');
    expect((await post('/api/subscribe', { subscription: sub, schedule, state: {} })).status).toBe(200);
    const res = await post('/api/sync', { endpoint: sub.endpoint, state: {} }, `sipster_session=${'y'.repeat(43)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/sipster_session=;/);
    expect(await linkedTo(sub.endpoint)).toBeNull();
  });

  it('answers the new error shape', async () => {
    const res = await post('/api/sync', { endpoint: 'https://push.example/unknown', state: {} });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Unknown device' } });
    const junk = await post('/api/subscribe', { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'x', auth: 'y' } }, schedule });
    expect(junk.status).toBe(400);
    expect(((await junk.json()) as { error: { code: string } }).error.code).toBe('validation');
  });
});
