import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { addDays, utcDay } from '../../worker/lib/days';
import {
  addDevice,
  api,
  befriend,
  decryptPush,
  errorCode,
  makeUser,
  mockPush,
  resetDb,
  socialPush,
  storedNotifications,
  type TestUser,
} from './social-helpers';

const today = utcDay(Date.now());
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

beforeEach(resetDb);
afterAll(resetDb);

afterEach(() => {
  vi.restoreAllMocks();
});

const put = (user: TestUser, days: unknown): Promise<Response> =>
  api('/api/totals', { method: 'PUT', cookie: user.cookie, body: { days } });

interface Row {
  day: string;
  ml: number;
  goal_ml: number;
  updated_at: number;
}

async function rows(user: TestUser): Promise<Row[]> {
  const { results } = await env.DB.prepare('SELECT day, ml, goal_ml, updated_at FROM daily_totals WHERE user_id = ? ORDER BY day')
    .bind(user.id)
    .all<Row>();
  return results;
}

async function seedTotal(user: TestUser, day: string, ml: number, goal_ml: number): Promise<void> {
  await env.DB.prepare('INSERT INTO daily_totals (user_id, day, ml, goal_ml, updated_at) VALUES (?, ?, ?, ?, 1)')
    .bind(user.id, day, ml, goal_ml)
    .run();
}

async function notificationCount(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n;
}

