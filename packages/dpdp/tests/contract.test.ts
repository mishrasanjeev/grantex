/**
 * Contract tests: every API function against the response bodies the Grantex
 * auth service actually sends (tests/fixtures/dpdp-server-fixtures.json, taken
 * from apps/auth-service/src/routes/dpdp.ts). Each test pins the exact request
 * (method, percent-encoded URL, JSON body) and the decoded result.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createConsentRecord,
  getConsentRecord,
  listConsentRecords,
  listConsentRecordsPage,
  withdrawConsent,
  getDataPrincipalRecords,
  requestDataErasure,
  getErasureRequest,
  createConsentNotice,
  listConsentNotices,
  getConsentNotice,
  fileGrievance,
  listGrievances,
  getGrievanceStatus,
  updateGrievance,
  requestDpdpExport,
  requestGdprExport,
  requestEuAiActExport,
  getExportStatus,
  DpdpError,
  WithdrawalError,
  GrievanceError,
  ExportError,
  ExportExpiredError,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Drop note keys (leading '_') recursively. */
function stripNotes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Json)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripNotes(v)]),
    );
  }
  return value;
}

const RAW = stripNotes(
  JSON.parse(readFileSync(new URL('./fixtures/dpdp-server-fixtures.json', import.meta.url), 'utf8')),
) as Record<string, Json>;

/** A fixture body, with "<name>" placeholders in arrays replaced by that fixture. */
function fx(name: string): Json {
  const resolve = (v: unknown): unknown => {
    if (typeof v === 'string' && /^<\w+>$/.test(v)) return fx(v.slice(1, -1));
    if (Array.isArray(v)) return v.map(resolve);
    return v;
  };
  const body = RAW[name];
  if (!body) throw new Error(`no fixture ${name}`);
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, resolve(v)])) as Json;
}

const errorFx = (name: string): Json => (RAW.errors as Record<string, Json>)[name]!;

const API = 'https://api.example.com';
const KEY = 'test-api-key';
const ODD = 'user@example.com/../x y';
const ODD_ENC = 'user%40example.com%2F..%2Fx%20y';

