import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { scimCommand } from '../src/commands/scim.js';
import { setJsonMode } from '../src/format.js';

const sampleUser = {
  id: 'usr_1',
  userName: 'john@co.com',
  displayName: 'John',
  active: true,
  emails: [{ value: 'john@co.com', primary: true }],
};

const mockClient = {
  scim: {
    listTokens: vi.fn(),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
    listUsers: vi.fn(),
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    replaceUser: vi.fn(),
    deleteUser: vi.fn(),
  },
};

describe('scimCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "scim" command', () => {
    const cmd = scimCommand();
    expect(cmd.name()).toBe('scim');
  });

  it('has "tokens" and "users" nested command groups', () => {
    const cmd = scimCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('tokens');
    expect(names).toContain('users');
  });

  it('"tokens" has list, create, and revoke subcommands', () => {
    const cmd = scimCommand();
    const tokensCmd = cmd.commands.find((c) => c.name() === 'tokens')!;
    const names = tokensCmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('create');
    expect(names).toContain('revoke');
  });

  it('"tokens create" has --label option', () => {
    const cmd = scimCommand();
    const tokensCmd = cmd.commands.find((c) => c.name() === 'tokens')!;
    const createCmd = tokensCmd.commands.find((c) => c.name() === 'create')!;
    const optNames = createCmd.options.map((o) => o.long);
    expect(optNames).toContain('--label');
  });

  it('"users" has list and get subcommands', () => {
    const cmd = scimCommand();
    const usersCmd = cmd.commands.find((c) => c.name() === 'users')!;
    const names = usersCmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('get');
  });

  it('"users list" has --start-index and --count options', () => {
    const cmd = scimCommand();
    const usersCmd = cmd.commands.find((c) => c.name() === 'users')!;
    const listCmd = usersCmd.commands.find((c) => c.name() === 'list')!;
    const optNames = listCmd.options.map((o) => o.long);
    expect(optNames).toContain('--start-index');
    expect(optNames).toContain('--count');
  });

  // ── tokens list action ───────────────────────────────────────────────

  it('tokens list calls scim.listTokens and prints table', async () => {
    mockClient.scim.listTokens.mockResolvedValue({
      tokens: [{
        id: 'tok_1',
        label: 'Okta',
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: null,
      }],
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'tokens', 'list']);
    expect(mockClient.scim.listTokens).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  it('tokens list shows lastUsedAt when present', async () => {
    mockClient.scim.listTokens.mockResolvedValue({
      tokens: [{
        id: 'tok_1',
        label: 'Okta',
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: '2026-01-15T00:00:00Z',
      }],
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'tokens', 'list']);
    expect(mockClient.scim.listTokens).toHaveBeenCalledOnce();
  });

  // ── tokens create action ─────────────────────────────────────────────

  it('tokens create calls scim.createToken and prints token', async () => {
    mockClient.scim.createToken.mockResolvedValue({
      id: 'tok_1',
      token: 'scim_abc123',
      label: 'Okta',
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'tokens', 'create', '--label', 'Okta']);
    expect(mockClient.scim.createToken).toHaveBeenCalledWith({ label: 'Okta' });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('tok_1');
  });

  it('tokens create --json outputs JSON', async () => {
    mockClient.scim.createToken.mockResolvedValue({
      id: 'tok_1',
      token: 'scim_abc123',
      label: 'Okta',
    });
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'tokens', 'create', '--label', 'Okta']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('tok_1');
    expect(parsed.token).toBe('scim_abc123');
  });

  // ── tokens revoke action ─────────────────────────────────────────────

  it('tokens revoke calls scim.revokeToken', async () => {
    mockClient.scim.revokeToken.mockResolvedValue(undefined);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'tokens', 'revoke', 'tok_1']);
    expect(mockClient.scim.revokeToken).toHaveBeenCalledWith('tok_1');
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('tok_1');
    expect(allOutput).toContain('revoked');
  });

  it('tokens revoke --json outputs JSON', async () => {
    mockClient.scim.revokeToken.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'tokens', 'revoke', 'tok_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.revoked).toBe('tok_1');
  });

  // ── users list action ────────────────────────────────────────────────

  it('users list calls scim.listUsers and prints table', async () => {
    mockClient.scim.listUsers.mockResolvedValue({
      Resources: [sampleUser],
      totalResults: 1,
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'list']);
    expect(mockClient.scim.listUsers).toHaveBeenCalledWith({
      startIndex: 1,
      count: 25,
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('users list passes --start-index and --count', async () => {
    mockClient.scim.listUsers.mockResolvedValue({
      Resources: [sampleUser],
      totalResults: 1,
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'list', '--start-index', '5', '--count', '10']);
    expect(mockClient.scim.listUsers).toHaveBeenCalledWith({
      startIndex: 5,
      count: 10,
    });
  });

  it('users list handles user with null displayName', async () => {
    mockClient.scim.listUsers.mockResolvedValue({
      Resources: [{ ...sampleUser, displayName: null }],
      totalResults: 1,
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'list']);
    expect(mockClient.scim.listUsers).toHaveBeenCalledOnce();
  });

  // ── users get action ─────────────────────────────────────────────────

  it('users get calls scim.getUser and prints record', async () => {
    mockClient.scim.getUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'get', 'usr_1']);
    expect(mockClient.scim.getUser).toHaveBeenCalledWith('usr_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('users get --json outputs JSON', async () => {
    mockClient.scim.getUser.mockResolvedValue(sampleUser);
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'get', 'usr_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('usr_1');
    expect(parsed.userName).toBe('john@co.com');
  });

  it('users get handles null displayName', async () => {
    mockClient.scim.getUser.mockResolvedValue({ ...sampleUser, displayName: null });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'get', 'usr_1']);
    expect(mockClient.scim.getUser).toHaveBeenCalledWith('usr_1');
  });

  it('users get handles empty emails', async () => {
    mockClient.scim.getUser.mockResolvedValue({ ...sampleUser, emails: [] });
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'get', 'usr_1']);
    expect(mockClient.scim.getUser).toHaveBeenCalledWith('usr_1');
  });

  // ── users create action ──────────────────────────────────────────────

  it('users create calls scim.createUser with required options', async () => {
    mockClient.scim.createUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'create', '--user-name', 'john@co.com']);
    expect(mockClient.scim.createUser).toHaveBeenCalledWith({
      userName: 'john@co.com',
    });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('usr_1');
  });

  it('users create passes all optional fields', async () => {
    mockClient.scim.createUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'create',
      '--user-name', 'john@co.com',
      '--display-name', 'John',
      '--external-id', 'ext_1',
      '--email', 'john@co.com',
    ]);
    expect(mockClient.scim.createUser).toHaveBeenCalledWith({
      userName: 'john@co.com',
      displayName: 'John',
      externalId: 'ext_1',
      emails: [{ value: 'john@co.com', primary: true }],
    });
  });

  it('users create --json outputs JSON', async () => {
    mockClient.scim.createUser.mockResolvedValue(sampleUser);
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'create', '--user-name', 'john@co.com']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('usr_1');
  });

  // ── users update action ──────────────────────────────────────────────

  it('users update calls scim.updateUser with PATCH operations', async () => {
    mockClient.scim.updateUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'update', 'usr_1',
      '--display-name', 'Jane',
    ]);
    expect(mockClient.scim.updateUser).toHaveBeenCalledWith('usr_1', [
      { op: 'replace', path: 'displayName', value: 'Jane' },
    ]);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('updated');
  });

  it('users update builds multiple operations', async () => {
    mockClient.scim.updateUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'update', 'usr_1',
      '--display-name', 'Jane',
      '--active', 'false',
      '--user-name', 'jane@co.com',
    ]);
    expect(mockClient.scim.updateUser).toHaveBeenCalledWith('usr_1', [
      { op: 'replace', path: 'displayName', value: 'Jane' },
      { op: 'replace', path: 'active', value: false },
      { op: 'replace', path: 'userName', value: 'jane@co.com' },
    ]);
  });

  it('users update --json outputs JSON', async () => {
    mockClient.scim.updateUser.mockResolvedValue(sampleUser);
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'update', 'usr_1',
      '--display-name', 'Jane',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('usr_1');
  });

  it('users update with no fields exits with error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });
    const cmd = scimCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['node', 'test', 'users', 'update', 'usr_1']),
    ).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('provide at least one field'));
    exitSpy.mockRestore();
  });

  // ── users replace action ─────────────────────────────────────────────

  it('users replace calls scim.replaceUser with required fields', async () => {
    mockClient.scim.replaceUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'replace', 'usr_1',
      '--user-name', 'john@co.com',
    ]);
    expect(mockClient.scim.replaceUser).toHaveBeenCalledWith('usr_1', {
      userName: 'john@co.com',
      active: true,
    });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('replaced');
  });

  it('users replace passes all optional fields', async () => {
    mockClient.scim.replaceUser.mockResolvedValue(sampleUser);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'replace', 'usr_1',
      '--user-name', 'john@co.com',
      '--display-name', 'John',
      '--email', 'john@co.com',
      '--active', 'false',
    ]);
    expect(mockClient.scim.replaceUser).toHaveBeenCalledWith('usr_1', {
      userName: 'john@co.com',
      displayName: 'John',
      emails: [{ value: 'john@co.com', primary: true }],
      active: false,
    });
  });

  it('users replace --json outputs JSON', async () => {
    mockClient.scim.replaceUser.mockResolvedValue(sampleUser);
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'users', 'replace', 'usr_1',
      '--user-name', 'john@co.com',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('usr_1');
  });

  // ── users delete action ──────────────────────────────────────────────

  it('users delete calls scim.deleteUser', async () => {
    mockClient.scim.deleteUser.mockResolvedValue(undefined);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'delete', 'usr_1']);
    expect(mockClient.scim.deleteUser).toHaveBeenCalledWith('usr_1');
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('usr_1');
    expect(allOutput).toContain('deleted');
  });

  it('users delete --json outputs JSON', async () => {
    mockClient.scim.deleteUser.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = scimCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'users', 'delete', 'usr_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.deleted).toBe('usr_1');
  });
});
