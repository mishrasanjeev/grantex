import { Grantex } from '@grantex/sdk';
import { defaultConfigPath, loadConfig, resolveConfig } from './config.js';

/** Client options a command can set on top of the configured URL and key. */
export interface ClientOverrides {
  /** The grant token audience check in `enforce()`: `on` (the SDK default) or `off`. */
  audienceCheck?: 'on' | 'off';
}

/**
 * Load config from file + env and return an authenticated Grantex client.
 * Exits with a helpful message if the CLI has not been configured yet.
 */
export async function requireClient(overrides: ClientOverrides = {}): Promise<Grantex> {
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

  return new Grantex({ baseUrl: config.baseUrl, apiKey: config.apiKey, ...overrides });
}
