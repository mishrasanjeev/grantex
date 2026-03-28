import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { tokensCommand } from '../src/commands/tokens.js';
import { setJsonMode } from '../src/format.js';

const exchangeResponse = {
  grantToken: 'jwt_header.jwt_payload.jwt_signature_long_enough',
  expiresAt: '2026-01-02T00:00:00Z',
  scopes: ['email:read'],
  refreshToken: 'ref_1',
  grantId: 'grnt_1',
};

const verifyValidResponse = {
  valid: true,
  grantId: 'grnt_1',
  scopes: ['email:read'],
  principal: 'user@test.com',
  agent: 'did:grantex:ag_1',
  expiresAt: '2026-01-02T00:00:00Z',
};

const verifyInvalidResponse = {
  valid: false,
  grantId: null,
  scopes: [],
  principal: null,
  agent: null,
  expiresAt: null,
};

const mockClient = {
  tokens: {
    exchange: vi.fn(),
    verify: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
  },
};

describe('tokensCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "tokens" command name', () => {
    const cmd = tokensCommand();
    expect(cmd.name()).toBe('tokens');
  });

  it('has exchange, verify, refresh, revoke subcommands', () => {
    const cmd = tokensCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('exchange');
    expect(names).toContain('verify');
    expect(names).toContain('refresh');
    expect(names).toContain('revoke');
  });

  // ── exchange ──────────────────────────────────────────────────────────

  it('exchange calls tokens.exchange with code and agentId', async () => {
    mockClient.tokens.exchange.mockResolvedValue(exchangeResponse);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'exchange',
      '--code',
      'auth_code_1',
      '--agent-id',
      'ag_1',
    ]);
    expect(mockClient.tokens.exchange).toHaveBeenCalledWith({
      code: 'auth_code_1',
      agentId: 'ag_1',
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('exchange passes codeVerifier when --code-verifier is set', async () => {
    mockClient.tokens.exchange.mockResolvedValue(exchangeResponse);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'exchange',
      '--code',
      'auth_code_1',
      '--agent-id',
      'ag_1',
      '--code-verifier',
      'verifier_value',
    ]);
    expect(mockClient.tokens.exchange).toHaveBeenCalledWith({
      code: 'auth_code_1',
      agentId: 'ag_1',
      codeVerifier: 'verifier_value',
    });
  });

  it('exchange --json outputs JSON', async () => {
    mockClient.tokens.exchange.mockResolvedValue(exchangeResponse);
    setJsonMode(true);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'exchange',
      '--code',
      'auth_code_1',
      '--agent-id',
      'ag_1',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.grantToken).toBe(exchangeResponse.grantToken);
    expect(parsed.grantId).toBe('grnt_1');
  });

  // ── verify ────────────────────────────────────────────────────────────

  it('verify calls tokens.verify with the token argument', async () => {
    mockClient.tokens.verify.mockResolvedValue(verifyValidResponse);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', 'some_jwt_token']);
    expect(mockClient.tokens.verify).toHaveBeenCalledWith('some_jwt_token');
    expect(console.log).toHaveBeenCalled();
  });

  it('verify prints success for valid token', async () => {
    mockClient.tokens.verify.mockResolvedValue(verifyValidResponse);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', 'some_jwt_token']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('valid');
  });

  it('verify prints error and exits 1 for invalid token', async () => {
    mockClient.tokens.verify.mockResolvedValue(verifyInvalidResponse);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });
    const cmd = tokensCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'verify', 'bad_token'])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(console.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('verify --json outputs JSON for valid token', async () => {
    mockClient.tokens.verify.mockResolvedValue(verifyValidResponse);
    setJsonMode(true);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', 'some_jwt_token']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.valid).toBe(true);
    expect(parsed.grantId).toBe('grnt_1');
    expect(parsed.principal).toBe('user@test.com');
  });

  it('verify --json outputs JSON even for invalid token (no exit)', async () => {
    mockClient.tokens.verify.mockResolvedValue(verifyInvalidResponse);
    setJsonMode(true);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', 'bad_token']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.valid).toBe(false);
  });

  // ── refresh ───────────────────────────────────────────────────────────

  it('refresh calls tokens.refresh with refreshToken and agentId', async () => {
    const refreshResponse = { ...exchangeResponse, refreshToken: 'ref_2' };
    mockClient.tokens.refresh.mockResolvedValue(refreshResponse);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'refresh',
      '--refresh-token',
      'ref_1',
      '--agent-id',
      'ag_1',
    ]);
    expect(mockClient.tokens.refresh).toHaveBeenCalledWith({
      refreshToken: 'ref_1',
      agentId: 'ag_1',
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('refresh --json outputs JSON', async () => {
    const refreshResponse = { ...exchangeResponse, refreshToken: 'ref_2' };
    mockClient.tokens.refresh.mockResolvedValue(refreshResponse);
    setJsonMode(true);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'refresh',
      '--refresh-token',
      'ref_1',
      '--agent-id',
      'ag_1',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.refreshToken).toBe('ref_2');
    expect(parsed.grantId).toBe('grnt_1');
  });

  // ── revoke ────────────────────────────────────────────────────────────

  it('revoke calls tokens.revoke with jti', async () => {
    mockClient.tokens.revoke.mockResolvedValue(undefined);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'revoke', 'jti_abc']);
    expect(mockClient.tokens.revoke).toHaveBeenCalledWith('jti_abc');
    expect(console.log).toHaveBeenCalled();
  });

  it('revoke --json outputs JSON', async () => {
    mockClient.tokens.revoke.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = tokensCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'revoke', 'jti_abc']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.revoked).toBe('jti_abc');
  });
});
