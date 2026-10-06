import { applyD1Migrations, env } from 'cloudflare:test';

// The schema, once per test file. One in-memory D1 serves the whole run, so rows outlive a test: suites
// mint unique names and ids, or reset their tables (test/worker/social-helpers.ts `resetDb`).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
