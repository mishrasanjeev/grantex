import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { auditCommand } from '../src/commands/audit.js';
import { setJsonMode } from '../src/format.js';

const sampleEntry = {
  entryId: 'alog_1',
  agentId: 'ag_1',
  agentDid: 'did:grantex:ag_1',
  grantId: 'grnt_1',
  principalId: 'user@test.com',
  action: 'email.read',
  status: 'success',
  hash: 'abc',
  prevHash: null,
  timestamp: '2026-01-01T00:00:00Z',
  metadata: {},
};

const mockClient = {
  audit: {
    list: vi.fn(),
    get: vi.fn(),
    log: vi.fn(),
  },
};

describe('auditCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "audit" command name', () => {
    const cmd = auditCommand();
    expect(cmd.name()).toBe('audit');
  });

  it('has list, get, log subcommands', () => {
    const cmd = auditCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('get');
    expect(names).toContain('log');
  });

  // ── list ──────────────────────────────────────────────────────────────

  it('list calls audit.list with no filters by default', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [sampleEntry] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.audit.list).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('list passes agentId filter from --agent', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--agent', 'ag_1']);
    expect(mockClient.audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'ag_1' }),
    );
  });

  it('list passes grantId filter from --grant', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--grant', 'grnt_1']);
    expect(mockClient.audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'grnt_1' }),
    );
  });

  it('list passes principalId filter from --principal', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--principal', 'user@test.com']);
    expect(mockClient.audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'user@test.com' }),
    );
  });

  it('list passes action filter from --action', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--action', 'email.read']);
    expect(mockClient.audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'email.read' }),
    );
  });

  it('list passes since/until filters', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'list',
      '--since',
      '2026-01-01T00:00:00Z',
      '--until',
      '2026-01-31T00:00:00Z',
    ]);
    expect(mockClient.audit.list).toHaveBeenCalledWith(
      expect.objectContaining({
        since: '2026-01-01T00:00:00Z',
        until: '2026-01-31T00:00:00Z',
      }),
    );
  });

  it('list prints "(no results)" for empty list', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [] });
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(console.log).toHaveBeenCalledWith('(no results)');
  });

  it('list --json outputs JSON array', async () => {
    mockClient.audit.list.mockResolvedValue({ entries: [sampleEntry] });
    setJsonMode(true);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].entryId).toBe('alog_1');
  });

  // ── get ───────────────────────────────────────────────────────────────

  it('get calls audit.get with entryId', async () => {
    mockClient.audit.get.mockResolvedValue(sampleEntry);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'alog_1']);
    expect(mockClient.audit.get).toHaveBeenCalledWith('alog_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('get --json outputs JSON object', async () => {
    mockClient.audit.get.mockResolvedValue(sampleEntry);
    setJsonMode(true);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'alog_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.entryId).toBe('alog_1');
    expect(parsed.action).toBe('email.read');
  });

  it('get displays record fields in text mode', async () => {
    mockClient.audit.get.mockResolvedValue(sampleEntry);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'alog_1']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('alog_1');
    expect(allArgs).toContain('email.read');
  });

  // ── log ───────────────────────────────────────────────────────────────

  it('log calls audit.log with required options', async () => {
    mockClient.audit.log.mockResolvedValue(sampleEntry);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'log',
      '--agent-id',
      'ag_1',
      '--agent-did',
      'did:grantex:ag_1',
      '--grant-id',
      'grnt_1',
      '--principal-id',
      'user@test.com',
      '--action',
      'email.read',
    ]);
    expect(mockClient.audit.log).toHaveBeenCalledWith({
      agentId: 'ag_1',
      agentDid: 'did:grantex:ag_1',
      grantId: 'grnt_1',
      principalId: 'user@test.com',
      action: 'email.read',
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('log passes status when --status is set', async () => {
    mockClient.audit.log.mockResolvedValue(sampleEntry);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'log',
      '--agent-id',
      'ag_1',
      '--agent-did',
      'did:grantex:ag_1',
      '--grant-id',
      'grnt_1',
      '--principal-id',
      'user@test.com',
      '--action',
      'email.read',
      '--status',
      'failure',
    ]);
    expect(mockClient.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failure' }),
    );
  });

  it('log passes metadata when --metadata is valid JSON', async () => {
    mockClient.audit.log.mockResolvedValue(sampleEntry);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'log',
      '--agent-id',
      'ag_1',
      '--agent-did',
      'did:grantex:ag_1',
      '--grant-id',
      'grnt_1',
      '--principal-id',
      'user@test.com',
      '--action',
      'email.read',
      '--metadata',
      '{"key":"value","count":42}',
    ]);
    expect(mockClient.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { key: 'value', count: 42 },
      }),
    );
  });

  it('log exits with error when --metadata is invalid JSON', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });
    const cmd = auditCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync([
        'node',
        'test',
        'log',
        '--agent-id',
        'ag_1',
        '--agent-did',
        'did:grantex:ag_1',
        '--grant-id',
        'grnt_1',
        '--principal-id',
        'user@test.com',
        '--action',
        'email.read',
        '--metadata',
        '{not valid json',
      ]),
    ).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith('Error: --metadata must be valid JSON.');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('log --json outputs JSON', async () => {
    mockClient.audit.log.mockResolvedValue(sampleEntry);
    setJsonMode(true);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'log',
      '--agent-id',
      'ag_1',
      '--agent-did',
      'did:grantex:ag_1',
      '--grant-id',
      'grnt_1',
      '--principal-id',
      'user@test.com',
      '--action',
      'email.read',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.entryId).toBe('alog_1');
  });

  it('log prints success message in text mode', async () => {
    mockClient.audit.log.mockResolvedValue(sampleEntry);
    const cmd = auditCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'log',
      '--agent-id',
      'ag_1',
      '--agent-did',
      'did:grantex:ag_1',
      '--grant-id',
      'grnt_1',
      '--principal-id',
      'user@test.com',
      '--action',
      'email.read',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('alog_1');
  });
});
