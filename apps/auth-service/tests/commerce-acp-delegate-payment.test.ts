/**
 * G35: the ACP delegate-payment allowance and risk-signal envelope derived
 * from a checkout Commerce Passport, validated against the saved ACP
 * 2026-04-17 delegate-payment schema; card data is refused, the cap is
 * enforced, passports are verified payment-affecting, every outcome is audited.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedPassport, VerifyPassportResult } from '../src/lib/commerce/passport.js';
import {
  AcpAllowanceError,
  assertNoCardData,
  deriveAcpDelegatePaymentEnvelope,
} from '../src/lib/commerce/acp-delegate-payment.js';
import { schemaErrors } from './protocol-schemas.js';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/commerce/passport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/commerce/passport.js')>()),
  verifyCommercePassport: verifyMock,
}));

const DP = 'https://example.com/schemas/delegate-payment/bundle.schema.json';
const TENANT = 'cten_ACPALLOW';
const SERVICE_TOKEN = 'agenticorg-acp-allowance-fixture-token';
const EXP = Math.floor(Date.parse('2026-10-20T10:10:00Z') / 1000);

function passport(overrides: Partial<VerifiedPassport> = {}): VerifiedPassport {
  return {
    jti: 'cpp_01EXAMPLE',
    kid: 'commerce-passport-20261001-abcdefgh',
    passportType: 'checkout',
    tenantId: TENANT,
    merchantId: 'mch_example',
    agentId: 'shopper-01',
    consentRecordId: 'ccr_01EXAMPLE',
    subject: 'buyer-principal-01',
    scopes: ['commerce:catalog.read', 'commerce:checkout.create', 'commerce:payment.initiate'],
    maxAmount: 250000,
    currency: 'INR',
    policyVersion: 'policy-7',
    environment: 'sandbox',
    issuedAt: EXP - 600,
    notBefore: EXP - 600,
    expiresAt: EXP,
    ...overrides,
  };
}

describe('deriveAcpDelegatePaymentEnvelope', () => {
  it('produces an ACP Allowance, RiskSignal[] and metadata map that validate against the saved schema', () => {
    const envelope = deriveAcpDelegatePaymentEnvelope(passport(), { checkout_session_id: 'csn_01EXAMPLE', amount: 199900, currency: 'inr' });
    expect(envelope.allowance).toEqual({
      reason: 'one_time',
      max_amount: 250000,
      currency: 'inr',
      checkout_session_id: 'csn_01EXAMPLE',
      merchant_id: 'mch_example',
      expires_at: '2026-10-20T10:10:00.000Z',
    });
    expect(schemaErrors('acp-2026-04-17', `${DP}#/$defs/Allowance`, envelope.allowance)).toEqual([]);
    expect(envelope.risk_signals).toEqual([]);
    for (const signal of envelope.risk_signals) expect(schemaErrors('acp-2026-04-17', `${DP}#/$defs/RiskSignal`, signal)).toEqual([]);
    expect(schemaErrors('acp-2026-04-17', `${DP}#/$defs/DelegatePaymentRequest/properties/metadata`, envelope.metadata)).toEqual([]);
    expect(envelope.authority.checks).toContain('amount_within_cap');
  });

  it('refuses a browse passport, a passport without payment.initiate or a cap, and amounts over the cap', () => {
    const cases: Array<[Partial<VerifiedPassport>, Record<string, unknown>, string]> = [
      [{ passportType: 'browse' }, {}, 'passport_not_checkout'],
      [{ scopes: ['commerce:checkout.create'] }, {}, 'passport_scope_missing'],
      [{ maxAmount: null }, {}, 'passport_cap_missing'],
      [{ currency: null }, {}, 'passport_cap_missing'],
      [{}, { amount: 250001 }, 'allowance_exceeds_passport_cap'],
      [{}, { amount: -1 }, 'invalid_amount'],
      [{}, { amount: 1.5 }, 'invalid_amount'],
      [{}, { currency: 'usd' }, 'currency_mismatch'],
      [{}, { checkout_session_id: 'has space' }, 'invalid_checkout_session_id'],
    ];
    for (const [over, request, code] of cases) {
      expect(() => deriveAcpDelegatePaymentEnvelope(passport(over), { checkout_session_id: 'csn_01', ...request } as never))
        .toThrow(expect.objectContaining({ code }) as unknown as Error);
    }
  });

  it('allows exactly the cap', () => {
    expect(deriveAcpDelegatePaymentEnvelope(passport(), { checkout_session_id: 'csn_01', amount: 250000 }).allowance.max_amount).toBe(250000);
  });

  it('refuses payment-method data at any depth', () => {
    for (const body of [{ payment_method: {} }, { nested: { Number: 'x' } }, { list: [{ cvc: 'x' }] }, { billing_address: {} }]) {
      expect(() => assertNoCardData(body)).toThrow(AcpAllowanceError);
    }
    expect(() => assertNoCardData({ checkout_session_id: 'csn_01', amount: 1 })).not.toThrow();
  });
});

describe('POST /v1/commerce/oacp/acp/delegate-payment-allowance', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('INSERT INTO commerce_audit_events')) return Promise.resolve([{ id: 'caud_01', occurred_at: new Date().toISOString() }]);
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    verifyMock.mockReset();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  const post = (payload: Record<string, unknown>, token = SERVICE_TOKEN) => app.inject({
    method: 'POST',
    url: '/v1/commerce/oacp/acp/delegate-payment-allowance',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  const body = (extra: Record<string, unknown> = {}) => ({
    tenant_id: TENANT, passport_jwt: 'eyJhbGciOiJFUzI1NiJ9.e30.sig', checkout_session_id: 'csn_01EXAMPLE', ...extra,
  });
  const auditRows = () => sqlMock.mock.calls.filter(([strings]) => String((strings as string[]).join('?')).includes('INSERT INTO commerce_audit_events'));

  it('returns the envelope after verifying the passport payment-affecting, and audits it', async () => {
    verifyMock.mockResolvedValue({ ok: true, passport: passport() } satisfies VerifyPassportResult);
    const res = await post(body({ merchant_id: 'mch_example', amount: 1000 }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const json = res.json<{ allowance: unknown; risk_signals: unknown[]; audit_event_id: string }>();
    expect(schemaErrors('acp-2026-04-17', `${DP}#/$defs/Allowance`, json.allowance)).toEqual([]);
    expect(json.audit_event_id).toBe('caud_01');
    expect(verifyMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'eyJhbGciOiJFUzI1NiJ9.e30.sig', {
      mode: 'payment_affecting', expectedTenantId: TENANT, expectedMerchantId: 'mch_example',
    });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('acp.delegate_payment_allowance.issued');
    expect(JSON.stringify(res.json())).not.toContain('eyJhbGciOiJFUzI1NiJ9');
  });

  it('refuses card data before anything else, without verifying or auditing', async () => {
    const res = await post(body({ payment_method: { type: 'card' } }));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('card_data_refused');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('maps passport failures and fails closed when revocation state is unavailable', async () => {
    for (const [error, status, code] of [
      [{ kind: 'revoked' }, 403, 'passport_revoked'],
      [{ kind: 'revocation_unavailable', error: 'redis down' }, 503, 'revocation_unavailable'],
      [{ kind: 'merchant_mismatch', expected: 'a', actual: 'b' }, 403, 'passport_merchant_mismatch'],
      [{ kind: 'expired' }, 400, 'passport_invalid'],
    ] as const) {
      verifyMock.mockResolvedValueOnce({ ok: false, error });
      const res = await post(body());
      expect(res.statusCode).toBe(status);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(code);
    }
    expect(auditRows()).toHaveLength(4);
    for (const row of auditRows()) expect(row).toContain('acp.delegate_payment_allowance.refused');
  });

  it('audits and refuses an amount over the cap', async () => {
    verifyMock.mockResolvedValue({ ok: true, passport: passport() });
    const res = await post(body({ amount: 999999 }));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('allowance_exceeds_passport_cap');
    expect(auditRows()[0]).toContain('acp.delegate_payment_allowance.refused');
  });

  it('refuses unknown members, another tenant and a developer key outside the tenant', async () => {
    expect((await post(body({ extra: 1 }))).statusCode).toBe(422);
    expect((await post(body({ tenant_id: 'cten_OTHER' }))).statusCode).toBe(403);
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ tenant_id: 'cten_DEV', status: 'active', role: 'owner' }]);
    const dev = await app.inject({
      method: 'POST', url: '/v1/commerce/oacp/acp/delegate-payment-allowance', headers: authHeader(), payload: body(),
    });
    expect(dev.statusCode).toBe(403);
    expect(verifyMock).not.toHaveBeenCalled();
  });
});
