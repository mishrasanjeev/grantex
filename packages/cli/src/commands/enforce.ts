import { Command } from 'commander';
import chalk from 'chalk';
import { requireClient } from '../client.js';
import { isJsonMode } from '../format.js';

export function enforceCommand(): Command {
  const cmd = new Command('enforce').description('Test scope enforcement against a grant token');

  cmd
    .command('test')
    .description('Dry-run scope enforcement for a tool call')
    .requiredOption('--token <token>', 'Grantex grant token (JWT)')
    .requiredOption('--connector <connector>', 'Connector name (e.g., salesforce)')
    .requiredOption('--tool <tool>', 'Tool name (e.g., delete_contact)')
    .option('--amount <amount>', 'Amount for capped scope check', parseFloat)
    .action(async (opts: { token: string; connector: string; tool: string; amount?: number }) => {
      const client = await requireClient();

      // Load the manifest for the connector
      try {
        const mod = await import(`@grantex/sdk/manifests/${opts.connector}.js`);
        const manifest = Object.values(mod)[0] as import('@grantex/sdk').ToolManifest;
        client.loadManifest(manifest);
      } catch {
        if (isJsonMode()) {
          console.log(JSON.stringify({
            allowed: false,
            reason: `No manifest found for connector '${opts.connector}'`,
          }));
          return;
        }
        console.log(chalk.red(`\n  ❌ No manifest found for connector '${opts.connector}'`));
        console.log(chalk.dim('  Run `grantex manifest list` to see available connectors.'));
        return;
      }

      const result = await client.enforce({
        grantToken: opts.token,
        connector: opts.connector,
        tool: opts.tool,
        ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      if (result.allowed) {
        console.log(chalk.green('  ✅ ALLOWED'));
      } else {
        console.log(chalk.red('  ❌ DENIED'));
      }
      console.log();
      console.log(`  ${chalk.dim('Token scopes:')}  [${result.scopes.join(', ')}]`);
      console.log(`  ${chalk.dim('Tool permission:')} ${result.permission || '?'} (from manifest)`);
      if (!result.allowed) {
        console.log(`  ${chalk.dim('Reason:')}         ${result.reason}`);
      }
      if (result.grantId) {
        console.log(`  ${chalk.dim('Grant ID:')}       ${result.grantId}`);
        console.log(`  ${chalk.dim('Agent DID:')}      ${result.agentDid}`);
      }
      console.log();
    });

  return cmd;
}
