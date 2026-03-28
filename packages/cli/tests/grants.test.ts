import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { grantsCommand } from '../src/commands/grants.js';
import { setJsonMode } from '../src/format.js';

const sampleGrant = {
  grantId: 'grnt_1',
  agentId: 'ag_1',
  principalId: 'user@test.com',
  status: 'active',
  scopes: ['email:read'],
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-02T00:00:00Z',
};

const delegateResponse = {
  grantToken: 'jwt_header.jwt_payload.jwt_signature_long_enough',
  expiresAt: '2026-01-02T00:00:00Z',
  scopes: ['email:read'],
  grantId: 'grnt_2',
};

const mockClient = {
  grants: {
    list: vi.fn(),
    get: vi.fn(),
    revoke: vi.fn(),
    delegate: vi.fn(),
  },
};

describe('grantsCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "grants" command name', () => {
    const cmd = grantsCommand();
    expect(cmd.name()).toBe('grants');
  });

  it('has list, get, revoke, delegate subcommands', () => {
    const cmd = grantsCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('get');
    expect(names).toContain('revoke');
    expect(names).toContain('delegate');
  });

  // ── list ──────────────────────────────────────────────────────────────

  it('list calls grants.list with no filters by default', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [sampleGrant] });
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.grants.list).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('list passes agentId filter from --agent', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [] });
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--agent', 'ag_1']);
    expect(mockClient.grants.list).toHaveBeenCalledWith({ agentId: 'ag_1' });
  });

  it('list passes principalId filter from --principal', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [] });
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--principal', 'user@test.com']);
    expect(mockClient.grants.list).toHaveBeenCalledWith({ principalId: 'user@test.com' });
  });

  it('list passes status filter from --status', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [] });
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--status', 'revoked']);
    expect(mockClient.grants.list).toHaveBeenCalledWith({ status: 'revoked' });
  });

  it('list passes multiple filters simultaneously', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [] });
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'list',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--status',
      'active',
    ]);
    expect(mockClient.grants.list).toHaveBeenCalledWith({
      agentId: 'ag_1',
      principalId: 'user@test.com',
      status: 'active',
    });
  });

  it('list prints "(no results)" for empty list', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [] });
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(console.log).toHaveBeenCalledWith('(no results)');
  });

  it('list --json outputs JSON array', async () => {
    mockClient.grants.list.mockResolvedValue({ grants: [sampleGrant] });
    setJsonMode(true);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].grantId).toBe('grnt_1');
  });

  // ── get ───────────────────────────────────────────────────────────────

  it('get calls grants.get with grantId', async () => {
    mockClient.grants.get.mockResolvedValue(sampleGrant);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'grnt_1']);
    expect(mockClient.grants.get).toHaveBeenCalledWith('grnt_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('get --json outputs JSON object', async () => {
    mockClient.grants.get.mockResolvedValue(sampleGrant);
    setJsonMode(true);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'grnt_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.grantId).toBe('grnt_1');
    expect(parsed.status).toBe('active');
  });

  // ── revoke ────────────────────────────────────────────────────────────

  it('revoke calls grants.revoke with grantId', async () => {
    mockClient.grants.revoke.mockResolvedValue(undefined);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'revoke', 'grnt_1']);
    expect(mockClient.grants.revoke).toHaveBeenCalledWith('grnt_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('revoke --json outputs JSON', async () => {
    mockClient.grants.revoke.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'revoke', 'grnt_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.revoked).toBe('grnt_1');
  });

  // ── delegate ──────────────────────────────────────────────────────────

  it('delegate calls grants.delegate with required options', async () => {
    mockClient.grants.delegate.mockResolvedValue(delegateResponse);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'delegate',
      '--grant-token',
      'parent_jwt',
      '--agent-id',
      'ag_child',
      '--scopes',
      'email:read',
    ]);
    expect(mockClient.grants.delegate).toHaveBeenCalledWith({
      parentGrantToken: 'parent_jwt',
      subAgentId: 'ag_child',
      scopes: ['email:read'],
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('delegate passes expiresIn when --expires-in is set', async () => {
    mockClient.grants.delegate.mockResolvedValue(delegateResponse);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'delegate',
      '--grant-token',
      'parent_jwt',
      '--agent-id',
      'ag_child',
      '--scopes',
      'email:read',
      '--expires-in',
      '1h',
    ]);
    expect(mockClient.grants.delegate).toHaveBeenCalledWith({
      parentGrantToken: 'parent_jwt',
      subAgentId: 'ag_child',
      scopes: ['email:read'],
      expiresIn: '1h',
    });
  });

  it('delegate splits comma-separated scopes', async () => {
    mockClient.grants.delegate.mockResolvedValue(delegateResponse);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'delegate',
      '--grant-token',
      'parent_jwt',
      '--agent-id',
      'ag_child',
      '--scopes',
      'email:read, calendar:write',
    ]);
    expect(mockClient.grants.delegate).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ['email:read', 'calendar:write'],
      }),
    );
  });

  it('delegate --json outputs JSON', async () => {
    mockClient.grants.delegate.mockResolvedValue(delegateResponse);
    setJsonMode(true);
    const cmd = grantsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'delegate',
      '--grant-token',
      'parent_jwt',
      '--agent-id',
      'ag_child',
      '--scopes',
      'email:read',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.grantId).toBe('grnt_2');
    expect(parsed.grantToken).toBe(delegateResponse.grantToken);
  });
});
