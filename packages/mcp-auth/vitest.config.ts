import { defineConfig } from 'vitest/config';
import { packageAliases } from './vitest.aliases';

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Postgres/Redis and browser suites run separately:
    // npm run test:integration and npm run test:e2e.
    exclude: ['tests/integration/**', 'tests/e2e/**', '**/node_modules/**'],
  },
});