function serve(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sent(fn: ReturnType<typeof serve>) {
  const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return {
    url,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    headers,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const RECORD_200_DECODED = {
  recordId: 'crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W',
  grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
  dataPrincipalId: 'user_123',
  dataFiduciaryName: 'Acme Health',
  purposes: [
    { code: 'analytics', description: 'Usage analytics for service improvement' },
    { code: 'personalization', description: 'Personalized recommendations' },
  ],
  scopes: ['read:profile', 'write:preferences'],
  consentNoticeId: 'privacy-notice',
  consentNoticeVersion: '2.0',
  status: 'active',
  consentGivenAt: new Date('2026-09-30T10:15:00.000Z'),
  processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
  retentionUntil: new Date('2027-10-30T00:00:00.000Z'),
  accessCount: 0,
  createdAt: new Date('2026-09-30T10:15:00.000Z'),
};

const ERASED_DECODED = {
  recordId: 'crec_01J9Z0AAAAAAAAAAAAAAAAAAAA',
  grantId: 'grnt_01J9Z0BBBBBBBBBBBBBBBBBBBB',
  dataPrincipalId: 'user_123',
  dataFiduciaryName: 'Acme Health',
  purposes: [{ code: 'analytics', description: 'Usage analytics for service improvement' }],
  scopes: ['read:profile'],
  consentNoticeId: 'privacy-notice',
  status: 'erased',
  consentGivenAt: new Date('2026-06-01T08:00:00.000Z'),
  processingExpiresAt: new Date('2027-06-01T00:00:00.000Z'),
  retentionUntil: new Date('2027-07-01T00:00:00.000Z'),
  accessCount: 3,
  lastAccessedAt: new Date('2026-07-01T09:00:00.000Z'),
  withdrawnAt: new Date('2026-09-29T12:00:00.000Z'),
  withdrawnReason: 'Data erasure request',
  erasedAt: new Date('2026-09-29T12:00:00.000Z'),
  createdAt: new Date('2026-06-01T08:00:00.000Z'),
};

// ---------------------------------------------------------------------------
// Consent records
// ---------------------------------------------------------------------------

describe('contract: consent records', () => {
  it('createConsentRecord sends only the fields the server reads and decodes the 201', async () => {
    const fn = serve(201, fx('createConsentRecord_201'));

    const created = await createConsentRecord({
      grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
      dataPrincipalId: 'user_123',
      purposes: [
        { code: 'analytics', description: 'Usage analytics for service improvement' },
        {
          purposeId: 'personalization',
          name: 'Personalization',
          description: 'Personalized recommendations',
          legalBasis: 'consent',
          dataCategories: ['preferences'],
          retentionPeriod: '1 year',
          thirdPartySharing: false,
        },
      ],
      consentNoticeId: 'privacy-notice',
      consentNoticeVersion: '2.0',
      processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
      apiKey: KEY,
      baseUrl: API,
    });

    const req = sent(fn);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v1/dpdp/consent-records`);
    expect(req.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.body).toEqual({
      grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
      dataPrincipalId: 'user_123',
      purposes: [
        { code: 'analytics', description: 'Usage analytics for service improvement' },
        { code: 'personalization', description: 'Personalized recommendations' },
      ],
      consentNoticeId: 'privacy-notice',
      consentNoticeVersion: '2.0',
      processingExpiresAt: '2027-09-30T00:00:00.000Z',
    });

    expect(created).toEqual({
      recordId: 'crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W',
      grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
      dataPrincipalId: 'user_123',
      consentNoticeId: 'privacy-notice',
      consentNoticeVersion: '2.0',
      consentNoticeHash: '9f2c1e7a4b3d5c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6',
      consentProof: {
        type: 'JWS-EdDSA',
        alg: 'EdDSA',
        kid: 'ed25519-2026-09',
        proofJwt: (fx('createConsentRecord_201').consentProof as Json).proofJwt,
        jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
        signedAt: new Date('2026-09-30T10:15:00.000Z'),
      },
      processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
      retentionUntil: new Date('2027-10-30T00:00:00.000Z'),
      status: 'active',
      createdAt: new Date('2026-09-30T10:15:00.000Z'),
    });
    // No Invalid Date anywhere.
    expect(Number.isNaN(created.createdAt.getTime())).toBe(false);
  });

  it('createConsentRecord omits consentNoticeVersion when not given and never sends local-only fields', async () => {
    const fn = serve(201, fx('createConsentRecord_201'));
    await createConsentRecord({
      grantId: 'g',
      dataPrincipalId: 'p',
      purposes: [{ code: 'analytics', description: 'd' }],
      consentNoticeId: 'n',
      processingExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      dataFiduciaryId: 'fid_1',
      dataFiduciaryName: 'Acme Health',
      scopes: ['read:profile'],
      consentNoticeContent: 'Notice text',
      consentMethod: 'explicit-click',
      retentionUntil: new Date('2028-01-01T00:00:00.000Z'),
      proofUserAgent: 'Nimbus Shopper 2.4',
      proofSessionId: 'sess_1',
      apiKey: KEY,
      baseUrl: API,
    });
    expect(Object.keys(sent(fn).body).sort()).toEqual(
      ['consentNoticeId', 'dataPrincipalId', 'grantId', 'processingExpiresAt', 'purposes'],
    );
  });

  it('createConsentRecord surfaces 503 CONSENT_PROOF_UNAVAILABLE with status, code and requestId', async () => {
    serve(503, errorFx('503_CONSENT_PROOF_UNAVAILABLE'));
    const err = await createConsentRecord({
      grantId: 'g',
      dataPrincipalId: 'p',
      purposes: [{ code: 'analytics', description: 'd' }],
      consentNoticeId: 'n',
      processingExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      apiKey: KEY,
      baseUrl: API,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DpdpError);
    expect(err).toMatchObject({
      statusCode: 503,
      code: 'CONSENT_PROOF_UNAVAILABLE',
      requestId: 'req-7f46',
      message: 'The consent proof could not be signed; no consent record was created',
    });
  });

  it.each([
    ['400_INVALID_GRANT', 400, 'INVALID_GRANT'],
    ['400_PRINCIPAL_MISMATCH', 400, 'PRINCIPAL_MISMATCH'],
    ['400_INVALID_NOTICE', 400, 'INVALID_NOTICE'],
    ['400_BAD_REQUEST', 400, 'BAD_REQUEST'],
  ])('createConsentRecord surfaces %s', async (name, status, code) => {
    serve(status, errorFx(name));
    await expect(
      createConsentRecord({
        grantId: 'g',
        dataPrincipalId: 'p',
        purposes: [{ code: 'analytics', description: 'd' }],
        consentNoticeId: 'n',
        processingExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
        apiKey: KEY,
        baseUrl: API,
      }),
    ).rejects.toMatchObject({ statusCode: status, code, requestId: errorFx(name).requestId });
  });

  it('getConsentRecord encodes the id and decodes the record (no consentProof on GET)', async () => {
    const fn = serve(200, fx('consentRecord_200'));
    const record = await getConsentRecord(ODD, KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/consent-records/${ODD_ENC}`);
    expect(req.body).toBeUndefined();
    expect(record).toEqual(RECORD_200_DECODED);
  });

  it('getConsentRecord decodes an erased legacy record (null consentNoticeVersion)', async () => {
    serve(200, fx('consentRecord_erased_legacy_200'));
    const record = await getConsentRecord('crec_01J9Z0AAAAAAAAAAAAAAAAAAAA', KEY, API);
    expect(record).toEqual(ERASED_DECODED);
  });

  it('getConsentRecord surfaces 404 NOT_FOUND', async () => {
    serve(404, errorFx('404_NOT_FOUND'));
    await expect(getConsentRecord('crec_x', KEY, API)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      requestId: 'req-7f3f',
    });
  });

  it('listConsentRecordsPage sends dataPrincipalId, limit and cursor and decodes the page', async () => {
    const fn = serve(200, fx('listConsentRecords_200'));
    const page = await listConsentRecordsPage(
      { dataPrincipalId: ODD, limit: 2, cursor: 'abc+/=' },
      KEY,
      API,
    );
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(
      `${API}/v1/dpdp/consent-records?dataPrincipalId=${ODD_ENC}&limit=2&cursor=abc%2B%2F%3D`,
    );
    expect(page).toEqual({
      records: [RECORD_200_DECODED, ERASED_DECODED],
      totalRecords: 7,
      nextCursor: fx('listConsentRecords_200').nextCursor,
    });
  });

  it('listConsentRecordsPage without filters calls the bare route', async () => {
    const fn = serve(200, { records: [], totalRecords: 0, nextCursor: null });
    const page = await listConsentRecordsPage({}, KEY, API);
    expect(sent(fn).url).toBe(`${API}/v1/dpdp/consent-records`);
    expect(page).toEqual({ records: [], totalRecords: 0, nextCursor: null });
  });

  it('listConsentRecords (array form) still returns the decoded records', async () => {
    const fn = serve(200, fx('listConsentRecords_200'));
    const records = await listConsentRecords('user_123', KEY, API);
    expect(sent(fn).url).toBe(`${API}/v1/dpdp/consent-records?dataPrincipalId=user_123`);
    expect(records).toEqual([RECORD_200_DECODED, ERASED_DECODED]);
  });

  it('withdrawConsent sends reason and flags, decodes the 200', async () => {
    const fn = serve(200, fx('withdrawConsent_200'));
    const result = await withdrawConsent(ODD, 'No longer needed', {
      revokeGrant: true,
      deleteProcessedData: true,
      apiKey: KEY,
      baseUrl: API,
    });
    const req = sent(fn);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v1/dpdp/consent-records/${ODD_ENC}/withdraw`);
    expect(req.body).toEqual({ reason: 'No longer needed', revokeGrant: true, deleteProcessedData: true });
    expect(result).toEqual({
      recordId: 'crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W',
      status: 'withdrawn',
      withdrawnAt: new Date('2026-09-30T11:00:00.000Z'),
      grantRevoked: true,
      dataDeleted: false,
      dataDeletionRequested: true,
    });
  });

  it.each([
    ['409_ALREADY_WITHDRAWN', 409, 'ALREADY_WITHDRAWN'],
    ['409_CONSENT_ERASED', 409, 'CONSENT_ERASED'],
    ['409_CONSENT_EXPIRED', 409, 'CONSENT_EXPIRED'],
    ['404_NOT_FOUND', 404, 'NOT_FOUND'],
  ])('withdrawConsent surfaces %s as WithdrawalError', async (name, status, code) => {
    serve(status, errorFx(name));
    const err = await withdrawConsent('crec_x', 'r', { apiKey: KEY, baseUrl: API }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WithdrawalError);
    expect(err).toMatchObject({ statusCode: status, code, requestId: errorFx(name).requestId });
  });
});

// ---------------------------------------------------------------------------
// Data principal rights
// ---------------------------------------------------------------------------

describe('contract: data principal rights', () => {
  it('getDataPrincipalRecords encodes the id, sends pagination and decodes totalRecords/nextCursor/dates', async () => {
    const fn = serve(200, fx('principalRecords_200'));
    const result = await getDataPrincipalRecords(ODD, KEY, API, { limit: 10, cursor: 'c1' });
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/data-principals/${ODD_ENC}/records?limit=10&cursor=c1`);
    expect(result).toEqual({
      dataPrincipalId: 'user_123',
      records: [RECORD_200_DECODED],
      totalRecords: 1,
      totalCount: 1,
      nextCursor: null,
    });
    expect(result.records[0]!.consentGivenAt).toBeInstanceOf(Date);
  });

  it('getDataPrincipalRecords tolerates records without dataPrincipalId (older servers)', async () => {
    const legacy = fx('principalRecords_200');
    const { dataPrincipalId: _drop, ...recordWithoutPrincipal } = fx('consentRecord_200');
    void _drop;
    serve(200, { ...legacy, records: [recordWithoutPrincipal] });
    const result = await getDataPrincipalRecords('user_123', KEY, API);
    expect(result.records[0]!.dataPrincipalId).toBe('user_123');
  });

  it('requestDataErasure POSTs with no body and decodes the 201', async () => {
    const fn = serve(201, fx('erasure_201'));
    const result = await requestDataErasure(ODD, KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v1/dpdp/data-principals/${ODD_ENC}/erasure`);
    expect(req.body).toBeUndefined();
    expect(req.headers['Content-Type']).toBeUndefined();
    const retained = (fx('erasure_201').retained as Json[]);
    expect(result).toEqual({
      requestId: 'ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R',
      dataPrincipalId: 'user_123',
      status: 'completed',
      recordsErased: 2,
      grantsRevoked: 1,
      delegatedGrantsRevoked: 0,
      grievancesRedacted: 1,
      exportsDeleted: 0,
      retained,
      submittedAt: new Date('2026-09-30T14:00:00.000Z'),
      completedAt: new Date('2026-09-30T14:00:00.120Z'),
      expectedCompletionBy: new Date('2026-09-30T14:00:00.120Z'),
      httpStatus: 201,
      created: true,
    });
  });

  it('requestDataErasure reports a repeat (200) as not newly created', async () => {
    serve(200, fx('erasure_201'));
    const result = await requestDataErasure('user_123', KEY, API);
    expect(result.httpStatus).toBe(200);
    expect(result.created).toBe(false);
    expect(result.requestId).toBe('ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R');
  });

  it('requestDataErasure surfaces 404 NOT_FOUND', async () => {
    serve(404, { message: 'No consent records found for this data principal', code: 'NOT_FOUND', requestId: 'req-1' });
    await expect(requestDataErasure('nobody', KEY, API)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      requestId: 'req-1',
      message: 'No consent records found for this data principal',
    });
  });

  it('getErasureRequest encodes the id and decodes the same shape', async () => {
    const fn = serve(200, fx('erasure_201'));
    const result = await getErasureRequest('ER-2026/x', KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/erasure-requests/ER-2026%2Fx`);
    expect(result.recordsErased).toBe(2);
    expect(result.retained).toHaveLength(4);
    expect(result.completedAt).toEqual(new Date('2026-09-30T14:00:00.120Z'));
    expect(result).not.toHaveProperty('httpStatus');
  });
});

