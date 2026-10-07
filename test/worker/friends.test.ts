import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { FriendRequestResponse, FriendsResponse } from '../../shared/api';
import { MAX_FAILS } from '../../worker/push';
import { MAX_PENDING_OUTGOING } from '../../worker/routes/friends';
import {
  addDevice,
  api,
  befriend,
  decryptPush,
  deviceRow,
  errorCode,
  friendshipRows,
  makeUser,
  mockPush,
  resetDb,
  socialPush,
  storedNotifications,
  type TestUser,
} from './social-helpers';

beforeEach(resetDb);
afterAll(resetDb);

afterEach(() => {
  vi.restoreAllMocks();
});

async function request(from: TestUser, username: string): Promise<{ status: number; body: FriendRequestResponse }> {
  const res = await api('/api/friends/request', { cookie: from.cookie, body: { username } });
  return { status: res.status, body: (await res.json()) as FriendRequestResponse };
}

async function friendsOf(user: TestUser): Promise<FriendsResponse> {
  const res = await api('/api/friends', { cookie: user.cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as FriendsResponse;
}

const ENDPOINTS: Array<[method: string, path: string, body: unknown]> = [
  ['GET', '/api/friends', undefined],
  ['POST', '/api/friends/request', { username: 'someone' }],
  ['POST', '/api/friends/accept', { user_id: 'x' }],
  ['POST', '/api/friends/decline', { user_id: 'x' }],
  ['DELETE', '/api/friends/x', undefined],
];

describe('friends', () => {
  it('need a session', async () => {
    for (const [method, path, body] of ENDPOINTS) {
      const res = await api(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
  });

  it('need a username', async () => {
    const nameless = await makeUser({ username: null });
    await makeUser({ username: 'someone' });
    for (const [method, path, body] of ENDPOINTS) {
      const res = await api(path, { method, body, cookie: nameless.cookie });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    }
    expect(await friendshipRows(nameless)).toEqual([]);
  });

  it('makes a pending request and tells the other side', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'Bob' });
    const before = Date.now();

    // Names are matched regardless of case; the answer carries the name as its owner spells it.
    const { status, body } = await request(a, 'bob');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'pending', user: { id: b.id, username: 'Bob' } });
    expect(await friendshipRows(a)).toEqual([{ requester_id: a.id, addressee_id: b.id, status: 'pending' }]);
    expect(await storedNotifications(b)).toEqual([{ kind: 'friend_request', actor_id: a.id, ref: null, read_at: null }]);
    expect(await storedNotifications(a)).toEqual([]);

    const mine = await friendsOf(a);
    expect(mine.friends).toEqual([]);
    expect(mine.incoming).toEqual([]);
    expect(mine.outgoing).toEqual([{ id: b.id, username: 'Bob', since: expect.any(Number) }]);
    const since = mine.outgoing[0]!.since;
    expect(since).toBeGreaterThanOrEqual(before);
    const theirs = await friendsOf(b);
    expect(theirs).toEqual({ friends: [], incoming: [{ id: a.id, username: 'alice', since }], outgoing: [] });
  });

  it('refuses unknown names, yourself and bad bodies', async () => {
    const a = await makeUser({ username: 'alice' });
    const unknown = await api('/api/friends/request', { cookie: a.cookie, body: { username: 'nobody' } });
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('not_found');

    const self = await api('/api/friends/request', { cookie: a.cookie, body: { username: 'ALICE' } });
    expect(self.status).toBe(400);
    expect(await errorCode(self)).toBe('validation');

    for (const body of [{}, { username: 42 }, { username: '' }, { username: 'x'.repeat(300) }]) {
      const res = await api('/api/friends/request', { cookie: a.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe('validation');
    }
    const notJson = await api('/api/friends/request', { cookie: a.cookie, body: 'alice', headers: { 'Content-Type': 'text/plain' } });
    expect(notJson.status).toBe(400);
    expect(await friendshipRows(a)).toEqual([]);
    expect(await storedNotifications(a)).toEqual([]);
  });

  it('answers already_pending and already_friends without a second row or notification', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'bob' });
    const c = await makeUser({ username: 'carol' });
    expect((await request(a, 'bob')).body.status).toBe('pending');
    expect((await request(a, 'bob')).body).toEqual({ status: 'already_pending', user: { id: b.id, username: 'bob' } });
    expect(await friendshipRows(a)).toEqual([{ requester_id: a.id, addressee_id: b.id, status: 'pending' }]);
    expect(await storedNotifications(b)).toHaveLength(1);

    // Carol asked Alice first; the friendship is stored from Carol's side and both see it as settled.
    await befriend(c, a);
    expect((await request(a, 'carol')).body).toEqual({ status: 'already_friends', user: { id: c.id, username: 'carol' } });
    expect((await request(c, 'alice')).body).toEqual({ status: 'already_friends', user: { id: a.id, username: 'alice' } });
    expect(await friendshipRows(c)).toEqual([{ requester_id: c.id, addressee_id: a.id, status: 'accepted' }]);
    expect(await storedNotifications(a)).toEqual([]);
    expect(await storedNotifications(c)).toEqual([]);
  });

  it('accepts when the other side had already asked', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'bob' });
    await request(a, 'bob');

    const { body } = await request(b, 'alice');
    expect(body).toEqual({ status: 'accepted', user: { id: a.id, username: 'alice' } });
    expect(await friendshipRows(a)).toEqual([{ requester_id: a.id, addressee_id: b.id, status: 'accepted' }]);
    expect(await storedNotifications(a)).toEqual([{ kind: 'friend_accepted', actor_id: b.id, ref: null, read_at: null }]);
    expect(await storedNotifications(b)).toEqual([{ kind: 'friend_request', actor_id: a.id, ref: null, read_at: null }]);

    expect(await friendsOf(a)).toEqual({ friends: [{ id: b.id, username: 'bob' }], incoming: [], outgoing: [] });
    expect(await friendsOf(b)).toEqual({ friends: [{ id: a.id, username: 'alice' }], incoming: [], outgoing: [] });
  });

  it('accepts a pending request with POST /accept', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'bob' });
    await request(a, 'bob');

    // Only the addressee can accept, and only once.
    const wrongWay = await api('/api/friends/accept', { cookie: a.cookie, body: { user_id: b.id } });
    expect(wrongWay.status).toBe(404);
    expect(await errorCode(wrongWay)).toBe('not_found');

    const res = await api('/api/friends/accept', { cookie: b.cookie, body: { user_id: a.id } });
    expect(res.status).toBe(204);
    expect(await friendshipRows(a)).toEqual([{ requester_id: a.id, addressee_id: b.id, status: 'accepted' }]);
    expect(await storedNotifications(a)).toEqual([{ kind: 'friend_accepted', actor_id: b.id, ref: null, read_at: null }]);

    expect((await api('/api/friends/accept', { cookie: b.cookie, body: { user_id: a.id } })).status).toBe(404);
    expect((await api('/api/friends/accept', { cookie: b.cookie, body: { user_id: 'nobody' } })).status).toBe(404);
    const bad = await api('/api/friends/accept', { cookie: b.cookie, body: {} });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('validation');
    expect(await storedNotifications(a)).toHaveLength(1);
  });

  it('declines a pending request and forgets its notification', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'bob' });
    const c = await makeUser({ username: 'carol' });
    await request(a, 'bob');
    await request(c, 'bob');
    expect(await storedNotifications(b)).toHaveLength(2);

    const res = await api('/api/friends/decline', { cookie: b.cookie, body: { user_id: a.id } });
    expect(res.status).toBe(204);
    expect(await friendshipRows(b)).toEqual([{ requester_id: c.id, addressee_id: b.id, status: 'pending' }]);
    expect(await storedNotifications(b)).toEqual([{ kind: 'friend_request', actor_id: c.id, ref: null, read_at: null }]);
    expect(await storedNotifications(a)).toEqual([]);

    const again = await api('/api/friends/decline', { cookie: b.cookie, body: { user_id: a.id } });
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('not_found');
    // The requester cannot decline their own request, and accepted friendships are not declined.
    expect((await api('/api/friends/decline', { cookie: c.cookie, body: { user_id: b.id } })).status).toBe(404);
    await api('/api/friends/accept', { cookie: b.cookie, body: { user_id: c.id } });
    expect((await api('/api/friends/decline', { cookie: b.cookie, body: { user_id: c.id } })).status).toBe(404);
    expect(await friendshipRows(b)).toEqual([{ requester_id: c.id, addressee_id: b.id, status: 'accepted' }]);
  });

  it('removes a friendship from either side', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'bob' });
    const c = await makeUser({ username: 'carol' });
    await befriend(a, b);
    await befriend(c, a);

    expect((await api(`/api/friends/${b.id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(204);
    expect(await friendshipRows(a)).toEqual([{ requester_id: c.id, addressee_id: a.id, status: 'accepted' }]);
    // Carol made the request; Alice can still end it.
    expect((await api(`/api/friends/${c.id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(204);
    expect(await friendshipRows(a)).toEqual([]);
    expect(await friendshipRows(c)).toEqual([]);
    expect((await api('/api/friends/nobody', { method: 'DELETE', cookie: a.cookie })).status).toBe(204);
  });

  it('withdraws an outgoing request and takes back the notification', async () => {
    const a = await makeUser({ username: 'alice' });
    const b = await makeUser({ username: 'bob' });
    const c = await makeUser({ username: 'carol' });
    await request(a, 'bob');
    await request(c, 'bob');
    await befriend(a, c);

    expect((await api(`/api/friends/${b.id}`, { method: 'DELETE', cookie: a.cookie })).status).toBe(204);
    expect(await friendshipRows(b)).toEqual([{ requester_id: c.id, addressee_id: b.id, status: 'pending' }]);
    expect(await storedNotifications(b)).toEqual([{ kind: 'friend_request', actor_id: c.id, ref: null, read_at: null }]);
    expect(await friendsOf(b)).toEqual({
      friends: [],
      incoming: [{ id: c.id, username: 'carol', since: expect.any(Number) }],
      outgoing: [],
    });
    // Alice's other friendship is untouched.
    expect(await friendshipRows(a)).toEqual([{ requester_id: a.id, addressee_id: c.id, status: 'accepted' }]);
  });

  it(`caps pending outgoing requests at ${MAX_PENDING_OUTGOING}`, async () => {
    const a = await makeUser({ username: 'alice' });
    for (let i = 1; i < MAX_PENDING_OUTGOING; i++) await befriend(a, await makeUser({ username: `pal${i}` }), 'pending');
    // Incoming requests and accepted friends do not count against the cap.
    await befriend(await makeUser({ username: 'asker' }), a, 'pending');
    await befriend(a, await makeUser({ username: 'friend' }));
    await makeUser({ username: 'last' });
    await makeUser({ username: 'onetoomany' });

    expect((await request(a, 'last')).body.status).toBe('pending');
    const res = await api('/api/friends/request', { cookie: a.cookie, body: { username: 'onetoomany' } });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect((await friendsOf(a)).outgoing).toHaveLength(MAX_PENDING_OUTGOING);
    // Answering someone who already asked is still fine.
    expect((await request(a, 'asker')).body.status).toBe('accepted');
  });

  it('sorts every list by username, ignoring case', async () => {
    const me = await makeUser({ username: 'me' });
    await befriend(me, await makeUser({ username: 'bob' }));
    await befriend(await makeUser({ username: 'Alice' }), me);
    await befriend(me, await makeUser({ username: 'carol' }));
    await befriend(await makeUser({ username: 'Zed' }), me, 'pending');
    await befriend(await makeUser({ username: 'yara' }), me, 'pending');
    await befriend(me, await makeUser({ username: 'Mia' }), 'pending');
    await befriend(me, await makeUser({ username: 'liam' }), 'pending');

    const lists = await friendsOf(me);
    expect(lists.friends.map((p) => p.username)).toEqual(['Alice', 'bob', 'carol']);
    expect(lists.incoming.map((p) => p.username)).toEqual(['yara', 'Zed']);
    expect(lists.outgoing.map((p) => p.username)).toEqual(['liam', 'Mia']);
  });

  describe('pushes', () => {
    it('reach every phone of a friend who wants them, and nobody else', async () => {
      const a = await makeUser({ username: 'alice' });
      const b = await makeUser({ username: 'bob' });
      const phone = await addDevice(b.id, 'https://push.example/bob-phone');
      const tablet = await addDevice(b.id, 'https://push.example/bob-tablet');
      await addDevice(a.id, 'https://push.example/alice-phone');
      await addDevice(null, 'https://push.example/signed-out');
      const { calls } = mockPush(201);

      expect((await request(a, 'bob')).status).toBe(200);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls.map((c) => c.url).sort()).toEqual([phone.endpoint, tablet.endpoint]);
      for (const call of calls) {
        expect(call.method).toBe('POST');
        expect(call.headers.get('Content-Encoding')).toBe('aes128gcm');
        expect(call.headers.get('Content-Type')).toBe('application/octet-stream');
        expect(call.headers.get('Authorization')).toMatch(/^vapid t=.+\..+\..+, k=/);
        expect(call.headers.get('Authorization')).toContain(`, k=${env.VAPID_PUBLIC_KEY}`);
        expect(call.headers.get('TTL')).toBe(String(24 * 3600));
        expect(call.headers.get('Urgency')).toBe('normal');
      }
      const toPhone = calls.find((c) => c.url === phone.endpoint)!;
      expect(await decryptPush(toPhone, phone)).toEqual(socialPush('friend_request', 'alice'));
      expect(await deviceRow(phone.id)).toEqual({ fails: 0, user_id: b.id });
    });

    it('stay away from someone who turned them off, while acceptances push like requests', async () => {
      const a = await makeUser({ username: 'alice', social_push: false });
      const b = await makeUser({ username: 'bob' });
      await addDevice(a.id, 'https://push.example/alice-phone');
      const bobsPhone = await addDevice(b.id, 'https://push.example/bob-phone');
      const { calls } = mockPush(201);

      expect((await request(b, 'alice')).status).toBe(200);
      expect(await storedNotifications(a)).toEqual([{ kind: 'friend_request', actor_id: b.id, ref: null, read_at: null }]);
      expect((await api('/api/friends/accept', { cookie: a.cookie, body: { user_id: b.id } })).status).toBe(204);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url).toBe(bobsPhone.endpoint);
      expect(await decryptPush(calls[0]!, bobsPhone)).toEqual(socialPush('friend_accepted', 'alice'));
      // Alice's request notification came first and sent nothing; her phone is untouched.
      expect(calls).toHaveLength(1);
      expect(await deviceRow((await deviceRow(bobsPhone.id)) ? bobsPhone.id : '')).not.toBeNull();
    });

    it('drop a phone the push service reports gone, and count other failures', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = await makeUser({ username: 'alice' });
      const b = await makeUser({ username: 'bob' });
      const gone = await addDevice(b.id, 'https://push.example/gone');
      const forbidden = await addDevice(b.id, 'https://push.example/forbidden');
      const flaky = await addDevice(b.id, 'https://push.example/flaky');
      const tired = await addDevice(b.id, 'https://push.example/tired', { fails: MAX_FAILS - 1 });
      const recovered = await addDevice(b.id, 'https://push.example/recovered', { fails: 3 });
      const statuses: Record<string, number> = {
        [gone.endpoint]: 410,
        [forbidden.endpoint]: 403,
        [flaky.endpoint]: 500,
        [tired.endpoint]: 500,
      };
      const { calls } = mockPush((url) => statuses[url] ?? 201);

      expect((await request(a, 'bob')).status).toBe(200);
      await vi.waitFor(async () => {
        expect(calls).toHaveLength(5);
        expect(await deviceRow(tired.id)).toBeNull();
      });
      expect(await deviceRow(gone.id)).toBeNull();
      expect(await deviceRow(forbidden.id)).toBeNull();
      expect(await deviceRow(flaky.id)).toEqual({ fails: 1, user_id: b.id });
      expect(await deviceRow(recovered.id)).toEqual({ fails: 0, user_id: b.id });
      // The in-app notification is there whatever became of the pushes.
      expect(await storedNotifications(b)).toHaveLength(1);
    });
  });
});
