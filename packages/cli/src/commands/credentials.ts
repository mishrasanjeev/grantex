import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function credentialsCommand(): Command {
  const cmd = new Command('credentials').description('Manage verifiable credentials and SD-JWT');

  cmd
    .command('list')
    .description('List verifiable credentials')
    .option('--grant-id <grantId>', 'Filter by grant ID')
    .option('--principal-id <principalId>', 'Filter by principal ID')
    .option('--status <status>', 'Filter by status')
    .action(async (opts: { grantId?: string; principalId?: string; status?: string }) => {
      const client = await requireClient();
      const res = await client.credentials.list({
        ...(opts.grantId !== undefined ? { grantId: opts.grantId } : {}),
        ...(opts.principalId !== undefined ? { principalId: opts.principalId } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      });
      printTable(
        res.credentials.map((c) => ({
          ID: c.id,
          GRANT: c.grantId,
          TYPE: c.credentialType,
          FORMAT: c.format,
          STATUS: c.status,
          ISSUED: shortDate(c.issuedAt),
        })),
        ['ID', 'GRANT', 'TYPE', 'FORMAT', 'STATUS', 'ISSUED'],
        res.credentials.map((c) => ({ ...c })),
      );
    });

  cmd
    .command('get <credentialId>')
    .description('Get a verifiable credential by ID')
    .action(async (credentialId: string) => {
      const client = await requireClient();
      const cred = await client.credentials.get(credentialId);
      if (isJsonMode()) {
        console.log(JSON.stringify(cred, null, 2));
        return;
      }
      printRecord({
        id: cred.id,
        grantId: cred.grantId,
        credentialType: cred.credentialType,
        format: cred.format,
        status: cred.status,
        issuedAt: shortDate(cred.issuedAt),
        expiresAt: shortDate(cred.expiresAt),
        credential: cred.credential.slice(0, 60) + '...',
      });
    });

  cmd
    .command('verify')
    .description('Verify a VC-JWT credential')
    .requiredOption('--vc-jwt <jwt>', 'The VC-JWT string to verify')
    .action(async (opts: { vcJwt: string }) => {
      const client = await requireClient();
      const res = await client.credentials.verify(opts.vcJwt);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.valid) {
        console.log(chalk.green('✓') + ' Credential is valid.');
        printRecord({
          credentialType: res.credentialType ?? '',
          issuer: res.issuer ?? '',
          expiresAt: res.expiresAt ? shortDate(res.expiresAt) : '—',
          revoked: String(res.revoked ?? false),
        });
      } else {
        console.error(chalk.red('✗') + ' Credential is invalid.');
        process.exit(1);
      }
    });

  cmd
    .command('present')
    .description('Verify an SD-JWT presentation (selective disclosure)')
    .requiredOption('--sd-jwt <sdJwt>', 'The SD-JWT string to present')
    .option('--nonce <nonce>', 'Presentation nonce')
    .option('--audience <aud>', 'Intended audience')
    .action(async (opts: { sdJwt: string; nonce?: string; audience?: string }) => {
      const client = await requireClient();
      const res = await client.credentials.present({
        sdJwt: opts.sdJwt,
        ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
        ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.valid) {
        console.log(chalk.green('✓') + ' SD-JWT presentation is valid.');
        if (res.disclosedClaims) {
          console.log('\nDisclosed claims:');
          console.log(JSON.stringify(res.disclosedClaims, null, 2));
        }
      } else {
        console.error(chalk.red('✗') + ` Presentation invalid: ${res.error ?? 'unknown error'}`);
        process.exit(1);
      }
    });

  return cmd;
}
