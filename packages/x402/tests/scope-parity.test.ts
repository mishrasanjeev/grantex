import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scopeMatches, parseScope } from '../src/verify.js';
import { issueGDT } from '../src/gdt.js';
import { verifyGDT } from '../src/verify.js';
import { generateKeyPair } from '../src/crypto.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('scope matching aligns with @grantex/sdk (exact match for constrained scopes)', () => {
  it('parseScope is byte-identical to the core SDK implementation', () => {
    const coreSource = readFileSync(resolve(here, '../../sdk-ts/src/scopes.ts'), 'utf8');
    const localSource = readFileSync(resolve(here, '../src/verify.ts'), 'utf8');
    const extract = (src: string) => {
      const start = src.indexOf('export function parseScope(');
      const end = src.indexOf('\n}\n', start) + 3;
      return src.slice(start, end);
    };
    expect(extract(localSource)).toBe(extract(coreSource));
  });

  it('a wildcard never covers a constrained scope', () => {
    // Regression: "weather:*" used to prefix-match "weather:read:max_5".
    expect(scopeMatches('weather:read:max_5', ['weather:*'])).toBe(false);
    expect(scopeMatches('weather:read:max_5', ['*'])).toBe(false);
    expect(scopeMatches('weather:read:max_5', ['weather:read'])).toBe(false);
    expect(scopeMatches('weather:read:max_5', ['weather:read:max_50'])).toBe(false);
    // Exact grant still works.
    expect(scopeMatches('weather:read:max_5', ['weather:read:max_5'])).toBe(true);
  });

  it('wildcards remain structural for unconstrained scopes', () => {
    expect(scopeMatches('weather:read', ['weather:*'])).toBe(true);
    expect(scopeMatches('weather:write', ['weather:*'])).toBe(true);
    expect(scopeMatches('weatherinfo:read', ['weather:*'])).toBe(false);
    expect(scopeMatches('anything:read', ['*'])).toBe(true);
    // A wildcard only spans one action segment.
    expect(scopeMatches('weather:read:write', ['weather:*'])).toBe(false);
    // Malformed grants are not wildcards.
    expect(scopeMatches('weather:read', ['weather:*:x'])).toBe(false);
    expect(parseScope('weather:*')).toEqual({ resource: 'weather', action: '*' });
  });

  it('verifyGDT rejects a constrained resource under a wildcard grant', async () => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());
    const principal = generateKeyPair();
    const agent = generateKeyPair();
    const token = await issueGDT({
      agentDID: agent.did,
      scope: ['weather:*'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h',
      signingKey: principal.privateKey,
    });
    const result = await verifyGDT(token, { resource: 'weather:read:max_5', amount: 0.001, currency: 'USDC' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Scope mismatch');
  });
});
