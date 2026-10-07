import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Leaderboard } from '../../shared/api';
import { addDays } from '../../worker/lib/days';
import { api, befriend, errorCode, makeUser, resetDb, type TestUser } from './social-helpers';

beforeEach(resetDb);
afterAll(resetDb);

/** Any fixed day: totals are seeded straight into D1, so "today" never comes into it. */
const DAY = '2026-03-10';
const d = (n: number): string => addDays(DAY, n);
const INSERT_TOTAL = 'INSERT INTO daily_totals (user_id, day, ml, goal_ml, updated_at) VALUES (?, ?, ?, ?, 1)';

async function seed(user: TestUser, totals: Array<[day: string, ml: number, goal_ml: number]>): Promise<void> {
  await env.DB.batch(totals.map(([day, ml, goal]) => env.DB.prepare(INSERT_TOTAL).bind(user.id, day, ml, goal)));
}

async function board(user: TestUser, day = DAY): Promise<Leaderboard> {
  const res = await api(`/api/leaderboard?day=${day}`, { cookie: user.cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as Leaderboard;
}

const names = (entries: Array<{ username: string }>): string[] => entries.map((e) => e.username);

describe('GET /api/leaderboard', () => {
  it('needs a session, a username and a real day', async () => {
    const anonymous = await api(`/api/leaderboard?day=${DAY}`);
    expect(anonymous.status).toBe(401);
    expect(await errorCode(anonymous)).toBe('unauthorized');

    const nameless = await makeUser({ username: null });
    const forbidden = await api(`/api/leaderboard?day=${DAY}`, { cookie: nameless.cookie });
    expect(forbidden.status).toBe(403);
    expect(await errorCode(forbidden)).toBe('forbidden');

    const me = await makeUser();
    for (const query of ['', '?day=', '?day=nope', '?day=2026-02-30', '?day=2026-3-1', '?day=20260301', '?day=2026-03-01T00:00']) {
      const res = await api(`/api/leaderboard${query}`, { cookie: me.cookie });
      expect(res.status, query).toBe(400);
      expect(await errorCode(res), query).toBe('validation');
    }
    expect((await board(me, '2024-02-29')).day).toBe('2024-02-29');
  });

  it('lists you and your accepted friends only', async () => {
    const me = await makeUser({ username: 'me' });
    const asked = await makeUser({ username: 'asked' });
    const asker = await makeUser({ username: 'asker' });
    const pendingOut = await makeUser({ username: 'pendingOut' });
    const pendingIn = await makeUser({ username: 'pendingIn' });
    await makeUser({ username: 'stranger' });
    await befriend(me, asked);
    await befriend(asker, me);
    await befriend(me, pendingOut, 'pending');
    await befriend(pendingIn, me, 'pending');

    const lb = await board(me);
    expect(lb.day).toBe(DAY);
    expect(names(lb.today).sort()).toEqual(['asked', 'asker', 'me']);
    expect(names(lb.week).sort()).toEqual(['asked', 'asker', 'me']);
    expect(lb.today.filter((e) => e.is_me).map((e) => e.id)).toEqual([me.id]);
    expect(lb.week.filter((e) => e.is_me).map((e) => e.id)).toEqual([me.id]);
    expect(lb.today.find((e) => e.id === asked.id)).toEqual({
      id: asked.id,
      username: 'asked',
      ml: 0,
      goal_ml: 2000,
      pct: 0,
      is_me: false,
      rank: expect.any(Number),
    });
    // Everyone has their own view.
    expect(names((await board(asker)).today).sort()).toEqual(['asker', 'me']);
    expect((await board(asker)).today.find((e) => e.is_me)?.id).toBe(asker.id);
  });

  it('scores today from that day’s row, falling back to the latest goal in the window', async () => {
    const me = await makeUser({ username: 'me' });
    const noRowToday = await makeUser({ username: 'noRowToday' });
    const onlyOld = await makeUser({ username: 'onlyOld' });
    const half = await makeUser({ username: 'half' });
    const over = await makeUser({ username: 'over' });
    for (const u of [noRowToday, onlyOld, half, over]) await befriend(me, u);
    await seed(me, [[DAY, 1500, 2000]]);
    await seed(noRowToday, [[d(-6), 9999, 1600], [d(-3), 100, 1800], [d(1), 100, 7000]]);
    await seed(onlyOld, [[d(-7), 3000, 3000]]);
    await seed(half, [[DAY, 1250, 2000]]);
    await seed(over, [[DAY, 3000, 2000]]);

    const today = Object.fromEntries((await board(me)).today.map((e) => [e.username, e]));
    expect(today.me).toMatchObject({ ml: 1500, goal_ml: 2000, pct: 75, is_me: true });
    // The most recent goal in the seven days ending on `day`; the day after does not count.
    expect(today.noRowToday).toMatchObject({ ml: 0, goal_ml: 1800, pct: 0 });
    // A row eight days back is outside the window, so the default goal stands in.
    expect(today.onlyOld).toMatchObject({ ml: 0, goal_ml: 2000, pct: 0 });
    // 62.5 rounds up; nothing is capped.
    expect(today.half).toMatchObject({ ml: 1250, goal_ml: 2000, pct: 63 });
    expect(today.over).toMatchObject({ ml: 3000, goal_ml: 2000, pct: 150 });
  });

  it('sums the week and averages the percentages over all seven days', async () => {
    const me = await makeUser({ username: 'me' });
    const empty = await makeUser({ username: 'empty' });
    const full = await makeUser({ username: 'full' });
    await befriend(me, empty);
    await befriend(me, full);
    await seed(me, [
      [d(0), 2000, 2000], // 100 %
      [d(-1), 1000, 2000], // 50 %
      [d(-6), 3000, 2000], // 150 %, the first day of the window
      [d(-7), 9999, 1], // the day before the window
      [d(1), 9999, 1], // the day after
    ]);
    await seed(full, Array.from({ length: 7 }, (_, i): [string, number, number] => [d(-i), 2500, 2500]));

    const week = Object.fromEntries((await board(me)).week.map((e) => [e.username, e]));
    expect(week.me).toEqual({ id: me.id, username: 'me', ml: 6000, goal_ml: 6000, days_hit: 2, pct: 43, is_me: true, rank: 2 });
    expect(week.empty).toEqual({ id: empty.id, username: 'empty', ml: 0, goal_ml: 0, days_hit: 0, pct: 0, is_me: false, rank: 3 });
    expect(week.full).toEqual({ id: full.id, username: 'full', ml: 17_500, goal_ml: 17_500, days_hit: 7, pct: 100, is_me: false, rank: 1 });
  });

  it('ranks by pct, then ml, then name regardless of case, in both lists', async () => {
    const me = await makeUser({ username: 'alice' });
    const zoe = await makeUser({ username: 'zoe' });
    const dave = await makeUser({ username: 'Dave' });
    const bob = await makeUser({ username: 'Bob' });
    const carl = await makeUser({ username: 'carl' });
    const eve = await makeUser({ username: 'eve' });
    for (const u of [zoe, dave, bob, carl, eve]) await befriend(u, me);
    await seed(zoe, [[DAY, 1800, 2000]]); // 90 %
    await seed(dave, [[DAY, 1500, 3000]]); // 50 %, more ml than the other 50s
    await seed(me, [[DAY, 1000, 2000]]); // 50 %
    await seed(bob, [[DAY, 1000, 2000]]); // 50 %
    await seed(carl, [[DAY, 1000, 2000]]); // 50 %
    await seed(eve, [[d(-1), 4000, 2000]]); // nothing today, but a big yesterday

    const lb = await board(me);
    expect(names(lb.today)).toEqual(['zoe', 'Dave', 'alice', 'Bob', 'carl', 'eve']);
    expect(lb.today.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lb.today.map((e) => e.pct)).toEqual([90, 50, 50, 50, 50, 0]);
    // The week is ranked on its own: Eve's 200 % day averages to 29 % and beats everyone's single 50 % day.
    expect(names(lb.week)).toEqual(['eve', 'zoe', 'Dave', 'alice', 'Bob', 'carl']);
    expect(lb.week.map((e) => e.pct)).toEqual([29, 13, 7, 7, 7, 7]);
    expect(lb.week.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
