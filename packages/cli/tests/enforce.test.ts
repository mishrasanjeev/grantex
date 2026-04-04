import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { enforceCommand } from '../src/commands/enforce.js';
import { setJsonMode } from '../src/format.js';

const enforceAllowedResult = {
  allowed: true,
  scopes: ['salesforce:read', 'salesforce:write'],
  permission: 'read',
  grantId: 'grnt_1',
  agentDid: 'did:grantex:ag_1',
  reason: '',
  connector: 'salesforce',
  tool: 'query',
};

const enforceDeniedResult = {
  allowed: false,
  scopes: ['salesforce:read'],
  permission: 'delete',
  reason: 'Scope salesforce:delete required but not granted',
  grantId: 'grnt_1',
  agentDid: 'did:grantex:ag_1',
  connector: 'salesforce',
  tool: 'delete_contact',
};

const mockClient = {
  enforce: vi.fn(),
  loadManifest: vi.fn(),
};

describe('enforceCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "enforce" command name', () => {
    const cmd = enforceCommand();
    expect(cmd.name()).toBe('enforce');
  });

  it('has test subcommand', () => {
    const cmd = enforceCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('test');
  });

  // ── test (allowed) ────────────────────────────────────────────────────

  it('test calls enforce with token, connector, and tool', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
    ]);
    expect(mockClient.loadManifest).toHaveBeenCalledOnce();
    expect(mockClient.enforce).toHaveBeenCalledWith({
      grantToken: 'jwt_token_value',
      connector: 'salesforce',
      tool: 'query',
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('test outputs ALLOWED for permitted tool call', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('ALLOWED');
  });

  it('test outputs scopes and permission in text mode', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('salesforce:read');
    expect(allArgs).toContain('salesforce:write');
    expect(allArgs).toContain('read');
  });

  it('test displays grantId and agentDid when present', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('grnt_1');
    expect(allArgs).toContain('did:grantex:ag_1');
  });

  // ── test (denied) ─────────────────────────────────────────────────────

  it('test outputs DENIED for disallowed tool call', async () => {
    mockClient.enforce.mockResolvedValue(enforceDeniedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'delete_contact',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('DENIED');
  });

  it('test outputs denial reason for disallowed tool call', async () => {
    mockClient.enforce.mockResolvedValue(enforceDeniedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'delete_contact',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('Scope salesforce:delete required but not granted');
  });

  // ── test --amount ─────────────────────────────────────────────────────

  it('test passes amount when --amount is set', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
      '--amount',
      '50.5',
    ]);
    expect(mockClient.enforce).toHaveBeenCalledWith({
      grantToken: 'jwt_token_value',
      connector: 'salesforce',
      tool: 'query',
      amount: 50.5,
    });
  });

  // ── test --json ───────────────────────────────────────────────────────

  it('test --json outputs JSON for allowed result', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    setJsonMode(true);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.allowed).toBe(true);
    expect(parsed.scopes).toEqual(['salesforce:read', 'salesforce:write']);
    expect(parsed.permission).toBe('read');
    expect(parsed.grantId).toBe('grnt_1');
  });

  it('test --json outputs JSON for denied result', async () => {
    mockClient.enforce.mockResolvedValue(enforceDeniedResult);
    setJsonMode(true);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'delete_contact',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.allowed).toBe(false);
    expect(parsed.reason).toContain('salesforce:delete');
  });

  // ── test with unknown connector ───────────────────────────────────────

  it('test with unknown connector outputs error in text mode', async () => {
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'unknown_connector',
      '--tool',
      'query',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain("No manifest found for connector 'unknown_connector'");
    expect(allArgs).toContain('grantex manifest list');
    // enforce should not have been called
    expect(mockClient.enforce).not.toHaveBeenCalled();
  });

  it('test --json with unknown connector outputs JSON error', async () => {
    setJsonMode(true);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'unknown_connector',
      '--tool',
      'query',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.allowed).toBe(false);
    expect(parsed.reason).toContain('unknown_connector');
    expect(mockClient.enforce).not.toHaveBeenCalled();
  });

  it('test with unknown connector does not call loadManifest', async () => {
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'nonexistent',
      '--tool',
      'some_tool',
    ]);
    expect(mockClient.loadManifest).not.toHaveBeenCalled();
    expect(mockClient.enforce).not.toHaveBeenCalled();
  });

  it('test --json with unknown connector returns correct JSON shape', async () => {
    setJsonMode(true);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'no_such_thing',
      '--tool',
      'query',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      allowed: false,
      reason: "No manifest found for connector 'no_such_thing'",
    });
  });

  // ── loadManifest called ───────────────────────────────────────────────

  it('test loads the manifest before calling enforce', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'list_opportunities',
    ]);
    // loadManifest should be called with the salesforce manifest object
    expect(mockClient.loadManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: 'salesforce',
      }),
    );
    // enforce should follow
    expect(mockClient.enforce).toHaveBeenCalledWith({
      grantToken: 'jwt_token_value',
      connector: 'salesforce',
      tool: 'list_opportunities',
    });
  });

  it('test calls loadManifest before enforce in correct order', async () => {
    mockClient.enforce.mockResolvedValue(enforceAllowedResult);
    const callOrder: string[] = [];
    mockClient.loadManifest.mockImplementation(() => {
      callOrder.push('loadManifest');
    });
    mockClient.enforce.mockImplementation(async () => {
      callOrder.push('enforce');
      return enforceAllowedResult;
    });

    const cmd = enforceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'test',
      '--token',
      'jwt_token_value',
      '--connector',
      'salesforce',
      '--tool',
      'query',
    ]);
    expect(callOrder).toEqual(['loadManifest', 'enforce']);
  });
});
