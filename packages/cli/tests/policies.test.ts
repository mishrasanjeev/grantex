import { describe, it, expect } from 'vitest';
import { policiesCommand } from '../src/commands/policies.js';

describe('policiesCommand()', () => {
  it('registers the "policies" command', () => {
    const cmd = policiesCommand();
    expect(cmd.name()).toBe('policies');
  });

  it('has list, get, create, update, and delete subcommands', () => {
    const cmd = policiesCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('get');
    expect(names).toContain('create');
    expect(names).toContain('update');
    expect(names).toContain('delete');
  });

  it('"create" has --name, --effect, --priority, --scopes options', () => {
    const cmd = policiesCommand();
    const createCmd = cmd.commands.find((c) => c.name() === 'create')!;
    const optNames = createCmd.options.map((o) => o.long);
    expect(optNames).toContain('--name');
    expect(optNames).toContain('--effect');
    expect(optNames).toContain('--priority');
    expect(optNames).toContain('--scopes');
  });

  it('"create" has --time-start and --time-end options', () => {
    const cmd = policiesCommand();
    const createCmd = cmd.commands.find((c) => c.name() === 'create')!;
    const optNames = createCmd.options.map((o) => o.long);
    expect(optNames).toContain('--time-start');
    expect(optNames).toContain('--time-end');
  });
});
