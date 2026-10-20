// SPDX-License-Identifier: Apache-2.0
/**
 * OACP mandates against real Postgres, through the routes (G41, G44, G45,
 * G46): Intent -> Cart -> Payment issued as ES256 JWTs by the DB-backed OACP
 * issuer key, each on the OACP Token Status List and verified the way a
 * relying party does (public JWKS + public status list); every refusal named
 * in the contract (passport cap, consent not active, chain mismatch, human
 * present without passkey, expired / revoked parent) recorded without a
 * token; a human-present cart issued only with a WebAuthn assertion whose
 * challenge is its checkout_hash; revocation cascading to descendants.
 */
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { resetOacpIssuerKeyCache } from '../src/lib/commerce/oacp-issuer-keys.js';
import { resetOacpStatusCache } from '../src/lib/commerce/oacp-status.js';
import { signCommercePassport, newCommercePassportJti } from '../src/lib/commerce/passport.js';
import { _resetCommercePassportKeyCacheForTests } from '../src/lib/commerce/passport-keys.js';
import { verifyOacpMandate, oacpCheckoutHash, oacpMandateChainRefusal, type OacpMandateStatusValue } from '../src/lib/commerce/oacp-mandate-jwt.js';
import { decodeTokenStatusList } from '../src/lib/registry/status-list-codec.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres OACP mandate tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const SERVICE_TOKEN = 'agenticorg-oacp-mandate-fixture-service-key';
const TENANT = 'cten_MANDATEINT';
const MERCHANT = 'mch_MANDATEINT';
const AGENT = 'cag_MANDATEINT';
const BUYER = 'buyer_principal_mandate_01';
const DEVELOPER = 'dev_MANDATEINT';
type Sql = ReturnType<typeof postgres>;

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
const savedFlag = process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'];
const service = { authorization: `Bearer ${SERVICE_TOKEN}` };

let consentSeq = 0;
const AGENT_JWK = (() => {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
})();

async function consent(opts: { status?: string | undefined; presence?: 'human_present' | 'human_not_present' | undefined } = {}): Promise<string> {
  consentSeq += 1;
  const id = `crec_MANDATE${String(consentSeq).padStart(4, '0')}`;
  await sql`
    INSERT INTO commerce_consent_records (
      id, tenant_id, merchant_id, agent_id, consent_request_id, passport_type, requested_scopes,
      approved_scopes, max_amount, currency, consent_text_version, status, user_principal_id,
      approved_at, expires_at, presence, amr
    ) VALUES (
      ${id}, ${TENANT}, ${MERCHANT}, ${AGENT}, ${`req_${id}`}, 'checkout',
      ${['commerce:checkout.create', 'commerce:payment.initiate']}, ${['commerce:checkout.create', 'commerce:payment.initiate']},
      ${100000}, 'INR', '2026-05-01', ${opts.status ?? 'granted'}, ${BUYER}, NOW(), NOW() + interval '10 minutes',
      ${opts.presence ?? 'human_not_present'}, ${['consent', 'otp']}
    )
  `;
  return id;
}

async function passport(opts: { presence?: 'human_present' | 'human_not_present'; consentStatus?: string; maxAmount?: number; ttl?: number } = {}): Promise<string> {
  const consentId = await consent({ status: opts.consentStatus, presence: opts.presence });
  const now = Math.floor(Date.now() / 1000);
  const { jwt } = await signCommercePassport(sql, {
    jti: newCommercePassportJti(), passportType: 'checkout', tenantId: TENANT, merchantId: MERCHANT, agentId: AGENT,
    consentRecordId: consentId, subject: BUYER, scopes: ['commerce:checkout.create', 'commerce:payment.initiate'],
    maxAmount: opts.maxAmount ?? 100000, currency: 'INR', presence: opts.presence ?? 'human_not_present', amr: ['consent', 'otp'],
    environment: 'sandbox', issuedAt: now, notBefore: now, expiresAt: now + (opts.ttl ?? 600),
  });
  return jwt;
}

function checkout(total = 45000, id = 'chk_MANDATE_001') {
  return {
    id,
    status: 'ready_for_complete',
    currency: 'INR',
    merchant: { id: MERCHANT, name: 'Synthetic Store' },
    line_items: [
      { id: 'li_1', item: { id: 'sku_kettle', title: 'Kettle', price: 30000 }, quantity: 1, totals: [{ type: 'total', amount: 30000 }] },
      { id: 'li_2', item: { id: 'sku_mug', title: 'Mug', price: 7500 }, quantity: 2, totals: [{ type: 'total', amount: 15000 }] },
    ],
    totals: [{ type: 'subtotal', amount: total }, { type: 'total', amount: total }],
    links: [{ type: 'terms_of_service', url: 'https://merchant.example/terms' }],
  };
}

