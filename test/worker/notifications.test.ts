import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Me, NotificationsResponse } from '../../shared/api';
import { api, errorCode, makeUser, resetDb, seedNotification, storedNotifications, type TestUser } from './social-helpers';

beforeEach(resetDb);
afterAll(resetDb);

async function list(user: TestUser): Promise<NotificationsResponse> {
  const res = await api('/api/notifications', { cookie: user.cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as NotificationsResponse;
}

async function unreadPerMe(user: TestUser): Promise<number> {
  const res = await api('/api/auth/me', { cookie: user.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as Me).unread;
}

describe('notifications', () => {
  it('need a session', async () => {
    for (const [method, path] of [['GET', '/api/notifications'], ['POST', '/api/notifications/read']] as const) {
      const res = await api(path, { method, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
  });

  it('lists the newest 50 with their actors, and counts everything unread', async () => {
    const me = await makeUser({ username: 'me' });
    const alice = await makeUser({ username: 'alice' });
    const nameless = await makeUser({ username: null });
    const other = await makeUser();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 55; i++) {
      const readAt = i % 10 === 0 ? base + 1000 : null;
      await seedNotification(me, { kind: 'friend_request', actorId: alice.id, createdAt: base + i, readAt });
    }
    const newest = await seedNotification(me, { kind: 'goal_reached', actorId: alice.id, ref: '2026-03-10', createdAt: base + 100 });
    const orphan = await seedNotification(me, { kind: 'friend_accepted', actorId: null, createdAt: base + 99 });
    const unnamed = await seedNotification(me, { kind: 'friend_accepted', actorId: nameless.id, createdAt: base + 98 });
    await seedNotification(other, { actorId: alice.id, createdAt: base + 200 });

    const { unread, items } = await list(me);
    expect(items).toHaveLength(50);
    expect(unread).toBe(58 - 6);
    expect(items.map((n) => n.created_at)).toEqual([...items.map((n) => n.created_at)].sort((a, b) => b - a));
    const fromAlice = { id: alice.id, username: 'alice' };
    expect(items[0]).toEqual({
      id: newest,
      kind: 'goal_reached',
      actor: fromAlice,
      ref: '2026-03-10',
      created_at: base + 100,
      read_at: null,
    });
    expect(items[1]).toEqual({ id: orphan, kind: 'friend_accepted', actor: null, ref: null, created_at: base + 99, read_at: null });
    expect(items[2]).toEqual({ id: unnamed, kind: 'friend_accepted', actor: null, ref: null, created_at: base + 98, read_at: null });
    expect(items[3]).toMatchObject({ kind: 'friend_request', actor: fromAlice, created_at: base + 54 });
    expect(items[items.length - 1]!.created_at).toBe(base + 8);
    const readOnes = items.filter((n) => n.read_at !== null).map((n) => n.created_at);
    expect(readOnes).toEqual([base + 50, base + 40, base + 30, base + 20, base + 10]);
    expect(await unreadPerMe(me)).toBe(52);
    expect((await list(other)).items).toHaveLength(1);
  });

  it('marks everything read, for the caller only', async () => {
    const me = await makeUser();
    const alice = await makeUser({ username: 'alice' });
    const other = await makeUser();
    await seedNotification(me, { actorId: alice.id, createdAt: 1 });
    await seedNotification(me, { actorId: alice.id, createdAt: 2, readAt: 5 });
    await seedNotification(me, { actorId: alice.id, createdAt: 3 });
    await seedNotification(other, { actorId: alice.id, createdAt: 4 });
    expect(await unreadPerMe(me)).toBe(2);
    expect((await list(me)).unread).toBe(2);
    const before = Date.now();

    const res = await api('/api/notifications/read', { cookie: me.cookie, body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unread: 0 });
    const stored = await storedNotifications(me);
    expect(stored.map((n) => n.read_at)).toEqual([expect.any(Number), 5, expect.any(Number)]);
    expect(stored[0]!.read_at).toBeGreaterThanOrEqual(before);
    expect((await storedNotifications(other)).map((n) => n.read_at)).toEqual([null]);

    const after = await list(me);
    expect(after.unread).toBe(0);
    expect(after.items.every((n) => n.read_at !== null)).toBe(true);
    expect(await unreadPerMe(me)).toBe(0);
    // Marking read needs no body.
    expect((await api('/api/notifications/read', { method: 'POST', cookie: me.cookie })).status).toBe(200);
  });

  it('carries what the friend routes create', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    expect((await api('/api/friends/request', { cookie: alice.cookie, body: { username: 'bob' } })).status).toBe(200);
    expect((await api('/api/friends/accept', { cookie: bob.cookie, body: { user_id: alice.id } })).status).toBe(204);

    const item = (kind: string, actor: TestUser) => ({
      id: expect.any(String),
      kind,
      actor: { id: actor.id, username: actor.username },
      ref: null,
      created_at: expect.any(Number),
      read_at: null,
    });
    const bobs = await list(bob);
    expect(bobs.unread).toBe(1);
    expect(bobs.items).toEqual([item('friend_request', alice)]);
    const alices = await list(alice);
    expect(alices.items).toEqual([item('friend_accepted', bob)]);
    expect(await unreadPerMe(alice)).toBe(1);
  });
});
