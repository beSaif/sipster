import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

// Fixed VAPID pair for tests only (never used in production).
const TEST_VAPID = {
  VAPID_PUBLIC_KEY: 'BHJsJP5DWW0s3g7Tn_2UuulRT-XtuCJtZEblX4HcMi8Y_082ybkISDG2OWcAsXErWm5HjtRDbYTdYSEzid3Fi3k',
  VAPID_PRIVATE_KEY: 'we2qLWvFKIMO8GnOWnvGzUiAlYNhan9_9y6ARLGwPxM',
  VAPID_SUBJECT: 'mailto:tests@sipster.test',
};
// A pretend Google OAuth client; the tests stand in for Google's token endpoint (test/worker/helpers.ts).
const TEST_GOOGLE = { GOOGLE_CLIENT_ID: 'sipster-test-client', GOOGLE_CLIENT_SECRET: 'sipster-test-secret' };

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));
  return {
    test: {
      projects: [
        {
          test: {
            name: 'unit',
            include: ['test/*.test.ts'],
            environment: 'node',
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                // The bundled workerd lags Cloudflare by a few weeks; the deployed Worker keeps wrangler.jsonc's date.
                compatibilityDate: '2026-08-22',
                bindings: { TEST_MIGRATIONS: migrations, ...TEST_VAPID, ...TEST_GOOGLE, ALLOW_ANY_PUSH_HOST: 'true' },
              },
            }),
          ],
          test: {
            name: 'worker',
            include: ['test/worker/**/*.test.ts'],
            setupFiles: ['test/worker/setup.ts'],
          },
        },
      ],
    },
  };
});
