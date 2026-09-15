import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Postgres/Redis and browser suites run separately:
    // npm run test:integration and npm run test:e2e.
    exclude: ['tests/integration/**', 'tests/e2e/**', '**/node_modules/**'],
  },
});
