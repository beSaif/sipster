// Friend requests and the friends list. See docs/SOCIAL.md §4 "Friends".

import { Hono } from 'hono';
import type { FriendRequestOutcome, FriendRequestResponse, FriendsResponse, Person } from '../../shared/api';
import type { AppEnv, Env, SessionUser } from '../env';
import { nowMs, requireUser, requireUsername } from '../lib/auth';
import { ApiError, notFound, readJson, stringField, validation } from '../lib/http';
import { executionCtxOf, notify } from '../lib/notify';

/** Requests one person may have waiting for an answer at a time. */
export const MAX_PENDING_OUTGOING = 50;

export const friendsRoutes = new Hono<AppEnv>();

friendsRoutes.use('*', requireUser, requireUsername);

/** The caller's username; `requireUsername` makes sure there is one. */
const nameOf = (user: SessionUser): string => user.username ?? '';

interface RelationRow {
  id: string;
  username: string;
  status: 'pending' | 'accepted';
  created_at: number;
  /** 1 when the caller made the request. */
  mine: number;
}

friendsRoutes.get('/', async (c) => {
  const me = c.var.user.id;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, f.status, f.created_at, f.requester_id = ?1 AS mine
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ?1 OR f.addressee_id = ?1) AND u.username IS NOT NULL
      ORDER BY u.username COLLATE NOCASE`,
  )
    .bind(me)
    .all<RelationRow>();
  const body: FriendsResponse = { friends: [], incoming: [], outgoing: [] };
  for (const r of results) {
    const person: Person = { id: r.id, username: r.username };
    if (r.status === 'accepted') body.friends.push(person);
    else (r.mine ? body.outgoing : body.incoming).push({ ...person, since: r.created_at });
  }
  return c.json(body);
});

interface PairRow {
  requester_id: string;
  status: 'pending' | 'accepted';
}

/** The one row for this pair, whichever way round it was made. */
function pairRow(env: Env, a: string, b: string): Promise<PairRow | null> {
  return env.DB.prepare(
    `SELECT requester_id, status FROM friendships
      WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`,
  )
    .bind(a, b)
    .first<PairRow>();
}

friendsRoutes.post('/request', async (c) => {
  const me = c.var.user;
  const username = stringField(await readJson(c), 'username');
  const them = await c.env.DB.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').bind(username).first<Person>();
  if (!them?.username) throw notFound('Nobody goes by that name');
  if (them.id === me.id) throw validation('That is you');
  const answer = (status: FriendRequestOutcome): Response => {
    const body: FriendRequestResponse = { status, user: them };
    return c.json(body);
  };

  const now = nowMs();
  const existing = await pairRow(c.env, me.id, them.id);
  if (existing?.status === 'accepted') return answer('already_friends');
  if (existing?.requester_id === me.id) return answer('already_pending');
  if (existing) {
    // They asked first, so this is a yes.
    await c.env.DB.prepare(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE requester_id = ? AND addressee_id = ?`)
      .bind(now, them.id, me.id)
      .run();
    await notify(c.env, executionCtxOf(c), { userId: them.id, kind: 'friend_accepted', actorId: me.id, actorUsername: nameOf(me) });
    return answer('accepted');
  }

  const pending = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM friendships WHERE requester_id = ? AND status = 'pending'`)
    .bind(me.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_OUTGOING) throw new ApiError('rate_limited', 'Too many requests are waiting for an answer');
  await c.env.DB.prepare(
    `INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`,
  )
    .bind(me.id, them.id, now, now)
    .run();
  await notify(c.env, executionCtxOf(c), { userId: them.id, kind: 'friend_request', actorId: me.id, actorUsername: nameOf(me) });
  return answer('pending');
});

friendsRoutes.post('/accept', async (c) => {
  const me = c.var.user;
  const them = stringField(await readJson(c), 'user_id');
  const res = await c.env.DB.prepare(
    `UPDATE friendships SET status = 'accepted', updated_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`,
  )
    .bind(nowMs(), them, me.id)
    .run();
  if (!res.meta.changes) throw notFound('No request from that person');
  await notify(c.env, executionCtxOf(c), { userId: them, kind: 'friend_accepted', actorId: me.id, actorUsername: nameOf(me) });
  return c.body(null, 204);
});

friendsRoutes.post('/decline', async (c) => {
  const me = c.var.user.id;
  const them = stringField(await readJson(c), 'user_id');
  const res = await c.env.DB.prepare(`DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`)
    .bind(them, me)
    .run();
  if (!res.meta.changes) throw notFound('No request from that person');
  await c.env.DB.prepare(`DELETE FROM notifications WHERE user_id = ? AND kind = 'friend_request' AND actor_id = ?`).bind(me, them).run();
  return c.body(null, 204);
});

/** Unfriend, withdraw or decline, whichever applies; the request notifications between the two go with it. */
friendsRoutes.delete('/:id', async (c) => {
  const me = c.var.user.id;
  const them = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM friendships WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`,
    ).bind(me, them),
    c.env.DB.prepare(
      `DELETE FROM notifications WHERE kind = 'friend_request'
        AND ((user_id = ?2 AND actor_id = ?1) OR (user_id = ?1 AND actor_id = ?2))`,
    ).bind(me, them),
  ]);
  return c.body(null, 204);
});
