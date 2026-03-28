import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function vaultCommand(): Command {
  const cmd = new Command('vault').description('Manage encrypted credential storage');

  cmd
    .command('list')
    .description('List stored credentials')
    .option('--principal <principalId>', 'Filter by principal ID')
    .option('--service <service>', 'Filter by service name')
    .action(async (opts: { principal?: string; service?: string }) => {
      const client = await requireClient();
      const res = await client.vault.list({
        ...(opts.principal !== undefined ? { principalId: opts.principal } : {}),
        ...(opts.service !== undefined ? { service: opts.service } : {}),
      });
      printTable(
        res.credentials.map((c) => ({
          ID: c.id,
          PRINCIPAL: c.principalId,
          SERVICE: c.service,
          TYPE: c.credentialType,
          EXPIRES: c.tokenExpiresAt ? shortDate(c.tokenExpiresAt) : '—',
          CREATED: shortDate(c.createdAt),
        })),
        ['ID', 'PRINCIPAL', 'SERVICE', 'TYPE', 'EXPIRES', 'CREATED'],
        res.credentials.map((c) => ({ ...c })),
      );
    });

  cmd
    .command('get <credentialId>')
    .description('Get a stored credential by ID')
    .action(async (credentialId: string) => {
      const client = await requireClient();
      const cred = await client.vault.get(credentialId);
      if (isJsonMode()) {
        console.log(JSON.stringify(cred, null, 2));
        return;
      }
      printRecord({
        id: cred.id,
        principalId: cred.principalId,
        service: cred.service,
        credentialType: cred.credentialType,
        tokenExpiresAt: cred.tokenExpiresAt ? shortDate(cred.tokenExpiresAt) : '—',
        createdAt: shortDate(cred.createdAt),
        updatedAt: shortDate(cred.updatedAt),
      });
    });

  cmd
    .command('store')
    .description('Store a credential in the vault')
    .requiredOption('--principal-id <principalId>', 'Principal who owns this credential')
    .requiredOption('--service <service>', 'Service name (e.g. google, slack)')
    .requiredOption('--access-token <token>', 'OAuth access token')
    .option('--refresh-token <token>', 'OAuth refresh token')
    .option('--credential-type <type>', 'Credential type (default: oauth2)')
    .option('--token-expires-at <iso>', 'Token expiration (ISO date)')
    .option('--metadata <json>', 'JSON metadata object')
    .action(async (opts: {
      principalId: string;
      service: string;
      accessToken: string;
      refreshToken?: string;
      credentialType?: string;
      tokenExpiresAt?: string;
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

      const res = await client.vault.store({
        principalId: opts.principalId,
        service: opts.service,
        accessToken: opts.accessToken,
        ...(opts.refreshToken !== undefined ? { refreshToken: opts.refreshToken } : {}),
        ...(opts.credentialType !== undefined ? { credentialType: opts.credentialType } : {}),
        ...(opts.tokenExpiresAt !== undefined ? { tokenExpiresAt: opts.tokenExpiresAt } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Credential stored: ${res.id}`);
    });

  cmd
    .command('delete <credentialId>')
    .description('Delete a stored credential')
    .action(async (credentialId: string) => {
      const client = await requireClient();
      await client.vault.delete(credentialId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ deleted: credentialId }));
        return;
      }
      console.log(chalk.green('✓') + ` Credential ${credentialId} deleted.`);
    });

  cmd
    .command('exchange')
    .description('Exchange a grant token for a stored service credential')
    .requiredOption('--grant-token <jwt>', 'Grant token (JWT)')
    .requiredOption('--service <service>', 'Service name to exchange for')
    .action(async (opts: { grantToken: string; service: string }) => {
      const client = await requireClient();
      const res = await client.vault.exchange(opts.grantToken, { service: opts.service });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        service: res.service,
        credentialType: res.credentialType,
        accessToken: res.accessToken.slice(0, 20) + '...',
        tokenExpiresAt: res.tokenExpiresAt ?? '—',
      });
    });

  return cmd;
}