// ---------------------------------------------------------------------------
// Consent notices
// ---------------------------------------------------------------------------

describe('contract: consent notices', () => {
  it('createConsentNotice sends noticeId, no contentHash, grievanceOfficer {name,email,phone}; decodes the 201', async () => {
    const fn = serve(201, fx('createConsentNotice_201'));
    const created = await createConsentNotice({
      noticeId: 'privacy-notice',
      version: '2.0',
      language: 'en',
      title: 'Data Processing Consent Notice',
      content: 'We collect and process your data for the following purposes...',
      purposes: [{ code: 'analytics', description: 'Usage analytics for service improvement' }],
      dataFiduciaryContact: 'privacy@acme.example',
      grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@acme.example', phone: '+91-00000-00000' },
      apiKey: KEY,
      baseUrl: API,
    });
    const req = sent(fn);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v1/dpdp/consent-notices`);
    expect(req.body).toEqual({
      noticeId: 'privacy-notice',
      version: '2.0',
      language: 'en',
      title: 'Data Processing Consent Notice',
      content: 'We collect and process your data for the following purposes...',
      purposes: [{ code: 'analytics', description: 'Usage analytics for service improvement' }],
      dataFiduciaryContact: 'privacy@acme.example',
      grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@acme.example', phone: '+91-00000-00000' },
    });
    expect(created).toEqual({
      id: 'notice_01J9ZA1B2C3D4E5F6G7H8J9K0M',
      noticeId: 'privacy-notice',
      version: '2.0',
      language: 'en',
      contentHash: '9f2c1e7a4b3d5c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6',
      createdAt: new Date('2026-09-30T09:00:00.000Z'),
    });
  });

  it('createConsentNotice surfaces 409 CONFLICT', async () => {
    serve(409, errorFx('409_CONFLICT'));
    await expect(
      createConsentNotice({
        noticeId: 'privacy-notice',
        version: '2.0',
        language: 'en',
        title: 't',
        content: 'c',
        purposes: [{ code: 'analytics', description: 'd' }],
        dataFiduciaryContact: 'privacy@acme.example',
        apiKey: KEY,
        baseUrl: API,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', requestId: 'req-7f43' });
  });

  it('listConsentNotices sends limit and cursor and decodes the page', async () => {
    const fn = serve(200, fx('listConsentNotices_200'));
    const page = await listConsentNotices({ limit: 5, cursor: 'c2' }, KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/consent-notices?limit=5&cursor=c2`);
    expect(page).toEqual({
      notices: [
        {
          id: 'notice_01J9ZA1B2C3D4E5F6G7H8J9K0M',
          noticeId: 'privacy-notice',
          version: '2.0',
          language: 'en',
          title: 'Data Processing Consent Notice',
          contentHash: '9f2c1e7a4b3d5c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6',
          createdAt: new Date('2026-09-30T09:00:00.000Z'),
        },
      ],
      nextCursor: null,
    });
  });

  it('getConsentNotice encodes the id and decodes every version', async () => {
    const fn = serve(200, fx('getConsentNotice_200'));
    const notice = await getConsentNotice('privacy notice/v', KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/consent-notices/privacy%20notice%2Fv`);
    expect(notice).toEqual({
      noticeId: 'privacy-notice',
      versions: [
        {
          id: 'notice_01J9ZA1B2C3D4E5F6G7H8J9K0M',
          version: '2.0',
          language: 'en',
          title: 'Data Processing Consent Notice',
          content: 'We collect and process your data for the following purposes...',
          purposes: [{ code: 'analytics', description: 'Usage analytics for service improvement' }],
          dataFiduciaryContact: 'privacy@acme.example',
          grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@acme.example', phone: '+91-00000-00000' },
          contentHash: '9f2c1e7a4b3d5c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6',
          createdAt: new Date('2026-09-30T09:00:00.000Z'),
        },
        {
          id: 'notice_01J9Z9ZZZZZZZZZZZZZZZZZZZZ',
          version: '1.0',
          language: 'en',
          title: 'Data Processing Consent Notice',
          content: 'Earlier text',
          purposes: [{ code: 'analytics', description: 'Usage analytics' }],
          contentHash: '1111111111111111111111111111111111111111111111111111111111111111',
          createdAt: new Date('2026-08-01T09:00:00.000Z'),
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Grievances
// ---------------------------------------------------------------------------

describe('contract: grievances', () => {
  it('fileGrievance sends the server fields and decodes only the 202 fields', async () => {
    const fn = serve(202, fx('fileGrievance_202'));
    const receipt = await fileGrievance(
      {
        dataPrincipalId: 'user_123',
        type: 'unauthorized-processing',
        description: 'My data was used for marketing without consent',
        evidence: { screenshots: ['https://files.example.com/s1.png'] },
        responsePeriodDays: 7,
      },
      KEY,
      API,
    );
    const req = sent(fn);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v1/dpdp/grievances`);
    expect(req.body).toEqual({
      dataPrincipalId: 'user_123',
      type: 'unauthorized-processing',
      description: 'My data was used for marketing without consent',
      evidence: { screenshots: ['https://files.example.com/s1.png'] },
      responsePeriodDays: 7,
    });
    expect(receipt).toEqual({
      grievanceId: 'grv_01J9ZC5D6E7F8G9H0J1K2M3N4P',
      referenceNumber: 'GRV-2026-01J9ZC5D6E7F8G9H0J1K2M3N4Q',
      type: 'unauthorized-processing',
      status: 'submitted',
      responsePeriodDays: 7,
      expectedResolutionBy: new Date('2026-10-07T12:00:00.000Z'),
      createdAt: new Date('2026-09-30T12:00:00.000Z'),
    });
  });

  it('fileGrievance sends recordId when given', async () => {
    const fn = serve(202, fx('fileGrievance_202'));
    await fileGrievance(
      { dataPrincipalId: 'user_123', recordId: 'crec_1', type: 'data-breach', description: 'd' },
      KEY,
      API,
    );
    expect(sent(fn).body).toEqual({
      dataPrincipalId: 'user_123',
      recordId: 'crec_1',
      type: 'data-breach',
      description: 'd',
    });
  });

  it('fileGrievance surfaces 400 INVALID_RECORD as GrievanceError', async () => {
    serve(400, errorFx('400_INVALID_RECORD'));
    const err = await fileGrievance(
      { dataPrincipalId: 'user_123', recordId: 'crec_missing', type: 'other', description: 'd' },
      KEY,
      API,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrievanceError);
    expect(err).toMatchObject({ statusCode: 400, code: 'INVALID_RECORD', requestId: 'req-7f3e' });
  });

  it('listGrievances sends filters and pagination and decodes summaries', async () => {
    const fn = serve(200, fx('listGrievances_200'));
    const page = await listGrievances(
      { status: 'in_review', dataPrincipalId: ODD, limit: 20, cursor: 'c3' },
      KEY,
      API,
    );
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(
      `${API}/v1/dpdp/grievances?status=in_review&dataPrincipalId=${ODD_ENC}&limit=20&cursor=c3`,
    );
    expect(page).toEqual({
      grievances: [
        {
          grievanceId: 'grv_01J9ZC5D6E7F8G9H0J1K2M3N4P',
          dataPrincipalId: 'user_123',
          type: 'unauthorized-processing',
          status: 'submitted',
          referenceNumber: 'GRV-2026-01J9ZC5D6E7F8G9H0J1K2M3N4Q',
          expectedResolutionBy: new Date('2026-10-07T12:00:00.000Z'),
          responsePeriodDays: 7,
          createdAt: new Date('2026-09-30T12:00:00.000Z'),
        },
      ],
      nextCursor: null,
    });
  });

  it('getGrievanceStatus encodes the id and decodes the detail', async () => {
    const fn = serve(200, fx('getGrievance_200'));
    const g = await getGrievanceStatus('grv/1', KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/grievances/grv%2F1`);
    expect(g).toEqual({
      grievanceId: 'grv_01J9ZC5D6E7F8G9H0J1K2M3N4P',
      dataPrincipalId: 'user_123',
      recordId: 'crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W',
      type: 'unauthorized-processing',
      description: 'My data was used for marketing without consent',
      evidence: { screenshots: ['https://files.example.com/s1.png'] },
      status: 'in_review',
      referenceNumber: 'GRV-2026-01J9ZC5D6E7F8G9H0J1K2M3N4Q',
      expectedResolutionBy: new Date('2026-10-07T12:00:00.000Z'),
      responsePeriodDays: 7,
      createdAt: new Date('2026-09-30T12:00:00.000Z'),
      updatedAt: new Date('2026-10-01T08:00:00.000Z'),
    });
  });

  it('updateGrievance PATCHes status and resolution and decodes the detail', async () => {
    const fn = serve(200, fx('updateGrievance_200'));
    const g = await updateGrievance(
      'grv/1',
      { status: 'resolved', resolution: 'Marketing processing stopped and the data principal informed' },
      KEY,
      API,
    );
    const req = sent(fn);
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe(`${API}/v1/dpdp/grievances/grv%2F1`);
    expect(req.body).toEqual({
      status: 'resolved',
      resolution: 'Marketing processing stopped and the data principal informed',
    });
    expect(g.status).toBe('resolved');
    expect(g.resolvedAt).toEqual(new Date('2026-10-02T09:30:00.000Z'));
    expect(g.resolution).toBe('Marketing processing stopped and the data principal informed');
    expect(g.evidence).toEqual({});
  });

  it('updateGrievance surfaces 409 INVALID_TRANSITION', async () => {
    serve(409, errorFx('409_INVALID_TRANSITION'));
    const err = await updateGrievance('grv_1', { status: 'in_review' }, KEY, API).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrievanceError);
    expect(err).toMatchObject({ statusCode: 409, code: 'INVALID_TRANSITION', requestId: 'req-7f44' });
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('contract: exports', () => {
  const CREATE_DECODED = {
    exportId: 'exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q',
    type: 'dpdp-audit',
    format: 'json',
    recordCount: 3,
    truncated: false,
    auditLogLimit: 1000,
    data: fx('createExport_201').data,
    expiresAt: new Date('2026-10-07T13:00:00.000Z'),
    createdAt: new Date('2026-09-30T13:00:00.000Z'),
  };

  it('requestDpdpExport sends only given fields (include flags default server-side) and decodes the 201', async () => {
    const fn = serve(201, fx('createExport_201'));
    const result = await requestDpdpExport(
      { dateFrom: new Date('2026-09-01T00:00:00.000Z'), dateTo: new Date('2026-09-30T23:59:59.999Z') },
      KEY,
      API,
    );
    const req = sent(fn);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${API}/v1/dpdp/exports`);
    expect(req.body).toEqual({
      type: 'dpdp-audit',
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-30T23:59:59.999Z',
    });
    expect(result).toEqual(CREATE_DECODED);
    expect(result).not.toHaveProperty('status');
  });

  it('requestGdprExport sends explicit flags, format and principal', async () => {
    const fn = serve(201, { ...fx('createExport_201'), type: 'gdpr-article-15', dataPrincipalId: 'user_123' });
    const result = await requestGdprExport(
      {
        dateFrom: new Date('2026-09-01T00:00:00.000Z'),
        dateTo: new Date('2026-09-30T23:59:59.999Z'),
        format: 'json',
        includeActionLog: false,
        includeConsentRecords: true,
        dataPrincipalId: 'user_123',
      },
      KEY,
      API,
    );
    expect(sent(fn).body).toEqual({
      type: 'gdpr-article-15',
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-30T23:59:59.999Z',
      format: 'json',
      includeActionLog: false,
      includeConsentRecords: true,
      dataPrincipalId: 'user_123',
    });
    expect(result.dataPrincipalId).toBe('user_123');
    expect(result.type).toBe('gdpr-article-15');
  });

  it('requestEuAiActExport sends the eu-ai-act-conformance type', async () => {
    const fn = serve(201, { ...fx('createExport_201'), type: 'eu-ai-act-conformance' });
    const result = await requestEuAiActExport(
      { dateFrom: new Date('2026-09-01T00:00:00.000Z'), dateTo: new Date('2026-09-30T23:59:59.999Z') },
      KEY,
      API,
    );
    expect(sent(fn).body.type).toBe('eu-ai-act-conformance');
    expect(result.type).toBe('eu-ai-act-conformance');
  });

  it('getExportStatus encodes the id and decodes the GET 200 (status complete, date range)', async () => {
    const fn = serve(200, fx('getExport_200'));
    const result = await getExportStatus('exp/1', KEY, API);
    const req = sent(fn);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/v1/dpdp/exports/exp%2F1`);
    expect(result).toEqual({
      exportId: 'exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q',
      type: 'dpdp-audit',
      dateFrom: new Date('2026-09-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-30T23:59:59.999Z'),
      format: 'json',
      status: 'complete',
      recordCount: 1001,
      truncated: true,
      auditLogLimit: 1000,
      dataPrincipalId: 'user_123',
      data: { exportType: 'dpdp-audit', truncated: true, auditLogLimit: 1000 },
      expiresAt: new Date('2026-10-07T13:00:00.000Z'),
      createdAt: new Date('2026-09-30T13:00:00.000Z'),
    });
  });

  it('getExportStatus throws ExportExpiredError on 410 GONE', async () => {
    serve(410, errorFx('410_GONE'));
    const err = await getExportStatus('exp_1', KEY, API).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportExpiredError);
    expect(err).toBeInstanceOf(ExportError);
    expect(err).toMatchObject({
      statusCode: 410,
      code: 'GONE',
      requestId: 'req-7f45',
      message: 'Export has expired and its data was purged',
    });
  });
});