describe('PUT /api/totals', () => {
  it('needs a session', async () => {
    const res = await api('/api/totals', { method: 'PUT', body: { days: [{ day: today, ml: 1, goal_ml: 1 }] } });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it('validates the body', async () => {
    const u = await makeUser();
    const entry = { day: today, ml: 1, goal_ml: 2 };
    const bad: Array<[label: string, days: unknown]> = [
      ['missing', undefined],
      ['not a list', 'nope'],
      ['empty', []],
      ['32 entries', Array.from({ length: 32 }, (_, i) => ({ ...entry, day: addDays(today, -i) }))],
      ['entry not an object', ['nope']],
      ['day not a date', [{ ...entry, day: '2026-1-5' }]],
      ['day impossible', [{ ...entry, day: '2026-02-30' }]],
      ['day too old', [{ ...entry, day: addDays(today, -41) }]],
      ['day too far ahead', [{ ...entry, day: addDays(today, 3) }]],
      ['ml negative', [{ ...entry, ml: -1 }]],
      ['ml too big', [{ ...entry, ml: 100_001 }]],
      ['ml fractional', [{ ...entry, ml: 1.5 }]],
      ['ml a string', [{ ...entry, ml: '5' }]],
      ['ml missing', [{ day: today, goal_ml: 1 }]],
      ['goal zero', [{ ...entry, goal_ml: 0 }]],
      ['goal too big', [{ ...entry, goal_ml: 50_001 }]],
      ['one bad entry among good ones', [entry, { ...entry, day: yesterday, goal_ml: -5 }]],
    ];
    for (const [label, days] of bad) {
      const res = days === undefined ? await api('/api/totals', { method: 'PUT', cookie: u.cookie, body: {} }) : await put(u, days);
      expect(res.status, label).toBe(400);
      expect(await errorCode(res), label).toBe('validation');
    }
    const notJson = await api('/api/totals', {
      method: 'PUT',
      cookie: u.cookie,
      body: { days: [entry] },
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(notJson.status).toBe(400);
    expect(await rows(u)).toEqual([]);

    // The edges are allowed: 40 days back, 2 days ahead, 0 ml, the largest goal.
    const edges = [
      { day: addDays(today, -40), ml: 0, goal_ml: 1 },
      { day: addDays(today, 2), ml: 100_000, goal_ml: 50_000 },
    ];
    expect((await put(u, edges)).status).toBe(204);
    expect((await rows(u)).map(({ updated_at: _, ...r }) => r)).toEqual(edges);
  });

  it('upserts one row per day; of duplicates in one request the last wins', async () => {
    const u = await makeUser();
    const other = await makeUser();
    await seedTotal(other, today, 123, 456);
    const before = Date.now();

    expect((await put(u, [{ day: today, ml: 500, goal_ml: 2000 }, { day: yesterday, ml: 1800, goal_ml: 2000 }])).status).toBe(204);
    const first = await rows(u);
    expect(first.map(({ updated_at: _, ...r }) => r)).toEqual([
      { day: yesterday, ml: 1800, goal_ml: 2000 },
      { day: today, ml: 500, goal_ml: 2000 },
    ]);
    expect(first[0]!.updated_at).toBeGreaterThanOrEqual(before);

    expect((await put(u, [{ day: today, ml: 700, goal_ml: 2000 }, { day: today, ml: 900, goal_ml: 2500 }])).status).toBe(204);
    expect((await rows(u)).map(({ updated_at: _, ...r }) => r)).toEqual([
      { day: yesterday, ml: 1800, goal_ml: 2000 },
      { day: today, ml: 900, goal_ml: 2500 },
    ]);
    expect((await rows(other)).map(({ updated_at: _, ...r }) => r)).toEqual([{ day: today, ml: 123, goal_ml: 456 }]);
  });

  describe('goal reached', () => {
    it('tells every accepted friend, once per day', async () => {
      const me = await makeUser({ username: 'alice' });
      const b = await makeUser({ username: 'bob' });
      const c = await makeUser({ username: 'carol' });
      const pendingOut = await makeUser();
      const pendingIn = await makeUser();
      const stranger = await makeUser();
      await befriend(me, b);
      await befriend(c, me);
      await befriend(me, pendingOut, 'pending');
      await befriend(pendingIn, me, 'pending');

      expect((await put(me, [{ day: today, ml: 1000, goal_ml: 2000 }])).status).toBe(204);
      expect(await notificationCount()).toBe(0);

      expect((await put(me, [{ day: today, ml: 2000, goal_ml: 2000 }])).status).toBe(204);
      const reached = { kind: 'goal_reached', actor_id: me.id, ref: today, read_at: null };
      expect(await storedNotifications(b)).toEqual([reached]);
      expect(await storedNotifications(c)).toEqual([reached]);
      for (const nobody of [me, pendingOut, pendingIn, stranger]) expect(await storedNotifications(nobody)).toEqual([]);

      // Drinking more, undoing below the goal and crossing it again: still one notification per friend.
      expect((await put(me, [{ day: today, ml: 2500, goal_ml: 2000 }])).status).toBe(204);
      expect((await put(me, [{ day: today, ml: 1500, goal_ml: 2000 }])).status).toBe(204);
      expect((await put(me, [{ day: today, ml: 2100, goal_ml: 2000 }])).status).toBe(204);
      expect(await storedNotifications(b)).toEqual([reached]);
      expect(await storedNotifications(c)).toEqual([reached]);

      // Yesterday counts as news too, and is a separate day. So does tomorrow: a phone east of UTC is already there.
      expect((await put(me, [{ day: yesterday, ml: 3000, goal_ml: 2000 }])).status).toBe(204);
      expect((await put(me, [{ day: tomorrow, ml: 2000, goal_ml: 2000 }])).status).toBe(204);
      for (const friend of [b, c]) {
        const mine = await storedNotifications(friend);
        expect(mine.map((n) => n.ref).sort()).toEqual([yesterday, today, tomorrow]);
        expect(mine.every((n) => n.kind === 'goal_reached' && n.actor_id === me.id && n.read_at === null)).toBe(true);
      }
      expect(await notificationCount()).toBe(6);
    });

    it('ignores days further than one from today, totals already over the goal, and keeps quiet without friends or a name', async () => {
      const me = await makeUser({ username: 'alice' });
      const b = await makeUser({ username: 'bob' });
      await befriend(me, b);

      // Two days back is history; two days ahead is nobody's today yet.
      expect((await put(me, [{ day: addDays(today, -2), ml: 5000, goal_ml: 2000 }])).status).toBe(204);
      expect((await put(me, [{ day: addDays(today, 2), ml: 5000, goal_ml: 2000 }])).status).toBe(204);
      expect(await notificationCount()).toBe(0);

      // Already over the goal before this request: not a crossing.
      await seedTotal(me, today, 2000, 2000);
      expect((await put(me, [{ day: today, ml: 2200, goal_ml: 2000 }])).status).toBe(204);
      expect(await notificationCount()).toBe(0);

      // Lowering the goal under what was drunk is a crossing.
      expect((await put(me, [{ day: yesterday, ml: 1500, goal_ml: 2000 }])).status).toBe(204);
      expect(await notificationCount()).toBe(0);
      expect((await put(me, [{ day: yesterday, ml: 1500, goal_ml: 1500 }])).status).toBe(204);
      expect(await storedNotifications(b)).toEqual([{ kind: 'goal_reached', actor_id: me.id, ref: yesterday, read_at: null }]);

      // Several days in one request: each is judged on its own.
      const c = await makeUser({ username: 'carol' });
      await befriend(me, c);
      const days = [
        { day: addDays(today, -3), ml: 9000, goal_ml: 2000 },
        { day: yesterday, ml: 1600, goal_ml: 1500 },
        { day: today, ml: 2300, goal_ml: 2000 },
        { day: addDays(today, 2), ml: 9000, goal_ml: 2000 },
      ];
      expect((await put(me, days)).status).toBe(204);
      expect(await storedNotifications(c)).toEqual([]);
      expect(await notificationCount()).toBe(1);

      // No friends: nothing to tell. No username: nothing can be said.
      const loner = await makeUser({ username: 'loner' });
      const nameless = await makeUser({ username: null });
      expect((await put(loner, [{ day: today, ml: 2000, goal_ml: 2000 }])).status).toBe(204);
      expect((await put(nameless, [{ day: today, ml: 2000, goal_ml: 2000 }])).status).toBe(204);
      expect((await rows(nameless)).map((r) => r.ml)).toEqual([2000]);
      expect(await notificationCount()).toBe(1);
    });

    it('pushes to friends who want it', async () => {
      const me = await makeUser({ username: 'alice' });
      const b = await makeUser({ username: 'bob' });
      const quiet = await makeUser({ username: 'quiet', social_push: false });
      await befriend(me, b);
      await befriend(quiet, me);
      const bobsPhone = await addDevice(b.id, 'https://push.example/bob');
      await addDevice(quiet.id, 'https://push.example/quiet');
      await addDevice(me.id, 'https://push.example/alice');
      const { calls } = mockPush(201);

      expect((await put(me, [{ day: today, ml: 2000, goal_ml: 2000 }])).status).toBe(204);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url).toBe(bobsPhone.endpoint);
      expect(calls[0]!.headers.get('Content-Encoding')).toBe('aes128gcm');
      expect(calls[0]!.headers.get('Authorization')).toMatch(/^vapid t=/);
      expect(await decryptPush(calls[0]!, bobsPhone)).toEqual(socialPush('goal_reached', 'alice'));
      expect(await storedNotifications(quiet)).toEqual([{ kind: 'goal_reached', actor_id: me.id, ref: today, read_at: null }]);
    });
  });
});
