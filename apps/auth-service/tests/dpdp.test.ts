import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_GRANT } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ── Consent Notices ─────────────────────────────────────────────────────────

describe('POST /v1/dpdp/consent-notices', () => {
  it('creates a consent notice', async () => {
    seedAuth();
    // Insert
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-notices',
      headers: authHeader(),
      payload: {
        noticeId: 'data-processing-v1',
        version: '1.0.0',
        title: 'Data Processing Notice',
        content: 'We process your data for the following purposes...',
        purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.noticeId).toBe('data-processing-v1');
    expect(body.version).toBe('1.0.0');
    expect(body.contentHash).toBeDefined();
    expect(body.id).toMatch(/^notice_/);
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-notices',
      headers: authHeader(),
      payload: { noticeId: 'test' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 409 for duplicate notice version', async () => {
    seedAuth();
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-notices',
      headers: authHeader(),
      payload: {
        noticeId: 'data-processing-v1',
        version: '1.0.0',
        title: 'Data Processing Notice',
        content: 'Duplicate content',
        purposes: [{ code: 'analytics', description: 'Analytics' }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });
});

// ── Consent Records ─────────────────────────────────────────────────────────

describe('POST /v1/dpdp/consent-records', () => {
  it('creates a consent record', async () => {
    seedAuth();
    // Grant lookup
    sqlMock.mockResolvedValueOnce([{
      id: TEST_GRANT.id,
      scopes: ['read', 'write'],
      principal_id: 'user_123',
    }]);
    // Notice lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'notice_TEST',
      content: 'Notice content',
      content_hash: 'abc123hash',
    }]);
    // Insert consent record
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records',
      headers: authHeader(),
      payload: {
        grantId: TEST_GRANT.id,
        dataPrincipalId: 'user_123',
        purposes: [{ code: 'analytics', description: 'Usage analytics' }],
        consentNoticeId: 'data-processing-v1',
        processingExpiresAt: new Date(Date.now() + 86400_000 * 365).toISOString(),
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.recordId).toMatch(/^crec_/);
    expect(body.grantId).toBe(TEST_GRANT.id);
    expect(body.consentNoticeHash).toBe('abc123hash');
    expect(body.status).toBe('active');
    expect(body.consentProof).toBeDefined();
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records',
      headers: authHeader(),
      payload: { grantId: 'grnt_TEST' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid grant', async () => {
    seedAuth();
    // Grant lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records',
      headers: authHeader(),
      payload: {
        grantId: 'grnt_INVALID',
        dataPrincipalId: 'user_123',
        purposes: [{ code: 'analytics', description: 'Analytics' }],
        consentNoticeId: 'notice-v1',
        processingExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_GRANT');
  });

  it('returns 400 for invalid notice', async () => {
    seedAuth();
    // Grant lookup
    sqlMock.mockResolvedValueOnce([{
      id: TEST_GRANT.id,
      scopes: ['read'],
      principal_id: 'user_123',
    }]);
    // Notice lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records',
      headers: authHeader(),
      payload: {
        grantId: TEST_GRANT.id,
        dataPrincipalId: 'user_123',
        purposes: [{ code: 'analytics', description: 'Analytics' }],
        consentNoticeId: 'nonexistent-notice',
        processingExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_NOTICE');
  });
});

// ── Withdraw Consent ────────────────────────────────────────────────────────

describe('POST /v1/dpdp/consent-records/:recordId/withdraw', () => {
  it('withdraws consent', async () => {
    seedAuth();
    // Record lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_TEST',
      grant_id: TEST_GRANT.id,
      status: 'active',
    }]);
    // Update consent record
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_TEST/withdraw',
      headers: authHeader(),
      payload: { reason: 'No longer needed' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recordId).toBe('crec_TEST');
    expect(body.status).toBe('withdrawn');
    expect(body.withdrawnAt).toBeDefined();
    expect(body.grantRevoked).toBe(false);
  });

  it('withdraws and revokes grant', async () => {
    seedAuth();
    // Record lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_TEST',
      grant_id: TEST_GRANT.id,
      status: 'active',
    }]);
    // Update consent record
    sqlMock.mockResolvedValueOnce([]);
    // Revoke grant
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_TEST/withdraw',
      headers: authHeader(),
      payload: { reason: 'Revoking all access', revokeGrant: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().grantRevoked).toBe(true);
  });

  it('returns 404 for unknown record', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_NONEXIST/withdraw',
      headers: authHeader(),
      payload: { reason: 'Test' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('returns 409 for already withdrawn', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_TEST',
      grant_id: TEST_GRANT.id,
      status: 'withdrawn',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_TEST/withdraw',
      headers: authHeader(),
      payload: { reason: 'Test' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_WITHDRAWN');
  });

  it('returns 400 for missing reason', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_TEST/withdraw',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('withdraws with deleteProcessedData and anonymizes audit entries', async () => {
    seedAuth();
    // Record lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_TEST',
      grant_id: TEST_GRANT.id,
      status: 'active',
    }]);
    // Update consent record
    sqlMock.mockResolvedValueOnce([]);
    // Anonymize audit entries (deleteProcessedData SQL)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_TEST/withdraw',
      headers: authHeader(),
      payload: { reason: 'GDPR Article 17 request', deleteProcessedData: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recordId).toBe('crec_TEST');
    expect(body.status).toBe('withdrawn');
    expect(body.dataDeleted).toBe(true);
    expect(body.grantRevoked).toBe(false);

    // Verify 4 SQL calls: auth, record lookup, update record, anonymize audit
    expect(sqlMock).toHaveBeenCalledTimes(4);
  });

  it('withdraws with deleteProcessedData and revokeGrant together', async () => {
    seedAuth();
    // Record lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_TEST',
      grant_id: TEST_GRANT.id,
      status: 'active',
    }]);
    // Update consent record
    sqlMock.mockResolvedValueOnce([]);
    // Revoke grant
    sqlMock.mockResolvedValueOnce([]);
    // Anonymize audit entries
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/consent-records/crec_TEST/withdraw',
      headers: authHeader(),
      payload: { reason: 'Full erasure', revokeGrant: true, deleteProcessedData: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grantRevoked).toBe(true);
    expect(body.dataDeleted).toBe(true);

    // 5 SQL calls: auth, record lookup, update record, revoke grant, anonymize audit
    expect(sqlMock).toHaveBeenCalledTimes(5);
  });
});

