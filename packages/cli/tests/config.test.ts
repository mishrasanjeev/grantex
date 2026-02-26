import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveConfig } from '../src/config.js';
import type { CliConfig } from '../src/config.js';

const FILE_CONFIG: CliConfig = {
  baseUrl: 'http://file-url:3000',
  apiKey: 'file-api-key',
};

afterEach(() => {
  vi.unstubAllEnvs();
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
