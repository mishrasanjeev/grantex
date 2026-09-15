import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Real Chromium via Playwright against the auth service on a local port, with
// real Postgres (AUDIT_INTEGRATION_DATABASE_URL). Run with `npm run test:e2e`
// after `npx playwright install chromium`. The base config's environment and
// setup file are kept; its exclusion of tests/e2e is not.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/e2e/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**'],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
