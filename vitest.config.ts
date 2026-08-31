import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    // Run E2E tests sequentially to avoid production rate limits
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    // A full local run shares production-style IP buckets. Individual tests
    // may legitimately wait for one Retry-After window without being flaky.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
