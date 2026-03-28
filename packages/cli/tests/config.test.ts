import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

import { resolveConfig, loadConfig, saveConfig, defaultConfigPath } from '../src/config.js';
import type { CliConfig } from '../src/config.js';

const FILE_CONFIG: CliConfig = {
  baseUrl: 'http://file-url:3000',
  apiKey: 'file-api-key',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('resolveConfig', () => {
  it('returns file config when no env vars are set', () => {
    vi.unstubAllEnvs();
    const result = resolveConfig(FILE_CONFIG);
    expect(result).toEqual(FILE_CONFIG);
  });

  it('returns null when no file config and no env vars', () => {
    vi.stubEnv('GRANTEX_URL', '');
    vi.stubEnv('GRANTEX_KEY', '');
    const result = resolveConfig(null);
    expect(result).toBeNull();
  });

  it('GRANTEX_URL env var overrides file baseUrl', () => {
    vi.stubEnv('GRANTEX_URL', 'http://env-url:4000');
    const result = resolveConfig(FILE_CONFIG);
    expect(result?.baseUrl).toBe('http://env-url:4000');
    expect(result?.apiKey).toBe('file-api-key');
  });

  it('GRANTEX_KEY env var overrides file apiKey', () => {
    vi.stubEnv('GRANTEX_KEY', 'env-api-key');
    const result = resolveConfig(FILE_CONFIG);
    expect(result?.baseUrl).toBe('http://file-url:3000');
    expect(result?.apiKey).toBe('env-api-key');
  });

  it('both env vars override file config', () => {
    vi.stubEnv('GRANTEX_URL', 'http://env-url:9000');
    vi.stubEnv('GRANTEX_KEY', 'env-key');
    const result = resolveConfig(FILE_CONFIG);
    expect(result).toEqual({ baseUrl: 'http://env-url:9000', apiKey: 'env-key' });
  });

  it('returns config from env vars alone when file config is null', () => {
    vi.stubEnv('GRANTEX_URL', 'http://only-env:3000');
    vi.stubEnv('GRANTEX_KEY', 'only-env-key');
    const result = resolveConfig(null);
    expect(result).toEqual({ baseUrl: 'http://only-env:3000', apiKey: 'only-env-key' });
  });

  it('returns null when only URL is set but key is missing', () => {
    vi.stubEnv('GRANTEX_URL', 'http://some-url:3000');
    vi.stubEnv('GRANTEX_KEY', '');
    const result = resolveConfig(null);
    expect(result).toBeNull();
  });
});

describe('defaultConfigPath', () => {
  it('returns a path under the user home directory', () => {
    const configPath = defaultConfigPath();
    expect(configPath).toContain('.grantex');
    expect(configPath).toContain('config.json');
    expect(configPath).toBe(path.join(os.homedir(), '.grantex', 'config.json'));
  });
});

describe('loadConfig', () => {
  it('returns parsed config when file exists', async () => {
    const config: CliConfig = { baseUrl: 'http://localhost:3000', apiKey: 'test-key' };
    mockReadFile.mockResolvedValue(JSON.stringify(config));

    const result = await loadConfig('/tmp/test-config.json');
    expect(result).toEqual(config);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/test-config.json', 'utf8');
  });

  it('returns null when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadConfig('/tmp/nonexistent.json');
    expect(result).toBeNull();
  });
});

describe('saveConfig', () => {
  it('creates directory and writes config file', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    const config: CliConfig = { baseUrl: 'http://localhost:3000', apiKey: 'test-key' };

    await saveConfig('/home/user/.grantex/config.json', config);

    expect(mockMkdir).toHaveBeenCalledWith(
      path.dirname('/home/user/.grantex/config.json'),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/home/user/.grantex/config.json',
      JSON.stringify(config, null, 2) + '\n',
      'utf8',
    );
  });
});
