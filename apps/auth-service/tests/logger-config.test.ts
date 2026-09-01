import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

const originalLogLevel = process.env['LOG_LEVEL'];

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env['LOG_LEVEL'];
  } else {
    process.env['LOG_LEVEL'] = originalLogLevel;
  }
});

describe('application logger configuration', () => {
  it('honors LOG_LEVEL when the startup logger option is omitted', async () => {
    process.env['LOG_LEVEL'] = 'warn';
    const app = await buildApp();

    try {
      expect(app.log.level).toBe('warn');
    } finally {
      await app.close();
    }
  });
});
