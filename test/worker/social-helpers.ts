/**
 * Helpers for the social tests: users and sessions seeded straight into D1 (sign-in has its own tests
 * and helpers), a same-origin JSON client, friendships, linked devices with real keys, and a
 * stand-in push service that records what the Worker sends.
 */
import { env, SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import type { NotificationKind, SocialPush } from '../../shared/api';
import { socialCopy } from '../../shared/copy';
import { randomToken, sha256Hex } from '../../worker/lib/auth';
import { b64urlEncode } from '../../worker/webpush';

export const ORIGIN = 'https://sipster.test';
const DAY_MS = 86_400_000;
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };

type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = (s: string): Bytes => new TextEncoder().encode(s) as Bytes;

// ---- users and requests -----------------------------------------------------

/** Storage is shared by the tests of one file, so each starts from an empty database. */
export async function resetDb(): Promise<void> {
  const tables = ['notifications', 'friendships', 'daily_totals', 'login_codes', 'sessions', 'devices', 'users'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export interface TestUser {
  id: string;
  /** Null for an account that has not picked one yet. */
  username: string | null;
  /** The `Cookie` header value for this user's session. */
  cookie: string;
}

let seq = 0;

/** A user with a live session. The username defaults to a unique one; pass null for a nameless account. */
export async function makeUser(opts: { username?: string | null; social_push?: boolean } = {}): Promise<TestUser> {
  const id = crypto.randomUUID();
  const username = opts.username === undefined ? `user${++seq}` : opts.username;
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, google_sub, email, username, social_push, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, `sub-${id}`, `${id}@example.com`, username, opts.social_push === false ? 0 : 1, now),
    env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), id, now, now + 30 * DAY_MS, 'tests'),
  ]);
  return { id, username, cookie: `sipster_session=${token}` };
}

export interface ApiOptions {
  method?: string;
  /** JSON-encoded; implies POST unless `method` says otherwise. */
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

/** A same-origin request to the Worker under test. */
export function api(path: string, opts: ApiOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Origin: ORIGIN, ...opts.headers };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}${path}`, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
}

export async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

// ---- friendships and notifications, as stored --------------------------------

/** A friendship row from `a` to `b`, accepted unless told otherwise. */
export async function befriend(
  a: TestUser,
  b: TestUser,
  status: 'accepted' | 'pending' = 'accepted',
  createdAt = Date.now(),
): Promise<void> {
  await env.DB.prepare('INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(a.id, b.id, status, createdAt, createdAt)
    .run();
}

export interface FriendshipRow {
  requester_id: string;
  addressee_id: string;
  status: string;
}

/** Every friendship row touching `user`, oldest first. */
export async function friendshipRows(user: TestUser): Promise<FriendshipRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT requester_id, addressee_id, status FROM friendships
      WHERE requester_id = ?1 OR addressee_id = ?1 ORDER BY created_at, requester_id`,
  )
    .bind(user.id)
    .all<FriendshipRow>();
  return results;
}

export interface StoredNotification {
  kind: string;
  actor_id: string | null;
  ref: string | null;
  read_at: number | null;
}

/** `user`'s notifications as stored, oldest first. */
export async function storedNotifications(user: TestUser): Promise<StoredNotification[]> {
  const { results } = await env.DB.prepare(
    'SELECT kind, actor_id, ref, read_at FROM notifications WHERE user_id = ? ORDER BY created_at, kind, ref',
  )
    .bind(user.id)
    .all<StoredNotification>();
  return results;
}

export interface NotificationSeed {
  kind?: string;
  actorId?: string | null;
  ref?: string | null;
  createdAt?: number;
  readAt?: number | null;
}

/** A notification row for `user`, bypassing `notify` (no push). Returns its id. */
export async function seedNotification(user: TestUser, seed: NotificationSeed = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO notifications (id, user_id, kind, actor_id, ref, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      id, user.id, seed.kind ?? 'friend_request', seed.actorId ?? null, seed.ref ?? null,
      seed.createdAt ?? Date.now(), seed.readAt ?? null,
    )
    .run();
  return id;
}

// ---- devices and the push service ----------------------------------------------

export interface TestDevice {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** What the browser keeps to itself: enough to decrypt what the Worker sent. */
  privateKey: CryptoKey;
  publicRaw: Bytes;
  authBytes: Bytes;
}

/** A `devices` row like /api/subscribe makes, with real P-256 keys, linked to `userId` (null: a signed-out phone). Nudges are far off. */
export async function addDevice(userId: string | null, endpoint: string, opts: { fails?: number } = {}): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey(ECDH_P256, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64urlEncode(publicRaw);
  const auth = b64urlEncode(authBytes);
  const id = await sha256Hex(endpoint);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO devices (id, endpoint, p256dh, auth, origin, tz, interval_min, start_min, end_min, smart,
       last_sip_at, quiet_until, next_at, fails, created_at, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, 'Europe/Zurich', 60, 540, 1320, 1, NULL, NULL, ?, ?, ?, ?, ?)`,
  )
    .bind(id, endpoint, p256dh, auth, ORIGIN, now + 365 * DAY_MS, opts.fails ?? 0, now, now, userId)
    .run();
  return { id, endpoint, p256dh, auth, privateKey: pair.privateKey, publicRaw, authBytes };
}

export async function deviceRow(id: string): Promise<{ fails: number; user_id: string | null } | null> {
  return env.DB.prepare('SELECT fails, user_id FROM devices WHERE id = ?').bind(id).first<{ fails: number; user_id: string | null }>();
}

export interface PushCall {
  url: string;
  method: string;
  headers: Headers;
  body: Bytes;
}

/**
 * Stands in for the push services. The Worker under test runs in this isolate, so replacing the global
 * fetch catches its outbound POSTs (`SELF.fetch` is a binding and unaffected). `status` may depend on
 * the URL. Restore with the returned function or `vi.restoreAllMocks()`.
 */
export function mockPush(status: number | ((url: string) => number) = 201): { calls: PushCall[]; restore: () => void } {
  const calls: PushCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(null, { status: typeof status === 'function' ? status(req.url) : status });
  });
  return { calls, restore: () => spy.mockRestore() };
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** The payload `notify` is expected to encrypt for a `kind` of notification about `username`. */
export function socialPush(kind: NotificationKind, username: string): SocialPush {
  return { type: 'social', kind, ...socialCopy(kind, username), url: '/#/inbox' };
}

/** The browser's side of RFC 8291: the payload the service worker would be handed. */
export async function decryptPush(call: PushCall, dev: TestDevice): Promise<SocialPush> {
  const body = call.body;
  const salt = body.slice(0, 16);
  const keyIdLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);
  const asKey = await crypto.subtle.importKey('raw', asPublic, ECDH_P256, false, []);
  const ecdh = { name: 'ECDH', public: asKey };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, dev.privateKey, 256));
  const ikm = await hkdf(dev.authBytes, shared, concat(utf8('WebPush: info\0'), dev.publicRaw, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  // The record ends with the 0x02 delimiter; the Worker adds no padding after it.
  return JSON.parse(new TextDecoder().decode(record.slice(0, -1))) as SocialPush;
}
