// End-to-end check of the push worker against a fake push service.
// 1. npm run vapid -- --dev-vars   2. npm run db:migrate:local
// 3. npm run worker:dev            4. node scripts/e2e-push.ts
//
// Subscribes a fake phone, fires the cron, and decrypts what arrives exactly like a browser would.

import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import ece from 'http_ece';

const WORKER = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';
const PUSH_PORT = 9999;

interface Received {
  headers: IncomingMessage['headers'];
  body: Buffer;
}

const received: Received[] = [];
let replyStatus = 201;
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(replyStatus).end();
  });
});
await new Promise<void>((r) => server.listen(PUSH_PORT, '127.0.0.1', r));

const ua = createECDH('prime256v1');
ua.generateKeys();
const auth = randomBytes(16);
const endpoint = `http://127.0.0.1:${PUSH_PORT}/push/${randomBytes(6).toString('hex')}`;
const schedule = { intervalMin: 15, startMin: 0, endMin: 0, tz: 'Europe/Zurich', smart: true };

let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
}

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(WORKER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

function sql(command: string): string {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'sipster', '--local', '--json', '--command', command], { encoding: 'utf8' });
}

async function waitForPush(count: number): Promise<Received | undefined> {
  for (let i = 0; i < 50 && received.length < count; i++) await new Promise((r) => setTimeout(r, 100));
  return received[count - 1];
}

function decrypt(msg: Received): Record<string, string> {
  return JSON.parse(ece.decrypt(msg.body, { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString('utf8'));
}

try {
  const now = Date.now();
  const sub = await post('/api/subscribe', {
    subscription: { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    schedule,
    state: { lastSipAt: now - 20 * 60_000, quietUntil: null },
  });
  check(sub.status === 200, `subscribe → ${sub.status}`);
  const nextAt = sub.data.nextAt as number;
  check(Math.abs(nextAt - (now + 60_000)) < 5_000, 'smart schedule: last sip 20 min ago, 15 min interval → nudge in ~1 min');

  const bad = await post('/api/subscribe', { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } }, schedule });
  check(bad.status === 400, `junk keys rejected → ${bad.status}`);

  // Make the nudge due and fire the cron.
  sql(`UPDATE devices SET next_at = 0 WHERE endpoint = '${endpoint}'`);
  await fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`);
  const nudge = await waitForPush(1);
  check(!!nudge, 'cron delivered a push to the push service');
  if (nudge) {
    check(nudge.headers['content-encoding'] === 'aes128gcm', 'Content-Encoding: aes128gcm');
    check(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(String(nudge.headers.authorization)), 'VAPID Authorization header');
    const msg = decrypt(nudge);
    check(msg.type === 'nudge' && typeof msg.title === 'string', `decrypted nudge: “${msg.title}”`);
  }
  const row = JSON.parse(sql(`SELECT next_at, last_nudge_at FROM devices WHERE endpoint = '${endpoint}'`))[0].results[0];
  check(row && row.next_at > Date.now() + 14 * 60_000, 'next nudge rescheduled one interval later');

  const snooze = await post('/api/snooze', { endpoint, minutes: 15 });
  check(snooze.status === 200 && Math.abs((snooze.data.nextAt as number) - (Date.now() + 15 * 60_000)) < 5_000, 'snooze → +15 min');

  const test = await post('/api/test', { endpoint });
  const testMsg = await waitForPush(2);
  check(test.status === 200 && !!testMsg && decrypt(testMsg).type === 'test', 'test nudge delivered');
  const again = await post('/api/test', { endpoint });
  check(again.status === 429, `test nudge rate-limited → ${again.status}`);

  // A subscription the push service says is gone gets cleaned up.
  replyStatus = 410;
  sql(`UPDATE devices SET next_at = 0 WHERE endpoint = '${endpoint}'`);
  await fetch(`${WORKER}/__scheduled?cron=*+*+*+*+*`);
  await waitForPush(3);
  await new Promise((r) => setTimeout(r, 500));
  const gone = await post('/api/sync', { endpoint, state: {} });
  check(gone.status === 404, `expired subscription deleted → sync ${gone.status}`);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll push checks passed');
process.exit(failures ? 1 : 0);
