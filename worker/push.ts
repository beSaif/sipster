// Nudges: the per-phone reminder schedule, the push endpoints (/api/config, subscribe, sync, snooze,
// test, unsubscribe) and the cron that sends due nudges. Unchanged in behaviour since before
// accounts existed, except that a signed-in phone is linked to its account (devices.user_id).

import { Hono } from 'hono';
import { pickNudge, TEST_NUDGE } from '../shared/copy';
import {
  nextAfterNudge,
  nextAfterSnooze,
  nextNudgeAt,
  validSchedule,
  type NudgeState,
  type Schedule,
} from '../shared/schedule';
import type { AppEnv, Env } from './env';
import { currentUser, optionalUser } from './lib/auth';
import { ApiError, readJson, type JsonObject } from './lib/http';
import { isValidClientKeys, sendPush, type PushTarget, type VapidKeys } from './webpush';

export interface DeviceRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string;
  tz: string;
  interval_min: number;
  start_min: number;
  end_min: number;
  smart: number;
  last_sip_at: number | null;
  quiet_until: number | null;
  next_at: number;
  last_nudge_at: number | null;
  last_test_at: number | null;
  fails: number;
  /** The account this phone was signed into when it last subscribed or synced; null when none. */
  user_id: string | null;
}

const MIN = 60_000;
const BATCH = 200;
export const MAX_FAILS = 10;

// Only real browser push services; stops the worker from being used to POST to arbitrary URLs.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

const bad = (message: string, status = 400) => new ApiError('validation', message, status);

export function checkEndpoint(endpoint: unknown, env: Env): string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) throw bad('Bad endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw bad('Bad endpoint');
  }
  if (env.ALLOW_ANY_PUSH_HOST === 'true') {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw bad('Bad endpoint');
    return endpoint;
  }
  if (url.protocol !== 'https:') throw bad('Endpoint must be https');
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) throw bad('Unknown push service');
  return endpoint;
}

export async function deviceId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A timestamp from the client, or null if missing or implausible. */
function clientTime(v: unknown, now: number, maxFuture: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < now - 30 * 24 * 60 * MIN || v > now + maxFuture) return null;
  return Math.floor(v);
}

function readState(raw: unknown, now: number): NudgeState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    lastSipAt: clientTime(o.lastSipAt, now, MIN),
    quietUntil: clientTime(o.quietUntil, now, 2 * 24 * 60 * MIN),
  };
}

function scheduleOf(row: DeviceRow): Schedule {
  return { intervalMin: row.interval_min, startMin: row.start_min, endMin: row.end_min, tz: row.tz, smart: row.smart === 1 };
}

function stateOf(row: DeviceRow): NudgeState {
  return { lastSipAt: row.last_sip_at, quietUntil: row.quiet_until };
}

/** VAPID keys for a push to `row`; the contact is VAPID_SUBJECT or the app's own origin. */
export function vapidFor(env: Env, row: Pick<DeviceRow, 'origin'>): VapidKeys {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new ApiError('internal', 'VAPID keys are not configured');
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || row.origin };
}

async function getDevice(env: Env, endpoint: string): Promise<DeviceRow> {
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(await deviceId(endpoint)).first<DeviceRow>();
  if (!row) throw new ApiError('not_found', 'Unknown device');
  return row;
}

// --- API -------------------------------------------------------------------

