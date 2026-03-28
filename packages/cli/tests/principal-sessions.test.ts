import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { principalSessionsCommand } from '../src/commands/principal-sessions.js';
import { setJsonMode } from '../src/format.js';

const mockClient = {
  principalSessions: {
    create: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(principalSessionsCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('principal-sessions command', () => {
  describe('structure', () => {
    it('registers the "principal-sessions" command', () => {
      const cmd = principalSessionsCommand();
      expect(cmd.name()).toBe('principal-sessions');
    });

    it('has a create subcommand', () => {
      const cmd = principalSessionsCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('create');
    });

    it('create has --principal-id and --expires-in options', () => {
      const cmd = principalSessionsCommand();
      const createCmd = cmd.commands.find((c) => c.name() === 'create')!;
      const optNames = createCmd.options.map((o) => o.long);
      expect(optNames).toContain('--principal-id');
      expect(optNames).toContain('--expires-in');
    });
  });

  describe('create', () => {
    const sessionResponse = {
      sessionToken: 'jwt...',
      dashboardUrl: 'https://example.com/dash',
      expiresAt: '2026-01-02T00:00:00Z',
    };

    it('creates a session and prints confirmation', async () => {
      mockClient.principalSessions.create.mockResolvedValue(sessionResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['principal-sessions', 'create', '--principal-id', 'user@test.com'],
        { from: 'user' },
      );

      expect(mockClient.principalSessions.create).toHaveBeenCalledWith({
        principalId: 'user@test.com',
      });
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Principal session created');
      expect(output).toContain('jwt...');
      expect(output).toContain('https://example.com/dash');
    });

    it('passes expiresIn when --expires-in is provided', async () => {
      mockClient.principalSessions.create.mockResolvedValue(sessionResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['principal-sessions', 'create', '--principal-id', 'user@test.com', '--expires-in', '24h'],
        { from: 'user' },
      );

      expect(mockClient.principalSessions.create).toHaveBeenCalledWith({
        principalId: 'user@test.com',
        expiresIn: '24h',
      });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockClient.principalSessions.create.mockResolvedValue(sessionResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['principal-sessions', 'create', '--principal-id', 'user@test.com'],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.sessionToken).toBe('jwt...');
      expect(parsed.dashboardUrl).toBe('https://example.com/dash');
      expect(parsed.expiresAt).toBe('2026-01-02T00:00:00Z');
    });

    it('errors when --principal-id is missing', async () => {
      const prog = makeProg();
      await expect(
        prog.parseAsync(['principal-sessions', 'create'], { from: 'user' }),
      ).rejects.toThrow();
    });
  });
});
