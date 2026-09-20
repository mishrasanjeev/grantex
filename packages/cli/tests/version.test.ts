import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('CLI dependencies', () => {
  // The evidence command imports the SDK's evidence module at run time, which
  // exists from 0.7.0. A lower floor would install an SDK without it.
  it('requires an SDK new enough for the evidence command', () => {
    const { dependencies } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(dependencies['@grantex/sdk']).toBe('>=0.7.0');
  });
});
