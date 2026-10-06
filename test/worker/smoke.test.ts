import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const ORIGIN = 'https://sipster.test';

describe('worker shell', () => {
  it('answers health and never caches the API', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'sipster' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 404 JSON for unknown API paths and 401 without a session', async () => {
    const missing = await SELF.fetch(`${ORIGIN}/api/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found');
    const me = await SELF.fetch(`${ORIGIN}/api/auth/me`);
    expect(me.status).toBe(401);
  });

  it('refuses cross-origin mutations', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x' }),
    });
    expect(res.status).toBe(403);
  });

  it('has the account schema', async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = tables.results.map((t) => t.name).filter((n) => !n.startsWith('_') && !n.startsWith('d1_') && !n.startsWith('sqlite_'));
    expect(names).toEqual(['daily_totals', 'devices', 'friendships', 'login_codes', 'notifications', 'sessions', 'users']);
  });
});
