import { defineConfig } from 'vitest/config';

// Real Chromium via Playwright. Run with `npm run test:e2e` after
// `npx playwright install chromium`.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