async function subscribe(body: JsonObject, env: Env, origin: string, userId: string | null, now: number): Promise<{ nextAt: number }> {
  const sub = (body.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = checkEndpoint(sub.endpoint, env);
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !isValidClientKeys(p256dh, auth)) throw bad('Bad subscription keys');
  if (!validSchedule(body.schedule)) throw bad('Bad schedule');
  const schedule = body.schedule;
  const state = readState(body.state, now);
  const nextAt = nextNudgeAt(now, schedule, state);
  const id = await deviceId(endpoint);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO devices (id, endpoint, p256dh, auth, origin, tz, interval_min, start_min, end_min, smart,
         last_sip_at, quiet_until, next_at, fails, created_at, updated_at, user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?14, ?15)
       ON CONFLICT (id) DO UPDATE SET p256dh = ?3, auth = ?4, origin = ?5, tz = ?6, interval_min = ?7,
         start_min = ?8, end_min = ?9, smart = ?10, last_sip_at = ?11, quiet_until = ?12, next_at = ?13,
         fails = 0, updated_at = ?14, user_id = ?15`,
    ).bind(
      id, endpoint, p256dh, auth, origin, schedule.tz, schedule.intervalMin, schedule.startMin, schedule.endMin,
      schedule.smart ? 1 : 0, state.lastSipAt ?? null, state.quietUntil ?? null, nextAt, now, userId,
    ),
  ];
  if (typeof body.oldEndpoint === 'string' && body.oldEndpoint !== endpoint) {
    stmts.push(env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(await deviceId(body.oldEndpoint)));
  }
  await env.DB.batch(stmts);
  return { nextAt };
}

async function sync(body: JsonObject, env: Env, userId: string | null, now: number): Promise<{ nextAt: number }> {
  const row = await getDevice(env, checkEndpoint(body.endpoint, env));
  let schedule = scheduleOf(row);
  if (body.schedule !== undefined) {
    if (!validSchedule(body.schedule)) throw bad('Bad schedule');
    schedule = body.schedule;
  }
  const state = body.state !== undefined ? readState(body.state, now) : stateOf(row);
  const nextAt = nextNudgeAt(now, schedule, state);
  await env.DB.prepare(
    `UPDATE devices SET tz = ?, interval_min = ?, start_min = ?, end_min = ?, smart = ?, last_sip_at = ?,
       quiet_until = ?, next_at = ?, updated_at = ?, user_id = ? WHERE id = ?`,
  )
    .bind(
      schedule.tz, schedule.intervalMin, schedule.startMin, schedule.endMin, schedule.smart ? 1 : 0,
      state.lastSipAt ?? null, state.quietUntil ?? null, nextAt, now, userId, row.id,
    )
    .run();
  return { nextAt };
}

async function snooze(body: JsonObject, env: Env, now: number): Promise<{ nextAt: number }> {
  const row = await getDevice(env, checkEndpoint(body.endpoint, env));
  const minutes = Number.isInteger(body.minutes) ? Math.min(180, Math.max(5, body.minutes as number)) : 15;
  const nextAt = nextAfterSnooze(now, minutes, scheduleOf(row));
  await env.DB.prepare('UPDATE devices SET next_at = ?, updated_at = ? WHERE id = ?').bind(nextAt, now, row.id).run();
  return { nextAt };
}

async function testNudge(body: JsonObject, env: Env, now: number): Promise<{ ok: boolean; status: number }> {
  const row = await getDevice(env, checkEndpoint(body.endpoint, env));
  if (row.last_test_at && now - row.last_test_at < 20_000) throw new ApiError('rate_limited', 'Gerald needs a moment');
  await env.DB.prepare('UPDATE devices SET last_test_at = ? WHERE id = ?').bind(now, row.id).run();
  const res = await sendPush(row, { type: 'test', ...TEST_NUDGE }, vapidFor(env, row), { ttl: 300, urgency: 'high' });
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(row.id).run();
    throw new ApiError('not_found', 'Subscription expired', 410);
  }
  return { ok: res.ok, status: res.status };
}

async function unsubscribe(body: JsonObject, env: Env): Promise<{ ok: true }> {
  const endpoint = checkEndpoint(body.endpoint, env);
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(await deviceId(endpoint)).run();
  return { ok: true };
}

/** Mounted at /api. A signed-in phone (session cookie) is linked to its account on subscribe and sync. */
export const pushRoutes = new Hono<AppEnv>();

pushRoutes.use('*', optionalUser);

pushRoutes.get('/config', (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) throw new ApiError('internal', 'Push is not configured', 503);
  return c.json({ vapidPublicKey: c.env.VAPID_PUBLIC_KEY });
});

pushRoutes.post('/subscribe', async (c) => {
  const body = await readJson(c);
  return c.json(await subscribe(body, c.env, new URL(c.req.url).origin, currentUser(c)?.id ?? null, Date.now()));
});

pushRoutes.post('/sync', async (c) => c.json(await sync(await readJson(c), c.env, currentUser(c)?.id ?? null, Date.now())));
pushRoutes.post('/snooze', async (c) => c.json(await snooze(await readJson(c), c.env, Date.now())));
pushRoutes.post('/test', async (c) => c.json(await testNudge(await readJson(c), c.env, Date.now())));
pushRoutes.post('/unsubscribe', async (c) => c.json(await unsubscribe(await readJson(c), c.env)));

// --- Cron ------------------------------------------------------------------

async function nudge(env: Env, row: DeviceRow, now: number): Promise<D1PreparedStatement> {
  const hoursSinceSip = row.smart && row.last_sip_at ? (now - row.last_sip_at) / 3_600_000 : null;
  const line = pickNudge(hoursSinceSip, now / MIN + row.id.charCodeAt(0));
  let status = 0;
  try {
    const res = await sendPush(row as PushTarget, { type: 'nudge', ...line }, vapidFor(env, row), { ttl: 3600 });
    status = res.status;
  } catch (err) {
    console.error('push failed', row.id.slice(0, 8), err);
  }

  if (status >= 200 && status < 300) {
    const next = nextAfterNudge(now, scheduleOf(row), stateOf(row));
    return env.DB.prepare('UPDATE devices SET next_at = ?, last_nudge_at = ?, fails = 0 WHERE id = ?').bind(next, now, row.id);
  }
  // Gone, or the VAPID key no longer matches: the subscription is dead.
  if (status === 404 || status === 410 || status === 403 || row.fails + 1 >= MAX_FAILS) {
    return env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(row.id);
  }
  console.warn('push not accepted', row.id.slice(0, 8), status);
  return env.DB.prepare('UPDATE devices SET next_at = ?, fails = fails + 1 WHERE id = ?').bind(now + 15 * MIN, row.id);
}

export async function runDueNudges(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare('SELECT * FROM devices WHERE next_at <= ? ORDER BY next_at LIMIT ?')
    .bind(now, BATCH)
    .all<DeviceRow>();
  if (!results.length) return 0;
  const updates: D1PreparedStatement[] = [];
  for (let i = 0; i < results.length; i += 20) {
    updates.push(...(await Promise.all(results.slice(i, i + 20).map((row) => nudge(env, row, now)))));
  }
  await env.DB.batch(updates);
  return results.length;
}
