# Accounts, friends and the leaderboard

Sipster stays a local-first app: drinks and settings live on the phone and nudges work without an
account. This document describes the optional social layer on top: **Sign in with Google**, a
**username**, **friends** (request / accept), a **leaderboard** (today and this week) and
**notifications** (in-app and push) for friend requests, acceptances and friends reaching their goal.

It is the contract between the Worker (`worker/`), the app (`src/`) and the shared types
(`shared/api.ts`). When code and this document disagree, fix one of them.

## 1. Goals and non-goals

- Signing in is optional. Nothing that works today starts requiring an account.
- Signing in is Google only, done the way Tally does it: OpenID Connect authorization-code flow with
  PKCE, run by the Worker. No Google script on the page; the Worker only learns the account id and the
  verified email.
- With an account, the phone sends the server **daily totals** (ml and goal per local day) so friends
  can compare. Individual drinks never leave the phone. This changes the old "never how much" promise
  for signed-in users only; README and the privacy page say so.
- Friends are symmetric: a request has to be accepted. Nothing is public; you only ever see your
  accepted friends' totals.
- Non-goals: public profiles, search by name beyond exact username, chat, groups, streak history
  beyond seven days.

## 2. How it fits together

```
phone (PWA, hash router)                      Cloudflare Worker (Hono) + D1
├─ #/account   sign in · pick username ·      ├─ /api/auth/*          Google OIDC, sessions, username, account
│              sign out · delete account      ├─ /api/friends/*       request / accept / decline / remove
├─ #/friends   leaderboard + friends          ├─ /api/leaderboard     you + friends, today and 7 days
├─ #/inbox     notifications                  ├─ /api/totals          daily totals (ml, goal) per local day
├─ src/account.ts  session state              ├─ /api/notifications   list, mark read
├─ src/social.ts   sends daily totals         ├─ /api/subscribe|sync|snooze|test|unsubscribe (unchanged,
└─ src/sw.ts   shows social pushes            │                        now linked to the account when signed in)
                                              └─ cron: nudges every minute, housekeeping hourly
```

