import { describe, it, expect, vi, beforeEach } from 'vitest';

import { manifestCommand } from '../src/commands/manifest.js';
import { setJsonMode } from '../src/format.js';

describe('manifestCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "manifest" command name', () => {
    const cmd = manifestCommand();
    expect(cmd.name()).toBe('manifest');
  });

  it('has list, show, validate subcommands', () => {
    const cmd = manifestCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('show');
    expect(names).toContain('validate');
  });

  // ── list ──────────────────────────────────────────────────────────────

  it('list outputs all 53 connectors with tool counts', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    // Check total count in the header
    expect(allArgs).toContain('53 connectors');
    // Spot-check a connector from each category
    expect(allArgs).toContain('stripe');
    expect(allArgs).toContain('darwinbox');
    expect(allArgs).toContain('salesforce');
    expect(allArgs).toContain('jira');
    expect(allArgs).toContain('gmail');
  });

  it('list shows tool counts for connectors', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('tools');
  });

  it('list shows category headers', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('FINANCE');
    expect(allArgs).toContain('HR');
    expect(allArgs).toContain('MARKETING');
    expect(allArgs).toContain('OPS');
    expect(allArgs).toContain('COMMS');
  });

  it('list --category finance filters to finance only', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--category', 'finance']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    // Should contain finance connectors
    expect(allArgs).toContain('stripe');
    expect(allArgs).toContain('quickbooks');
    expect(allArgs).toContain('FINANCE');
    // Should NOT contain non-finance connectors or category headers
    expect(allArgs).not.toContain('HR');
    expect(allArgs).not.toContain('MARKETING');
    expect(allArgs).not.toContain('jira');
    expect(allArgs).not.toContain('salesforce');
    expect(allArgs).not.toContain('gmail');
  });

  it('list --category hr filters to hr only', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--category', 'hr']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('darwinbox');
    expect(allArgs).toContain('okta');
    expect(allArgs).not.toContain('FINANCE');
    expect(allArgs).not.toContain('stripe');
  });

  it('list --category marketing filters to marketing only', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--category', 'marketing']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('hubspot');
    expect(allArgs).toContain('mailchimp');
    expect(allArgs).not.toContain('FINANCE');
    expect(allArgs).not.toContain('jira');
  });

  it('list --json with unknown category outputs empty JSON array', async () => {
    setJsonMode(true);
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--category', 'nonexistent']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  });

  it('list --json outputs JSON array', async () => {
    setJsonMode(true);
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(53);
    // Check structure
    expect(parsed[0]).toHaveProperty('connector');
    expect(parsed[0]).toHaveProperty('tools');
    expect(parsed[0]).toHaveProperty('category');
    expect(typeof parsed[0].connector).toBe('string');
    expect(typeof parsed[0].tools).toBe('number');
    expect(typeof parsed[0].category).toBe('string');
  });

  it('list --json with --category filters JSON output', async () => {
    setJsonMode(true);
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--category', 'finance']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    // Every entry should be finance category
    for (const entry of parsed) {
      expect(entry.category).toBe('finance');
    }
    // Should include known finance connectors
    const connectors = parsed.map((e: { connector: string }) => e.connector);
    expect(connectors).toContain('stripe');
    expect(connectors).toContain('quickbooks');
    expect(connectors).not.toContain('jira');
    expect(connectors).not.toContain('gmail');
  });

  it('list --json contains expected connectors in each category', async () => {
    setJsonMode(true);
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output) as { connector: string; tools: number; category: string }[];

    const byCategory = (cat: string) => parsed.filter((e) => e.category === cat);

    expect(byCategory('finance').length).toBe(11);
    expect(byCategory('hr').length).toBe(8);
    expect(byCategory('marketing').length).toBe(16);
    expect(byCategory('ops').length).toBe(7);
    expect(byCategory('comms').length).toBe(11);
  });

  it('list text mode includes usage hint', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allArgs).toContain('grantex.manifests.');
  });

  it('list text mode shows total tool count across all connectors', async () => {
    const cmd = manifestCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    const allArgs = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    // The header should contain the total tools count
    expect(allArgs).toMatch(/\d+ tools/);
  });
});
