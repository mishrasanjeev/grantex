import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { requireClient } from '../src/client.js';
import { eventsCommand } from '../src/commands/events.js';
import { setJsonMode } from '../src/format.js';

const sampleEvents = [
  {
    id: 'evt_1',
    type: 'grant.created',
    createdAt: '2026-01-01T00:00:00Z',
    data: { grantId: 'grnt_1' },
  },
];

async function* fakeStream() {
  for (const evt of sampleEvents) {
    yield evt;
  }
}

const mockClient = {
  events: {
    stream: vi.fn(),
  },
};

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(eventsCommand());
  return prog;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClient).mockResolvedValue(mockClient as never);
  mockClient.events.stream.mockReturnValue(fakeStream());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

describe('events command', () => {
  describe('structure', () => {
    it('registers the "events" command', () => {
      const cmd = eventsCommand();
      expect(cmd.name()).toBe('events');
    });

    it('has a stream subcommand', () => {
      const cmd = eventsCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('stream');
    });

    it('stream has --types option', () => {
      const cmd = eventsCommand();
      const streamCmd = cmd.commands.find((c) => c.name() === 'stream')!;
      const optNames = streamCmd.options.map((o) => o.long);
      expect(optNames).toContain('--types');
    });
  });

  describe('stream', () => {
    it('prints events with type and data', async () => {
      const prog = makeProg();
      await prog.parseAsync(['events', 'stream'], { from: 'user' });

      expect(mockClient.events.stream).toHaveBeenCalledOnce();
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('grant.created');
      expect(output).toContain('grnt_1');
    });

    it('prints streaming header in normal mode', async () => {
      const prog = makeProg();
      await prog.parseAsync(['events', 'stream'], { from: 'user' });

      const firstLog = vi.mocked(console.log).mock.calls[0]![0];
      expect(firstLog).toContain('Streaming events');
    });

    it('prints JSON lines in --json mode', async () => {
      setJsonMode(true);
      mockClient.events.stream.mockReturnValue(fakeStream());

      const prog = makeProg();
      await prog.parseAsync(['events', 'stream'], { from: 'user' });

      // In JSON mode, each event is a separate JSON line
      const calls = vi.mocked(console.log).mock.calls;
      // Should not have the header
      expect(calls[0]![0]).not.toContain('Streaming events');

      const parsed = JSON.parse(calls[0]![0]);
      expect(parsed.type).toBe('grant.created');
      expect(parsed.data.grantId).toBe('grnt_1');
    });

    it('passes --types filter to stream', async () => {
      const prog = makeProg();
      await prog.parseAsync(['events', 'stream', '--types', 'grant.created,token.exchanged'], {
        from: 'user',
      });

      expect(mockClient.events.stream).toHaveBeenCalledWith({
        types: ['grant.created', 'token.exchanged'],
      });
    });

    it('does not pass types when not specified', async () => {
      const prog = makeProg();
      await prog.parseAsync(['events', 'stream'], { from: 'user' });

      expect(mockClient.events.stream).toHaveBeenCalledWith({});
    });
  });
});
