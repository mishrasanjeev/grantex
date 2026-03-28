import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  defaultConfigPath: vi.fn().mockReturnValue('/mock/.grantex/config.json'),
  saveConfig: vi.fn(),
  loadConfig: vi.fn(),
  resolveConfig: vi.fn(),
}));

import { saveConfig, loadConfig, resolveConfig, defaultConfigPath } from '../src/config.js';
import { configCommand } from '../src/commands/config.js';

describe('configCommand() actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ── set ──────────────────────────────────────────────────────────────

  it('set calls saveConfig with url and key', async () => {
    (saveConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const cmd = configCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'set',
      '--url', 'http://localhost:3000',
      '--key', 'gx_test_abc123',
    ]);

    expect(saveConfig).toHaveBeenCalledWith(
      '/mock/.grantex/config.json',
      { baseUrl: 'http://localhost:3000', apiKey: 'gx_test_abc123' },
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Config saved'));
  });

  // ── show ─────────────────────────────────────────────────────────────

  it('show prints config when configured', async () => {
    const config = { baseUrl: 'http://localhost:3000', apiKey: 'gx_test_abc12345' };
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
    (resolveConfig as ReturnType<typeof vi.fn>).mockReturnValue(config);

    const cmd = configCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'show']);

    expect(loadConfig).toHaveBeenCalledOnce();
    expect(resolveConfig).toHaveBeenCalledWith(config);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('http://localhost:3000');
    expect(allOutput).toContain('gx_test_');
    expect(allOutput).toContain('********');
  });

  it('show prints masked key with gx_live_ prefix', async () => {
    const config = { baseUrl: 'http://prod:3000', apiKey: 'gx_live_secretkey123' };
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
    (resolveConfig as ReturnType<typeof vi.fn>).mockReturnValue(config);

    const cmd = configCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'show']);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('gx_live_');
  });

  it('show exits 1 when not configured', async () => {
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (resolveConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });

    const cmd = configCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'show'])).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not configured'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('show notes when env vars are set', async () => {
    const config = { baseUrl: 'http://localhost:3000', apiKey: 'gx_test_abc12345' };
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
    (resolveConfig as ReturnType<typeof vi.fn>).mockReturnValue(config);

    const origUrl = process.env['GRANTEX_URL'];
    process.env['GRANTEX_URL'] = 'http://env-url:4000';

    try {
      const cmd = configCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', 'show']);

      const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c.join(' '))
        .join('\n');
      expect(allOutput).toContain('env vars');
    } finally {
      if (origUrl === undefined) {
        delete process.env['GRANTEX_URL'];
      } else {
        process.env['GRANTEX_URL'] = origUrl;
      }
    }
  });
});
