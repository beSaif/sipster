// End-to-end check of the sign-in plumbing against the locally served build, in a real browser.
// 1. npm run vapid -- --dev-vars (any GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET values in .dev.vars do)
// 2. npm run db:migrate:local   3. npm run worker:dev   4. node scripts/e2e-signin.ts
//
// Wrangler serves assets exactly like production, so this catches what the Worker tests can't: a
// navigation to /api/* answered with index.html instead of by the Worker (assets.run_worker_first).
// Needs Playwright's Chromium (`npx playwright install chromium`) or CHROMIUM=/path/to/chromium.

import { chromium } from 'playwright';

const base = process.env.BASE ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: process.env.CHROMIUM ? ['--no-sandbox'] : [] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

// Google's consent screen links to /privacy as a plain path; it must render before the intro too.
await page.goto(`${base}/privacy`, { waitUntil: 'networkidle' });
check(page.url().endsWith('/#/privacy'), `/privacy becomes #/privacy (${page.url()})`);
check((await page.locator('h1').first().textContent())?.trim() === 'Privacy policy', 'privacy page renders its title');

await page.goto(`${base}/#/account`, { waitUntil: 'networkidle' });
const signIn = page.locator('a.btn.signin');
await signIn.waitFor({ timeout: 10_000 }).catch(() => undefined);
check((await signIn.count()) === 1, 'account screen shows the Sign in with Google button');
check(!(await page.locator('main').textContent())?.includes('isn’t set up'), 'no "isn’t set up" note while the client is configured');

// The link is a navigation: the Worker must answer it with a redirect to Google. Google won't take a
// made-up client, so only where the browser was sent matters.
const [request] = await Promise.all([
  page.waitForRequest((r) => r.url().startsWith('https://accounts.google.com/'), { timeout: 15_000 }).catch(() => null),
  signIn.click(),
]);
check(request !== null, `clicking Sign in leaves for Google (${request ? new URL(request.url()).pathname : 'stayed on the app'})`);
if (request) {
  const u = new URL(request.url());
  check(u.searchParams.get('redirect_uri') === `${base}/api/auth/google/callback`, `redirect_uri is ${u.searchParams.get('redirect_uri')}`);
  check(u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('scope') === 'openid email', 'PKCE and the OpenID scopes are present');
}

// Google's callback is a navigation too: backing out at Google must come back with the explanation.
await page.goto(`${base}/api/auth/google/callback?error=access_denied&state=x`, { waitUntil: 'networkidle' });
check(page.url().endsWith('/#/account'), `cancelled callback lands on the account screen (${page.url()})`);
check(Boolean((await page.locator('[role="alert"]').textContent().catch(() => ''))?.includes('backed out')), 'and explains the cancellation');

await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll browser checks passed');
process.exit(failures.length ? 1 : 0);
