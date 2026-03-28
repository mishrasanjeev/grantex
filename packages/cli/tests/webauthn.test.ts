import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { webauthnCommand } from '../src/commands/webauthn.js';
import { setJsonMode } from '../src/format.js';

const sampleCredential = {
  id: 'cred_1',
  principalId: 'user@test.com',
  deviceName: 'MacBook',
  backedUp: true,
  transports: ['internal'],
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null as string | null,
};

const mockClient = {
  webauthn: {
    registerOptions: vi.fn(),
    registerVerify: vi.fn(),
    listCredentials: vi.fn(),
    deleteCredential: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(webauthnCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('webauthn command', () => {
  describe('structure', () => {
    it('registers the "webauthn" command', () => {
      const cmd = webauthnCommand();
      expect(cmd.name()).toBe('webauthn');
    });

    it('has register-options, register-verify, list, and delete subcommands', () => {
      const cmd = webauthnCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('register-options');
      expect(names).toContain('register-verify');
      expect(names).toContain('list');
      expect(names).toContain('delete');
    });
  });

  describe('register-options', () => {
    const optionsResponse = {
      challengeId: 'ch_1',
      publicKey: { challenge: 'abc', rp: { name: 'Grantex' } },
    };

    it('generates registration options and prints challenge ID', async () => {
      mockClient.webauthn.registerOptions.mockResolvedValue(optionsResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['webauthn', 'register-options', '--principal-id', 'user@test.com'],
        { from: 'user' },
      );

      expect(mockClient.webauthn.registerOptions).toHaveBeenCalledWith({
        principalId: 'user@test.com',
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('ch_1');
      expect(output).toContain('publicKey');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.webauthn.registerOptions.mockResolvedValue(optionsResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['webauthn', 'register-options', '--principal-id', 'user@test.com'],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.challengeId).toBe('ch_1');
      expect(parsed.publicKey).toBeDefined();
    });

    it('errors when --principal-id is missing', async () => {
      const prog = makeProg();
      await expect(
        prog.parseAsync(['webauthn', 'register-options'], { from: 'user' }),
      ).rejects.toThrow();
    });
  });

  describe('register-verify', () => {
    const verifyResponse = {
      id: 'cred_1',
      principalId: 'user@test.com',
      deviceName: 'MacBook',
      backedUp: true,
      transports: ['internal'],
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: null,
    };

    it('verifies registration and prints credential ID', async () => {
      mockClient.webauthn.registerVerify.mockResolvedValue(verifyResponse);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'webauthn', 'register-verify',
          '--challenge-id', 'ch_1',
          '--response', '{"attestationObject":"abc","clientDataJSON":"def"}',
        ],
        { from: 'user' },
      );

      expect(mockClient.webauthn.registerVerify).toHaveBeenCalledWith({
        challengeId: 'ch_1',
        response: { attestationObject: 'abc', clientDataJSON: 'def' },
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Credential registered');
      expect(output).toContain('cred_1');
    });

    it('passes optional device name', async () => {
      mockClient.webauthn.registerVerify.mockResolvedValue(verifyResponse);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'webauthn', 'register-verify',
          '--challenge-id', 'ch_1',
          '--response', '{"attestationObject":"abc"}',
          '--device-name', 'My MacBook',
        ],
        { from: 'user' },
      );

      expect(mockClient.webauthn.registerVerify).toHaveBeenCalledWith({
        challengeId: 'ch_1',
        response: { attestationObject: 'abc' },
        deviceName: 'My MacBook',
      });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.webauthn.registerVerify.mockResolvedValue(verifyResponse);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'webauthn', 'register-verify',
          '--challenge-id', 'ch_1',
          '--response', '{"attestationObject":"abc"}',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('cred_1');
      expect(parsed.principalId).toBe('user@test.com');
    });

    it('exits with error for invalid --response JSON', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'webauthn', 'register-verify',
            '--challenge-id', 'ch_1',
            '--response', 'not-json',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalledWith('Error: --response must be valid JSON.');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  describe('list', () => {
    it('prints a table of credentials', async () => {
      mockClient.webauthn.listCredentials.mockResolvedValue({
        credentials: [sampleCredential],
      });

      const prog = makeProg();
      await prog.parseAsync(['webauthn', 'list', 'user@test.com'], { from: 'user' });

      expect(mockClient.webauthn.listCredentials).toHaveBeenCalledWith('user@test.com');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cred_1');
      expect(output).toContain('MacBook');
      expect(output).toContain('yes');
      expect(output).toContain('internal');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.webauthn.listCredentials.mockResolvedValue({
        credentials: [sampleCredential],
      });

      const prog = makeProg();
      await prog.parseAsync(['webauthn', 'list', 'user@test.com'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].id).toBe('cred_1');
    });

    it('shows dash for null lastUsedAt and null deviceName', async () => {
      mockClient.webauthn.listCredentials.mockResolvedValue({
        credentials: [{ ...sampleCredential, deviceName: null, lastUsedAt: null }],
      });

      const prog = makeProg();
      await prog.parseAsync(['webauthn', 'list', 'user@test.com'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toMatch(/\u2014/);
    });
  });

  describe('delete', () => {
    it('deletes a credential and prints confirmation', async () => {
      mockClient.webauthn.deleteCredential.mockResolvedValue(undefined);

      const prog = makeProg();
      await prog.parseAsync(['webauthn', 'delete', 'cred_1'], { from: 'user' });

      expect(mockClient.webauthn.deleteCredential).toHaveBeenCalledWith('cred_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cred_1 deleted');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.webauthn.deleteCredential.mockResolvedValue(undefined);

      const prog = makeProg();
      await prog.parseAsync(['webauthn', 'delete', 'cred_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.deleted).toBe('cred_1');
    });
  });
});
