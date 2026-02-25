import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    env: {
      AUTO_GENERATE_KEYS: 'true',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ISSUER: 'https://grantex.dev',
    },
  },
});
