import { describe, it, expect } from 'vitest';
import { anomaliesCommand } from '../src/commands/anomalies.js';

describe('anomaliesCommand()', () => {
  it('registers the "anomalies" command', () => {
    const cmd = anomaliesCommand();
    expect(cmd.name()).toBe('anomalies');
  });

  it('has detect, list, and acknowledge subcommands', () => {
    const cmd = anomaliesCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('detect');
    expect(names).toContain('list');
    expect(names).toContain('acknowledge');
  });

  it('"list" has --unacknowledged option', () => {
    const cmd = anomaliesCommand();
    const listCmd = cmd.commands.find((c) => c.name() === 'list')!;
    const optNames = listCmd.options.map((o) => o.long);
    expect(optNames).toContain('--unacknowledged');
  });
});
