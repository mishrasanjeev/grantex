import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = mkdtempSync(join(tmpdir(), 'grantex-audit-test-'));
import { auditCmdCommand } from '../src/commands/audit-cmd.js';
import { setJsonMode } from '../src/format.js';

function computeHash(entry: Record<string, unknown>, prevHash: string | null): string {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key !== 'hash') {
      obj[key] = value;
    }
  }
  obj.prevHash = prevHash;
  const data = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(data).digest('hex');
}

function createAuditLog(entries: Array<{ action: string; timestamp: string; status: string; agentDid: string }>): string {
  const result: Array<Record<string, unknown>> = [];
  let prevHash: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry: Record<string, unknown> = {
      seq: i + 1,
      ...entries[i],
    };
    entry.prevHash = prevHash;
    const hash = computeHash(entry, prevHash);
    entry.hash = hash;
    prevHash = hash;
    result.push(entry);
  }

  return result.map((e) => JSON.stringify(e)).join('\n');
}

describe('auditCmdCommand()', () => {
  let tmpFiles: string[] = [];

  function writeTmpFile(content: string): string {
    const filePath = join(testDir, `audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(filePath, content, 'utf8');
    tmpFiles.push(filePath);
    return filePath;
  }

  beforeEach(() => {
    tmpFiles = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it('registers the "audit-log" command name', () => {
    const cmd = auditCmdCommand();
    expect(cmd.name()).toBe('audit-log');
  });

  it('has inspect and verify subcommands', () => {
    const cmd = auditCmdCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('inspect');
    expect(names).toContain('verify');
  });

  // ── inspect ────────────────────────────────────────────────────────────

  it('inspect displays entries in table format', async () => {
    const log = createAuditLog([
      { action: 'email.read', timestamp: '2026-01-01T00:00:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
      { action: 'calendar.write', timestamp: '2026-01-01T00:01:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
    ]);
    const file = writeTmpFile(log);

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'inspect', file]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('email.read');
    expect(allOutput).toContain('calendar.write');
    expect(allOutput).toContain('did:grantex:ag_1');
  });

  it('inspect --json outputs JSON array', async () => {
    const log = createAuditLog([
      { action: 'email.read', timestamp: '2026-01-01T00:00:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
    ]);
    const file = writeTmpFile(log);

    setJsonMode(true);
    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'inspect', file]);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].action).toBe('email.read');
  });

  it('inspect shows "(no entries)" for empty file', async () => {
    const file = writeTmpFile('');

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'inspect', file]);

    expect(console.log).toHaveBeenCalledWith('(no entries)');
  });

  // ── verify ─────────────────────────────────────────────────────────────

  it('verify reports valid hash chain', async () => {
    const log = createAuditLog([
      { action: 'email.read', timestamp: '2026-01-01T00:00:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
      { action: 'email.send', timestamp: '2026-01-01T00:01:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
      { action: 'calendar.read', timestamp: '2026-01-01T00:02:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
    ]);
    const file = writeTmpFile(log);

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', file]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Hash chain valid');
    expect(allOutput).toContain('3 entries');
  });

  it('verify detects tampered chain', async () => {
    const log = createAuditLog([
      { action: 'email.read', timestamp: '2026-01-01T00:00:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
      { action: 'email.send', timestamp: '2026-01-01T00:01:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
    ]);

    // Tamper with the second entry's action
    const lines = log.split('\n');
    const entry2 = JSON.parse(lines[1]!);
    entry2.action = 'TAMPERED';
    lines[1] = JSON.stringify(entry2);
    const tamperedLog = lines.join('\n');
    const file = writeTmpFile(tamperedLog);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'verify', file])).rejects.toThrow('process.exit');

    const allOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Hash chain BROKEN');
    expect(allOutput).toContain('entry 2');
    exitSpy.mockRestore();
  });

  it('verify --json reports valid chain', async () => {
    const log = createAuditLog([
      { action: 'email.read', timestamp: '2026-01-01T00:00:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
    ]);
    const file = writeTmpFile(log);

    setJsonMode(true);
    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', file]);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.valid).toBe(true);
    expect(parsed.entries).toBe(1);
  });

  it('verify --json reports broken chain', async () => {
    const log = createAuditLog([
      { action: 'email.read', timestamp: '2026-01-01T00:00:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
      { action: 'email.send', timestamp: '2026-01-01T00:01:00Z', status: 'success', agentDid: 'did:grantex:ag_1' },
    ]);

    const lines = log.split('\n');
    const entry2 = JSON.parse(lines[1]!);
    entry2.action = 'TAMPERED';
    lines[1] = JSON.stringify(entry2);
    const file = writeTmpFile(lines.join('\n'));

    setJsonMode(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    try {
      await cmd.parseAsync(['node', 'test', 'verify', file]);
    } catch {
      // expected
    }

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.valid).toBe(false);
    expect(parsed.brokenAt).toBe(2);
    exitSpy.mockRestore();
  });

  it('verify handles empty file gracefully', async () => {
    const file = writeTmpFile('');

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'verify', file]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Hash chain valid');
    expect(allOutput).toContain('0 entries');
  });

  it('verify exits 1 for invalid JSONL', async () => {
    const file = writeTmpFile('not valid json\nalso not json');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = auditCmdCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'verify', file])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