// ── Get Consent Record by ID ────────────────────────────────────────────────

describe('GET /v1/dpdp/consent-records/:recordId', () => {
  it('returns a consent record by ID', async () => {
    seedAuth();
    // Record lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'crec_1',
      grant_id: TEST_GRANT.id,
      data_principal_id: 'user_123',
      data_fiduciary_name: 'Test Dev',
      purposes: [{ code: 'analytics', description: 'Analytics' }],
      scopes: ['read'],
      consent_notice_id: 'notice-v1',
      status: 'active',
      consent_given_at: '2026-03-01T00:00:00Z',
      processing_expires_at: '2027-03-01T00:00:00Z',
      retention_until: '2027-04-01T00:00:00Z',
      access_count: 5,
      last_accessed_at: '2026-03-15T00:00:00Z',
      withdrawn_at: null,
      withdrawn_reason: null,
      created_at: '2026-03-01T00:00:00Z',
    }]);
    // Update access count
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/consent-records/crec_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recordId).toBe('crec_1');
    expect(body.grantId).toBe(TEST_GRANT.id);
    expect(body.dataPrincipalId).toBe('user_123');
    expect(body.dataFiduciaryName).toBe('Test Dev');
    expect(body.status).toBe('active');
    expect(body.accessCount).toBe(6); // incremented by 1
    expect(body.lastAccessedAt).toBeDefined();
    expect(body.withdrawnAt).toBeNull();
    expect(body.withdrawnReason).toBeNull();
  });

  it('returns 404 for unknown record', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/consent-records/crec_NONEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ── List Consent Records ────────────────────────────────────────────────────

describe('GET /v1/dpdp/consent-records', () => {
  it('lists records filtered by dataPrincipalId', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'crec_1',
        grant_id: TEST_GRANT.id,
        data_principal_id: 'user_123',
        data_fiduciary_name: 'Test Dev',
        purposes: [{ code: 'analytics', description: 'Analytics' }],
        scopes: ['read'],
        consent_notice_id: 'notice-v1',
        status: 'active',
        consent_given_at: '2026-03-01T00:00:00Z',
        processing_expires_at: '2027-03-01T00:00:00Z',
        retention_until: '2027-04-01T00:00:00Z',
        access_count: 2,
        last_accessed_at: '2026-03-15T00:00:00Z',
        withdrawn_at: null,
        withdrawn_reason: null,
        created_at: '2026-03-01T00:00:00Z',
      },
      {
        id: 'crec_2',
        grant_id: 'grnt_OTHER',
        data_principal_id: 'user_123',
        data_fiduciary_name: 'Test Dev',
        purposes: [{ code: 'storage', description: 'Storage' }],
        scopes: ['write'],
        consent_notice_id: 'notice-v2',
        status: 'withdrawn',
        consent_given_at: '2026-02-01T00:00:00Z',
        processing_expires_at: '2027-02-01T00:00:00Z',
        retention_until: '2027-03-01T00:00:00Z',
        access_count: 0,
        last_accessed_at: null,
        withdrawn_at: '2026-03-10T00:00:00Z',
        withdrawn_reason: 'No longer needed',
        created_at: '2026-02-01T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/consent-records?dataPrincipalId=user_123',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toHaveLength(2);
    expect(body.totalRecords).toBe(2);
    expect(body.records[0].recordId).toBe('crec_1');
    expect(body.records[1].recordId).toBe('crec_2');
    expect(body.records[1].status).toBe('withdrawn');
    expect(body.records[1].withdrawnAt).toBe('2026-03-10T00:00:00Z');
  });

  it('lists all records without filter', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'crec_1',
        grant_id: TEST_GRANT.id,
        data_principal_id: 'user_123',
        data_fiduciary_name: 'Test Dev',
        purposes: [],
        scopes: ['read'],
        consent_notice_id: 'notice-v1',
        status: 'active',
        consent_given_at: '2026-03-01T00:00:00Z',
        processing_expires_at: '2027-03-01T00:00:00Z',
        retention_until: '2027-04-01T00:00:00Z',
        access_count: 0,
        last_accessed_at: null,
        withdrawn_at: null,
        withdrawn_reason: null,
        created_at: '2026-03-01T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/consent-records',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toHaveLength(1);
    expect(body.totalRecords).toBe(1);
    expect(body.records[0].recordId).toBe('crec_1');
  });

  it('returns empty list when no records exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/consent-records?dataPrincipalId=user_unknown',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toEqual([]);
    expect(body.totalRecords).toBe(0);
  });
});

