// Sipster Worker: serves the app, stores reminder schedules and sends nudges on a cron; with an
// account (Sign in with Google) it also keeps friends, daily totals, the leaderboard and
// notifications. docs/SOCIAL.md is the contract.

import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { sameOriginGuard } from './lib/auth';
import { handleError } from './lib/http';
import { pushRoutes, runDueNudges } from './push';
import { authRoutes } from './routes/auth';
import { friendsRoutes } from './routes/friends';
import { leaderboardRoutes } from './routes/leaderboard';
import { notificationsRoutes } from './routes/notifications';
import { totalsRoutes } from './routes/totals';

export type { Env } from './env';

const app = new Hono<AppEnv>();

app.onError(handleError);

app.use('/api/*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
});
app.use('/api/*', sameOriginGuard);

app.get('/api/health', (c) => c.json({ ok: true, name: 'sipster' }));
app.route('/api/auth', authRoutes);
app.route('/api/friends', friendsRoutes);
app.route('/api/leaderboard', leaderboardRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/totals', totalsRoutes);
app.route('/api', pushRoutes);

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

const DAY_MS = 86_400_000;

/** Once an hour: forget expired sessions and codes, and notifications nobody will scroll back to. */
export async function housekeeping(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM notifications WHERE created_at < ?').bind(now - 60 * DAY_MS),
  ]);
}

export async function runScheduled(env: Env, now: number): Promise<void> {
  await runDueNudges(env, now);
  if (new Date(now).getUTCMinutes() === 0) await housekeeping(env, now);
}

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

export { app };
