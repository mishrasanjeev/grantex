import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { passportsCommand } from '../src/commands/passports.js';
import { setJsonMode } from '../src/format.js';

const samplePassport = {
  passportId: 'pp_1',
  credential: {},
  encodedCredential: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyQHRlc3QuY29tIn0.signature',
  expiresAt: '2026-02-01T00:00:00Z',
};

const mockClient = {
  passports: {
    issue: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(passportsCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('passports command', () => {
  describe('structure', () => {
    it('registers the "passports" command', () => {
      const cmd = passportsCommand();
      expect(cmd.name()).toBe('passports');
    });

    it('has issue, get, list, and revoke subcommands', () => {
      const cmd = passportsCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('issue');
      expect(names).toContain('get');
      expect(names).toContain('list');
      expect(names).toContain('revoke');
    });
  });

  describe('issue', () => {
    it('issues a passport and prints confirmation', async () => {
      mockClient.passports.issue.mockResolvedValue(samplePassport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'passports', 'issue',
          '--agent-id', 'agent_1',
          '--grant-id', 'grnt_1',
          '--categories', 'compute,storage',
          '--max-amount', '100',
        ],
        { from: 'user' },
      );

      expect(mockClient.passports.issue).toHaveBeenCalledWith({
        agentId: 'agent_1',
        grantId: 'grnt_1',
        allowedMPPCategories: ['compute', 'storage'],
        maxTransactionAmount: { amount: 100, currency: 'USD' },
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Passport issued');
      expect(output).toContain('pp_1');
    });

    it('passes optional parameters', async () => {
      mockClient.passports.issue.mockResolvedValue(samplePassport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'passports', 'issue',
          '--agent-id', 'agent_1',
          '--grant-id', 'grnt_1',
          '--categories', 'compute',
          '--max-amount', '50',
          '--currency', 'EUR',
          '--payment-rails', 'stripe,paypal',
          '--expires-in', '24h',
          '--parent-passport-id', 'pp_0',
        ],
        { from: 'user' },
      );

      expect(mockClient.passports.issue).toHaveBeenCalledWith({
        agentId: 'agent_1',
        grantId: 'grnt_1',
        allowedMPPCategories: ['compute'],
        maxTransactionAmount: { amount: 50, currency: 'EUR' },
        paymentRails: ['stripe', 'paypal'],
        expiresIn: '24h',
        parentPassportId: 'pp_0',
      });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.passports.issue.mockResolvedValue(samplePassport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'passports', 'issue',
          '--agent-id', 'agent_1',
          '--grant-id', 'grnt_1',
          '--categories', 'compute',
          '--max-amount', '100',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.passportId).toBe('pp_1');
      expect(parsed.encodedCredential).toContain('eyJ');
    });

    it('errors when required options are missing', async () => {
      const prog = makeProg();
      await expect(
        prog.parseAsync(['passports', 'issue', '--agent-id', 'agent_1'], { from: 'user' }),
      ).rejects.toThrow();
    });

    it('uses default currency USD', async () => {
      mockClient.passports.issue.mockResolvedValue(samplePassport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'passports', 'issue',
          '--agent-id', 'agent_1',
          '--grant-id', 'grnt_1',
          '--categories', 'compute',
          '--max-amount', '100',
        ],
        { from: 'user' },
      );

      const callArgs = mockClient.passports.issue.mock.calls[0]![0];
      expect(callArgs.maxTransactionAmount.currency).toBe('USD');
    });
  });

  describe('get', () => {
    it('prints passport details', async () => {
      mockClient.passports.get.mockResolvedValue({
        status: 'active',
        passportId: 'pp_1',
        agentId: 'agent_1',
      });

      const prog = makeProg();
      await prog.parseAsync(['passports', 'get', 'pp_1'], { from: 'user' });

      expect(mockClient.passports.get).toHaveBeenCalledWith('pp_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('active');
      expect(output).toContain('pp_1');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.passports.get.mockResolvedValue({
        status: 'active',
        passportId: 'pp_1',
      });

      const prog = makeProg();
      await prog.parseAsync(['passports', 'get', 'pp_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('active');
      expect(parsed.passportId).toBe('pp_1');
    });
  });

  describe('list', () => {
    it('prints a table of passports', async () => {
      mockClient.passports.list.mockResolvedValue([samplePassport]);

      const prog = makeProg();
      await prog.parseAsync(['passports', 'list'], { from: 'user' });

      expect(mockClient.passports.list).toHaveBeenCalledWith({});
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('pp_1');
    });

    it('passes --agent-id filter', async () => {
      mockClient.passports.list.mockResolvedValue([]);

      const prog = makeProg();
      await prog.parseAsync(['passports', 'list', '--agent-id', 'agent_1'], { from: 'user' });

      expect(mockClient.passports.list).toHaveBeenCalledWith({ agentId: 'agent_1' });
    });

    it('passes --grant-id filter', async () => {
      mockClient.passports.list.mockResolvedValue([]);

      const prog = makeProg();
      await prog.parseAsync(['passports', 'list', '--grant-id', 'grnt_1'], { from: 'user' });

      expect(mockClient.passports.list).toHaveBeenCalledWith({ grantId: 'grnt_1' });
    });

    it('passes --status filter', async () => {
      mockClient.passports.list.mockResolvedValue([]);

      const prog = makeProg();
      await prog.parseAsync(['passports', 'list', '--status', 'active'], { from: 'user' });

      expect(mockClient.passports.list).toHaveBeenCalledWith({ status: 'active' });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.passports.list.mockResolvedValue([samplePassport]);

      const prog = makeProg();
      await prog.parseAsync(['passports', 'list'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].passportId).toBe('pp_1');
    });

    it('prints "(no results)" when empty', async () => {
      mockClient.passports.list.mockResolvedValue([]);

      const prog = makeProg();
      await prog.parseAsync(['passports', 'list'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('no results');
    });
  });

  describe('revoke', () => {
    it('revokes a passport and prints confirmation', async () => {
      mockClient.passports.revoke.mockResolvedValue({
        revoked: true,
        revokedAt: '2026-01-15T00:00:00Z',
      });

      const prog = makeProg();
      await prog.parseAsync(['passports', 'revoke', 'pp_1'], { from: 'user' });

      expect(mockClient.passports.revoke).toHaveBeenCalledWith('pp_1');
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('pp_1 revoked');
      expect(output).toContain('2026-01-15T00:00:00Z');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.passports.revoke.mockResolvedValue({
        revoked: true,
        revokedAt: '2026-01-15T00:00:00Z',
      });

      const prog = makeProg();
      await prog.parseAsync(['passports', 'revoke', 'pp_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.revoked).toBe(true);
      expect(parsed.revokedAt).toBe('2026-01-15T00:00:00Z');
    });
  });
});
