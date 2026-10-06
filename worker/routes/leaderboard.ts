// You and your friends, today and this week. See docs/SOCIAL.md §4 "Totals and leaderboard".
// TODO(agent B): implement.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, requireUsername } from '../lib/auth';

export const leaderboardRoutes = new Hono<AppEnv>();

leaderboardRoutes.use('*', requireUser, requireUsername);
