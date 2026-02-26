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
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
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
