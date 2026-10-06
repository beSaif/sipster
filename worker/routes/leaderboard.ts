// You and your friends, today and this week. See docs/SOCIAL.md §4 "Totals and leaderboard".

import { Hono } from 'hono';
import type { Leaderboard, LeaderboardEntry, Person, WeekEntry } from '../../shared/api';
import type { AppEnv } from '../env';
import { requireUser, requireUsername } from '../lib/auth';
import { addDays, isDay } from '../lib/days';
import { validation } from '../lib/http';

/** Stands in for the goal of someone who logged nothing in the window. */
export const DEFAULT_GOAL_ML = 2000;
const WEEK_DAYS = 7;

export const leaderboardRoutes = new Hono<AppEnv>();

leaderboardRoutes.use('*', requireUser, requireUsername);

interface TotalRow {
  user_id: string;
  day: string;
  ml: number;
  goal_ml: number;
}

type Unranked<T extends LeaderboardEntry> = Omit<T, 'rank'>;

const percent = (ml: number, goal: number): number => (100 * ml) / goal;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Case-insensitive, like `COLLATE NOCASE` (usernames are ASCII). */
function compareNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `pct` desc, `ml` desc, username asc, then 1-based ranks. */
function ranked<T extends LeaderboardEntry>(entries: Unranked<T>[]): T[] {
  entries.sort((a, b) => b.pct - a.pct || b.ml - a.ml || compareNames(a.username, b.username));
  return entries.map((e, i) => ({ ...e, rank: i + 1 }) as T);
}

leaderboardRoutes.get('/', async (c) => {
  const day = c.req.query('day');
  if (!isDay(day)) throw validation('day: expected a date as YYYY-MM-DD');
  const me = c.var.user.id;
  const start = addDays(day, 1 - WEEK_DAYS);

  // Members are the caller and their accepted friends, whichever side asked; the window is the seven days ending on `day`.
  const friendIds = `SELECT CASE WHEN requester_id = ?1 THEN addressee_id ELSE requester_id END
                       FROM friendships WHERE (requester_id = ?1 OR addressee_id = ?1) AND status = 'accepted'`;
  const [members, totals] = await Promise.all([
    c.env.DB.prepare(`SELECT id, username FROM users WHERE username IS NOT NULL AND (id = ?1 OR id IN (${friendIds}))`).bind(me).all<Person>(),
    c.env.DB.prepare(
      `SELECT user_id, day, ml, goal_ml FROM daily_totals
        WHERE day >= ?2 AND day <= ?3 AND (user_id = ?1 OR user_id IN (${friendIds}))
        ORDER BY day`,
    )
      .bind(me, start, day)
      .all<TotalRow>(),
  ]);
  const rowsOf = new Map<string, TotalRow[]>(members.results.map((p) => [p.id, []]));
  for (const t of totals.results) rowsOf.get(t.user_id)?.push(t);

  const today: Unranked<LeaderboardEntry>[] = [];
  const week: Unranked<WeekEntry>[] = [];
  for (const p of members.results) {
    const rows = rowsOf.get(p.id) ?? [];
    const base = { id: p.id, username: p.username, is_me: p.id === me };
    // Rows come oldest first, so the last one is the most recent goal we know of.
    const latest = rows[rows.length - 1];
    const todayRow = latest?.day === day ? latest : undefined;
    const ml = todayRow?.ml ?? 0;
    const goal = todayRow?.goal_ml ?? latest?.goal_ml ?? DEFAULT_GOAL_ML;
    today.push({ ...base, ml, goal_ml: goal, pct: Math.round(percent(ml, goal)) });
    week.push({
      ...base,
      ml: sum(rows.map((r) => r.ml)),
      goal_ml: sum(rows.map((r) => r.goal_ml)),
      days_hit: rows.filter((r) => r.ml >= r.goal_ml).length,
      // The mean over all seven days: a day without a row counts as 0%.
      pct: Math.round(sum(rows.map((r) => percent(r.ml, r.goal_ml))) / WEEK_DAYS),
    });
  }
  const body: Leaderboard = { day, today: ranked(today), week: ranked(week) };
  return c.json(body);
});
