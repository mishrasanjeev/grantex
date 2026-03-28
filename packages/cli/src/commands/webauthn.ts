import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

export function webauthnCommand(): Command {
  const cmd = new Command('webauthn').description('Manage FIDO2/WebAuthn credentials');

  cmd
    .command('register-options')
    .description('Generate a WebAuthn registration challenge')
    .requiredOption('--principal-id <principalId>', 'Principal to register for')
    .action(async (opts: { principalId: string }) => {
      const client = await requireClient();
      const res = await client.webauthn.registerOptions({ principalId: opts.principalId });
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Registration challenge created: ${res.challengeId}`);
      console.log('\nPass the publicKey options to your WebAuthn client:');
      console.log(JSON.stringify(res.publicKey, null, 2));
    });

  cmd
    .command('register-verify')
    .description('Verify a WebAuthn registration response')
    .requiredOption('--challenge-id <id>', 'Challenge ID from register-options')
    .requiredOption('--response <json>', 'JSON attestation response from browser')
    .option('--device-name <name>', 'Human-readable device name')
    .action(async (opts: { challengeId: string; response: string; deviceName?: string }) => {
      const client = await requireClient();

      let response: Record<string, unknown>;
      try {
        response = JSON.parse(opts.response) as Record<string, unknown>;
      } catch {
        console.error('Error: --response must be valid JSON.');
        process.exit(1);
      }

      const res = await client.webauthn.registerVerify({
        challengeId: opts.challengeId,
        response,
        ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Credential registered: ${res.id}`);
    });

  cmd
    .command('list <principalId>')
    .description('List WebAuthn credentials for a principal')
    .action(async (principalId: string) => {
      const client = await requireClient();
      const res = await client.webauthn.listCredentials(principalId);
      printTable(
        res.credentials.map((c) => ({
          ID: c.id,
          DEVICE: c.deviceName ?? '—',
          BACKED_UP: c.backedUp ? 'yes' : 'no',
          TRANSPORTS: c.transports.join(', '),
          CREATED: shortDate(c.createdAt),
          LAST_USED: c.lastUsedAt ? shortDate(c.lastUsedAt) : '—',
        })),
        ['ID', 'DEVICE', 'BACKED_UP', 'TRANSPORTS', 'CREATED', 'LAST_USED'],
        res.credentials.map((c) => ({ ...c })),
      );
    });

  cmd
    .command('delete <credentialId>')
    .description('Delete a WebAuthn credential')
    .action(async (credentialId: string) => {
      const client = await requireClient();
      await client.webauthn.deleteCredential(credentialId);
      if (isJsonMode()) {
        console.log(JSON.stringify({ deleted: credentialId }));
        return;
      }
      console.log(chalk.green('✓') + ` Credential ${credentialId} deleted.`);
    });

  return cmd;
}
