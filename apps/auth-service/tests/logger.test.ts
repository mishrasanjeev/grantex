import { describe, expect, it } from 'vitest';
import { shouldUsePrettyLogger } from '../src/lib/logger.js';

describe('standalone logger configuration', () => {
  it('does not load pino-pretty when local Docker disables pretty logging', () => {
    expect(shouldUsePrettyLogger({
      NODE_ENV: 'development',
      LOG_PRETTY: 'false',
    })).toBe(false);
  });

  it('uses pretty logging in development by default', () => {
    expect(shouldUsePrettyLogger({
      NODE_ENV: 'development',
    })).toBe(true);
  });

  it('uses JSON logging outside development', () => {
    expect(shouldUsePrettyLogger({
      NODE_ENV: 'production',
    })).toBe(false);
  });
});
