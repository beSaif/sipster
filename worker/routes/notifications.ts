// In-app notifications: list and mark read. See docs/SOCIAL.md §4 "Notifications".

import { Hono } from 'hono';
import type { Notification, NotificationKind, NotificationsResponse, ReadResponse } from '../../shared/api';
import type { AppEnv, Env } from '../env';
import { nowMs, requireUser } from '../lib/auth';

/** How far back the inbox shows; older rows are pruned after 60 days anyway (housekeeping). */
export const PAGE_SIZE = 50;

export const notificationsRoutes = new Hono<AppEnv>();

notificationsRoutes.use('*', requireUser);

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  ref: string | null;
  created_at: number;
  read_at: number | null;
  actor_id: string | null;
  actor_username: string | null;
}

export async function unreadCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

notificationsRoutes.get('/', async (c) => {
  const me = c.var.user.id;
  const [list, unread] = await Promise.all([
    c.env.DB.prepare(
      `SELECT n.id, n.kind, n.ref, n.created_at, n.read_at, u.id AS actor_id, u.username AS actor_username
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ?`,
    )
      .bind(me, PAGE_SIZE)
      .all<NotificationRow>(),
    unreadCount(c.env, me),
  ]);
  const items: Notification[] = list.results.map((r) => ({
    id: r.id,
    kind: r.kind,
    actor: r.actor_id && r.actor_username ? { id: r.actor_id, username: r.actor_username } : null,
    ref: r.ref,
    created_at: r.created_at,
    read_at: r.read_at,
  }));
  const body: NotificationsResponse = { unread, items };
  return c.json(body);
});

notificationsRoutes.post('/read', async (c) => {
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(nowMs(), c.var.user.id).run();
  const body: ReadResponse = { unread: 0 };
  return c.json(body);
});
