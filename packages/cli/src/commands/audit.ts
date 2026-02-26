import { Command } from 'commander';
import { requireClient } from '../client.js';
import { printTable, shortDate } from '../format.js';

export function auditCommand(): Command {
  const cmd = new Command('audit').description('View the audit log');

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
        );
      },
    );

  return cmd;
}
