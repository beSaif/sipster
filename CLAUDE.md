# Sipster notes for Claude

- **Pushing to `main` deploys.** The repo is connected to Cloudflare (Workers Builds), so every
  push to `main` builds and deploys the app and Worker. There's no need to run
  `npm run deploy` by hand, and anything pushed to `main` goes live.
- D1 migrations are not applied by the deploy: run `npm run db:migrate` when `migrations/`
  gets a new file.
- Before pushing, run `npm run typecheck`, `npm test` and `npm run build`.
