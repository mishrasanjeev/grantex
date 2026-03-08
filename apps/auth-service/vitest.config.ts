import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',           // Entry point — starts the server
        'src/db/client.ts',       // Database connection — mocked in tests
        'src/db/migrate.ts',      // Migration runner — infra-only
        'src/redis/client.ts',    // Redis connection — mocked in tests
        'src/routes/events.ts',   // SSE/WS — reply.hijack() not testable via inject()
      ],
    },
    env: {
      AUTO_GENERATE_KEYS: 'true',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ISSUER: 'https://grantex.dev',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
      STRIPE_PRICE_PRO: 'price_pro_fake',
      STRIPE_PRICE_ENTERPRISE: 'price_enterprise_fake',
      VAULT_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ADMIN_API_KEY: 'test-admin-key-secret',
    },
  },
});
