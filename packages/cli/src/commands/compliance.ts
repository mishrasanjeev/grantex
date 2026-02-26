import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { requireClient } from '../client.js';
import { printRecord, printTable, shortDate } from '../format.js';
import type { Grant, AuditEntry } from '@grantex/sdk';

export function complianceCommand(): Command {
  const cmd = new Command('compliance').description('Enterprise compliance tools');

  cmd
    .command('summary')
    .description('Get an org-wide compliance summary')
    .option('--since <iso>', 'Start of reporting window (ISO date)')
    .option('--until <iso>', 'End of reporting window (ISO date)')
    .action(async (opts: { since?: string; until?: string }) => {
      const client = await requireClient();
      const s = await client.compliance.getSummary({
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
      });
      printRecord({
        'Generated at': shortDate(s.generatedAt),
        'Plan':         s.plan,
        'Agents':       `total=${s.agents.total}  active=${s.agents.active}  suspended=${s.agents.suspended}  revoked=${s.agents.revoked}`,
        'Grants':       `total=${s.grants.total}  active=${s.grants.active}  revoked=${s.grants.revoked}  expired=${s.grants.expired}`,
        'Audit entries':`total=${s.auditEntries.total}  success=${s.auditEntries.success}  failure=${s.auditEntries.failure}  blocked=${s.auditEntries.blocked}`,
        'Policies':     `total=${s.policies.total}`,
      });
    });

  const exportCmd = new Command('export').description('Export compliance data');

  exportCmd
    .command('grants')
    .description('Export all grants as JSON or CSV')
    .option('--since <iso>', 'Only grants issued after this date')
    .option('--until <iso>', 'Only grants issued before this date')
    .option('--status <status>', 'Filter by status (active|revoked|expired)')
    .option('--format <fmt>', 'Output format: json or table (default: table)', 'table')
    .option('--output <file>', 'Write output to a file instead of stdout')
    .action(
      async (opts: {
        since?: string;
        until?: string;
        status?: string;
        format: string;
        output?: string;
      }) => {
        const client = await requireClient();
        const result = await client.compliance.exportGrants({
          ...(opts.since ? { since: opts.since } : {}),
          ...(opts.until ? { until: opts.until } : {}),
          ...(opts.status
            ? { status: opts.status as 'active' | 'revoked' | 'expired' }
            : {}),
        });

        const output = renderGrants(result.grants, opts.format);
        writeOutput(output, opts.output);
      },
    );

  exportCmd
    .command('audit')
    .description('Export all audit entries as JSON or CSV')
    .option('--since <iso>', 'Only entries after this date')
    .option('--until <iso>', 'Only entries before this date')
    .option('--agent <agentId>', 'Filter by agent ID')
    .option('--status <status>', 'Filter by status (success|failure|blocked)')
    .option('--format <fmt>', 'Output format: json or table (default: table)', 'table')
    .option('--output <file>', 'Write output to a file instead of stdout')
    .action(
      async (opts: {
        since?: string;
        until?: string;
        agent?: string;
        status?: string;
        format: string;
        output?: string;
      }) => {
        const client = await requireClient();
        const result = await client.compliance.exportAudit({
          ...(opts.since ? { since: opts.since } : {}),
          ...(opts.until ? { until: opts.until } : {}),
          ...(opts.agent ? { agentId: opts.agent } : {}),
          ...(opts.status
            ? { status: opts.status as 'success' | 'failure' | 'blocked' }
            : {}),
        });

        const output = renderAudit(result.entries, opts.format);
        writeOutput(output, opts.output);
      },
    );

  cmd.addCommand(exportCmd);
  return cmd;
}

function renderGrants(grants: readonly Grant[], format: string): string {
  if (format === 'json') {
    return JSON.stringify(grants, null, 2);
  }
  if (grants.length === 0) return '(no results)';
  return tableToString(
    grants.map((g) => ({
      ID: g.id,
      AGENT: g.agentId,
      PRINCIPAL: g.principalId,
      STATUS: g.status,
      EXPIRES: shortDate(g.expiresAt),
    })),
    ['ID', 'AGENT', 'PRINCIPAL', 'STATUS', 'EXPIRES'],
  );
}

function renderAudit(entries: readonly AuditEntry[], format: string): string {
  if (format === 'json') {
    return JSON.stringify(entries, null, 2);
  }
  if (entries.length === 0) return '(no results)';
  return tableToString(
    entries.map((e) => ({
      ID: e.entryId,
      AGENT: e.agentId,
      ACTION: e.action,
      STATUS: e.status,
      TIMESTAMP: shortDate(e.timestamp),
    })),
    ['ID', 'AGENT', 'ACTION', 'STATUS', 'TIMESTAMP'],
  );
}

/**
 * Build a printTable-style string without printing to stdout.
 * (printTable() writes directly; here we return the string for --output support.)
 */
function tableToString(rows: Record<string, string>[], columns: string[]): string {
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines: string[] = [
    columns.map((c, i) => pad(c.toUpperCase(), widths[i] ?? c.length)).join('  '),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((row) =>
      columns.map((c, i) => pad(row[c] ?? '', widths[i] ?? 0)).join('  '),
    ),
  ];
  return lines.join('\n');
}

function writeOutput(content: string, file?: string): void {
  if (file) {
    writeFileSync(file, content + '\n', 'utf8');
    console.log(`Wrote ${file}`);
  } else {
    console.log(content);
  }
}
