import { defineConfig } from 'vitest/config';
import { packageAliases } from './vitest.aliases';

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Postgres/Redis suites run separately: npm run test:integration.
    exclude: ['tests/integration/**', '**/node_modules/**'],
  },
});
