import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { writeFileSync } from 'fs';
import { complianceCommand } from '../src/commands/compliance.js';
import { setJsonMode } from '../src/format.js';

const summaryResult = {
  generatedAt: '2026-01-01T00:00:00Z',
  agents: { total: 5, active: 4, suspended: 1, revoked: 0 },
  grants: { total: 10, active: 8, revoked: 1, expired: 1 },
  auditEntries: { total: 50, success: 45, failure: 3, blocked: 2 },
  policies: { total: 3 },
  plan: 'pro',
};

const grantsResult = {
  grants: [{
    id: 'grnt_1',
    agentId: 'ag_1',
    principalId: 'user@test.com',
    status: 'active',
    expiresAt: '2026-02-01T00:00:00Z',
  }],
};

const auditResult = {
  entries: [{
    entryId: 'alog_1',
    agentId: 'ag_1',
    action: 'test',
    status: 'success',
    timestamp: '2026-01-01T00:00:00Z',
  }],
};

const evidencePackResult = {
  meta: { framework: 'soc2', generatedAt: '2026-01-01T00:00:00Z' },
  grants: [],
  auditEntries: [],
  policies: [],
  chainIntegrity: { valid: true, checkedEntries: 50, firstBrokenAt: null },
};

const mockClient = {
  compliance: {
    getSummary: vi.fn(),
    exportGrants: vi.fn(),
    exportAudit: vi.fn(),
    evidencePack: vi.fn(),
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('complianceCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

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

  // ── summary action ───────────────────────────────────────────────────

  it('summary calls compliance.getSummary and prints record', async () => {
    mockClient.compliance.getSummary.mockResolvedValue(summaryResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'summary']);
    expect(mockClient.compliance.getSummary).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('summary passes --since and --until options', async () => {
    mockClient.compliance.getSummary.mockResolvedValue(summaryResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'summary', '--since', '2026-01-01', '--until', '2026-02-01']);
    expect(mockClient.compliance.getSummary).toHaveBeenCalledWith({
      since: '2026-01-01',
      until: '2026-02-01',
    });
  });

  it('summary --json outputs JSON', async () => {
    mockClient.compliance.getSummary.mockResolvedValue(summaryResult);
    setJsonMode(true);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'summary']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.plan).toBe('pro');
    expect(parsed.agents.total).toBe(5);
  });

  // ── export grants action ─────────────────────────────────────────────

  it('export grants prints table by default', async () => {
    mockClient.compliance.exportGrants.mockResolvedValue(grantsResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'grants']);
    expect(mockClient.compliance.exportGrants).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('export grants --format json outputs JSON', async () => {
    mockClient.compliance.exportGrants.mockResolvedValue(grantsResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'grants', '--format', 'json']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('grnt_1');
  });

  it('export grants --json mode outputs JSON', async () => {
    mockClient.compliance.exportGrants.mockResolvedValue(grantsResult);
    setJsonMode(true);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'grants']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('grnt_1');
  });

  it('export grants --output writes to file', async () => {
    mockClient.compliance.exportGrants.mockResolvedValue(grantsResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'grants', '--output', 'grants.txt']);
    expect(writeFileSync).toHaveBeenCalledWith('grants.txt', expect.any(String), 'utf8');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('grants.txt'));
  });

  it('export grants with empty result shows (no results)', async () => {
    mockClient.compliance.exportGrants.mockResolvedValue({ grants: [] });
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'grants']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('(no results)');
  });

  it('export grants passes filter options', async () => {
    mockClient.compliance.exportGrants.mockResolvedValue(grantsResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'export', 'grants',
      '--since', '2026-01-01',
      '--until', '2026-02-01',
      '--status', 'active',
    ]);
    expect(mockClient.compliance.exportGrants).toHaveBeenCalledWith({
      since: '2026-01-01',
      until: '2026-02-01',
      status: 'active',
    });
  });

  // ── export audit action ──────────────────────────────────────────────

  it('export audit prints table by default', async () => {
    mockClient.compliance.exportAudit.mockResolvedValue(auditResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'audit']);
    expect(mockClient.compliance.exportAudit).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('export audit --format json outputs JSON', async () => {
    mockClient.compliance.exportAudit.mockResolvedValue(auditResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'audit', '--format', 'json']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('alog_1');
  });

  it('export audit passes filter options', async () => {
    mockClient.compliance.exportAudit.mockResolvedValue(auditResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'export', 'audit',
      '--since', '2026-01-01',
      '--until', '2026-02-01',
      '--agent', 'ag_1',
      '--status', 'success',
    ]);
    expect(mockClient.compliance.exportAudit).toHaveBeenCalledWith({
      since: '2026-01-01',
      until: '2026-02-01',
      agentId: 'ag_1',
      status: 'success',
    });
  });

  it('export audit --output writes to file', async () => {
    mockClient.compliance.exportAudit.mockResolvedValue(auditResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'audit', '--output', 'audit.txt']);
    expect(writeFileSync).toHaveBeenCalledWith('audit.txt', expect.any(String), 'utf8');
  });

  it('export audit with empty result shows (no results)', async () => {
    mockClient.compliance.exportAudit.mockResolvedValue({ entries: [] });
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'export', 'audit']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('(no results)');
  });

  // ── evidence-pack action ─────────────────────────────────────────────

  it('evidence-pack calls compliance.evidencePack and writes file', async () => {
    mockClient.compliance.evidencePack.mockResolvedValue(evidencePackResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'evidence-pack', '--output', 'ep.json']);
    expect(mockClient.compliance.evidencePack).toHaveBeenCalledWith({
      framework: 'all',
    });
    expect(writeFileSync).toHaveBeenCalledWith('ep.json', expect.any(String), 'utf8');
    expect(console.log).toHaveBeenCalled();
  });

  it('evidence-pack uses default filename when no --output', async () => {
    mockClient.compliance.evidencePack.mockResolvedValue(evidencePackResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'evidence-pack']);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('evidence-pack-'),
      expect.any(String),
      'utf8',
    );
  });

  it('evidence-pack passes --framework, --since, --until options', async () => {
    mockClient.compliance.evidencePack.mockResolvedValue(evidencePackResult);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'evidence-pack',
      '--framework', 'soc2',
      '--since', '2026-01-01',
      '--until', '2026-02-01',
    ]);
    expect(mockClient.compliance.evidencePack).toHaveBeenCalledWith({
      framework: 'soc2',
      since: '2026-01-01',
      until: '2026-02-01',
    });
  });

  it('evidence-pack --json outputs JSON to stdout instead of file', async () => {
    mockClient.compliance.evidencePack.mockResolvedValue(evidencePackResult);
    setJsonMode(true);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'evidence-pack']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.meta.framework).toBe('soc2');
    expect(parsed.chainIntegrity.valid).toBe(true);
    // Should NOT write to file in JSON mode
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('evidence-pack shows broken chain integrity', async () => {
    const brokenPack = {
      ...evidencePackResult,
      chainIntegrity: { valid: false, checkedEntries: 50, firstBrokenAt: 'alog_10' },
    };
    mockClient.compliance.evidencePack.mockResolvedValue(brokenPack);
    const cmd = complianceCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'evidence-pack', '--output', 'ep.json']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('BROKEN');
  });
});
