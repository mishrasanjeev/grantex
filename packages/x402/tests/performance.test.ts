import { describe, it, expect, beforeEach } from 'vitest';
import { issueGDT } from '../src/gdt.js';
import { verifyGDT } from '../src/verify.js';
import { generateKeyPair } from '../src/crypto.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';
import type { IssueGDTParams } from '../src/types.js';

describe('Performance tests', () => {
  let principal: ReturnType<typeof generateKeyPair>;
  let agent: ReturnType<typeof generateKeyPair>;
  let baseParams: IssueGDTParams;

  beforeEach(() => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());

    principal = generateKeyPair();
    agent = generateKeyPair();
    baseParams = {
      agentDID: agent.did,
      scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h',
      signingKey: principal.privateKey,
    };
  });

  it('issues 100 tokens in under 5 seconds', async () => {
    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      await issueGDT(baseParams);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
    console.log(`Issued 100 tokens in ${elapsed.toFixed(0)}ms (${(elapsed / 100).toFixed(1)}ms/token)`);
  });

  it('verifies 100 tokens in under 5 seconds', async () => {
    const token = await issueGDT(baseParams);

    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
    console.log(`Verified 100 tokens in ${elapsed.toFixed(0)}ms (${(elapsed / 100).toFixed(1)}ms/token)`);
  });

  it('handles concurrent issuance and verification', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => issueGDT(baseParams)),
    );

    const results = await Promise.all(
      tokens.map((token) =>
        verifyGDT(token, { resource: 'weather:read', amount: 0.001, currency: 'USDC' }),
      ),
    );

    expect(results.every((r) => r.valid)).toBe(true);
  });

  it('key generation is fast', () => {
    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      generateKeyPair();
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    console.log(`Generated 100 key pairs in ${elapsed.toFixed(0)}ms`);
  });
});
