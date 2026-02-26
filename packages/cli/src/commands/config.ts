import { Command } from 'commander';
import chalk from 'chalk';
import { defaultConfigPath, loadConfig, resolveConfig, saveConfig } from '../config.js';

export function configCommand(): Command {
  const cmd = new Command('config').description('Manage CLI configuration');

  cmd
    .command('set')
    .description('Set the Grantex server URL and API key')
    .requiredOption('--url <url>', 'Auth service base URL (e.g. http://localhost:3000)')
    .requiredOption('--key <api-key>', 'Developer API key')
    .action(async (opts: { url: string; key: string }) => {
      const configPath = defaultConfigPath();
      await saveConfig(configPath, { baseUrl: opts.url, apiKey: opts.key });
      console.log(chalk.green('✓') + ` Config saved to ${configPath}`);
    });

  cmd
    .command('show')
    .description('Print the current configuration')
    .action(async () => {
      const fileConfig = await loadConfig(defaultConfigPath());
      const config = resolveConfig(fileConfig);

      if (!config) {
        console.error(
          chalk.yellow('Not configured.') +
            ' Run: grantex config set --url <url> --key <api-key>',
        );
        process.exit(1);
      }

      console.log(`URL      ${config.baseUrl}`);
      console.log(`API key  ${config.apiKey}`);

      if (process.env['GRANTEX_URL'] || process.env['GRANTEX_KEY']) {
        console.log(chalk.dim('(env vars take precedence over config file)'));
      }
    });

  return cmd;
}
