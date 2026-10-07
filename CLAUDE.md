# Sipster notes for Claude

- **Pushing to `main` deploys.** The repo is connected to Cloudflare (Workers Builds), so every
  push to `main` builds and deploys the app and Worker. There's no need to run
  `npm run deploy` by hand, and anything pushed to `main` goes live.
- D1 migrations are not applied by the deploy: run `npm run db:migrate` when `migrations/`
  gets a new file. **Migrate first, then push to `main`.** The new Worker may need the new
  schema from its first request, while an additive migration does the live Worker no harm.
- Before pushing, run `npm run typecheck`, `npm test` and `npm run build`.
- The Worker is a [Hono](https://hono.dev) app: `worker/index.ts` mounts `worker/routes/*`
  (auth, friends, leaderboard, totals, notifications) and the push endpoints in
  `worker/push.ts`. API errors are `{ error: { code, message } }` everywhere.
- `docs/SOCIAL.md` is the contract for accounts, friends, the leaderboard and notifications
  across the Worker, the app and `shared/api.ts`. When code and the doc disagree, fix one.
- Shipping the accounts work: 1) `npm run db:migrate` (applies `migrations/0002_accounts.sql`),
  2) merge to `main` (deploys), 3) `npx wrangler secret put GOOGLE_CLIENT_ID` and
  `npx wrangler secret put GOOGLE_CLIENT_SECRET` (before or after the merge; sign-in stays off
  until both exist, everything else works). Merging before migrating breaks nudge syncing until
  the migration lands, because the new Worker writes `devices.user_id`.
- `npm test` runs the node unit tests (`npm run test:unit`) and the Worker tests in workerd
  with a real D1 (`npm run test:worker`, `@cloudflare/vitest-pool-workers`, `test/worker/**`).
- `.npmrc` sets `legacy-peer-deps=true` on purpose: npm's strict peer resolution trips over the
  Vitest 4 + `@cloudflare/vitest-pool-workers` combination. Leave it, and don't "fix" install
  warnings by removing it.
- Local stack: `npm run dev` (Vite, :5173) proxies `/api` to `npm run worker:dev` (:8787, reads
  `.dev.vars`; `.dev.vars.example` lists the variables). The local D1 needs
  `npm run db:migrate:local` once.
