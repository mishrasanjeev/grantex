import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
