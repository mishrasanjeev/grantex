import { describe, it, expect } from 'vitest';
import { scimCommand } from '../src/commands/scim.js';

describe('scimCommand()', () => {
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
});
