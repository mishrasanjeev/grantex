import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { authorizeCommand } from '../src/commands/authorize.js';
import { setJsonMode } from '../src/format.js';

const mockClient = {
  authorize: vi.fn(),
};

describe('authorizeCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "authorize" command name', () => {
    const cmd = authorizeCommand();
    expect(cmd.name()).toBe('authorize');
  });

  it('has --agent, --principal, --scopes required options', () => {
    const cmd = authorizeCommand();
    const optNames = cmd.options.map((o) => o.long);
    expect(optNames).toContain('--agent');
    expect(optNames).toContain('--principal');
    expect(optNames).toContain('--scopes');
  });

  it('has --redirect-uri, --code-challenge, --expires-in optional options', () => {
    const cmd = authorizeCommand();
    const optNames = cmd.options.map((o) => o.long);
    expect(optNames).toContain('--redirect-uri');
    expect(optNames).toContain('--code-challenge');
    expect(optNames).toContain('--expires-in');
  });

  // ── basic authorization ───────────────────────────────────────────────

  it('calls client.authorize with parsed options', async () => {
    mockClient.authorize.mockResolvedValue({
      authRequestId: 'areq_1',
      consentUrl: 'https://grantex.dev/consent?req=areq_1',
      expiresAt: '2026-01-02T00:00:00Z',
      code: 'code_1',
      sandbox: true,
    });
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read, calendar:write',
    ]);
    expect(mockClient.authorize).toHaveBeenCalledWith({
      agentId: 'ag_1',
      userId: 'user@test.com',
      scopes: ['email:read', 'calendar:write'],
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('prints sandbox auto-approved message when code is present', async () => {
    mockClient.authorize.mockResolvedValue({
      authRequestId: 'areq_1',
      consentUrl: 'https://grantex.dev/consent?req=areq_1',
      expiresAt: '2026-01-02T00:00:00Z',
      code: 'code_1',
      sandbox: true,
    });
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read',
    ]);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('sandbox');
  });

  // ── PKCE code challenge ───────────────────────────────────────────────

  it('passes codeChallenge and codeChallengeMethod when --code-challenge is set', async () => {
    mockClient.authorize.mockResolvedValue({
      authRequestId: 'areq_2',
      consentUrl: 'https://grantex.dev/consent?req=areq_2',
      expiresAt: '2026-01-02T00:00:00Z',
    });
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read',
      '--code-challenge',
      'abc123challenge',
    ]);
    expect(mockClient.authorize).toHaveBeenCalledWith({
      agentId: 'ag_1',
      userId: 'user@test.com',
      scopes: ['email:read'],
      codeChallenge: 'abc123challenge',
      codeChallengeMethod: 'S256',
    });
  });

  // ── optional redirect URI and expires-in ──────────────────────────────

  it('passes redirectUri when --redirect-uri is set', async () => {
    mockClient.authorize.mockResolvedValue({
      authRequestId: 'areq_3',
      consentUrl: 'https://grantex.dev/consent?req=areq_3',
      expiresAt: '2026-01-02T00:00:00Z',
    });
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read',
      '--redirect-uri',
      'https://myapp.com/callback',
    ]);
    expect(mockClient.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'https://myapp.com/callback',
      }),
    );
  });

  it('passes expiresIn when --expires-in is set', async () => {
    mockClient.authorize.mockResolvedValue({
      authRequestId: 'areq_4',
      consentUrl: 'https://grantex.dev/consent?req=areq_4',
      expiresAt: '2026-01-02T00:00:00Z',
    });
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read',
      '--expires-in',
      '24h',
    ]);
    expect(mockClient.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresIn: '24h',
      }),
    );
  });

  // ── JSON mode ─────────────────────────────────────────────────────────

  it('--json outputs JSON', async () => {
    const response = {
      authRequestId: 'areq_1',
      consentUrl: 'https://grantex.dev/consent?req=areq_1',
      expiresAt: '2026-01-02T00:00:00Z',
      code: 'code_1',
      sandbox: true,
    };
    mockClient.authorize.mockResolvedValue(response);
    setJsonMode(true);
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.authRequestId).toBe('areq_1');
    expect(parsed.consentUrl).toBe('https://grantex.dev/consent?req=areq_1');
  });

  it('does not print sandbox message in JSON mode', async () => {
    mockClient.authorize.mockResolvedValue({
      authRequestId: 'areq_1',
      consentUrl: 'https://grantex.dev/consent?req=areq_1',
      expiresAt: '2026-01-02T00:00:00Z',
      code: 'code_1',
      sandbox: true,
    });
    setJsonMode(true);
    const cmd = authorizeCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      '--agent',
      'ag_1',
      '--principal',
      'user@test.com',
      '--scopes',
      'email:read',
    ]);
    // In JSON mode, only 1 console.log call with the JSON string
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
