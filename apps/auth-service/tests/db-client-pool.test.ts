import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';

describe('PostgreSQL pool budget', () => {
  it('uses the configured per-instance connection limit', async () => {
    const client = await vi.importActual<typeof import('../src/db/client.js')>('../src/db/client.js');
    try {
      expect(client.getSql().options.max).toBe(config.databasePoolMax);
    } finally {
      await client.closeSql();
    }
  });
});
