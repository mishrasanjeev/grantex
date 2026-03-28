import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { credentialsCommand } from '../src/commands/credentials.js';
import { setJsonMode } from '../src/format.js';

const sampleCredential = {
  id: 'vc_1',
  grantId: 'grnt_1',
  credentialType: 'GrantCredential',
  format: 'vc-jwt',
  credential: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyQHRlc3QuY29tIn0.signature',
  status: 'active',
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-02-01T00:00:00Z',
};

const mockClient = {
  credentials: {
    list: vi.fn(),
    get: vi.fn(),
    verify: vi.fn(),
    present: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(credentialsCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('credentials command', () => {
  describe('structure', () => {
    it('registers the "credentials" command', () => {
      const cmd = credentialsCommand();
      expect(cmd.name()).toBe('credentials');
    });

    it('has list, get, verify, and present subcommands', () => {
      const cmd = credentialsCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('list');
      expect(names).toContain('get');
      expect(names).toContain('verify');
      expect(names).toContain('present');
    });
  });

  describe('list', () => {
    it('prints a table of credentials', async () => {
      mockClient.credentials.list.mockResolvedValue({
        credentials: [sampleCredential],
      });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'list'], { from: 'user' });

      expect(mockClient.credentials.list).toHaveBeenCalledWith({});
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('vc_1');
      expect(output).toContain('grnt_1');
      expect(output).toContain('GrantCredential');
      expect(output).toContain('vc-jwt');
      expect(output).toContain('active');
    });

    it('passes --grant-id filter', async () => {
      mockClient.credentials.list.mockResolvedValue({ credentials: [] });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'list', '--grant-id', 'grnt_1'], { from: 'user' });

      expect(mockClient.credentials.list).toHaveBeenCalledWith({ grantId: 'grnt_1' });
    });

    it('passes --principal-id filter', async () => {
      mockClient.credentials.list.mockResolvedValue({ credentials: [] });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'list', '--principal-id', 'user@test.com'], {
        from: 'user',
      });

      expect(mockClient.credentials.list).toHaveBeenCalledWith({ principalId: 'user@test.com' });
    });

    it('passes --status filter', async () => {
      mockClient.credentials.list.mockResolvedValue({ credentials: [] });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'list', '--status', 'active'], { from: 'user' });

      expect(mockClient.credentials.list).toHaveBeenCalledWith({ status: 'active' });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.credentials.list.mockResolvedValue({ credentials: [sampleCredential] });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'list'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].id).toBe('vc_1');
    });
  });

  describe('get', () => {
    it('prints credential details', async () => {
      mockClient.credentials.get.mockResolvedValue(sampleCredential);

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'get', 'vc_1'], { from: 'user' });

      expect(mockClient.credentials.get).toHaveBeenCalledWith('vc_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('vc_1');
      expect(output).toContain('grnt_1');
      expect(output).toContain('GrantCredential');
      // Credential is truncated to 60 chars + '...'
      expect(output).toContain('...');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.credentials.get.mockResolvedValue(sampleCredential);

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'get', 'vc_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('vc_1');
      expect(parsed.credential).toContain('eyJ');
    });
  });

  describe('verify', () => {
    it('prints success when credential is valid', async () => {
      mockClient.credentials.verify.mockResolvedValue({
        valid: true,
        credentialType: 'GrantCredential',
        issuer: 'did:web:grantex.dev',
        expiresAt: '2026-02-01T00:00:00Z',
        revoked: false,
      });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'verify', '--vc-jwt', 'eyJ.test.sig'], {
        from: 'user',
      });

      expect(mockClient.credentials.verify).toHaveBeenCalledWith('eyJ.test.sig');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Credential is valid');
      expect(output).toContain('GrantCredential');
      expect(output).toContain('did:web:grantex.dev');
    });

    it('exits with error when credential is invalid', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      mockClient.credentials.verify.mockResolvedValue({ valid: false });

      const prog = makeProg();
      await expect(
        prog.parseAsync(['credentials', 'verify', '--vc-jwt', 'bad.jwt'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalled();
      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('Credential is invalid');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('prints JSON in --json mode when valid', async () => {
      setJsonMode(true);
      mockClient.credentials.verify.mockResolvedValue({
        valid: true,
        credentialType: 'GrantCredential',
        issuer: 'did:web:grantex.dev',
        expiresAt: '2026-02-01T00:00:00Z',
        revoked: false,
      });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'verify', '--vc-jwt', 'eyJ.test.sig'], {
        from: 'user',
      });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.valid).toBe(true);
      expect(parsed.issuer).toBe('did:web:grantex.dev');
    });

    it('prints JSON in --json mode when invalid', async () => {
      setJsonMode(true);
      mockClient.credentials.verify.mockResolvedValue({ valid: false });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'verify', '--vc-jwt', 'bad.jwt'], { from: 'user' });

      // In JSON mode, the result is printed via JSON.stringify before the process.exit check
      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.valid).toBe(false);
    });

    it('errors when --vc-jwt is missing', async () => {
      const prog = makeProg();
      await expect(
        prog.parseAsync(['credentials', 'verify'], { from: 'user' }),
      ).rejects.toThrow();
    });
  });

  describe('present', () => {
    it('prints success when presentation is valid', async () => {
      mockClient.credentials.present.mockResolvedValue({
        valid: true,
        disclosedClaims: { scope: 'email:read' },
      });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'present', '--sd-jwt', 'eyJ.sd.jwt~disc'], {
        from: 'user',
      });

      expect(mockClient.credentials.present).toHaveBeenCalledWith({ sdJwt: 'eyJ.sd.jwt~disc' });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('SD-JWT presentation is valid');
      expect(output).toContain('email:read');
    });

    it('passes --nonce and --audience', async () => {
      mockClient.credentials.present.mockResolvedValue({
        valid: true,
        disclosedClaims: { scope: 'email:read' },
      });

      const prog = makeProg();
      await prog.parseAsync(
        [
          'credentials', 'present',
          '--sd-jwt', 'eyJ.sd.jwt~disc',
          '--nonce', 'abc123',
          '--audience', 'https://verifier.example.com',
        ],
        { from: 'user' },
      );

      expect(mockClient.credentials.present).toHaveBeenCalledWith({
        sdJwt: 'eyJ.sd.jwt~disc',
        nonce: 'abc123',
        audience: 'https://verifier.example.com',
      });
    });

    it('exits with error when presentation is invalid', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      mockClient.credentials.present.mockResolvedValue({
        valid: false,
        error: 'expired',
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(['credentials', 'present', '--sd-jwt', 'bad.sd.jwt'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('Presentation invalid');
      expect(errorOutput).toContain('expired');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('prints JSON in --json mode when valid', async () => {
      setJsonMode(true);
      mockClient.credentials.present.mockResolvedValue({
        valid: true,
        disclosedClaims: { scope: 'email:read' },
      });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'present', '--sd-jwt', 'eyJ.sd.jwt~disc'], {
        from: 'user',
      });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.valid).toBe(true);
      expect(parsed.disclosedClaims.scope).toBe('email:read');
    });

    it('prints JSON in --json mode when invalid', async () => {
      setJsonMode(true);
      mockClient.credentials.present.mockResolvedValue({
        valid: false,
        error: 'expired',
      });

      const prog = makeProg();
      await prog.parseAsync(['credentials', 'present', '--sd-jwt', 'bad.sd.jwt'], {
        from: 'user',
      });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toBe('expired');
    });
  });
});
