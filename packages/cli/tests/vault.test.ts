import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { vaultCommand } from '../src/commands/vault.js';
import { setJsonMode } from '../src/format.js';

const sampleCredential = {
  id: 'cred_1',
  principalId: 'user@test.com',
  service: 'google',
  credentialType: 'oauth2',
  tokenExpiresAt: '2026-02-01T00:00:00Z',
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockClient = {
  vault: {
    list: vi.fn(),
    get: vi.fn(),
    store: vi.fn(),
    delete: vi.fn(),
    exchange: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(vaultCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('vault command', () => {
  describe('structure', () => {
    it('registers the "vault" command', () => {
      const cmd = vaultCommand();
      expect(cmd.name()).toBe('vault');
    });

    it('has list, get, store, delete, and exchange subcommands', () => {
      const cmd = vaultCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('list');
      expect(names).toContain('get');
      expect(names).toContain('store');
      expect(names).toContain('delete');
      expect(names).toContain('exchange');
    });
  });

  describe('list', () => {
    it('prints a table of credentials', async () => {
      mockClient.vault.list.mockResolvedValue({
        credentials: [sampleCredential],
      });

      const prog = makeProg();
      await prog.parseAsync(['vault', 'list'], { from: 'user' });

      expect(mockClient.vault.list).toHaveBeenCalledWith({});
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cred_1');
      expect(output).toContain('user@test.com');
      expect(output).toContain('google');
    });

    it('passes --principal filter', async () => {
      mockClient.vault.list.mockResolvedValue({ credentials: [] });

      const prog = makeProg();
      await prog.parseAsync(['vault', 'list', '--principal', 'user@test.com'], { from: 'user' });

      expect(mockClient.vault.list).toHaveBeenCalledWith({ principalId: 'user@test.com' });
    });

    it('passes --service filter', async () => {
      mockClient.vault.list.mockResolvedValue({ credentials: [] });

      const prog = makeProg();
      await prog.parseAsync(['vault', 'list', '--service', 'google'], { from: 'user' });

      expect(mockClient.vault.list).toHaveBeenCalledWith({ service: 'google' });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.vault.list.mockResolvedValue({ credentials: [sampleCredential] });

      const prog = makeProg();
      await prog.parseAsync(['vault', 'list'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].id).toBe('cred_1');
    });
  });

  describe('get', () => {
    it('prints credential details', async () => {
      mockClient.vault.get.mockResolvedValue(sampleCredential);

      const prog = makeProg();
      await prog.parseAsync(['vault', 'get', 'cred_1'], { from: 'user' });

      expect(mockClient.vault.get).toHaveBeenCalledWith('cred_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cred_1');
      expect(output).toContain('user@test.com');
      expect(output).toContain('google');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.vault.get.mockResolvedValue(sampleCredential);

      const prog = makeProg();
      await prog.parseAsync(['vault', 'get', 'cred_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('cred_1');
      expect(parsed.service).toBe('google');
    });

    it('shows dash for null tokenExpiresAt', async () => {
      mockClient.vault.get.mockResolvedValue({ ...sampleCredential, tokenExpiresAt: null });

      const prog = makeProg();
      await prog.parseAsync(['vault', 'get', 'cred_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toMatch(/\u2014/);
    });
  });

  describe('store', () => {
    const storeResponse = {
      id: 'cred_1',
      principalId: 'user@test.com',
      service: 'google',
      credentialType: 'oauth2',
      createdAt: '2026-01-01T00:00:00Z',
    };

    it('stores a credential and prints confirmation', async () => {
      mockClient.vault.store.mockResolvedValue(storeResponse);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'vault', 'store',
          '--principal-id', 'user@test.com',
          '--service', 'google',
          '--access-token', 'ya29.test',
        ],
        { from: 'user' },
      );

      expect(mockClient.vault.store).toHaveBeenCalledWith({
        principalId: 'user@test.com',
        service: 'google',
        accessToken: 'ya29.test',
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Credential stored');
      expect(output).toContain('cred_1');
    });

    it('passes optional parameters', async () => {
      mockClient.vault.store.mockResolvedValue(storeResponse);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'vault', 'store',
          '--principal-id', 'user@test.com',
          '--service', 'google',
          '--access-token', 'ya29.test',
          '--refresh-token', 'rt_xyz',
          '--credential-type', 'oauth2',
          '--token-expires-at', '2026-02-01T00:00:00Z',
          '--metadata', '{"scope":"email"}',
        ],
        { from: 'user' },
      );

      expect(mockClient.vault.store).toHaveBeenCalledWith({
        principalId: 'user@test.com',
        service: 'google',
        accessToken: 'ya29.test',
        refreshToken: 'rt_xyz',
        credentialType: 'oauth2',
        tokenExpiresAt: '2026-02-01T00:00:00Z',
        metadata: { scope: 'email' },
      });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.vault.store.mockResolvedValue(storeResponse);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'vault', 'store',
          '--principal-id', 'user@test.com',
          '--service', 'google',
          '--access-token', 'ya29.test',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('cred_1');
    });

    it('exits with error for invalid --metadata JSON', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'vault', 'store',
            '--principal-id', 'user@test.com',
            '--service', 'google',
            '--access-token', 'ya29.test',
            '--metadata', 'not-json',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalledWith('Error: --metadata must be valid JSON.');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('errors when required options are missing', async () => {
      const prog = makeProg();
      await expect(
        prog.parseAsync(['vault', 'store', '--principal-id', 'user@test.com'], { from: 'user' }),
      ).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('deletes a credential and prints confirmation', async () => {
      mockClient.vault.delete.mockResolvedValue(undefined);

      const prog = makeProg();
      await prog.parseAsync(['vault', 'delete', 'cred_1'], { from: 'user' });

      expect(mockClient.vault.delete).toHaveBeenCalledWith('cred_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cred_1 deleted');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.vault.delete.mockResolvedValue(undefined);

      const prog = makeProg();
      await prog.parseAsync(['vault', 'delete', 'cred_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.deleted).toBe('cred_1');
    });
  });

  describe('exchange', () => {
    const exchangeResponse = {
      accessToken: 'ya29.exchanged-token-value',
      service: 'google',
      credentialType: 'oauth2',
      tokenExpiresAt: null,
      metadata: {},
    };

    it('exchanges a grant token and prints credential', async () => {
      mockClient.vault.exchange.mockResolvedValue(exchangeResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['vault', 'exchange', '--grant-token', 'jwt.token.here', '--service', 'google'],
        { from: 'user' },
      );

      expect(mockClient.vault.exchange).toHaveBeenCalledWith('jwt.token.here', {
        service: 'google',
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('google');
      expect(output).toContain('oauth2');
      // accessToken is truncated to first 20 chars + '...'
      expect(output).toContain('ya29.exchanged-token');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.vault.exchange.mockResolvedValue(exchangeResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['vault', 'exchange', '--grant-token', 'jwt.token.here', '--service', 'google'],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.accessToken).toBe('ya29.exchanged-token-value');
      expect(parsed.service).toBe('google');
    });

    it('shows dash for null tokenExpiresAt', async () => {
      mockClient.vault.exchange.mockResolvedValue(exchangeResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['vault', 'exchange', '--grant-token', 'jwt.token.here', '--service', 'google'],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toMatch(/\u2014/);
    });
  });
});
