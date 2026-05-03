import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlMock, mockRedis } from './helpers.js';
import {
  checkPassportRevocation,
  revokeCommercePassport,
} from '../src/lib/commerce/revocation.js';

beforeEach(() => {
  // Reset sismember to default 0 (not revoked) for these tests.
  mockRedis.sismember.mockReset().mockResolvedValue(0);
  mockRedis.sadd.mockReset().mockResolvedValue(1);
});

describe('Revocation lookup', () => {
  it('Redis hit → revoked: true, source: redis', async () => {
    mockRedis.sismember.mockResolvedValueOnce(1);
    const r = await checkPassportRevocation(sqlMock as unknown as never, mockRedis as unknown as never, 'jti_X');
    expect(r.revoked).toBe(true);
    expect(r.source).toBe('redis');
  });

  it('Redis miss + Postgres hit → revoked: true, source: postgres + Redis warmed', async () => {
    mockRedis.sismember.mockResolvedValueOnce(0);
    sqlMock.mockResolvedValueOnce([{ reason: 'user_revoked' }]);
    const r = await checkPassportRevocation(sqlMock as unknown as never, mockRedis as unknown as never, 'jti_X');
    expect(r.revoked).toBe(true);
    expect(r.source).toBe('postgres');
    if (r.revoked && r.source === 'postgres') expect(r.reason).toBe('user_revoked');
    expect(mockRedis.sadd).toHaveBeenCalledWith('commerce:revoked:passport', 'jti_X');
  });

  it('Redis miss + Postgres miss → revoked: false, source: postgres', async () => {
    mockRedis.sismember.mockResolvedValueOnce(0);
    sqlMock.mockResolvedValueOnce([]);
    const r = await checkPassportRevocation(sqlMock as unknown as never, mockRedis as unknown as never, 'jti_X');
    expect(r.revoked).toBe(false);
    expect(r.source).toBe('postgres');
  });

  it('Redis throws + Postgres hit → still positively revoked via Postgres', async () => {
    mockRedis.sismember.mockRejectedValueOnce(new Error('redis down'));
    sqlMock.mockResolvedValueOnce([{ reason: 'merchant_disabled' }]);
    const r = await checkPassportRevocation(sqlMock as unknown as never, mockRedis as unknown as never, 'jti_X');
    expect(r.revoked).toBe(true);
    expect(r.source).toBe('postgres');
  });

  it('Redis throws + Postgres throws → fail-closed (source: fail_closed_unavailable)', async () => {
    mockRedis.sismember.mockRejectedValueOnce(new Error('redis down'));
    sqlMock.mockRejectedValueOnce(new Error('pg down'));
    const r = await checkPassportRevocation(sqlMock as unknown as never, mockRedis as unknown as never, 'jti_X');
    expect(r.revoked).toBe(false);
    expect(r.source).toBe('fail_closed_unavailable');
    if (r.source === 'fail_closed_unavailable') expect(typeof r.error).toBe('string');
  });
});

describe('Revocation write', () => {
  it('inserts into Postgres and warms Redis', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await revokeCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, {
      jti: 'jti_R', tenantId: 'cten_T', reason: 'user_revoked', revokedBy: 'user_X',
    });
    expect(mockRedis.sadd).toHaveBeenCalledWith('commerce:revoked:passport', 'jti_R');
  });

  it('survives Redis warm-up failure (Postgres remains source of truth)', async () => {
    sqlMock.mockResolvedValueOnce([]);
    mockRedis.sadd.mockRejectedValueOnce(new Error('redis down'));
    // Should not throw.
    await expect(
      revokeCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, {
        jti: 'jti_R', tenantId: 'cten_T', reason: 'explicit', revokedBy: null,
      }),
    ).resolves.toBeUndefined();
  });
});

// Silence unused-import warning when adjusting.
void vi;
