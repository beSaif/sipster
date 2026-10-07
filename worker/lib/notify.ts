// The one place that creates a notification: the in-app row, and a push to every phone linked to
// the recipient when they want them. See docs/SOCIAL.md §4 "Notifications".

import type { Context } from 'hono';
import type { NotificationKind, SocialPush } from '../../shared/api';
import { socialCopy } from '../../shared/copy';
import type { AppEnv, Env } from '../env';
import { MAX_FAILS, vapidFor, type DeviceRow } from '../push';
import { sendPush } from '../webpush';
import { nowMs, uuid } from './auth';

export interface NotifyInput {
  /** Who sees it. */
  userId: string;
  kind: NotificationKind;
  /** Who caused it. */
  actorId: string;
  actorUsername: string;
  /** goal_reached: the day. */
  ref?: string | null;
}

/** What `notify` needs of an ExecutionContext (Hono's and workers-types' interfaces differ beyond this). */
export type WaitUntil = Pick<ExecutionContext, 'waitUntil'>;

/** Social pushes can wait a day; nothing about them is urgent. */
const SEND_OPTIONS = { ttl: 24 * 3600, urgency: 'normal' } as const;

/** Hono's `c.executionCtx` throws where there is none (the app called directly); sends are then awaited instead. */
export function executionCtxOf(c: Context<AppEnv>): WaitUntil | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/** Inserts the row and tells the recipient's phones. The request does not wait for push services. */
export async function notify(env: Env, ctx: WaitUntil | undefined, input: NotifyInput): Promise<void> {
  await notifyMany(env, ctx, [input]);
}

/** Several at once (a goal reached, told to every friend): one D1 batch for the rows, then the pushes. */
export async function notifyMany(env: Env, ctx: WaitUntil | undefined, inputs: readonly NotifyInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const now = nowMs();
  await env.DB.batch(
    inputs.map((input) =>
      env.DB.prepare('INSERT INTO notifications (id, user_id, kind, actor_id, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(uuid(), input.userId, input.kind, input.actorId, input.ref ?? null, now),
    ),
  );
  const sends = pushAll(env, inputs);
  if (ctx) ctx.waitUntil(sends);
  else await sends;
}

/** Pushes for every input, then one batch of device bookkeeping. Never rejects: a lost push is not worth failing anything for. */
async function pushAll(env: Env, inputs: readonly NotifyInput[]): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.error('VAPID keys are not configured; social pushes not sent');
    return;
  }
  const writes: D1PreparedStatement[] = [];
  for (const input of inputs) {
    try {
      writes.push(...(await pushOne(env, input)));
    } catch (err) {
      console.error('social push failed', input.kind, err);
    }
  }
  if (writes.length === 0) return;
  try {
    await env.DB.batch(writes);
  } catch (err) {
    console.error('device bookkeeping failed', err);
  }
}

/** Encrypts the copy for `input` to each phone linked to the recipient, if they want social pushes. */
async function pushOne(env: Env, input: NotifyInput): Promise<D1PreparedStatement[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.* FROM devices d
       JOIN users u ON u.id = d.user_id
      WHERE d.user_id = ? AND u.social_push = 1`,
  )
    .bind(input.userId)
    .all<DeviceRow>();
  if (results.length === 0) return [];
  const payload: SocialPush = { type: 'social', kind: input.kind, ...socialCopy(input.kind, input.actorUsername), url: '/#/inbox' };
  const outcomes = await Promise.all(results.map((row) => deliver(env, row, payload)));
  return outcomes.filter((stmt): stmt is D1PreparedStatement => stmt !== null);
}

/** One push, and the statement recording what became of the device (null when nothing changed). */
async function deliver(env: Env, row: DeviceRow, payload: SocialPush): Promise<D1PreparedStatement | null> {
  let status = 0;
  try {
    status = (await sendPush(row, payload, vapidFor(env, row), SEND_OPTIONS)).status;
  } catch (err) {
    console.error('social push failed', row.id.slice(0, 8), err);
  }
  if (status >= 200 && status < 300) {
    return row.fails > 0 ? env.DB.prepare('UPDATE devices SET fails = 0 WHERE id = ?').bind(row.id) : null;
  }
  // Gone, or the VAPID key no longer matches: the subscription is dead. So is one that keeps failing.
  if (status === 404 || status === 410 || status === 403 || row.fails + 1 >= MAX_FAILS) {
    return env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(row.id);
  }
  console.warn('social push not accepted', row.id.slice(0, 8), status);
  return env.DB.prepare('UPDATE devices SET fails = fails + 1 WHERE id = ?').bind(row.id);
}
