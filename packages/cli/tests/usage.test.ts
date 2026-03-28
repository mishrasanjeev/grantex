import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { usageCommand } from '../src/commands/usage.js';
import { setJsonMode } from '../src/format.js';

const currentResponse = {
  developerId: 'dev_1',
  period: '2026-01',
  tokenExchanges: 10,
  authorizations: 5,
  verifications: 20,
  totalRequests: 35,
};

const historyResponse = {
  entries: [
    {
      date: '2026-01-01',
      tokenExchanges: 5,
      authorizations: 2,
      verifications: 10,
      totalRequests: 17,
    },
    {
      date: '2026-01-02',
      tokenExchanges: 5,
      authorizations: 3,
      verifications: 10,
      totalRequests: 18,
    },
  ],
};

const mockClient = {
  usage: {
    current: vi.fn(),
    history: vi.fn(),
  },
};

describe('usageCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "usage" command name', () => {
    const cmd = usageCommand();
    expect(cmd.name()).toBe('usage');
  });

  it('has current and history subcommands', () => {
    const cmd = usageCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('current');
    expect(names).toContain('history');
  });

  // ── current ───────────────────────────────────────────────────────────

  it('current calls usage.current()', async () => {
    mockClient.usage.current.mockResolvedValue(currentResponse);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'current']);
    expect(mockClient.usage.current).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  it('current --json outputs JSON', async () => {
    mockClient.usage.current.mockResolvedValue(currentResponse);
    setJsonMode(true);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'current']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.developerId).toBe('dev_1');
    expect(parsed.period).toBe('2026-01');
    expect(parsed.totalRequests).toBe(35);
  });

  it('current prints record fields in text mode', async () => {
    mockClient.usage.current.mockResolvedValue(currentResponse);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'current']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('dev_1');
    expect(allArgs).toContain('2026-01');
    expect(allArgs).toContain('35');
  });

  // ── history ───────────────────────────────────────────────────────────

  it('history calls usage.history with empty opts by default', async () => {
    mockClient.usage.history.mockResolvedValue(historyResponse);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'history']);
    expect(mockClient.usage.history).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('history passes days when --days is set', async () => {
    mockClient.usage.history.mockResolvedValue(historyResponse);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'history', '--days', '7']);
    expect(mockClient.usage.history).toHaveBeenCalledWith({ days: 7 });
  });

  it('history --json outputs JSON array', async () => {
    mockClient.usage.history.mockResolvedValue(historyResponse);
    setJsonMode(true);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'history']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].date).toBe('2026-01-01');
    expect(parsed[0].totalRequests).toBe(17);
  });

  it('history prints table rows in text mode', async () => {
    mockClient.usage.history.mockResolvedValue(historyResponse);
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'history']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('2026-01-01');
    expect(allArgs).toContain('2026-01-02');
    expect(allArgs).toContain('17');
  });

  it('history prints "(no results)" for empty entries', async () => {
    mockClient.usage.history.mockResolvedValue({ entries: [] });
    const cmd = usageCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'history']);
    expect(console.log).toHaveBeenCalledWith('(no results)');
  });
});
