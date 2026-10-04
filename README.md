# Sipster

Drink water, feed Gerald. Sipster is a pixel-hamster hydration reminder that runs as an
installable web app on your phone. Every glass you log, Gerald gets a sip too. Drink too
little and he turns to dust; drink too much and he becomes a water balloon.

- **Everything stays on your phone.** Drinks and settings live in IndexedDB. No account.
- **Push reminders that work when the app is closed**, via a tiny Cloudflare Worker that
  only knows your reminder schedule and *when* you last drank (never how much).
- **Installable**: Android gets Chrome's own install sheet; iPhone gets an illustrated
  Add to Home Screen guide (iPhone only allows push for home-screen apps).

## How it fits together

```
phone (PWA)                                   Cloudflare Worker (worker/)
├─ src/views/*      intro, home, settings      ├─ serves dist/ (the app)
├─ src/store.ts     IndexedDB: drinks, settings├─ /api/subscribe|sync|snooze|test|unsubscribe
├─ src/sw.ts        service worker: offline,   ├─ D1 table `devices`: push address, schedule,
│                   notifications + buttons    │   last-drink time, next nudge time
└─ src/sync.ts      sends schedule + timestamps└─ cron every minute → Web Push (worker/webpush.ts)
shared/             sprite, schedule maths and Gerald's lines, used by both sides
```

`shared/schedule.ts` decides when the next nudge is: one interval after your last drink
(smart mode) or the last nudge, only inside your active hours, and nothing after you hit
your goal until tomorrow.

## Develop

```bash
npm install
npm run dev            # UI only, http://localhost:5173 (no push, no service worker)
```

Full stack locally (app + API + local database + cron):

```bash
node scripts/gen-vapid.ts --dev-vars                 # local push keys → .dev.vars
npx wrangler d1 migrations apply sipster --local
npm run worker:dev                                    # http://127.0.0.1:8787
node scripts/e2e-push.ts                              # fake phone + fake push service
```

Checks:

```bash
npm test               # unit tests (encryption checked against the http_ece reference)
npm run typecheck
```

Assets: `node scripts/gen-icons.ts` redraws the icons from the sprite;
`node scripts/gen-screenshots.ts` re-captures the install-sheet screenshots (app must be running).

## Deploy

See [DEPLOY.md](DEPLOY.md). About ten minutes on Cloudflare's free plan.
