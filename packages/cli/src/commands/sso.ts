import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord, shortDate } from '../format.js';

export function ssoCommand(): Command {
  const cmd = new Command('sso').description('Manage SSO configuration');

  cmd
    .command('get')
    .description('Show current SSO configuration')
    .action(async () => {
      const client = await requireClient();
      const config = await client.sso.getConfig();
      printRecord({
        issuerUrl: config.issuerUrl,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        updatedAt: shortDate(config.updatedAt),
      });
    });

  cmd
    .command('configure')
    .description('Create or update SSO configuration')
    .requiredOption('--issuer-url <url>', 'OIDC issuer URL')
    .requiredOption('--client-id <id>', 'OIDC client ID')
    .requiredOption('--client-secret <secret>', 'OIDC client secret')
    .requiredOption('--redirect-uri <uri>', 'Callback redirect URI')
    .action(async (opts: { issuerUrl: string; clientId: string; clientSecret: string; redirectUri: string }) => {
      const client = await requireClient();
      await client.sso.createConfig({
        issuerUrl: opts.issuerUrl,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        redirectUri: opts.redirectUri,
      });
      console.log(chalk.green('✓') + ' SSO configuration saved.');
    });

  cmd
    .command('delete')
    .description('Delete SSO configuration')
    .action(async () => {
      const client = await requireClient();
      await client.sso.deleteConfig();
      console.log(chalk.green('✓') + ' SSO configuration deleted.');
    });

  cmd
    .command('login-url <org>')
    .description('Get the SSO login URL for an organization')
    .action(async (org: string) => {
      const client = await requireClient();
      const { authorizeUrl } = await client.sso.getLoginUrl(org);
      console.log(authorizeUrl);
    });

  return cmd;
}
