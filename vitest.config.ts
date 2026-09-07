import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const consumer = process.env['GRANTEX_SDK_TEST_ROOT'];
const sdk = consumer ? resolve(consumer, 'node_modules/@grantex/sdk/dist/index.js') : undefined;
const x402 = consumer ? resolve(consumer, 'node_modules/@grantex/x402/dist/index.js') : undefined;
if (consumer && (!existsSync(sdk!) || !existsSync(x402!))) {
  throw new Error('GRANTEX_SDK_TEST_ROOT must contain installed SDK and x402 distributions');
}

export default defineConfig({
  resolve: {
    alias: consumer ? [
      { find: '@grantex/sdk', replacement: sdk! },
      { find: '@grantex/x402', replacement: x402! },
      { find: /^\.\.\/\.\.\/packages\/x402\/src\/agent\.js$/, replacement: x402! },
    ] : [],
  },
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
