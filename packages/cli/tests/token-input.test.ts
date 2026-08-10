import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTokenInput } from '../src/token-input.js';

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env['GRANTEX_TEST_TOKEN'];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readTokenInput()', () => {
  it('trims a positional token', () => {
    expect(readTokenInput('  token-value\n', {})).toBe('token-value');
  });

  it('reads a token from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantex-token-'));
    tempDirs.push(dir);
    const file = join(dir, 'grant.jwt');
    writeFileSync(file, ' file-token\n');

    expect(readTokenInput(undefined, { file })).toBe('file-token');
  });

  it('reads a token from an environment variable', () => {
    process.env['GRANTEX_TEST_TOKEN'] = 'env-token';
    expect(readTokenInput(undefined, { env: 'GRANTEX_TEST_TOKEN' })).toBe('env-token');
  });

  it('rejects multiple token sources', () => {
    expect(() => readTokenInput('argument-token', { env: 'GRANTEX_TEST_TOKEN' }))
      .toThrow('Provide exactly one token source');
  });

  it('rejects a missing environment variable', () => {
    expect(() => readTokenInput(undefined, { env: 'GRANTEX_TEST_TOKEN' }))
      .toThrow('is not set');
  });
});
