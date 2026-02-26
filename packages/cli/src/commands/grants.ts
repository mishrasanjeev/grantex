import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, shortDate } from '../format.js';

export function grantsCommand(): Command {
  const cmd = new Command('grants').description('View and manage grants');

  cmd
    .command('list')
    .description('List grants')
    .option('--agent <agentId>', 'Filter by agent ID')
    .option('--principal <principalId>', 'Filter by principal ID')
    .option('--status <status>', 'Filter by status (active|revoked|expired)')
    .action(async (opts: { agent?: string; principal?: string; status?: string }) => {
      const client = await requireClient();
      const { grants } = await client.grants.list({
        ...(opts.agent ? { agentId: opts.agent } : {}),
        ...(opts.principal ? { principalId: opts.principal } : {}),
        ...(opts.status ? { status: opts.status as 'active' | 'revoked' | 'expired' } : {}),
      });
      printTable(
        grants.map((g) => ({
          ID: g.id,
          AGENT: g.agentId,
          PRINCIPAL: g.principalId,
          STATUS: g.status,
          SCOPES: g.scopes.join(', '),
          EXPIRES: shortDate(g.expiresAt),
        })),
        ['ID', 'AGENT', 'PRINCIPAL', 'STATUS', 'SCOPES', 'EXPIRES'],
      );
    });

  cmd
    .command('revoke <grantId>')
    .description('Revoke a grant (and all its delegated descendants)')
    .action(async (grantId: string) => {
      const client = await requireClient();
      await client.grants.revoke(grantId);
      console.log(chalk.green('✓') + ` Grant ${grantId} revoked.`);
    });

  return cmd;
}
