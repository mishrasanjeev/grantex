import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Postgres/Redis suites run separately: npm run test:integration.
    exclude: ['tests/integration/**', '**/node_modules/**'],
  },
});
