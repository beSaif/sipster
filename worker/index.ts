// Sipster push worker: serves the app, stores reminder schedules, sends nudges on a cron.

import { pickNudge, TEST_NUDGE } from '../shared/copy';
import {
  nextAfterNudge,
  nextAfterSnooze,
  nextNudgeAt,
  validSchedule,
  type NudgeState,
  type Schedule,
} from '../shared/schedule';
import { isValidClientKeys, sendPush, type PushTarget, type VapidKeys } from './webpush';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** Optional "mailto:" / "https:" contact; defaults to the app's own origin. */
  VAPID_SUBJECT?: string;
  /** "true" lets any http(s) endpoint subscribe (local testing only). */
  ALLOW_ANY_PUSH_HOST?: string;
}

interface DeviceRow {
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
}

const MIN = 60_000;
const MAX_BODY = 8 * 1024;
const BATCH = 200;
const MAX_FAILS = 10;

// Only real browser push services; stops the worker from being used to POST to arbitrary URLs.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Body too large');
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Expected a JSON object');
}

function checkEndpoint(endpoint: unknown, env: Env): string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) throw new HttpError(400, 'Bad endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'Bad endpoint');
  }
  if (env.ALLOW_ANY_PUSH_HOST === 'true') {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Bad endpoint');
    return endpoint;
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'Endpoint must be https');
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) throw new HttpError(400, 'Unknown push service');
  return endpoint;
}

async function deviceId(endpoint: string): Promise<string> {
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

function vapidFor(env: Env, row: DeviceRow): VapidKeys {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new HttpError(500, 'VAPID keys are not configured');
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || row.origin };
}

async function getDevice(env: Env, endpoint: string): Promise<DeviceRow> {
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(await deviceId(endpoint)).first<DeviceRow>();
  if (!row) throw new HttpError(404, 'Unknown device');
  return row;
}

// --- API -------------------------------------------------------------------

async function subscribe(request: Request, env: Env, now: number): Promise<Response> {
  const body = await readJson(request);
  const sub = (body.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = checkEndpoint(sub.endpoint, env);
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !isValidClientKeys(p256dh, auth)) {
    throw new HttpError(400, 'Bad subscription keys');
  }
  if (!validSchedule(body.schedule)) throw new HttpError(400, 'Bad schedule');
  const schedule = body.schedule;
  const state = readState(body.state, now);
  const nextAt = nextNudgeAt(now, schedule, state);
  const id = await deviceId(endpoint);
  const origin = new URL(request.url).origin;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO devices (id, endpoint, p256dh, auth, origin, tz, interval_min, start_min, end_min, smart,
         last_sip_at, quiet_until, next_at, fails, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?14)
       ON CONFLICT (id) DO UPDATE SET p256dh = ?3, auth = ?4, origin = ?5, tz = ?6, interval_min = ?7,
         start_min = ?8, end_min = ?9, smart = ?10, last_sip_at = ?11, quiet_until = ?12, next_at = ?13,
         fails = 0, updated_at = ?14`,
    ).bind(
      id, endpoint, p256dh, auth, origin, schedule.tz, schedule.intervalMin, schedule.startMin, schedule.endMin,
      schedule.smart ? 1 : 0, state.lastSipAt ?? null, state.quietUntil ?? null, nextAt, now,
    ),
  ];
  if (typeof body.oldEndpoint === 'string' && body.oldEndpoint !== endpoint) {
    stmts.push(env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(await deviceId(body.oldEndpoint)));
  }
  await env.DB.batch(stmts);
  return json({ nextAt });
}

async function sync(request: Request, env: Env, now: number): Promise<Response> {
  const body = await readJson(request);
  const row = await getDevice(env, checkEndpoint(body.endpoint, env));
  let schedule = scheduleOf(row);
  if (body.schedule !== undefined) {
    if (!validSchedule(body.schedule)) throw new HttpError(400, 'Bad schedule');
    schedule = body.schedule;
  }
  const state = body.state !== undefined ? readState(body.state, now) : stateOf(row);
  const nextAt = nextNudgeAt(now, schedule, state);
  await env.DB.prepare(
    `UPDATE devices SET tz = ?, interval_min = ?, start_min = ?, end_min = ?, smart = ?, last_sip_at = ?,
       quiet_until = ?, next_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      schedule.tz, schedule.intervalMin, schedule.startMin, schedule.endMin, schedule.smart ? 1 : 0,
      state.lastSipAt ?? null, state.quietUntil ?? null, nextAt, now, row.id,
    )
    .run();
  return json({ nextAt });
}

async function snooze(request: Request, env: Env, now: number): Promise<Response> {
  const body = await readJson(request);
  const row = await getDevice(env, checkEndpoint(body.endpoint, env));
  const minutes = Number.isInteger(body.minutes) ? Math.min(180, Math.max(5, body.minutes as number)) : 15;
  const nextAt = nextAfterSnooze(now, minutes, scheduleOf(row));
  await env.DB.prepare('UPDATE devices SET next_at = ?, updated_at = ? WHERE id = ?').bind(nextAt, now, row.id).run();
  return json({ nextAt });
}

async function testNudge(request: Request, env: Env, now: number): Promise<Response> {
  const body = await readJson(request);
  const row = await getDevice(env, checkEndpoint(body.endpoint, env));
  if (row.last_test_at && now - row.last_test_at < 20_000) throw new HttpError(429, 'Gerald needs a moment');
  await env.DB.prepare('UPDATE devices SET last_test_at = ? WHERE id = ?').bind(now, row.id).run();
  const res = await sendPush(row, { type: 'test', ...TEST_NUDGE }, vapidFor(env, row), { ttl: 300, urgency: 'high' });
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(row.id).run();
    throw new HttpError(410, 'Subscription expired');
  }
  return json({ ok: res.ok, status: res.status });
}

async function unsubscribe(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const endpoint = checkEndpoint(body.endpoint, env);
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(await deviceId(endpoint)).run();
  return json({ ok: true });
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const now = Date.now();
  if (path === '/api/config' && request.method === 'GET') {
    if (!env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'Push is not configured');
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  switch (path) {
    case '/api/subscribe':
      return subscribe(request, env, now);
    case '/api/sync':
      return sync(request, env, now);
    case '/api/snooze':
      return snooze(request, env, now);
    case '/api/test':
      return testNudge(request, env, now);
    case '/api/unsubscribe':
      return unsubscribe(request, env);
  }
  throw new HttpError(404, 'Not found');
}

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

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, path);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runDueNudges(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