The Worker moved from a hand-rolled switch to [Hono](https://hono.dev) so the auth code from Tally
ports almost verbatim (`hono/cookie`, middleware). The push endpoints keep their paths and bodies;
only the error shape changed to `{ error: { code, message } }` everywhere.

## 3. Data model (`migrations/0002_accounts.sql`)

| Table | Purpose |
| --- | --- |
| `users` | `id`, `google_sub` (unique), `email` (unique, lower-cased), `username` (unique, case-insensitive, NULL until chosen), `social_push` (1/0), `created_at` |
| `sessions` | `id` = sha256(token) hex, `user_id`, `created_at`, `expires_at`, `user_agent`. 30 days, sliding renewal under 15 days left (one write per session and day at most) |
| `login_codes` | one-time handoff codes after sign-in: `id` = sha256(code), `user_id`, `expires_at` (2 minutes) |
| `daily_totals` | `(user_id, day)` → `ml`, `goal_ml`, `updated_at`. `day` is the user's local date `YYYY-MM-DD` as the phone reports it |
| `friendships` | `(requester_id, addressee_id)` → `status` `pending` \| `accepted`, `created_at`, `updated_at`. One row per pair, never both directions |
| `notifications` | `id`, `user_id` (recipient), `kind`, `actor_id`, `ref` (goal_reached: the day), `created_at`, `read_at` |
| `devices` | unchanged, plus `user_id` (nullable, `ON DELETE SET NULL`): the account the phone was signed into when it last subscribed or synced |

Deleting a user cascades to sessions, codes, totals, friendships and notifications; devices are kept
and unlinked, so nudges keep coming after an account is deleted.

## 4. API

All endpoints are same-origin JSON. Mutations must send `Content-Type: application/json`; the Worker
refuses cross-origin mutations (Origin header check) and never caches `/api/*`. Errors are
`{ error: { code, message } }` with codes `unauthorized` 401, `validation` 400, `not_found` 404,
`conflict` 409, `rate_limited` 429, `forbidden` 403, `internal` 500. Types for every body are in
`shared/api.ts`.

Endpoints marked 🔒 need the session cookie (`requireUser`), else 401. Endpoints marked 🔒👤 also need
a username (403 `forbidden` otherwise): you cannot add friends or appear on a leaderboard nameless.

### Account (`worker/routes/auth.ts`)

| Method & path | Body → answer |
| --- | --- |
| `GET /api/auth/google/start` | 302 to Google. Sets the `sipster_oauth` cookie (`state.nonce.verifier`, HttpOnly, SameSite=Lax, Path=/api/auth/google, 10 min). Scope `openid email`, `prompt=select_account`, PKCE S256 |
| `GET /api/auth/google/callback` | Checks state, swaps the code for an ID token (client secret + verifier), validates `iss`, `aud`, `exp`, `nonce`, `sub`, `email_verified`. Finds the user by `google_sub` or creates one (no username yet; refused with `signups_disabled` when `SIGNUPS_ENABLED` is `"false"`). Follows a changed email unless another account has it. Replaces any session it signs in over. Sets the session cookie, mints a login code and redirects to `/#/account?claim=<code>`. Failures redirect to `/#/account?error=cancelled|failed|signups_disabled` |
| `POST /api/auth/claim` | `{ code }` → `Me`. Consumes the code (one use, 2 minutes). If the request already carries a valid session for that user, no new session is made; otherwise a session is created and the cookie set. Expired or unknown → 401 |
| `GET /api/auth/me` 🔒 | → `Me` = `{ user, unread }` |
| `PUT /api/auth/username` 🔒 | `{ username }` → `{ user }`. Rules in `shared/username.ts`. Taken (case-insensitive, by another account) → 409 `conflict` |
| `GET /api/auth/username/check?username=…` 🔒 | → `{ valid, available }`; `available` is true for the caller's own name |
| `PUT /api/auth/settings` 🔒 | `{ social_push?: boolean }` → `{ user }` |
| `POST /api/auth/logout` | `{ endpoint? }` → 204. Deletes the session, clears the cookie. With a valid `endpoint` and a session, unlinks that device (`devices.user_id = NULL` where it belonged to this user) |
| `DELETE /api/auth/account` 🔒 | `{ email }` (typed again, compared case-insensitively) → 204. Deletes the user and everything cascading; clears the cookie |

### Friends (`worker/routes/friends.ts`) 🔒👤

| Method & path | Body → answer |
| --- | --- |
| `GET /api/friends` | → `{ friends: Person[], incoming: FriendRequest[], outgoing: FriendRequest[] }`, each list sorted by username (case-insensitive). `since` = request `created_at` |
| `POST /api/friends/request` | `{ username }` → `{ status, user }`. Unknown name → 404; yourself → 400. Already accepted → `already_friends`; your own pending request → `already_pending`; their pending request to you → it is accepted (`accepted`) and they get a `friend_accepted` notification; otherwise a pending row is made (`pending`) and they get a `friend_request` notification. More than 50 pending outgoing → 429 |
| `POST /api/friends/accept` | `{ user_id }` → 204. Their pending request to you becomes `accepted`; they get `friend_accepted`. None pending → 404 |
| `POST /api/friends/decline` | `{ user_id }` → 204. Deletes their pending request to you and your `friend_request` notification from them. None → 404 |
| `DELETE /api/friends/:id` | → 204 whether or not anything existed. Removes the friendship or pending request in either direction; a withdrawn outgoing request also deletes the other side's `friend_request` notification |

### Totals and leaderboard (`worker/routes/totals.ts`, `worker/routes/leaderboard.ts`)

| Method & path | Body → answer |
| --- | --- |
| `PUT /api/totals` 🔒 | `{ days: DayTotal[] }` (1–31 entries) → 204. Upserts `(user_id, day)`. `day` must be a real `YYYY-MM-DD` no older than 40 days and no more than 2 days ahead (UTC); `ml` integer 0–100000; `goal_ml` integer 1–50000. **Goal reached:** for an entry whose day is within one day of today (UTC, either direction, so every time zone's today counts) where the stored row had `ml < goal_ml` (or did not exist) and the new one has `ml >= goal_ml`, and no `goal_reached` notification by this user with `ref = day` exists yet, every accepted friend gets a `goal_reached` notification (`ref` = day) |
| `GET /api/leaderboard?day=YYYY-MM-DD` 🔒👤 | → `Leaderboard` for you and your accepted friends. **today**: the row for `day` (missing → 0 ml; `goal_ml` falls back to that person's most recent goal in the week window, else 2000); `pct` = round(100·ml/goal_ml). **week**: the seven days ending on `day`; `ml` = sum, `goal_ml` = sum over logged days, `days_hit` = days with `ml >= goal_ml`, `pct` = round(mean over the 7 days of 100·ml/goal_ml, missing days count 0). Both lists sorted by `pct` desc, `ml` desc, username asc; `rank` is the 1-based position; `is_me` marks the caller. Bad `day` → 400 |

Days are compared as strings, so "today" means the caller's local date for everyone: a friend in
another time zone is shown by the same calendar date, which is what people expect of a daily score.

### Notifications (`worker/routes/notifications.ts`) 🔒

| Method & path | Body → answer |
| --- | --- |
| `GET /api/notifications` | → `{ unread, items }`: newest 50, `actor` joined as `{ id, username }` or null |
| `POST /api/notifications/read` | → `{ unread: 0 }`; stamps `read_at` on everything unread |

`worker/lib/notify.ts` is the one place that creates a notification: inserts the row and, when the
recipient's `social_push` is on, encrypts `{ type: 'social', kind, title, body, url: '/#/inbox' }` to
every device linked to that account (`devices.user_id`), with the copy from `socialCopy()` in
`shared/copy.ts`. Sends run in `executionCtx.waitUntil` so requests do not wait for push services;
dead subscriptions (404/410/403) are deleted like nudges. Rows older than 60 days are pruned hourly.

### Push endpoints (`worker/push.ts`, unchanged paths)

`GET /api/config`, `POST /api/subscribe|sync|snooze|test|unsubscribe` behave as before. `subscribe`
and `sync` additionally store `devices.user_id` from the session cookie when there is one (and NULL
when there is none), so the account's social pushes reach this phone.

## 5. Sign-in flow, step by step

1. The app links to `/api/auth/google/start` (a full navigation, not a fetch). Offline, it says so
   instead of leaving.
2. Google shows the account chooser and sends the browser to `/api/auth/google/callback`.
3. The Worker verifies and signs in, sets `sipster_session` (HttpOnly, Secure on https, SameSite=Lax,
   Path=/, 30 days) and redirects to `/#/account?claim=<code>`.
4. `src/main.ts` sees `claim`, calls `POST /api/auth/claim` and removes the parameter from the URL.
   **Why the handoff:** on iPhone, a home-screen app opens Google in an in-app browser sheet whose
   cookies are not the app's; when the sheet returns to the app's own address, iOS hands the URL back
   to the app, which is signed out. The one-time code in the fragment lets that context get its own
   session. In a normal browser the cookie from step 3 already works and the claim is a no-op.
5. `#/account` shows the username picker until `user.username` is set, then the account card.
6. Signed in, the app sends today's total after every drink (`src/social.ts`, `PUT /api/totals`) and
   the last 30 days once per app start, so a new account's week is not empty.

Signing out posts the device's push endpoint so the server unlinks it, then clears the cached account.

## 6. The app

Hash routes: `#/` home, `#/intro`, `#/settings`, `#/install`, `#/account`, `#/friends`, `#/inbox`,
`#/privacy`. `src/router.ts` parses `#/path?query`. `/privacy` as a path is rewritten to `#/privacy`
so Google's consent screen can link to a plain URL. The intro gate lets `#/account` and `#/privacy`
through so a sign-in redirect is never swallowed.

- `src/api.ts`: typed client for everything in §4 (cookie session, 401 handler, `ApiError`).
- `src/account.ts`: account state (`loading` → `out` | `in`), cached in `localStorage` so the home
  screen can show the badge and name offline; `loadAccount`, `claimSession`, `signOut`, `onAccount`.
- `src/social.ts`: `syncTotals({ full? })` computes totals from IndexedDB (`localDate` per sip) and
  PUTs them; also runs in the service worker after the "Log a glass" notification button. Skipped while
  signed out.
- Home: trophy → `#/friends`, bell with unread badge → `#/inbox`.
- Settings: an **Account** card (sign in / username, email, friend-notifications toggle, manage, sign
  out) and an updated "Your data" text.
- Service worker: `type: 'social'` pushes show title/body without action buttons; a tap opens
  `payload.url` (focus an open window and post `{ type: 'open', hash }`, else `openWindow`).

## 7. Security and privacy

- Same model as Tally: the ID token comes straight from Google's token endpoint over TLS in exchange
  for the client secret, so its claims are trusted without a signature check, and every claim is
  validated (`iss`, `aud`, `exp`, `nonce`, `sub`, `email_verified`).
- Session tokens are 32 random bytes, stored as SHA-256; cookies are HttpOnly and SameSite=Lax;
  mutations are refused cross-origin and must be JSON.
- Login codes are 32 random bytes, stored hashed, good once for two minutes, and travel only in the
  URL fragment (never sent to a server, never logged).
- Usernames are the only thing another person can learn about you, and only by typing them exactly.
  Emails are never shown to anyone but the account holder.
- The server stores, per account: Google id, email, username, daily totals (ml + goal), friendships,
  notifications. Deleting the account removes all of it; the phone keeps its drinks.

## 8. Configuration

Secrets (`npx wrangler secret put …`, or `.dev.vars` locally): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (an OAuth client of type *Web application* in the Google Cloud console, with
the production callback (`https://<your-domain>/api/auth/google/callback`), the `workers.dev` address's callback and, for
development, `http://127.0.0.1:8787/api/auth/google/callback` among the authorized redirect URIs;
`npm run worker:dev` pins the local Worker to that origin with `--local-upstream`, because wrangler
would otherwise present local requests under the production host). Optional var
`SIGNUPS_ENABLED="false"` closes sign-ups. `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` exist only so tests
can point at a stand-in.

Shipping this feature, in this order: 1) `npm run db:migrate` applies `0002_accounts.sql` to the live
database while the old Worker still runs (the migration only adds tables and a nullable column, so
the old Worker is unaffected); 2) merge to `main`, which deploys; 3) `npx wrangler secret put` the two
Google secrets, before or after the merge. Merging before migrating would break `/api/sync` until the
migration lands, because the new Worker writes `devices.user_id`. Until the secrets exist,
`/api/auth/google/start` answers 500 and the app's sign-in button explains that sign-in is not set up.

## 9. Tests

- `npm run test:unit`: the existing node tests (`test/*.test.ts`).
- `npm run test:worker`: Worker tests in workerd with a real D1 (`@cloudflare/vitest-pool-workers`,
  `test/worker/**`). Migrations are applied per test file and one in-memory D1 serves the whole run, so
  tests mint unique rows or reset their tables; Google's token endpoint is stood in for with a `fetch`
  mock (see `test/worker/helpers.ts`). Covers sign-in, sessions, username rules, friends,
  totals and goal notifications, leaderboard maths, notifications, device linking.
- `npm run typecheck` covers the app, the service worker, the Worker and the Worker tests.
