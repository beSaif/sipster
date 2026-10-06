# Sipster

Drink water, feed Gerald. Sipster is a pixel-hamster hydration reminder that runs as an
installable web app on your phone. Every glass you log, Gerald gets a sip too. Drink too
little and he turns to dust; drink too much and he becomes a water balloon.

- **No account needed.** Drinks and settings live in IndexedDB on your phone.
- **Push reminders that work when the app is closed**, via a tiny Cloudflare Worker that
  only knows your reminder schedule and *when* you last drank.
- **Friends, if you want them.** Sign in with Google to pick a username, add friends and see
  who's leading. Only then do your daily totals (ml and goal, per day) reach the server;
  individual drinks never do.
- **Installable**: Android gets Chrome's own install sheet; iPhone gets an illustrated
  Add to Home Screen guide (iPhone only allows push for home-screen apps).

## How it fits together

```
phone (PWA, hash router)                       Cloudflare Worker (worker/, Hono) + D1
├─ src/views/*      intro, home, settings,     ├─ serves dist/ (the app)
│                   account, friends, inbox    ├─ /api/subscribe|sync|snooze|test|unsubscribe
├─ src/store.ts     IndexedDB: drinks, settings├─ /api/auth/*: Google sign-in, sessions, username
├─ src/sync.ts      sends schedule + timestamps├─ /api/friends/*: request, accept, decline, remove
├─ src/account.ts   who is signed in (cached)  ├─ /api/leaderboard: you + friends, today / week
├─ src/social.ts    sends daily totals         ├─ /api/totals: daily totals (ml + goal per day)
└─ src/sw.ts        service worker: offline,   ├─ /api/notifications: list, mark read
                    nudges, social pushes      ├─ D1: `devices` (push address, schedule, when you
                                               │   last drank, next nudge), `users`, `sessions`,
                                               │   `daily_totals`, `friendships`, `notifications`
                                               └─ cron every minute → Web Push (worker/webpush.ts)
shared/             sprite, schedule maths, Gerald's lines, API types and username rules,
                    used by both sides
```

`shared/schedule.ts` decides when the next nudge is: one interval after your last drink
(smart mode) or the last nudge, only inside your active hours, and nothing after you hit
your goal until tomorrow.

The Worker is a [Hono](https://hono.dev) app. Everything to do with accounts, friends, the
leaderboard and notifications is specified in [docs/SOCIAL.md](docs/SOCIAL.md); when the code
and that document disagree, one of them is wrong.

## Friends & leaderboard

Signing in is optional and Google only. The first time, you pick a username; that username is
the only thing anyone else can ever learn about you, and only by typing it exactly. Add a
friend by their username and they get a request to accept or decline (if you both ask, you're
cage-mates straight away). Friendships are mutual and nothing is public: you only ever see the
totals of friends who accepted, and they only see yours.

The leaderboard ranks you and your friends by percent of goal. **Today** is how much of the
day's goal each of you has drunk so far. **This week** is that percentage averaged over the
last seven days (a day without drinks counts as zero), plus how many of those days hit the
goal. Ties go to whoever drank more. "Today" means everyone's own local date, so a friend in
another time zone is compared by calendar day, as a daily score should be.

For this to work, a signed-in phone sends its daily totals, ml and goal per day, after every
drink (and the last 30 days once per app start, so a new account's week isn't empty). Friend
requests, acceptances and a friend reaching their goal land in the inbox (the bell on the home
screen) and, when the Account card's toggle is on, arrive as push notifications too. Gerald
narrates.

## Develop

```bash
npm install
npm run dev            # UI only, http://localhost:5173 (no push, no service worker)
```

Full stack locally (app + API + local database + cron):

```bash
npm run vapid -- --dev-vars      # local push keys → .dev.vars (see .dev.vars.example)
npm run db:migrate:local         # local D1: devices + the account tables
npm run worker:dev               # http://127.0.0.1:8787, built app + API + cron
node scripts/e2e-push.ts         # fake phone + fake push service
```

`npm run dev` proxies `/api` to :8787, so with `npm run worker:dev` running next to it you get
hot reload on :5173 and the real API behind it.

Signing in locally needs a Google OAuth client ([DEPLOY.md](DEPLOY.md), step 6) with
`http://127.0.0.1:8787/api/auth/google/callback` and
`http://localhost:5173/api/auth/google/callback` among its redirect URIs. Put its
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars` (`.dev.vars.example` shows the
shape; `npm run vapid -- --dev-vars` adds the placeholder lines and keeps whatever you filled
in). Without them everything else works and the sign-in button says sign-in isn't set up.

Checks:

```bash
npm test               # node unit tests (encryption checked against the http_ece reference)
                       # + Worker tests in workerd with a real D1 (@cloudflare/vitest-pool-workers)
npm run test:worker    # only the Worker tests; npm run test:unit for only the node ones
npm run typecheck
```

Assets: `node scripts/gen-icons.ts` redraws the icons from the sprite;
`node scripts/gen-screenshots.ts` re-captures the install-sheet screenshots (app must be running).

## Privacy

Without an account, the Worker only ever holds a push address, your reminder schedule and when
you last drank, enough to time the nudges and never how much. Signed in, the server also keeps
your Google account id, your email (shown to nobody but you), your username, your daily totals
(ml and goal per day), your friendships and your notifications. Individual drinks stay in
IndexedDB either way. Sign-in is Google's OpenID Connect flow run by the Worker, with no Google
script on the page. Deleting the account removes everything the server has about you; Gerald
and your drinks stay on the phone. The full policy is at
[`/privacy`](https://sipster.codesaif.dev/privacy).

## Deploy

See [DEPLOY.md](DEPLOY.md). About ten minutes on Cloudflare's free plan.
