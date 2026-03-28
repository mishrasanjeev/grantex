import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { webhooksCommand } from '../src/commands/webhooks.js';
import { setJsonMode } from '../src/format.js';

const sampleWebhook = {
  id: 'wh_1',
  url: 'https://example.com/hook',
  events: ['grant.created'],
  secret: 'whsec_abc123',
  createdAt: '2026-01-01T00:00:00Z',
};

const mockClient = {
  webhooks: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
};

describe('webhooksCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "webhooks" command name', () => {
    const cmd = webhooksCommand();
    expect(cmd.name()).toBe('webhooks');
  });

  it('has list, create, delete subcommands', () => {
    const cmd = webhooksCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('create');
    expect(names).toContain('delete');
  });

  // ── list ──────────────────────────────────────────────────────────────

  it('list calls webhooks.list and prints table', async () => {
    mockClient.webhooks.list.mockResolvedValue({ webhooks: [sampleWebhook] });
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.webhooks.list).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  it('list prints "(no results)" for empty list', async () => {
    mockClient.webhooks.list.mockResolvedValue({ webhooks: [] });
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(console.log).toHaveBeenCalledWith('(no results)');
  });

  it('list --json outputs JSON array', async () => {
    mockClient.webhooks.list.mockResolvedValue({ webhooks: [sampleWebhook] });
    setJsonMode(true);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('wh_1');
    expect(parsed[0].url).toBe('https://example.com/hook');
  });

  // ── create ────────────────────────────────────────────────────────────

  it('create calls webhooks.create with url and events', async () => {
    mockClient.webhooks.create.mockResolvedValue(sampleWebhook);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'create',
      '--url',
      'https://example.com/hook',
      '--events',
      'grant.created',
    ]);
    expect(mockClient.webhooks.create).toHaveBeenCalledWith({
      url: 'https://example.com/hook',
      events: ['grant.created'],
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('create with multiple events splits comma-separated values', async () => {
    mockClient.webhooks.create.mockResolvedValue({
      ...sampleWebhook,
      events: ['grant.created', 'grant.revoked'],
    });
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'create',
      '--url',
      'https://example.com/hook',
      '--events',
      'grant.created, grant.revoked',
    ]);
    expect(mockClient.webhooks.create).toHaveBeenCalledWith({
      url: 'https://example.com/hook',
      events: ['grant.created', 'grant.revoked'],
    });
  });

  it('create prints error and exits for invalid event type', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync([
        'node',
        'test',
        'create',
        '--url',
        'https://example.com/hook',
        '--events',
        'invalid.event',
      ]),
    ).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalled();
    const errorMsg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]?.join(' ') ?? '';
    expect(errorMsg).toContain('invalid.event');
    // Should NOT have called the SDK
    expect(mockClient.webhooks.create).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('create prints error when mixing valid and invalid event types', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync([
        'node',
        'test',
        'create',
        '--url',
        'https://example.com/hook',
        '--events',
        'grant.created, bad.event',
      ]),
    ).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalled();
    expect(mockClient.webhooks.create).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('create --json outputs JSON with secret', async () => {
    mockClient.webhooks.create.mockResolvedValue(sampleWebhook);
    setJsonMode(true);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'create',
      '--url',
      'https://example.com/hook',
      '--events',
      'grant.created',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('wh_1');
    expect(parsed.secret).toBe('whsec_abc123');
  });

  it('create in text mode prints webhook ID and secret', async () => {
    mockClient.webhooks.create.mockResolvedValue(sampleWebhook);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'create',
      '--url',
      'https://example.com/hook',
      '--events',
      'grant.created',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('wh_1');
  });

  // ── delete ────────────────────────────────────────────────────────────

  it('delete calls webhooks.delete with webhookId', async () => {
    mockClient.webhooks.delete.mockResolvedValue(undefined);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'wh_1']);
    expect(mockClient.webhooks.delete).toHaveBeenCalledWith('wh_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('delete --json outputs JSON', async () => {
    mockClient.webhooks.delete.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'wh_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.deleted).toBe('wh_1');
  });

  it('delete prints success message in text mode', async () => {
    mockClient.webhooks.delete.mockResolvedValue(undefined);
    const cmd = webhooksCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'wh_1']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('wh_1');
    expect(allArgs).toContain('deleted');
  });
});
