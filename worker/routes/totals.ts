// Daily totals the phone reports (ml and goal per local day), and the goal-reached notifications
// they trigger. See docs/SOCIAL.md §4 "Totals and leaderboard".

import { Hono } from 'hono';
import type { DayTotal } from '../../shared/api';
import type { AppEnv, Env } from '../env';
import { nowMs, requireUser } from '../lib/auth';
import { addDays, isDay, utcDay } from '../lib/days';
import { intField, readJson, validation, type JsonObject } from '../lib/http';
import { executionCtxOf, notifyMany, type NotifyInput, type WaitUntil } from '../lib/notify';

/** A month of catch-up per request (the app sends the last 30 days once per start). */
export const MAX_DAYS_PER_REQUEST = 31;
/** How far from today (UTC) a reported day may lie: well behind for catch-up, a little ahead for phones east of UTC. */
export const OLDEST_DAYS_AGO = 40;
export const FURTHEST_DAYS_AHEAD = 2;
export const MAX_ML = 100_000;
export const MAX_GOAL_ML = 50_000;

export const totalsRoutes = new Hono<AppEnv>();

totalsRoutes.use('*', requireUser);

/** The validated entries, one per day; when a day repeats, the last entry wins. */
function readDays(body: JsonObject, today: string): DayTotal[] {
  const raw = body.days;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_DAYS_PER_REQUEST) {
    throw validation(`days: expected 1 to ${MAX_DAYS_PER_REQUEST} entries`);
  }
  const oldest = addDays(today, -OLDEST_DAYS_AGO);
  const furthest = addDays(today, FURTHEST_DAYS_AHEAD);
  const byDay = new Map<string, DayTotal>();
  raw.forEach((entry: unknown, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw validation(`days[${i}]: expected an object`);
    const e = entry as JsonObject;
    const day = e.day;
    if (!isDay(day)) throw validation(`days[${i}].day: expected a date as YYYY-MM-DD`);
    if (day < oldest || day > furthest) throw validation(`days[${i}].day: must be between ${oldest} and ${furthest}`);
    byDay.set(day, { day, ml: intField(e, 'ml', 0, MAX_ML), goal_ml: intField(e, 'goal_ml', 1, MAX_GOAL_ML) });
  });
  return [...byDay.values()];
}

totalsRoutes.put('/', async (c) => {
  const me = c.var.user;
  const now = nowMs();
  const today = utcDay(now);
  const days = readDays(await readJson(c), today);
  const dayList = JSON.stringify(days.map((d) => d.day));

  const stored = await c.env.DB.prepare(
    `SELECT day, ml, goal_ml FROM daily_totals WHERE user_id = ? AND day IN (SELECT value FROM json_each(?))`,
  )
    .bind(me.id, dayList)
    .all<DayTotal>();
  const before = new Map(stored.results.map((r) => [r.day, r]));

  await c.env.DB.batch(
    days.map((d) =>
      c.env.DB.prepare(
        `INSERT INTO daily_totals (user_id, day, ml, goal_ml, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET ml = excluded.ml, goal_ml = excluded.goal_ml, updated_at = excluded.updated_at`,
      ).bind(me.id, d.day, d.ml, d.goal_ml, now),
    ),
  );

  // Goal reached: the total crossed the line today or yesterday. Older days are history, not news.
  const recent = new Set([today, addDays(today, -1)]);
  const crossed = days.filter((d) => {
    const prev = before.get(d.day);
    return recent.has(d.day) && d.ml >= d.goal_ml && (!prev || prev.ml < prev.goal_ml);
  });
  if (crossed.length && me.username) await tellFriends(c.env, executionCtxOf(c), me.id, me.username, crossed.map((d) => d.day));
  return c.body(null, 204);
});

/** A `goal_reached` notification per friend for each of `days` not announced before (once per day, however often the line is re-crossed). */
async function tellFriends(env: Env, ctx: WaitUntil | undefined, meId: string, myName: string, days: string[]): Promise<void> {
  const [announced, friends] = await Promise.all([
    env.DB.prepare(`SELECT DISTINCT ref FROM notifications WHERE actor_id = ? AND kind = 'goal_reached' AND ref IN (SELECT value FROM json_each(?))`)
      .bind(meId, JSON.stringify(days))
      .all<{ ref: string }>(),
    env.DB.prepare(
      `SELECT CASE WHEN requester_id = ?1 THEN addressee_id ELSE requester_id END AS id
         FROM friendships WHERE (requester_id = ?1 OR addressee_id = ?1) AND status = 'accepted'`,
    )
      .bind(meId)
      .all<{ id: string }>(),
  ]);
  const done = new Set(announced.results.map((r) => r.ref));
  const inputs: NotifyInput[] = [];
  for (const day of days) {
    if (done.has(day)) continue;
    for (const friend of friends.results) inputs.push({ userId: friend.id, kind: 'goal_reached', actorId: meId, actorUsername: myName, ref: day });
  }
  await notifyMany(env, ctx, inputs);
}
