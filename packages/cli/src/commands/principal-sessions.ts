import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord, shortDate, isJsonMode } from '../format.js';

export function principalSessionsCommand(): Command {
  const cmd = new Command('principal-sessions').description('Manage end-user principal sessions');

  cmd
    .command('create')
    .description('Create a session token for an end-user')
    .requiredOption('--principal-id <principalId>', 'Principal (user) identifier')
    .option('--expires-in <duration>', 'Session duration (e.g. 1h, 24h)')
    .action(async (opts: { principalId: string; expiresIn?: string }) => {
      const client = await requireClient();
      const res = await client.principalSessions.create({
        principalId: opts.principalId,
        ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(chalk.green('✓') + ' Principal session created.');
      printRecord({
        sessionToken: res.sessionToken,
        dashboardUrl: res.dashboardUrl,
        expiresAt: shortDate(res.expiresAt),
      });
    });

  return cmd;
}