// ── Data Erasure ────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/data-principals/:principalId/erasure', () => {
  it('erases data, marks records, and revokes grants', async () => {
    seedAuth();
    // Consent records lookup
    sqlMock.mockResolvedValueOnce([
      { id: 'crec_1', grant_id: TEST_GRANT.id },
      { id: 'crec_2', grant_id: 'grnt_OTHER' },
    ]);
    // Mark consent records as erased
    sqlMock.mockResolvedValueOnce([]);
    // Revoke grants
    sqlMock.mockResolvedValueOnce([]);
    // Anonymize audit entries
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/data-principals/user_123/erasure',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.requestId).toMatch(/^ER-\d{4}-\d{5}$/);
    expect(body.dataPrincipalId).toBe('user_123');
    expect(body.status).toBe('completed');
    expect(body.recordsErased).toBe(2);
    expect(body.grantsRevoked).toBe(2);
    expect(body.submittedAt).toBeDefined();
    expect(body.expectedCompletionBy).toBeDefined();

    // Verify expectedCompletionBy is 7 days from submittedAt
    const submitted = new Date(body.submittedAt);
    const expected = new Date(body.expectedCompletionBy);
    const diffDays = Math.round((expected.getTime() - submitted.getTime()) / (86400_000));
    expect(diffDays).toBe(7);
  });

  it('returns 404 when no consent records found for principal', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/data-principals/user_unknown/erasure',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('handles records with no associated grants', async () => {
    seedAuth();
    // Consent records lookup — grant_id is null
    sqlMock.mockResolvedValueOnce([
      { id: 'crec_1', grant_id: null },
    ]);
    // Mark consent records as erased
    sqlMock.mockResolvedValueOnce([]);
    // Anonymize audit entries (still runs)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/data-principals/user_456/erasure',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.recordsErased).toBe(1);
    expect(body.grantsRevoked).toBe(0);

    // Only 4 SQL calls: auth, records lookup, mark erased, anonymize audit
    // (no revoke grants call because there are no grant IDs)
    expect(sqlMock).toHaveBeenCalledTimes(4);
  });
});

// ── Data Principal Records ──────────────────────────────────────────────────

