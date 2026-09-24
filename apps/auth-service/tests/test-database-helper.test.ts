import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The helper's own clean-up paths, with the driver replaced: a failure the
// server would have to be coaxed into is here a rejected promise.
const admin = { unsafe: vi.fn(), end: vi.fn() };
vi.mock('postgres', () => ({ default: vi.fn(() => admin) }));

async function load(): Promise<typeof import('./helpers/database.js')> {
  vi.resetModules();
  return import('./helpers/database.js');
}

describe('createTestDatabase clean-up paths', () => {
  beforeEach(() => {
    vi.stubEnv('AUDIT_INTEGRATION_DATABASE_URL', 'postgres://user:pass@127.0.0.1:5432/admin');
    admin.unsafe.mockReset();
    admin.end.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('closes its admin connection when CREATE DATABASE fails, and still reports the failure', async () => {
    admin.unsafe.mockRejectedValueOnce(new Error('permission denied to create database'));
    const { createTestDatabase } = await load();
    await expect(createTestDatabase('any')).rejects.toThrow(/permission denied to create database/);
    expect(admin.end).toHaveBeenCalledTimes(1);
  });

  it('closes its admin connection after a drop, whether or not the drop succeeds', async () => {
    admin.unsafe.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('drop refused'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const { createTestDatabase } = await load();
      const db = await createTestDatabase('any');
      await expect(db.drop()).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`could not drop test database ${db.name}`));
      expect(admin.end).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
