import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function auditCommand(): Command {
  const cmd = new Command('audit').description('View and manage the audit log');

  cmd
    .command('list')
    .description('List audit entries')
    .option('--agent <agentId>', 'Filter by agent ID')
    .option('--grant <grantId>', 'Filter by grant ID')
    .option('--principal <principalId>', 'Filter by principal ID')
    .option('--action <action>', 'Filter by action string')
    .option('--since <iso>', 'Only entries after this ISO date')
    .option('--until <iso>', 'Only entries before this ISO date')
    .action(
      async (opts: {
        agent?: string;
        grant?: string;
        principal?: string;
        action?: string;
        since?: string;
        until?: string;
      }) => {
        const client = await requireClient();
        const { entries } = await client.audit.list({
          ...(opts.agent ? { agentId: opts.agent } : {}),
          ...(opts.grant ? { grantId: opts.grant } : {}),
          ...(opts.principal ? { principalId: opts.principal } : {}),
          ...(opts.action ? { action: opts.action } : {}),
          ...(opts.since ? { since: opts.since } : {}),
          ...(opts.until ? { until: opts.until } : {}),
        });
        printTable(
          entries.map((e) => ({
            ID: e.entryId,
            AGENT: e.agentId,
            ACTION: e.action,
            STATUS: e.status,
            TIMESTAMP: shortDate(e.timestamp),
          })),
          ['ID', 'AGENT', 'ACTION', 'STATUS', 'TIMESTAMP'],
          entries.map((e) => ({ ...e })),
        );
      },
    );

  cmd
    .command('get <entryId>')
    .description('Get a single audit entry by ID')
    .action(async (entryId: string) => {
      const client = await requireClient();
      const entry = await client.audit.get(entryId);
      if (isJsonMode()) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      printRecord({
        entryId: entry.entryId,
        agentId: entry.agentId,
        agentDid: entry.agentDid ?? '',
        grantId: entry.grantId ?? '',
        principalId: entry.principalId ?? '',
        action: entry.action,
        status: entry.status,
        hash: entry.hash ?? '',
        previousHash: entry.prevHash ?? '',
        timestamp: shortDate(entry.timestamp),
        metadata: JSON.stringify(entry.metadata ?? {}),
      });
    });

  cmd
    .command('log')
    .description('Log a new audit entry')
    .requiredOption('--agent-id <agentId>', 'Agent ID')
    .requiredOption('--agent-did <agentDid>', 'Agent DID (e.g. did:grantex:ag_...)')
    .requiredOption('--grant-id <grantId>', 'Grant ID')
    .requiredOption('--principal-id <principalId>', 'Principal ID')
    .requiredOption('--action <action>', 'Action name (e.g. email.read, payment.initiated)')
    .option('--status <status>', 'Status: success, failure, or blocked')
    .option('--metadata <json>', 'JSON metadata object')
    .action(
      async (opts: {
        agentId: string;
        agentDid: string;
        grantId: string;
        principalId: string;
        action: string;
        status?: string;
        metadata?: string;
      }) => {
        const client = await requireClient();

        let metadata: Record<string, unknown> | undefined;
        if (opts.metadata !== undefined) {
          try {
            metadata = JSON.parse(opts.metadata) as Record<string, unknown>;
          } catch {
            console.error('Error: --metadata must be valid JSON.');
            process.exit(1);
          }
        }

        const entry = await client.audit.log({
          agentId: opts.agentId,
          agentDid: opts.agentDid,
          grantId: opts.grantId,
          principalId: opts.principalId,
          action: opts.action,
          ...(opts.status !== undefined ? { status: opts.status as 'success' | 'failure' | 'blocked' } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }

        console.log(chalk.green('✓') + ` Audit entry logged: ${entry.entryId}`);
      },
    );

  return cmd;
}
