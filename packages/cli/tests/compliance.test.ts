import { describe, it, expect, vi, afterEach } from 'vitest';

// ── helpers ──────────────────────────────────────────────────────────────────

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── renderGrants / renderAudit are tested via the exported helpers ────────────

// These helpers are private in compliance.ts, so we test the exported
// command object's structure and the public utility functions indirectly
// by importing the functions we can reach.

import { complianceCommand } from '../src/commands/compliance.js';

describe('complianceCommand()', () => {
  it('registers the "compliance" command name', () => {
    const cmd = complianceCommand();
    expect(cmd.name()).toBe('compliance');
  });

  it('has a "summary" subcommand', () => {
    const cmd = complianceCommand();
    const sub = cmd.commands.find((c) => c.name() === 'summary');
    expect(sub).toBeDefined();
  });

  it('has an "export" subcommand with "grants" and "audit" children', () => {
    const cmd = complianceCommand();
    const exportCmd = cmd.commands.find((c) => c.name() === 'export');
    expect(exportCmd).toBeDefined();
    const names = exportCmd!.commands.map((c) => c.name());
    expect(names).toContain('grants');
    expect(names).toContain('audit');
  });

  it('"export grants" has --format and --output options', () => {
    const cmd = complianceCommand();
    const exportCmd = cmd.commands.find((c) => c.name() === 'export')!;
    const grantsCmd = exportCmd.commands.find((c) => c.name() === 'grants')!;
    const optNames = grantsCmd.options.map((o) => o.long);
    expect(optNames).toContain('--format');
    expect(optNames).toContain('--output');
    expect(optNames).toContain('--since');
    expect(optNames).toContain('--status');
  });

  it('"export audit" has --agent option', () => {
    const cmd = complianceCommand();
    const exportCmd = cmd.commands.find((c) => c.name() === 'export')!;
    const auditCmd = exportCmd.commands.find((c) => c.name() === 'audit')!;
    const optNames = auditCmd.options.map((o) => o.long);
    expect(optNames).toContain('--agent');
    expect(optNames).toContain('--format');
    expect(optNames).toContain('--output');
  });

  it('has an "evidence-pack" subcommand', () => {
    const cmd = complianceCommand();
    const epCmd = cmd.commands.find((c) => c.name() === 'evidence-pack');
    expect(epCmd).toBeDefined();
  });

  it('"evidence-pack" has --framework, --since, --until, --output options', () => {
    const cmd = complianceCommand();
    const epCmd = cmd.commands.find((c) => c.name() === 'evidence-pack')!;
    const optNames = epCmd.options.map((o) => o.long);
    expect(optNames).toContain('--framework');
    expect(optNames).toContain('--since');
    expect(optNames).toContain('--until');
    expect(optNames).toContain('--output');
  });
});
