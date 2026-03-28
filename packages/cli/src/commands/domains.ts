import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, isJsonMode } from '../format.js';

export function domainsCommand(): Command {
  const cmd = new Command('domains').description('Manage custom domains');

  cmd
    .command('list')
    .description('List custom domains')
    .action(async () => {
      const client = await requireClient();
      const res = await client.domains.list();
      printTable(
        res.domains.map((d) => ({
          ID: d.id,
          DOMAIN: d.domain,
          VERIFIED: d.verified ? 'yes' : 'no',
        })),
        ['ID', 'DOMAIN', 'VERIFIED'],
        res.domains.map((d) => ({ ...d })),
      );
    });

  cmd
    .command('add')
    .description('Add a custom domain')
    .requiredOption('--domain <domain>', 'Domain name (e.g. auth.mycompany.com)')
    .action(async (opts: { domain: string }) => {
      const client = await requireClient();
      const res = await client.domains.create({ domain: opts.domain });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Domain added: ${res.domain}`);
      printRecord({
        id: res.id,
        domain: res.domain,
        verified: String(res.verified),
        verificationToken: res.verificationToken,
        instructions: res.instructions,
      });
    });

  cmd
    .command('verify <domainId>')
    .description('Verify domain ownership via DNS TXT record')
    .action(async (domainId: string) => {
      const client = await requireClient();
      const res = await client.domains.verify(domainId);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.verified) {
        console.log(chalk.green('✓') + ' Domain verified successfully.');
      } else {
        console.log(chalk.yellow('⚠') + ' Domain not yet verified. Check your DNS TXT record.');
      }
    });

  cmd
    .command('delete <domainId>')
    .description('Remove a custom domain')
    .action(async (domainId: string) => {
      const client = await requireClient();
      await client.domains.delete(domainId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ deleted: domainId }));
        return;
      }
      console.log(chalk.green('✓') + ` Domain ${domainId} deleted.`);
    });

  return cmd;
}
