# Deploying Sipster

Sipster runs on Cloudflare's free plan: one Worker serves the app and the push API, a D1
database holds reminder schedules, and a cron trigger sends nudges every minute.

You need a free Cloudflare account and Node 20+.

## 1. Log in

```bash
npm install
npx wrangler login
```

## 2. Create the database

```bash
npx wrangler d1 create sipster
```

Copy the `database_id` it prints into `wrangler.jsonc` (replace the all-zeros id), then
create the table:

```bash
npm run db:migrate
```

## 3. Deploy

```bash
npm run deploy
```

Wrangler prints the address, e.g. `https://sipster.<your-subdomain>.workers.dev`.
The app works now; reminders need step 4.

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

## Custom domain (optional)

Sipster is served at `sipster.codesaif.dev` through the `routes` entry in `wrangler.jsonc`;
Cloudflare creates the DNS record and certificate on deploy. `workers_dev` is set to `true`
there so the workers.dev address keeps working too. To use another domain, change the
pattern (the zone must be in the same Cloudflare account).

Each address is its own app as far as phones are concerned: drinks, settings and
notification permission don't carry over, so on a new address you install and allow
nudges again.

## Updating

The repo is connected to Cloudflare, so every push to `main` builds and deploys the app
and Worker automatically. `npm run deploy` still works for a manual deploy.

Migrations aren't applied by the automatic deploy. When `migrations/` gets a new file:

```bash
npm run db:migrate
```
