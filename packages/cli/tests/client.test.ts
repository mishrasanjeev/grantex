import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  defaultConfigPath: vi.fn().mockReturnValue('/mock/.grantex/config.json'),
  loadConfig: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock('@grantex/sdk', () => ({
  Grantex: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
}));

import { loadConfig, resolveConfig } from '../src/config.js';
import { Grantex } from '@grantex/sdk';
import { requireClient } from '../src/client.js';

describe('requireClient()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Grantex instance when config is valid', async () => {
    const config = { baseUrl: 'http://localhost:3000', apiKey: 'gx_test_abc' };
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
    (resolveConfig as ReturnType<typeof vi.fn>).mockReturnValue(config);

    const client = await requireClient();

    expect(loadConfig).toHaveBeenCalledOnce();
    expect(resolveConfig).toHaveBeenCalledWith(config);
    expect(Grantex).toHaveBeenCalledWith({ baseUrl: 'http://localhost:3000', apiKey: 'gx_test_abc' });
    expect(client).toBeDefined();
  });

  it('exits with error when config is null', async () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (resolveConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });

    await expect(requireClient()).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
