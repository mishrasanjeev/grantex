import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/config.js', () => ({
  defaultConfigPath: vi.fn().mockReturnValue('/home/user/.grantex/config.json'),
  loadConfig: vi.fn(),
  resolveConfig: vi.fn(),
}));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { loadConfig, resolveConfig } from '../src/config.js';
import { meCommand } from '../src/commands/me.js';
import { setJsonMode } from '../src/format.js';

const sampleProfile = {
  id: 'dev_1',
  name: 'Test Dev',
  email: 'test@dev.com',
  mode: 'sandbox',
  plan: 'free',
  createdAt: '2026-01-01T00:00:00Z',
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(meCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue({
    baseUrl: 'http://localhost:3001',
    apiKey: 'gx_test_key',
  });
  vi.mocked(resolveConfig).mockReturnValue({
    baseUrl: 'http://localhost:3001',
    apiKey: 'gx_test_key',
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);

  // Mock global fetch
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleProfile),
    }),
  );
});

describe('me command', () => {
  describe('structure', () => {
    it('registers the "me" command', () => {
      const cmd = meCommand();
      expect(cmd.name()).toBe('me');
    });
  });

  describe('action', () => {
    it('fetches and prints developer profile', async () => {
      const prog = makeProg();
      await prog.parseAsync(['me'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/v1/me', {
        headers: {
          Authorization: 'Bearer gx_test_key',
          Accept: 'application/json',
        },
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('dev_1');
      expect(output).toContain('Test Dev');
      expect(output).toContain('test@dev.com');
      expect(output).toContain('sandbox');
      expect(output).toContain('free');
    });

    it('strips trailing slash from baseUrl', async () => {
      vi.mocked(resolveConfig).mockReturnValue({
        baseUrl: 'http://localhost:3001/',
        apiKey: 'gx_test_key',
      });

      const prog = makeProg();
      await prog.parseAsync(['me'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/me',
        expect.any(Object),
      );
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);

      const prog = makeProg();
      await prog.parseAsync(['me'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('dev_1');
      expect(parsed.name).toBe('Test Dev');
      expect(parsed.email).toBe('test@dev.com');
    });

    it('exits with error when config is not set', async () => {
      vi.mocked(resolveConfig).mockReturnValue(null);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(prog.parseAsync(['me'], { from: 'user' })).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalled();
      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('not configured');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('exits with error when fetch returns non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ message: 'Invalid API key' }),
        }),
      );

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(prog.parseAsync(['me'], { from: 'user' })).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalled();
      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('Invalid API key');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('falls back to HTTP status when error body has no message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.resolve(null),
        }),
      );

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(prog.parseAsync(['me'], { from: 'user' })).rejects.toThrow('process.exit');

      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('HTTP 500');
      exitSpy.mockRestore();
    });

    it('handles fetch json parse failure gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('not JSON')),
        }),
      );

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(prog.parseAsync(['me'], { from: 'user' })).rejects.toThrow('process.exit');

      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('HTTP 502');
      exitSpy.mockRestore();
    });
  });
});
