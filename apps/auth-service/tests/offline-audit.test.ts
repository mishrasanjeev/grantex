import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeOfflineAuditEntryHash,
  OFFLINE_AUDIT_GENESIS_HASH,
  verifyOfflineAuditEntrySignature,
  type SignedOfflineAuditEntry,
} from '../src/lib/offline-audit.js';

describe('offline audit verification', () => {
  it('matches the Gemma hash format and verifies Ed25519 signatures', () => {
    const keys = generateKeyPairSync('ed25519');
    const partial = {
      seq: 1,
      timestamp: '2026-04-01T10:00:00.000Z',
      action: 'calendar.read',
      agentDID: 'did:grantex:ag_TEST',
      grantId: 'grnt_TEST',
      scopes: ['calendar:read'],
      result: 'success',
      metadata: { count: 2 },
      prevHash: OFFLINE_AUDIT_GENESIS_HASH,
    };
    const hash = computeOfflineAuditEntryHash(partial);
    const entry: SignedOfflineAuditEntry = {
      ...partial,
      hash,
      signature: sign(null, Buffer.from(hash, 'utf8'), keys.privateKey).toString('hex'),
    };

    const publicJwk = keys.publicKey.export({ format: 'jwk' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyOfflineAuditEntrySignature(entry, publicJwk)).toBe(true);
    expect(verifyOfflineAuditEntrySignature({ ...entry, hash: '0'.repeat(64) }, publicJwk)).toBe(false);
  });
});
