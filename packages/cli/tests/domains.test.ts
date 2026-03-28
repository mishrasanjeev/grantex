import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { domainsCommand } from '../src/commands/domains.js';
import { setJsonMode } from '../src/format.js';

const mockClient = {
  domains: {
    list: vi.fn(),
    create: vi.fn(),
    verify: vi.fn(),
    delete: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(domainsCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('domains command', () => {
  describe('structure', () => {
    it('registers the "domains" command', () => {
      const cmd = domainsCommand();
      expect(cmd.name()).toBe('domains');
    });

    it('has list, add, verify, and delete subcommands', () => {
      const cmd = domainsCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('list');
      expect(names).toContain('add');
      expect(names).toContain('verify');
      expect(names).toContain('delete');
    });
  });

  describe('list', () => {
    it('prints a table of domains', async () => {
      mockClient.domains.list.mockResolvedValue({
        domains: [
          {
            id: 'dom_1',
            domain: 'auth.example.com',
            verified: true,
            verifiedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'list'], { from: 'user' });

      expect(mockClient.domains.list).toHaveBeenCalledOnce();
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('dom_1');
      expect(output).toContain('auth.example.com');
      expect(output).toContain('yes');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.domains.list.mockResolvedValue({
        domains: [
          {
            id: 'dom_1',
            domain: 'auth.example.com',
            verified: true,
            verifiedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'list'], { from: 'user' });

      expect(console.log).toHaveBeenCalled();
      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].id).toBe('dom_1');
    });

    it('prints "(no results)" when domains is empty', async () => {
      mockClient.domains.list.mockResolvedValue({ domains: [] });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'list'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('no results');
    });
  });

  describe('add', () => {
    it('creates a domain and prints confirmation', async () => {
      mockClient.domains.create.mockResolvedValue({
        id: 'dom_1',
        domain: 'auth.example.com',
        verified: false,
        verificationToken: 'tok_abc',
        instructions: 'Add TXT record',
      });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'add', '--domain', 'auth.example.com'], { from: 'user' });

      expect(mockClient.domains.create).toHaveBeenCalledWith({ domain: 'auth.example.com' });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Domain added');
      expect(output).toContain('auth.example.com');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.domains.create.mockResolvedValue({
        id: 'dom_1',
        domain: 'auth.example.com',
        verified: false,
        verificationToken: 'tok_abc',
        instructions: 'Add TXT record',
      });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'add', '--domain', 'auth.example.com'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('dom_1');
      expect(parsed.verificationToken).toBe('tok_abc');
    });

    it('errors when --domain is missing', async () => {
      const prog = makeProg();
      await expect(
        prog.parseAsync(['domains', 'add'], { from: 'user' }),
      ).rejects.toThrow();
    });
  });

  describe('verify', () => {
    it('prints success when verified', async () => {
      mockClient.domains.verify.mockResolvedValue({ verified: true });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'verify', 'dom_1'], { from: 'user' });

      expect(mockClient.domains.verify).toHaveBeenCalledWith('dom_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('verified successfully');
    });

    it('prints warning when not verified', async () => {
      mockClient.domains.verify.mockResolvedValue({ verified: false });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'verify', 'dom_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('not yet verified');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.domains.verify.mockResolvedValue({ verified: true });

      const prog = makeProg();
      await prog.parseAsync(['domains', 'verify', 'dom_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.verified).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes a domain and prints confirmation', async () => {
      mockClient.domains.delete.mockResolvedValue(undefined);

      const prog = makeProg();
      await prog.parseAsync(['domains', 'delete', 'dom_1'], { from: 'user' });

      expect(mockClient.domains.delete).toHaveBeenCalledWith('dom_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('dom_1 deleted');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.domains.delete.mockResolvedValue(undefined);

      const prog = makeProg();
      await prog.parseAsync(['domains', 'delete', 'dom_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.deleted).toBe('dom_1');
    });
  });
});
