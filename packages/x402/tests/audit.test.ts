import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditLog } from '../src/audit.js';

describe('InMemoryAuditLog', () => {
  let auditLog: InMemoryAuditLog;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
  });

  it('starts empty', async () => {
    expect(auditLog.size).toBe(0);
    expect(await auditLog.export()).toEqual([]);
  });

  it('logs an entry with auto-generated id and timestamp', async () => {
    const entry = await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: ['weather:read'],
      tokenId: 'token-1',
    });

    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.eventType).toBe('issuance');
    expect(auditLog.size).toBe(1);
  });

  it('queries by event type', async () => {
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'token-1',
    });
    await auditLog.log({
      eventType: 'verification',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'token-1',
    });

    const issuances = await auditLog.query({ eventType: 'issuance' });
    expect(issuances).toHaveLength(1);

    const verifications = await auditLog.query({ eventType: 'verification' });
    expect(verifications).toHaveLength(1);
  });

  it('queries by agent DID', async () => {
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent1',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'token-1',
    });
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent2',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'token-2',
    });

    const results = await auditLog.query({ agentDID: 'did:key:agent1' });
    expect(results).toHaveLength(1);
    expect(results[0]!.agentDID).toBe('did:key:agent1');
  });

  it('respects query limit', async () => {
    for (let i = 0; i < 10; i++) {
      await auditLog.log({
        eventType: 'issuance',
        agentDID: 'did:key:agent',
        principalDID: 'did:key:principal',
        scope: [],
        tokenId: `token-${i}`,
      });
    }

    const results = await auditLog.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('returns newest first in queries', async () => {
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'first',
    });
    await new Promise((r) => setTimeout(r, 5));
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'second',
    });

    const results = await auditLog.query();
    expect(results[0]!.tokenId).toBe('second');
  });

  it('exports in chronological order', async () => {
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'first',
    });
    await new Promise((r) => setTimeout(r, 5));
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'second',
    });

    const all = await auditLog.export();
    expect(all[0]!.tokenId).toBe('first');
    expect(all[1]!.tokenId).toBe('second');
  });

  it('stores details', async () => {
    const entry = await auditLog.log({
      eventType: 'payment',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'token-1',
      details: { amount: 0.5, currency: 'USDC' },
    });

    expect(entry.details).toEqual({ amount: 0.5, currency: 'USDC' });
  });

  it('clears all entries', async () => {
    await auditLog.log({
      eventType: 'issuance',
      agentDID: 'did:key:agent',
      principalDID: 'did:key:principal',
      scope: [],
      tokenId: 'token-1',
    });
    auditLog.clear();
    expect(auditLog.size).toBe(0);
  });
});
