import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { ssoCommand } from '../src/commands/sso.js';
import { setJsonMode } from '../src/format.js';

const ssoConfig = {
  issuerUrl: 'https://accounts.google.com',
  clientId: 'abc',
  redirectUri: 'https://app.com/cb',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockClient = {
  sso: {
    getConfig: vi.fn(),
    createConfig: vi.fn(),
    deleteConfig: vi.fn(),
    getLoginUrl: vi.fn(),
    handleCallback: vi.fn(),
  },
};

describe('ssoCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "sso" command', () => {
    const cmd = ssoCommand();
    expect(cmd.name()).toBe('sso');
  });

  it('has get, configure, delete, and login-url subcommands', () => {
    const cmd = ssoCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('get');
    expect(names).toContain('configure');
    expect(names).toContain('delete');
    expect(names).toContain('login-url');
  });

  it('"configure" has --issuer-url, --client-id, --client-secret, --redirect-uri options', () => {
    const cmd = ssoCommand();
    const configureCmd = cmd.commands.find((c) => c.name() === 'configure')!;
    const optNames = configureCmd.options.map((o) => o.long);
    expect(optNames).toContain('--issuer-url');
    expect(optNames).toContain('--client-id');
    expect(optNames).toContain('--client-secret');
    expect(optNames).toContain('--redirect-uri');
  });

  // ── get action ───────────────────────────────────────────────────────

  it('get calls sso.getConfig and prints record', async () => {
    mockClient.sso.getConfig.mockResolvedValue(ssoConfig);
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get']);
    expect(mockClient.sso.getConfig).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  // ── configure action ─────────────────────────────────────────────────

  it('configure calls sso.createConfig with all options', async () => {
    mockClient.sso.createConfig.mockResolvedValue(undefined);
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'configure',
      '--issuer-url', 'https://accounts.google.com',
      '--client-id', 'abc',
      '--client-secret', 'secret',
      '--redirect-uri', 'https://app.com/cb',
    ]);
    expect(mockClient.sso.createConfig).toHaveBeenCalledWith({
      issuerUrl: 'https://accounts.google.com',
      clientId: 'abc',
      clientSecret: 'secret',
      redirectUri: 'https://app.com/cb',
    });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('SSO configuration saved');
  });

  // ── delete action ────────────────────────────────────────────────────

  it('delete calls sso.deleteConfig', async () => {
    mockClient.sso.deleteConfig.mockResolvedValue(undefined);
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete']);
    expect(mockClient.sso.deleteConfig).toHaveBeenCalledOnce();
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('SSO configuration deleted');
  });

  // ── login-url action ─────────────────────────────────────────────────

  it('login-url calls sso.getLoginUrl and prints URL', async () => {
    mockClient.sso.getLoginUrl.mockResolvedValue({
      authorizeUrl: 'https://accounts.google.com/authorize?state=abc',
    });
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'login-url', 'my-org']);
    expect(mockClient.sso.getLoginUrl).toHaveBeenCalledWith('my-org');
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('https://accounts.google.com/authorize');
  });

  it('login-url --json outputs JSON', async () => {
    mockClient.sso.getLoginUrl.mockResolvedValue({
      authorizeUrl: 'https://accounts.google.com/authorize?state=abc',
    });
    setJsonMode(true);
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'login-url', 'my-org']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.authorizeUrl).toContain('https://accounts.google.com/authorize');
  });

  // ── callback action ──────────────────────────────────────────────────

  it('callback calls sso.handleCallback and prints record', async () => {
    mockClient.sso.handleCallback.mockResolvedValue({
      email: 'test@co.com',
      name: 'Test',
      sub: 'sub_1',
      developerId: 'dev_1',
    });
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'callback',
      '--code', 'auth_code_1',
      '--state', 'state_abc',
    ]);
    expect(mockClient.sso.handleCallback).toHaveBeenCalledWith('auth_code_1', 'state_abc');
    expect(console.log).toHaveBeenCalled();
  });

  it('callback --json outputs JSON', async () => {
    mockClient.sso.handleCallback.mockResolvedValue({
      email: 'test@co.com',
      name: 'Test',
      sub: 'sub_1',
      developerId: 'dev_1',
    });
    setJsonMode(true);
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'callback',
      '--code', 'auth_code_1',
      '--state', 'state_abc',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.email).toBe('test@co.com');
    expect(parsed.developerId).toBe('dev_1');
  });

  it('callback handles null email and name', async () => {
    mockClient.sso.handleCallback.mockResolvedValue({
      email: null,
      name: null,
      sub: null,
      developerId: 'dev_1',
    });
    const cmd = ssoCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'callback',
      '--code', 'auth_code_1',
      '--state', 'state_abc',
    ]);
    expect(mockClient.sso.handleCallback).toHaveBeenCalledWith('auth_code_1', 'state_abc');
  });
});
