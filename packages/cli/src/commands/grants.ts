import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

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
        grants.map((g) => ({ ...g })),
      );
    });

  cmd
    .command('get <grantId>')
    .description('Get details for a single grant')
    .action(async (grantId: string) => {
      const client = await requireClient();
      const grant = await client.grants.get(grantId);
      if (isJsonMode()) {
        console.log(JSON.stringify(grant, null, 2));
        return;
      }
      printRecord({
        id: grant.id,
        agentId: grant.agentId,
        principalId: grant.principalId,
        status: grant.status,
        scopes: grant.scopes.join(', '),
        issuedAt: shortDate(grant.issuedAt),
        expiresAt: shortDate(grant.expiresAt),
      });
    });

  cmd
    .command('revoke <grantId>')
    .description('Revoke a grant (and all its delegated descendants)')
    .action(async (grantId: string) => {
      const client = await requireClient();
      await client.grants.revoke(grantId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ revoked: grantId }));
        return;
      }
      console.log(chalk.green('✓') + ` Grant ${grantId} revoked.`);
    });

  cmd
    .command('delegate')
    .description('Create a delegated sub-grant from an existing grant token')
    .requiredOption('--grant-token <jwt>', 'Parent grant token (JWT)')
    .requiredOption('--agent-id <agentId>', 'Child agent to delegate to')
    .requiredOption('--scopes <scopes>', 'Comma-separated scopes (must be subset of parent)')
    .option('--expires-in <duration>', 'Expiry duration (e.g. 1h, must be <= parent)')
    .action(
      async (opts: {
        grantToken: string;
        agentId: string;
        scopes: string;
        expiresIn?: string;
      }) => {
        const client = await requireClient();
        const res = await client.grants.delegate({
          parentGrantToken: opts.grantToken,
          subAgentId: opts.agentId,
          scopes: opts.scopes.split(',').map((s) => s.trim()),
          ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        console.log(chalk.green('✓') + ' Grant delegated successfully.');
        printRecord({
          grantToken: res.grantToken.slice(0, 40) + '...',
          grantId: res.grantId,
          scopes: res.scopes.join(', '),
          expiresAt: shortDate(res.expiresAt),
        });
      },
    );

  return cmd;
}
