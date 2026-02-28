import { describe, it, expect } from 'vitest';
import { billingCommand } from '../src/commands/billing.js';

describe('billingCommand()', () => {
  it('registers the "billing" command', () => {
    const cmd = billingCommand();
    expect(cmd.name()).toBe('billing');
  });

  it('has status, checkout, and portal subcommands', () => {
    const cmd = billingCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('status');
    expect(names).toContain('checkout');
    expect(names).toContain('portal');
  });

  it('"checkout" has --success-url and --cancel-url options', () => {
    const cmd = billingCommand();
    const checkoutCmd = cmd.commands.find((c) => c.name() === 'checkout')!;
    const optNames = checkoutCmd.options.map((o) => o.long);
    expect(optNames).toContain('--success-url');
    expect(optNames).toContain('--cancel-url');
  });

  it('"portal" has --return-url option', () => {
    const cmd = billingCommand();
    const portalCmd = cmd.commands.find((c) => c.name() === 'portal')!;
    const optNames = portalCmd.options.map((o) => o.long);
    expect(optNames).toContain('--return-url');
  });
});
