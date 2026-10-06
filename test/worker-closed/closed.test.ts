import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { api, claimCodeOf, claimsFor, cookieOf, count, finishSignIn, freshIdentity, idToken, mockTokenEndpoint, startSignIn } from '../worker/helpers';

describe('sign-in with SIGNUPS_ENABLED=false', () => {
  it('turns new Google accounts away but lets existing ones in', async () => {
    const stranger = freshIdentity('stranger');
    const first = await startSignIn();
    const refused = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ ...stranger, nonce: first.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: first.state }, first.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/#/account?error=signups_disabled');
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sipster_session=/);
    } finally {
      refused.restore();
    }
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE google_sub = ? OR email = ?', stranger.sub, stranger.email)).toBe(0);

    // An account made while sign-ups were open still signs in.
    const member = freshIdentity('member');
    await env.DB.prepare('INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), member.sub, member.email, Date.now()).run();
    const second = await startSignIn();
    const welcomed = mockTokenEndpoint(() => ({ body: { id_token: idToken(claimsFor({ ...member, nonce: second.nonce })) } }));
    try {
      const res = await finishSignIn({ code: 'c', state: second.state }, second.cookie);
      expect(claimCodeOf(res)).toMatch(/^[\w-]{43}$/);
      expect((await api('/api/auth/me', { cookie: cookieOf(res) })).status).toBe(200);
    } finally {
      welcomed.restore();
    }
  });
});
