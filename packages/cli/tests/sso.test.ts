import { describe, it, expect } from 'vitest';
import { ssoCommand } from '../src/commands/sso.js';

describe('ssoCommand()', () => {
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
});
