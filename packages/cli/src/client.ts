import { Grantex } from '@grantex/sdk';
import { defaultConfigPath, loadConfig, resolveConfig } from './config.js';

/**
 * Load config from file + env and return an authenticated Grantex client.
 * Exits with a helpful message if the CLI has not been configured yet.
 */
export async function requireClient(): Promise<Grantex> {
  const fileConfig = await loadConfig(defaultConfigPath());
  const config = resolveConfig(fileConfig);

  if (!config) {
    console.error(
      'Error: Grantex is not configured.\n' +
        'Run:  grantex config set --url <url> --key <api-key>\n' +
        'Or set the GRANTEX_URL and GRANTEX_KEY environment variables.',
    );
    process.exit(1);
  }

  return new Grantex({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
