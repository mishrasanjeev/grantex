import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord, shortDate } from '../format.js';

export function tokensCommand(): Command {
  const cmd = new Command('tokens').description('Verify and revoke grant tokens');

  cmd
    .command('verify <token>')
    .description('Verify a grant token (online check)')
    .action(async (token: string) => {
      const client = await requireClient();
      const res = await client.tokens.verify(token);

      if (!res.valid) {
        console.error(chalk.red('✗') + ' Token is invalid or has been revoked.');
        process.exit(1);
      }

      console.log(chalk.green('✓') + ' Token is valid.');
      printRecord({
        grantId: res.grantId ?? '',
        scopes: (res.scopes ?? []).join(', '),
        principal: res.principal ?? '',
        agent: res.agent ?? '',
        expiresAt: res.expiresAt ? shortDate(res.expiresAt) : '',
      });
    });

  cmd
    .command('revoke <jti>')
    .description('Revoke a grant token by JTI')
    .action(async (jti: string) => {
      const client = await requireClient();
      await client.tokens.revoke(jti);
      console.log(chalk.green('✓') + ` Token ${jti} revoked.`);
    });

  return cmd;
}
