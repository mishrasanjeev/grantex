import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CliConfig {
  baseUrl: string;
  apiKey: string;
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.grantex', 'config.json');
}

export async function loadConfig(configPath: string): Promise<CliConfig | null> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(configPath: string, config: CliConfig): Promise<void> {
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.chmod(configDir, 0o700).catch(() => {});
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600).catch(() => {});
}

/**
 * Merge env vars (highest precedence) over the file-based config.
 * Returns null if baseUrl or apiKey cannot be resolved.
 */
export function resolveConfig(fileConfig: CliConfig | null): CliConfig | null {
  const baseUrl = process.env['GRANTEX_URL'] ?? fileConfig?.baseUrl;
  const apiKey = process.env['GRANTEX_KEY'] ?? fileConfig?.apiKey;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}