async function post(path: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${path}`, headers: service, payload });
}

async function intent(passportJwt: string, extra: Record<string, unknown> = {}) {
  const res = await post('intent', {
    tenant_id: TENANT, passport_jwt: passportJwt, description: 'Buy a kettle and two mugs under 1000 rupees',
    max_amount: { value: 80000, currency: 'INR' }, ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ mandate: string; jti: string; mandate_hash: string; claims: Record<string, any> }>();
}

async function jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
  const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function statusOf(claims: Record<string, any>): Promise<OacpMandateStatusValue> {
  const { uri, idx } = claims['status']['status_list'] as { uri: string; idx: number };
  const res = await app.inject({ method: 'GET', url: new URL(uri).pathname });
  if (res.statusCode !== 200) return 'unavailable';
  const { payload } = await jwtVerify(res.body, createLocalJWKSet((await jwks()) as never), { typ: 'statuslist+jwt' });
  expect(payload.sub).toBe(uri);
  return decodeTokenStatusList(payload['status_list'] as { bits: number; lst: string }).statusAt(idx);
}

/** What AgenticOrg does: verify against the public JWKS and the public status list. */
async function relyingPartyVerify(mandate: string, claims: Record<string, any>, type: 'intent' | 'cart' | 'payment') {
  return verifyOacpMandate({
    mandate, jwks: await jwks(), issuer: 'https://grantex.dev', now_seconds: Math.floor(Date.now() / 1000),
    status: await statusOf(claims), expected_type: type, expected_audience: MERCHANT,
  });
}

async function refusalRows(code: string) {
  return sql<Array<Record<string, unknown>>>`SELECT jti, status, jwt, status_list_uri FROM oacp_mandates WHERE refusal_code = ${code}`;
}

// --- WebAuthn: a synthetic platform passkey registered for the buyer ---------
const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const CREDENTIAL_ID = Buffer.from('synthetic-passkey-credential-01').toString('base64url');
let signCount = 0;

function cosePublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x as string, 'base64url');
  const y = Buffer.from(jwk.y as string, 'base64url');
  // CBOR map {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} (RFC 9053 §7.1.1)
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ]).toString('base64url');
}

function assertion(challenge: string, opts: { userVerified?: boolean; key?: KeyObject; origin?: string } = {}) {
  signCount += 1;
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: 'webauthn.get', challenge, origin: opts.origin ?? 'https://grantex.dev', crossOrigin: false,
  }));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  const authenticatorData = Buffer.concat([
    createHash('sha256').update('grantex.dev').digest(),
    Buffer.from([opts.userVerified === false ? 0x01 : 0x05]),
    counter,
  ]);
  const signature = cryptoSign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), opts.key ?? passkey.privateKey);
  return {
    id: CREDENTIAL_ID, rawId: CREDENTIAL_ID, type: 'public-key',
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authenticatorData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
    clientExtensionResults: {},
  };
}

describePostgres('OACP mandates against Postgres', () => {
  beforeAll(async () => {
    const db = await createTestDatabase('oacp-mandates');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    await sql`INSERT INTO developers (id, api_key_hash, name, mode) VALUES (${DEVELOPER}, ${'m'.repeat(64)}, 'Mandate developer', 'sandbox')`;
    await sql`INSERT INTO commerce_tenants (id, display_name) VALUES (${TENANT}, 'Mandate tenant')`;
    await sql`INSERT INTO commerce_developer_tenants (developer_id, tenant_id) VALUES (${DEVELOPER}, ${TENANT})`;
    const [preset] = await sql`SELECT preset_key FROM commerce_category_presets ORDER BY preset_key LIMIT 1`;
    await sql`
      INSERT INTO commerce_merchants (id, tenant_id, legal_name, display_name, category_preset)
      VALUES (${MERCHANT}, ${TENANT}, 'Synthetic Store Pvt Ltd', 'Synthetic Store', ${preset!['preset_key'] as string})
    `;
    await sql`
      INSERT INTO commerce_agents (id, tenant_id, display_name, public_key_jwk, trust_status)
      VALUES (${AGENT}, ${TENANT}, 'shopper-01', ${sql.json(AGENT_JWK as never)}, 'trusted')
    `;
    await sql`
      INSERT INTO webauthn_credentials (id, principal_id, developer_id, credential_id, public_key, counter)
      VALUES ('wcred_MANDATE', ${BUYER}, ${DEVELOPER}, ${CREDENTIAL_ID}, ${cosePublicKey(passkey.publicKey)}, 0)
    `;
    process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'] = 'true';
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'];
    else process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'] = savedFlag;
    await app?.close();
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await dropTestDatabase?.();
  }, 60_000);

  beforeEach(() => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
    vi.stubEnv('OACP_AUTO_GENERATE_ISSUER_KEY', 'true');
    vi.stubEnv('COMMERCE_AUTO_GENERATE_PASSPORT_KEY', 'true');
    resetOacpIssuerKeyCache();
    resetOacpStatusCache();
    _resetCommercePassportKeyCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('issues Intent -> Cart -> Payment mandates that verify through the public JWKS and status list', async () => {
    const pp = await passport();
    const i = await intent(pp);
    expect(i.claims['intent']['constraints']).toEqual([
      { type: 'checkout.allowed_merchants', allowed: [{ id: MERCHANT }] },
      { type: 'payment.amount_range', currency: 'INR', max: 80000 },
    ]);
    expect(i.claims['presence']).toBe('human_not_present');
    expect(i.claims['amr']).toEqual(['consent', 'otp']);
    // AP2 open-mandate key binding: the buyer agent's registered key.
    expect(i.claims['cnf']).toEqual({ jwk: AGENT_JWK });

    const c = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout() });
    expect(c.statusCode, c.body).toBe(201);
    const cart = c.json<{ mandate: string; jti: string; claims: Record<string, any> }>();
    expect(cart.claims['cart']['checkout_hash']).toBe(oacpCheckoutHash(checkout()));
    expect(cart.claims['cart']['total']).toEqual({ value: 45000, currency: 'INR' });
    expect(cart.claims['intent_mandate_jti']).toBe(i.jti);
    expect(cart.claims['webauthn']).toBeUndefined();

    const p = await post('payment', {
      tenant_id: TENANT, passport_jwt: pp, cart_mandate: cart.mandate, rail: 'plural',
      token_binding: { type: 'network_token', id: 'tokref_synthetic_001' },
    });
    expect(p.statusCode, p.body).toBe(201);
    const payment = p.json<{ mandate: string; jti: string; mandate_hash: string; claims: Record<string, any> }>();
    expect(payment.claims['payment']).toMatchObject({
      transaction_id: cart.claims['cart']['checkout_hash'], amount: 45000, currency: 'INR', rail: 'plural', cart_mandate_jti: cart.jti,
    });
    expect(payment.mandate_hash).toBe(createHash('sha256').update(payment.mandate).digest('hex'));

    const header = JSON.parse(Buffer.from(payment.mandate.split('.')[0]!, 'base64url').toString()) as Record<string, string>;
    expect(header).toEqual({ alg: 'ES256', kid: expect.stringMatching(/^oacp-\d{8}-[0-9a-f]{16}$/), typ: 'oacp-payment-mandate+jwt' });
    expect((await jwks()).keys.filter((k) => k['kid'] === header['kid'])).toHaveLength(1);

    for (const [m, type] of [[i, 'intent'], [cart, 'cart'], [payment, 'payment']] as const) {
      expect(await relyingPartyVerify(m.mandate, m.claims, type)).toMatchObject({ valid: true, refusal_code: null });
    }
    expect(oacpMandateChainRefusal({ intent: i.claims as never, cart: cart.claims as never, payment: payment.claims as never })).toBeNull();

    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT m.jti, m.status, m.jwt_sha256, m.parent_jti, e.status AS entry_status
        FROM oacp_mandates m JOIN oacp_status_entries e ON e.artifact_id = m.jti
       WHERE m.jti = ANY(${[i.jti, cart.jti, payment.jti]}) ORDER BY m.created_at`;
    expect(rows.map((r) => [r['status'], r['parent_jti'], r['entry_status']])).toEqual([
      ['issued', null, 0], ['issued', i.jti, 0], ['issued', cart.jti, 0],
    ]);

    // Each issuance wrote its commerce audit event in the issuing transaction.
    const audits = await sql<Array<Record<string, unknown>>>`
      SELECT id, resource_id, event_type, passport_jti FROM commerce_audit_events
       WHERE resource_type = 'oacp_mandate' AND resource_id = ANY(${[i.jti, cart.jti, payment.jti]}) ORDER BY occurred_at`;
    expect(audits.map((a) => [a['event_type'], a['resource_id']])).toEqual([
      ['oacp.mandate.issued', i.jti], ['oacp.mandate.issued', cart.jti], ['oacp.mandate.issued', payment.jti],
    ]);
    expect(p.json<{ audit_event_id: string }>().audit_event_id).toBe(audits[2]!['id']);

    // The verification endpoint answers the same.
    const v = await post('verify', { tenant_id: TENANT, mandate: payment.mandate, expected_type: 'payment', expected_merchant_id: MERCHANT });
    expect(v.json()).toMatchObject({ valid: true, refusal_code: null, mandate_type: 'payment', mandate_hash: payment.mandate_hash });
  });

  it('refuses a mandate above the passport cap and records the refusal without a token', async () => {
    const pp = await passport({ maxAmount: 50000 });
    const res = await post('intent', {
      tenant_id: TENANT, passport_jwt: pp, description: 'Too much', max_amount: { value: 50001, currency: 'INR' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { code: string; details: { refusal_record_id: string } } }>();
    expect(body.error.code).toBe('passport_cap_exceeded');
    const [row] = await sql`SELECT status, jwt, status_list_uri, refusal_code FROM oacp_mandates WHERE jti = ${body.error.details.refusal_record_id}`;
    expect(row).toMatchObject({ status: 'refused', jwt: null, status_list_uri: null, refusal_code: 'passport_cap_exceeded' });
    const audit = await sql`SELECT event_type, tenant_id FROM commerce_audit_events WHERE resource_id = ${body.error.details.refusal_record_id}`;
    expect(audit).toEqual([{ event_type: 'oacp.mandate.refused', tenant_id: TENANT }]);
    expect(res.json<{ error: { audit_event_id: string } }>().error.audit_event_id).toMatch(/^caud_/);
  });

  it('refuses when the consent behind the passport is not active', async () => {
    const pp = await passport({ consentStatus: 'expired' });
    const res = await post('intent', { tenant_id: TENANT, passport_jwt: pp, description: 'x', max_amount: { value: 100, currency: 'INR' } });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('consent_not_active');
    expect(await refusalRows('consent_not_active')).toHaveLength(1);
  });

  it('refuses a cart above its intent cap and a cart under another consent (chain mismatch)', async () => {
    const pp = await passport();
    const i = await intent(pp, { max_amount: { value: 40000, currency: 'INR' } });
    const over = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout(45000) });
    expect(over.json<{ error: { code: string } }>().error.code).toBe('intent_cap_exceeded');

    const otherPassport = await passport();
    const mismatch = await post('cart', { tenant_id: TENANT, passport_jwt: otherPassport, intent_mandate: i.mandate, checkout: checkout(30000) });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json<{ error: { code: string } }>().error.code).toBe('mandate_chain_mismatch');
  });

  it('refuses a human_not_present mandate under a human_present consent, and a human_present cart without a passkey', async () => {
    const pp = await passport({ presence: 'human_present' });
    const loose = await post('intent', {
      tenant_id: TENANT, passport_jwt: pp, description: 'x', max_amount: { value: 100, currency: 'INR' }, presence: 'human_not_present',
    });
    expect(loose.json<{ error: { code: string } }>().error.code).toBe('presence_mismatch');

    const i = await intent(pp);
    expect(i.claims['presence']).toBe('human_present');
    const res = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout() });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('passkey_evidence_required');
    expect(await sql`SELECT 1 FROM oacp_mandates WHERE mandate_type = 'cart' AND presence = 'human_present' AND status = 'issued'`).toHaveLength(0);
  });

  it('issues a human_present cart only with a passkey assertion over its checkout_hash (G45)', async () => {
    const pp = await passport({ presence: 'human_present' });
    const i = await intent(pp);
    const hash = oacpCheckoutHash(checkout());

    // An assertion over another challenge (a different cart) is refused.
    const wrong = await post('cart', {
      tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout(),
      webauthn_assertion: assertion(oacpCheckoutHash(checkout(44000))),
    });
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('passkey_evidence_invalid');

    // Without user verification, or signed by another key: refused.
    const noUv = await post('cart', {
      tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout(), webauthn_assertion: assertion(hash, { userVerified: false }),
    });
    expect(noUv.json<{ error: { code: string } }>().error.code).toBe('passkey_evidence_invalid');
    const impostor = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const forged = await post('cart', {
      tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout(), webauthn_assertion: assertion(hash, { key: impostor.privateKey }),
    });
    expect(forged.json<{ error: { code: string } }>().error.code).toBe('passkey_evidence_invalid');

    const proof = assertion(hash);
    const ok = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout(), webauthn_assertion: proof });
    expect(ok.statusCode, ok.body).toBe(201);
    const cart = ok.json<{ mandate: string; jti: string; claims: Record<string, any> }>();
    expect(cart.claims['presence']).toBe('human_present');
    expect(cart.claims['amr']).toEqual(['consent', 'otp', 'passkey']);
    expect(cart.claims['webauthn']).toMatchObject({ challenge: hash, rp_id: 'grantex.dev', origin: 'https://grantex.dev', user_verified: true });
    expect(await relyingPartyVerify(cart.mandate, cart.claims, 'cart')).toMatchObject({ valid: true });
    const [row] = await sql`SELECT webauthn_evidence FROM oacp_mandates WHERE jti = ${cart.jti}`;
    expect((row!['webauthn_evidence'] as Record<string, unknown>)['challenge']).toBe(hash);
    expect((row!['webauthn_evidence'] as Record<string, unknown>)['digest']).toBe(cart.claims['webauthn']['digest']);

    // The same assertion cannot back a second mandate.
    const replay = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout(), webauthn_assertion: proof });
    expect(replay.statusCode).toBe(403);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('passkey_evidence_replayed');

    // The payment mandate inherits human_present.
    const p = await post('payment', {
      tenant_id: TENANT, passport_jwt: pp, cart_mandate: cart.mandate, rail: 'upi_autopay', token_binding: { type: 'upi_mandate', id: 'upimref_synthetic_01' },
    });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json<{ claims: Record<string, any> }>().claims['presence']).toBe('human_present');
  });

  it('refuses card data in a token binding and an unknown rail', async () => {
    const pp = await passport();
    const i = await intent(pp);
    const cart = (await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout() })).json<{ mandate: string }>();
    const card = await post('payment', { tenant_id: TENANT, passport_jwt: pp, cart_mandate: cart.mandate, rail: 'plural', token_binding: { type: 'card', id: 'x', card_number: '4111111111111111' } });
    expect(card.json<{ error: { code: string } }>().error.code).toBe('card_data_refused');
    const rail = await post('payment', { tenant_id: TENANT, passport_jwt: pp, cart_mandate: cart.mandate, rail: 'wire', token_binding: { type: 'network_token', id: 'tok_1' } });
    expect(rail.json<{ error: { code: string } }>().error.code).toBe('payment_rail_unsupported');
  });

  it('revokes a mandate and its descendants through the status list (G46), idempotently', async () => {
    const pp = await passport();
    const i = await intent(pp);
    const cart = (await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout() })).json<{ mandate: string; jti: string; claims: Record<string, any> }>();

    const revoke = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/revoke`, headers: service, payload: { reason_code: 'buyer_withdrew' } });
    expect(revoke.statusCode, revoke.body).toBe(201);
    expect(revoke.json()).toMatchObject({ jti: i.jti, status: 'revoked', revocation_reason: 'buyer_withdrew', already_revoked: false });
    expect(revoke.json<{ revoked_jtis: string[] }>().revoked_jtis.sort()).toEqual([i.jti, cart.jti].sort());
    const revokedAudits = await sql`
      SELECT resource_id FROM commerce_audit_events WHERE event_type = 'oacp.mandate.revoked' AND resource_id = ANY(${[i.jti, cart.jti]})`;
    expect(revokedAudits).toHaveLength(2);

    resetOacpStatusCache();
    expect(await relyingPartyVerify(i.mandate, i.claims, 'intent')).toMatchObject({ valid: false, refusal_code: 'mandate_revoked' });
    expect(await relyingPartyVerify(cart.mandate, cart.claims, 'cart')).toMatchObject({ valid: false, refusal_code: 'mandate_revoked' });
    const v = await post('verify', { tenant_id: TENANT, mandate: cart.mandate });
    expect(v.json()).toMatchObject({ valid: false, refusal_code: 'mandate_revoked' });

    // A revoked parent cannot back a new mandate.
    const after = await post('payment', { tenant_id: TENANT, passport_jwt: pp, cart_mandate: cart.mandate, rail: 'plural', token_binding: { type: 'network_token', id: 'tok_2' } });
    expect(after.statusCode).toBe(403);
    expect(after.json<{ error: { code: string } }>().error.code).toBe('parent_mandate_revoked');

    const again = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/revoke`, headers: service, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ already_revoked: true, revocation_reason: 'buyer_withdrew', revoked_jtis: [] });

    const refused = (await refusalRows('parent_mandate_revoked'))[0]!;
    const notRevocable = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${refused['jti'] as string}/revoke`, headers: service, payload: {} });
    expect(notRevocable.statusCode).toBe(409);
  });

  it('suspends and reinstates a mandate through the status list (status 2), platform admin or service scope only', async () => {
    const pp = await passport();
    const i = await intent(pp);
    const suspend = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/suspend`, headers: service, payload: { reason_code: 'risk_review' } });
    expect(suspend.statusCode, suspend.body).toBe(201);
    expect(suspend.json()).toMatchObject({ jti: i.jti, suspended: true, suspension_reason: 'risk_review', changed: true });
    resetOacpStatusCache();
    expect(await relyingPartyVerify(i.mandate, i.claims, 'intent')).toMatchObject({ valid: false, refusal_code: 'mandate_suspended' });
    expect((await post('verify', { tenant_id: TENANT, mandate: i.mandate })).json()).toMatchObject({ refusal_code: 'mandate_suspended' });

    // Nothing is issued under a suspended parent.
    const cart = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout() });
    expect(cart.statusCode).toBe(403);
    expect(cart.json<{ error: { code: string } }>().error.code).toBe('parent_mandate_suspended');

    // Idempotent.
    const again = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/suspend`, headers: service, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ suspended: true, changed: false });

    const reinstate = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/reinstate`, headers: { authorization: `Bearer ${TEST_ADMIN_API_KEY}` }, payload: {} });
    expect(reinstate.statusCode, reinstate.body).toBe(201);
    expect(reinstate.json()).toMatchObject({ suspended: false, suspended_at: null, changed: true });
    resetOacpStatusCache();
    expect(await relyingPartyVerify(i.mandate, i.claims, 'intent')).toMatchObject({ valid: true });

    const events = await sql`SELECT event_type FROM commerce_audit_events WHERE resource_id = ${i.jti} ORDER BY occurred_at`;
    expect(events.map((e) => e['event_type'])).toEqual(['oacp.mandate.issued', 'oacp.mandate.suspended', 'oacp.mandate.reinstated']);

    // A suspended mandate can still be revoked (final), and a revoked one cannot be suspended.
    await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/suspend`, headers: service, payload: {} });
    const revoke = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/revoke`, headers: service, payload: {} });
    expect(revoke.statusCode).toBe(201);
    resetOacpStatusCache();
    expect(await relyingPartyVerify(i.mandate, i.claims, 'intent')).toMatchObject({ refusal_code: 'mandate_revoked' });
    const late = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/mandates/${i.jti}/reinstate`, headers: service, payload: {} });
    expect(late.statusCode).toBe(409);
  });

  it('refuses a cart under an expired intent', async () => {
    const pp = await passport();
    const i = await intent(pp, { expires_at: new Date(Date.now() + 2_000).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    const res = await post('cart', { tenant_id: TENANT, passport_jwt: pp, intent_mandate: i.mandate, checkout: checkout() });
    expect(res.json<{ error: { code: string } }>().error.code).toBe('parent_mandate_expired');
  });

  it('scopes the service token per route and tenant, and keeps retired keys published while mandates live', async () => {
    const other = await post('intent', { tenant_id: 'cten_OTHER', passport_jwt: 'x'.repeat(40), description: 'x', max_amount: { value: 1, currency: 'INR' } });
    expect(other.statusCode).toBe(403);
    const pp = await passport();
    const i = await intent(pp);
    const kid = JSON.parse(Buffer.from(i.mandate.split('.')[0]!, 'base64url').toString())['kid'] as string;
    await sql`UPDATE oacp_issuer_keys SET status = 'retired', retired_at = NOW() - interval '1 hour' WHERE kid = ${kid}`;
    expect((await jwks()).keys.some((k) => k['kid'] === kid)).toBe(true);
    await sql`UPDATE oacp_mandates SET expires_at = NOW() - interval '1 hour', issued_at = NOW() - interval '2 hours' WHERE issuer_key_id = ${kid}`;
    await sql`UPDATE oacp_artifacts SET expires_at = NOW() - interval '1 hour' WHERE issuer_key_id = ${kid}`;
    expect((await jwks()).keys.some((k) => k['kid'] === kid)).toBe(false);
  });
});
