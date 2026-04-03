import { Command } from 'commander';
import chalk from 'chalk';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { printTable, isJsonMode } from '../format.js';

interface AuditEntry {
  seq?: number;
  timestamp: string;
  action: string;
  status?: string;
  agentDid?: string;
  agentId?: string;
  grantId?: string;
  principalId?: string;
  hash?: string;
  prevHash?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJsonlFile(filePath: string): AuditEntry[] {
  const content = readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map((line, i) => {
    try {
      return JSON.parse(line) as AuditEntry;
    } catch {
      throw new Error(`Invalid JSON on line ${i + 1}: ${line.slice(0, 80)}`);
    }
  });
}

function computeHash(entry: AuditEntry, prevHash: string | null): string {
  // Reconstruct the hash input: all fields except hash itself, plus prevHash
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

export function auditCmdCommand(): Command {
  const cmd = new Command('audit-log')
    .description('Inspect and verify offline audit log files (JSONL)');

  cmd
    .command('inspect <file>')
    .description('Display entries from an offline audit log (JSONL file)')
    .action(async (file: string) => {
      let entries: AuditEntry[];
      try {
        entries = readJsonlFile(file);
      } catch (err) {
        console.error(chalk.red('\u2717') + ` ${(err as Error).message}`);
        process.exit(1);
        return;
      }

      if (isJsonMode()) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        console.log('(no entries)');
        return;
      }

      printTable(
        entries.map((e, i) => ({
          SEQ: String(e.seq ?? i + 1),
          TIMESTAMP: e.timestamp,
          ACTION: e.action,
          STATUS: e.status ?? '',
          AGENT: e.agentDid ?? e.agentId ?? '',
        })),
        ['SEQ', 'TIMESTAMP', 'ACTION', 'STATUS', 'AGENT'],
        entries,
      );
    });

  cmd
    .command('verify <file>')
    .description('Verify the hash chain integrity of an offline audit log')
    .action(async (file: string) => {
      let entries: AuditEntry[];
      try {
        entries = readJsonlFile(file);
      } catch (err) {
        if (isJsonMode()) {
          console.log(JSON.stringify({ valid: false, error: (err as Error).message }));
        } else {
          console.error(chalk.red('\u2717') + ` ${(err as Error).message}`);
        }
        process.exit(1);
        return;
      }

      if (entries.length === 0) {
        if (isJsonMode()) {
          console.log(JSON.stringify({ valid: true, entries: 0 }));
        } else {
          console.log(chalk.green('\u2713') + ' Hash chain valid (0 entries)');
        }
        return;
      }

      let prevHash: string | null = null;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const expectedHash = computeHash(entry, prevHash);

        if (entry.hash && entry.hash !== expectedHash) {
          if (isJsonMode()) {
            console.log(JSON.stringify({
              valid: false,
              brokenAt: i + 1,
              expected: expectedHash,
              actual: entry.hash,
            }));
          } else {
            console.error(
              chalk.red('\u2717') + ` Hash chain BROKEN at entry ${i + 1}`,
            );
            console.error(`  Expected: ${expectedHash}`);
            console.error(`  Actual:   ${entry.hash}`);
          }
          process.exit(1);
          return;
        }

        prevHash = entry.hash ?? expectedHash;
      }

      if (isJsonMode()) {
        console.log(JSON.stringify({ valid: true, entries: entries.length }));
      } else {
        console.log(chalk.green('\u2713') + ` Hash chain valid (${entries.length} entries)`);
      }
    });

  return cmd;
}
