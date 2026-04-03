import { describe, it, expect } from 'vitest';
import {
  computeEntryHash,
  verifyChain,
  GENESIS_HASH,
  type SignedAuditEntry,
} from '../src/audit/hash-chain.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeEntry(
  seq: number,
  prevHash: string,
  action = 'tool:test',
): SignedAuditEntry {
  const partial = {
    seq,
    timestamp: new Date(Date.now() + seq * 1000).toISOString(),
    action,
    agentDID: 'did:key:z6MkTest',
    grantId: 'grant_01',
    scopes: ['read'],
    result: 'success',
    prevHash,
  };

  const hash = computeEntryHash(partial);

  return {
    ...partial,
    hash,
    signature: 'fake-sig',
  };
}

function buildChain(count: number): SignedAuditEntry[] {
  const entries: SignedAuditEntry[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= count; i++) {
    const entry = makeEntry(i, prev, `tool:op${i}`);
    entries.push(entry);
    prev = entry.hash;
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('hash-chain', () => {
  it('computes deterministic hash for identical inputs', () => {
    const partial = {
      seq: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      action: 'tool:test',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['a', 'b'],
      result: 'success',
      prevHash: GENESIS_HASH,
    };

    const h1 = computeEntryHash(partial);
    const h2 = computeEntryHash(partial);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64); // SHA-256 hex
  });

  it('produces different hashes for different inputs', () => {
    const base = {
      seq: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      action: 'tool:test',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['a'],
      result: 'success',
      prevHash: GENESIS_HASH,
    };

    const h1 = computeEntryHash(base);
    const h2 = computeEntryHash({ ...base, action: 'tool:other' });
    expect(h1).not.toBe(h2);
  });

  it('verifies a valid chain', () => {
    const chain = buildChain(5);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it('detects tampered hash at specific position', () => {
    const chain = buildChain(5);
    chain[2]!.hash = 'aaaa' + chain[2]!.hash.slice(4);

    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('detects broken prevHash linkage', () => {
    const chain = buildChain(4);
    chain[2]!.prevHash = 'deadbeef';

    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('handles single-entry chain', () => {
    const chain = buildChain(1);
    expect(verifyChain(chain).valid).toBe(true);
  });

  it('handles empty chain', () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  it('first entry prevHash must be GENESIS_HASH', () => {
    const chain = buildChain(3);
    chain[0]!.prevHash = 'wrong';
    // Also recompute hash since prevHash changed
    chain[0]!.hash = computeEntryHash({
      ...chain[0]!,
      prevHash: 'wrong',
    });

    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });
});
