import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createProgram } from '../src/index.js';

const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

describe('CLI version', () => {
  // `--version` is hard-coded in index.ts, so it can drift from the version
  // that is actually published. The SDKs guard this the same way.
  it('reports the version in package.json', () => {
    expect(createProgram().version()).toBe(packageVersion);
  });

  it('requires an SDK new enough for the evidence command', () => {
    const { dependencies } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(dependencies['@grantex/sdk']).toBe('>=0.7.0');
  });
});
