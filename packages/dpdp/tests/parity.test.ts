/**
 * Client/server parity and legal-reference tests that are not tied to a single
 * response fixture: purpose mapping, client-side validation, status values,
 * error details, and the statutory references the package exports.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createConsentRecord,
  fileGrievance,
  updateGrievance,
  requestDpdpExport,
  getConsentRecord,
  checkPurposeCompliance,
  toWirePurpose,
  PurposeRegistry,
  ConsentRegistry,
  GRIEVANCE_TYPES,
  EU_AI_ACT_ARTICLES,
  REGION_IN,
  REGION_EU,
  calculateExpectedResolution,
  DpdpError,
  GrievanceError,
  ExportError,
} from '../src/index.js';
import type { DPDPConsentRecord, FileGrievanceParams, ComplianceExportRequest } from '../src/index.js';

const API = 'https://api.example.com';
const KEY = 'test-api-key';

const CREATED = {
  recordId: 'crec_1',
  grantId: 'grnt_1',
  dataPrincipalId: 'user_123',
  consentNoticeId: 'privacy-notice',
  consentNoticeVersion: '2.0',
  consentNoticeHash: 'aa',
  consentProof: {
    type: 'JWS-EdDSA',
    alg: 'EdDSA',
    kid: null,
    proofJwt: 'a.b.c',
    jwksUri: 'https://api.example.com/.well-known/jwks.json',
    signedAt: '2026-09-30T10:15:00.000Z',
  },
  processingExpiresAt: '2027-09-30T00:00:00.000Z',
  retentionUntil: '2027-10-30T00:00:00.000Z',
  status: 'active',
  createdAt: '2026-09-30T10:15:00.000Z',
};

function serve(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sentBody(fn: ReturnType<typeof serve>): string {
  return (fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('purpose wire shape', () => {
  it('toWirePurpose maps the local model to {code, description} and passes wire purposes through', () => {
    expect(
      toWirePurpose({
        purposeId: 'analytics',
        name: 'Analytics',
        description: 'Usage analytics',
        legalBasis: 'consent',
        dataCategories: ['usage'],
        retentionPeriod: '1 year',
        thirdPartySharing: true,
        thirdParties: ['Partner A'],
      }),
    ).toEqual({ code: 'analytics', description: 'Usage analytics' });
    expect(toWirePurpose({ code: 'x', description: 'y' })).toEqual({ code: 'x', description: 'y' });
  });

  it('PurposeRegistry.toWirePurpose returns the wire shape for a registered purpose', () => {
    const registry = new PurposeRegistry();
    registry.register({
      purposeId: 'email-access',
      name: 'Email Access',
      description: 'Read and send emails',
      requiredScopes: ['email:read'],
      legalBasis: 'consent',
      dataCategories: ['email'],
      retentionPeriod: '1 year',
      thirdPartySharing: false,
    });
    expect(registry.toWirePurpose('email-access')).toEqual({
      code: 'email-access',
      description: 'Read and send emails',
    });
    expect(registry.toWirePurpose('missing')).toBeUndefined();
  });

  it('checkPurposeCompliance accepts records decoded from the server ({code, description} purposes)', () => {
    const record: DPDPConsentRecord = {
      recordId: 'crec_1',
      grantId: 'grnt_1',
      dataPrincipalId: 'user_123',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      scopes: ['read:profile'],
      consentNoticeId: 'privacy-notice',
      status: 'active',
      consentGivenAt: new Date('2026-09-30T10:15:00.000Z'),
      processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
      retentionUntil: new Date('2027-10-30T00:00:00.000Z'),
      accessCount: 0,
    };
    expect(checkPurposeCompliance(record)).toEqual([]);
    expect(
      checkPurposeCompliance({ ...record, purposes: [{ code: '', description: '' }] }).length,
    ).toBeGreaterThan(0);
  });

  it('checkPurposeCompliance reports erased records as not active', () => {
    const errors = checkPurposeCompliance({
      status: 'erased',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
    });
    expect(errors).toContain('Consent record is erased, not active');
  });
});

describe('createConsentRecord local-only evidence', () => {
  it('keeps the IP hash, session and signature local: none of it is sent', async () => {
    const fn = serve(201, CREATED);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keyPair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as any;
    const created = await createConsentRecord({
      grantId: 'grnt_1',
      dataPrincipalId: 'user_123',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      consentNoticeId: 'privacy-notice',
      processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
      consentNoticeContent: 'Notice text',
      proofIpAddress: '192.0.2.10',
      proofUserAgent: 'Nimbus Shopper 2.4',
      proofSessionId: 'sess_1',
      signingKey: keyPair.privateKey,
      apiKey: KEY,
      baseUrl: API,
    });

    const body = sentBody(fn);
    expect(body).not.toContain('192.0.2.10');
    expect(body).not.toContain(createHash('sha256').update('192.0.2.10').digest('hex'));
    expect(body).not.toContain('sess_1');
    expect(body).not.toContain('consentProof');

    const ev = created.localEvidence!;
    expect(ev.ipAddressHash).toBe(createHash('sha256').update('192.0.2.10').digest('hex'));
    expect(ev.userAgent).toBe('Nimbus Shopper 2.4');
    expect(ev.sessionId).toBe('sess_1');
    expect(ev.consentNoticeHash).toBe(createHash('sha256').update('Notice text').digest('hex'));
    const valid = await crypto.subtle.verify(
      'Ed25519',
      keyPair.publicKey,
      Buffer.from(ev.signature!, 'base64'),
      new TextEncoder().encode(ev.signedPayload!),
    );
    expect(valid).toBe(true);
  });

  it('omits localEvidence when no local-only input is given', async () => {
    serve(201, CREATED);
    const created = await createConsentRecord({
      grantId: 'grnt_1',
      dataPrincipalId: 'user_123',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      consentNoticeId: 'privacy-notice',
      processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
      apiKey: KEY,
      baseUrl: API,
    });
    expect(created).not.toHaveProperty('localEvidence');
    expect(created.consentProof.kid).toBeNull();
  });

  it('rejects a purpose without code/purposeId or description before calling the server', async () => {
    const fn = serve(201, CREATED);
    await expect(
      createConsentRecord({
        grantId: 'grnt_1',
        dataPrincipalId: 'user_123',
        purposes: [{ code: 'analytics', description: '' }],
        consentNoticeId: 'privacy-notice',
        processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
        apiKey: KEY,
        baseUrl: API,
      }),
    ).rejects.toThrow('missing mandatory fields: description');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('grievance parity', () => {
  it('exports hyphenated grievance type constants', () => {
    expect(GRIEVANCE_TYPES.CONSENT_VIOLATION).toBe('consent-violation');
    expect(GRIEVANCE_TYPES.DATA_BREACH).toBe('data-breach');
    expect(GRIEVANCE_TYPES.UNAUTHORIZED_PROCESSING).toBe('unauthorized-processing');
  });

  it('accepts any type string, including the legacy underscore values, and no recordId', async () => {
    const fn = serve(202, {
      grievanceId: 'grv_1',
      referenceNumber: 'GRV-2026-X',
      type: 'unauthorized_processing',
      status: 'submitted',
      responsePeriodDays: 7,
      expectedResolutionBy: '2026-10-07T12:00:00.000Z',
      createdAt: '2026-09-30T12:00:00.000Z',
    });
    const legacy: FileGrievanceParams = {
      dataPrincipalId: 'user_123',
      type: 'unauthorized_processing',
      description: 'd',
    };
    const receipt = await fileGrievance(legacy, KEY, API);
    expect(JSON.parse(sentBody(fn))).toEqual({
      dataPrincipalId: 'user_123',
      type: 'unauthorized_processing',
      description: 'd',
    });
    expect(receipt.type).toBe('unauthorized_processing');
  });

  it.each([0, 91, 1.5])('rejects responsePeriodDays %s (must be an integer 1..90)', async (days) => {
    const fn = serve(202, {});
    await expect(
      fileGrievance(
        { dataPrincipalId: 'user_123', type: 'other', description: 'd', responsePeriodDays: days },
        KEY,
        API,
      ),
    ).rejects.toThrow(GrievanceError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a missing type before calling the server', async () => {
    const fn = serve(202, {});
    await expect(
      fileGrievance({ dataPrincipalId: 'user_123', type: '', description: 'd' }, KEY, API),
    ).rejects.toThrow('type is required');
    expect(fn).not.toHaveBeenCalled();
  });

  it('updateGrievance requires a resolution for resolved and rejected', async () => {
    const fn = serve(200, {});
    await expect(updateGrievance('grv_1', { status: 'resolved' }, KEY, API)).rejects.toThrow(
      'resolution is required',
    );
    await expect(updateGrievance('grv_1', { status: 'rejected', resolution: '' }, KEY, API)).rejects.toThrow(
      'resolution is required',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('calculateExpectedResolution uses the 7-day product default and accepts a published period', () => {
    const from = new Date('2026-04-01T00:00:00Z');
    expect(calculateExpectedResolution(from).toISOString()).toBe('2026-04-08T00:00:00.000Z');
    expect(calculateExpectedResolution(from, 30).toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('export parity', () => {
  it('rejects a non-json format before calling the server (only JSON is produced)', async () => {
    const fn = serve(201, {});
    const params = {
      dateFrom: new Date('2026-09-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-30T23:59:59.999Z'),
      format: 'csv',
    } as unknown as Omit<ComplianceExportRequest, 'type'>;
    await expect(requestDpdpExport(params, KEY, API)).rejects.toThrow(ExportError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('status values', () => {
  it('ConsentRegistry counts erased records', () => {
    const registry = new ConsentRegistry();
    const base: DPDPConsentRecord = {
      recordId: 'r1',
      grantId: 'g',
      dataPrincipalId: 'p',
      purposes: [{ code: 'analytics', description: 'd' }],
      scopes: [],
      consentNoticeId: 'n',
      status: 'erased',
      consentGivenAt: new Date('2026-01-01T00:00:00Z'),
      processingExpiresAt: new Date('2027-01-01T00:00:00Z'),
      retentionUntil: new Date('2028-01-01T00:00:00Z'),
      accessCount: 0,
    };
    registry.register(base);
    registry.register({ ...base, recordId: 'r2', status: 'active' });
    const stats = registry.getStats();
    expect(stats.erasedRecords).toBe(1);
    expect(stats.activeRecords).toBe(1);
    expect(stats.totalRecords).toBe(2);
  });
});

describe('errors', () => {
  it('keeps the fallback message and status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream timeout', { status: 502 })));
    const err = await getConsentRecord('crec_1', KEY, API).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DpdpError);
    expect(err).toMatchObject({ statusCode: 502, message: 'Failed to get consent record crec_1 (502)' });
    expect((err as DpdpError).requestId).toBeUndefined();
  });
});

describe('legal references', () => {
  it('EU AI Act Article 50 is transparency for certain AI systems, not GPAI', () => {
    const art50 = EU_AI_ACT_ARTICLES.find((a) => a.article === '50')!;
    expect(art50.title).toBe('Transparency Obligations for Providers and Deployers of Certain AI Systems');
    expect(art50.title).not.toMatch(/GPAI|general-purpose/i);
    expect(art50.description).not.toMatch(/^Transparency obligations for general-purpose AI/);
  });

  it('India is not a data-localisation regime (DPDP s.16)', () => {
    expect(REGION_IN.dataResidencyRequired).toBe(false);
  });

  it('GDPR regulates transfers (Chapter V) but does not require EU storage', () => {
    expect(REGION_EU.dataResidencyRequired).toBe(false);
  });

  it('India grievance period is the published period, at most 90 days (DPDP Rules 2025 r.14(3))', () => {
    expect(REGION_IN.grievanceResolutionDays).toBe(90);
  });

  it('EU child-consent age is 13 to 16 by member state (GDPR Art. 8)', () => {
    expect(REGION_EU.consentMinAgeRange).toEqual({ min: 13, max: 16 });
    expect(REGION_EU.consentMinAge).toBe(16);
    expect(REGION_IN.consentMinAgeRange).toEqual({ min: 18, max: 18 });
  });
});
