import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { printRecord, isJsonMode } from '../format.js';

export function registryCommand(): Command {
  const cmd = new Command('registry').description('Trust registry operations');

  cmd
    .command('lookup <did>')
    .description('Look up an organization by DID in the trust registry')
    .action(async (did: string) => {
      const client = await requireClient();
      // Use the SDK fetch helper to call the trust registry endpoint
      const res = await (client as unknown as { request: (method: string, path: string) => Promise<Record<string, unknown>> })
        .request('GET', `/v1/registry/${encodeURIComponent(did)}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      if (!res || (res as Record<string, unknown>).error) {
        console.error(chalk.red('\u2717') + ` DID not found in registry: ${did}`);
        process.exit(1);
        return;
      }

      printRecord({
        did: String(res.did ?? did),
        name: String(res.name ?? ''),
        verified: String(res.verified ?? false),
        registeredAt: String(res.registeredAt ?? ''),
      });
    });

  cmd
    .command('verify-dns <did>')
    .description('Trigger DNS verification for a DID')
    .action(async (did: string) => {
      const client = await requireClient();
      const res = await (client as unknown as { request: (method: string, path: string) => Promise<Record<string, unknown>> })
        .request('POST', `/v1/registry/${encodeURIComponent(did)}/verify-dns`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      if (res.verified) {
        console.log(chalk.green('\u2713') + ` DNS verified for ${did}`);
      } else {
        console.log(chalk.yellow('\u25CB') + ` DNS verification pending for ${did}`);
        if (res.instructions) {
          console.log(`  ${String(res.instructions)}`);
        }
      }
    });

  return cmd;
}
