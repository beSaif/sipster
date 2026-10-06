// Sign in with Google, sessions, username and account. See docs/SOCIAL.md §4 "Account" and §5.
// TODO(agent A): implement. The skeleton only answers /me so the app can probe the session.

import { Hono } from 'hono';
import type { Me } from '../../shared/api';
import type { AppEnv } from '../env';
import { requireUser } from '../lib/auth';

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/me', requireUser, async (c) => {
  const unread =
    (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(c.var.user.id).first<{ n: number }>())?.n ?? 0;
  const body: Me = { user: c.var.user, unread };
  return c.json(body);
});
