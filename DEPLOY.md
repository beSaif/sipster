# Deploying Sipster

Sipster runs on Cloudflare's free plan: one Worker serves the app and the API, a D1 database
holds reminder schedules and, for people who sign in, accounts, friends and daily totals, and
a cron trigger sends nudges every minute.

You need a free Cloudflare account and Node 22 or newer (the scripts are TypeScript that Node
runs directly).

## 1. Log in

```bash
npm install
npx wrangler login
```

## 2. Create the database

```bash
npx wrangler d1 create sipster
```

Copy the `database_id` it prints into `wrangler.jsonc` (replace the id there with yours), then
create the tables:

```bash
npm run db:migrate
```

## 3. Deploy

```bash
npm run deploy
```

Wrangler prints the address, e.g. `https://sipster.<your-subdomain>.workers.dev`.
The app works now; reminders need step 4, friends need step 6.

## 4. Push keys

```bash
npm run vapid
```

It prints two keys. Store each one when asked:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

Keep the private key secret and don't change the keys later: every phone would be
unsubscribed. Push services are given the app's address as the contact; to use an email
instead, also set `npx wrangler secret put VAPID_SUBJECT` to `mailto:you@example.com`.

## 5. Try it on your phone

- **Android (Chrome):** open the address, go through the intro, tap **Install Sipster**,
  then **Allow notifications**. In Settings, **Send a test nudge**.
- **iPhone (iOS 16.4+):** open the address in Safari, follow the Add to Home Screen steps,
  then open Sipster **from the home screen** (it starts fresh there, that's normal) and
  allow notifications. iPhone notifications have no action buttons; tapping opens the app.

## 6. Sign in with Google (optional)

Friends and the leaderboard need an account, and accounts need a Google OAuth client. Until
the two secrets below exist, everything else works and the sign-in button says sign-in isn't
set up.

1. In the [Google Cloud console](https://console.cloud.google.com), create a project and
   configure its **OAuth consent screen**: user type External, scopes `openid` and `email`,
   app home page `https://sipster.codesaif.dev`, privacy policy
   `https://sipster.codesaif.dev/privacy` (the app serves it there). While the app is in
   "Testing", only the test users you list can sign in; publishing it lifts that.
2. Create an OAuth client of type **Web application** with these authorized redirect URIs:
   - `https://sipster.codesaif.dev/api/auth/google/callback`
   - `https://sipster.<your-subdomain>.workers.dev/api/auth/google/callback`
   - for development, `http://127.0.0.1:8787/api/auth/google/callback`

   Every address you serve the app from needs its callback here, or Google refuses the sign-in.
3. Store the client id and secret (paste each one when asked):

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

The account tables (`migrations/0002_accounts.sql`) were created by `npm run db:migrate` in
step 2. If you are upgrading an app deployed before accounts existed, see "Updating" below:
migrate first, then deploy.

To close sign-ups later, add `"vars": { "SIGNUPS_ENABLED": "false" }` to `wrangler.jsonc`:
only Google accounts that already have a Sipster account get in.

## Custom domain (optional)

Sipster is served at `sipster.codesaif.dev` through the `routes` entry in `wrangler.jsonc`;
Cloudflare creates the DNS record and certificate on deploy. `workers_dev` is set to `true`
there so the workers.dev address keeps working too. To use another domain, change the
pattern (the zone must be in the same Cloudflare account) and update the home page, privacy
policy and redirect URIs from step 6.

Each address is its own app as far as phones are concerned: drinks, settings, notification
permission and sign-in don't carry over, so on a new address you install, allow nudges and
sign in again.

## Updating

The repo is connected to Cloudflare, so every push to `main` builds and deploys the app and
Worker automatically. `npm run deploy` still works for a manual deploy.

Migrations aren't applied by the automatic deploy, and the new Worker may need the new schema
from its first request. So when a change adds a file to `migrations/`, migrate **first**, then
push: our migrations only add tables and columns, which does the Worker that is still live no
harm.

```bash
npm run db:migrate      # 1. against the live database, while the old Worker still runs
                        # 2. then merge / push to main, which deploys
```

The accounts work is the current example. `npm run db:migrate` applies
`migrations/0002_accounts.sql` (`users`, `sessions`, `daily_totals`, `friendships`,
`notifications`, and a `user_id` column on `devices`); then merge to `main`; then store
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as in step 6 (before or after the merge, sign-in
simply stays off until both exist). Merging before migrating breaks nudge syncing until the
migration lands, because the new Worker writes `devices.user_id`.
