import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { billingCommand } from '../src/commands/billing.js';
import { setJsonMode } from '../src/format.js';

const mockClient = {
  billing: {
    getSubscription: vi.fn(),
    createCheckout: vi.fn(),
    createPortal: vi.fn(),
  },
};

describe('billingCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

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

  // ── status action ────────────────────────────────────────────────────

  it('status calls billing.getSubscription and prints record', async () => {
    mockClient.billing.getSubscription.mockResolvedValue({
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: '2026-02-01',
    });
    const cmd = billingCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'status']);
    expect(mockClient.billing.getSubscription).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  it('status handles null currentPeriodEnd', async () => {
    mockClient.billing.getSubscription.mockResolvedValue({
      plan: 'free',
      status: 'active',
      currentPeriodEnd: null,
    });
    const cmd = billingCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'status']);
    expect(mockClient.billing.getSubscription).toHaveBeenCalledOnce();
  });

  // ── checkout action ──────────────────────────────────────────────────

  it('checkout calls billing.createCheckout and prints URL', async () => {
    mockClient.billing.createCheckout.mockResolvedValue({
      checkoutUrl: 'https://stripe.com/checkout',
    });
    const cmd = billingCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'checkout', 'pro',
      '--success-url', 'https://app.com/success',
      '--cancel-url', 'https://app.com/cancel',
    ]);
    expect(mockClient.billing.createCheckout).toHaveBeenCalledWith({
      plan: 'pro',
      successUrl: 'https://app.com/success',
      cancelUrl: 'https://app.com/cancel',
    });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('https://stripe.com/checkout');
  });

  it('checkout --json outputs JSON', async () => {
    mockClient.billing.createCheckout.mockResolvedValue({
      checkoutUrl: 'https://stripe.com/checkout',
    });
    setJsonMode(true);
    const cmd = billingCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'checkout', 'pro',
      '--success-url', 'https://app.com/success',
      '--cancel-url', 'https://app.com/cancel',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.checkoutUrl).toBe('https://stripe.com/checkout');
  });

  // ── portal action ───────────────────────────────────────────────────

  it('portal calls billing.createPortal and prints URL', async () => {
    mockClient.billing.createPortal.mockResolvedValue({
      portalUrl: 'https://stripe.com/portal',
    });
    const cmd = billingCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'portal',
      '--return-url', 'https://app.com/dashboard',
    ]);
    expect(mockClient.billing.createPortal).toHaveBeenCalledWith({
      returnUrl: 'https://app.com/dashboard',
    });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('https://stripe.com/portal');
  });

  it('portal --json outputs JSON', async () => {
    mockClient.billing.createPortal.mockResolvedValue({
      portalUrl: 'https://stripe.com/portal',
    });
    setJsonMode(true);
    const cmd = billingCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'portal',
      '--return-url', 'https://app.com/dashboard',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.portalUrl).toBe('https://stripe.com/portal');
  });
});