describe('GET /v1/dpdp/data-principals/:principalId/records', () => {
  it('returns records for a data principal', async () => {
    seedAuth();
    // Select records
    sqlMock.mockResolvedValueOnce([
      {
        id: 'crec_1',
        grant_id: TEST_GRANT.id,
        data_fiduciary_name: 'Test Dev',
        purposes: [{ code: 'analytics', description: 'Analytics' }],
        scopes: ['read'],
        consent_notice_id: 'notice-v1',
        status: 'active',
        consent_given_at: '2026-03-01T00:00:00Z',
        processing_expires_at: '2027-03-01T00:00:00Z',
        retention_until: '2027-04-01T00:00:00Z',
        access_count: 2,
        last_accessed_at: '2026-03-15T00:00:00Z',
        withdrawn_at: null,
        withdrawn_reason: null,
        created_at: '2026-03-01T00:00:00Z',
      },
    ]);
    // Update access counts
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/data-principals/user_123/records',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataPrincipalId).toBe('user_123');
    expect(body.records).toHaveLength(1);
    expect(body.records[0].recordId).toBe('crec_1');
    expect(body.records[0].accessCount).toBe(3);
    expect(body.totalRecords).toBe(1);
  });

  it('returns empty list when no records', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/data-principals/user_unknown/records',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().records).toEqual([]);
    expect(res.json().totalRecords).toBe(0);
  });
});

// ── Grievances ──────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/grievances', () => {
  it('files a grievance', async () => {
    seedAuth();
    // Insert grievance
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/grievances',
      headers: authHeader(),
      payload: {
        dataPrincipalId: 'user_123',
        type: 'data-erasure',
        description: 'Please delete my data',
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.grievanceId).toMatch(/^grv_/);
    expect(body.referenceNumber).toMatch(/^GRV-\d{4}-\d{5}$/);
    expect(body.status).toBe('submitted');
    expect(body.expectedResolutionBy).toBeDefined();
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/grievances',
      headers: authHeader(),
      payload: { dataPrincipalId: 'user_123' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

describe('GET /v1/dpdp/grievances/:grievanceId', () => {
  it('returns a grievance', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'grv_TEST',
      data_principal_id: 'user_123',
      record_id: null,
      type: 'data-erasure',
      description: 'Delete my data',
      evidence: {},
      status: 'submitted',
      reference_number: 'GRV-2026-00001',
      expected_resolution_by: '2026-04-10T00:00:00Z',
      resolved_at: null,
      resolution: null,
      created_at: '2026-04-03T00:00:00Z',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/grievances/grv_TEST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grievanceId).toBe('grv_TEST');
    expect(body.referenceNumber).toBe('GRV-2026-00001');
    expect(body.status).toBe('submitted');
  });

  it('returns 404 for unknown grievance', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/grievances/grv_NONEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ── Exports ─────────────────────────────────────────────────────────────────

describe('POST /v1/dpdp/exports', () => {
  it('creates a DPDP audit export', async () => {
    seedAuth();
    // sql`` fragment for dataPrincipalId in consent records query
    sqlMock.mockResolvedValueOnce([]);
    // Consent records query
    sqlMock.mockResolvedValueOnce([
      { id: 'crec_1', grant_id: 'grnt_1', data_principal_id: 'user_1', purposes: [], scopes: [], status: 'active', consent_given_at: '2026-03-01', processing_expires_at: '2027-01-01', withdrawn_at: null },
    ]);
    // sql`` fragment for dataPrincipalId in audit log query
    sqlMock.mockResolvedValueOnce([]);
    // Audit log query
    sqlMock.mockResolvedValueOnce([
      { id: 'alog_1', action: 'token.exchange', status: 'success', metadata: {}, timestamp: '2026-03-15' },
    ]);
    // Grievances query (for dpdp-audit type)
    sqlMock.mockResolvedValueOnce([]);
    // Insert export
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/exports',
      headers: authHeader(),
      payload: {
        type: 'dpdp-audit',
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.exportId).toMatch(/^exp_/);
    expect(body.type).toBe('dpdp-audit');
    expect(body.data).toBeDefined();
    expect(body.data.consentRecords).toBeDefined();
    expect(body.data.auditLog).toBeDefined();
  });

  it('returns 400 for invalid type', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/exports',
      headers: authHeader(),
      payload: {
        type: 'invalid-type',
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dpdp/exports',
      headers: authHeader(),
      payload: { type: 'dpdp-audit' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

describe('GET /v1/dpdp/exports/:exportId', () => {
  it('returns an export', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'exp_TEST',
      type: 'dpdp-audit',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      format: 'json',
      status: 'complete',
      record_count: 5,
      data: { consentRecords: [], auditLog: [] },
      expires_at: '2026-04-10T00:00:00Z',
      created_at: '2026-04-03T00:00:00Z',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/exports/exp_TEST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exportId).toBe('exp_TEST');
    expect(body.type).toBe('dpdp-audit');
    expect(body.recordCount).toBe(5);
  });

  it('returns 404 for unknown export', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dpdp/exports/exp_NONEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
