import { defineConfig } from 'vitest/config';
import { packageAliases } from './vitest.aliases';

// Real Postgres and Redis, and a spawned server process. Run with
// `npm run test:integration`; tests/integration/env.ts names the variables.
export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
