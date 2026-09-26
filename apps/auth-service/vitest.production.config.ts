import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/production/**/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 360_000,
    hookTimeout: 60_000,
  },
});
