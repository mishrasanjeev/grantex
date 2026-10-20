// SPDX-License-Identifier: Apache-2.0
/**
 * OACP mandates: issuance, persistence, verification and revocation (G41,
 * G45, G46). The JWT profile itself (claims, signer, verifier, refusal codes)
 * is in oacp-mandate-jwt.ts.
 *
 * Every issuance starts from a checkout Commerce Passport verified in
 * payment-affecting mode (signature, expiry, tenant, online revocation) and
 * the consent behind it, and refuses:
 *
 *   passport_invalid / passport_revoked      the passport does not verify
 *   passport_not_checkout / passport_scope_missing / passport_cap_missing
 *   consent_not_active                       the consent is not `granted`
 *   passport_cap_exceeded                    amount above the passport cap
 *   currency_mismatch                        currency other than the passport's
 *   merchant_not_allowed                     a merchant the passport does not name
 *   presence_mismatch                        `human_not_present` under a
 *                                            `human_present` consent or parent
 *   parent_mandate_expired / parent_mandate_revoked / parent_mandate_invalid
 *   mandate_chain_mismatch                   the parent belongs to another buyer,
 *                                            consent, merchant or agent
 *   intent_cap_exceeded                      a cart above its intent's cap
 *   passkey_evidence_required                a `human_present` cart without a
 *                                            WebAuthn assertion (G45)
 *   passkey_evidence_invalid / passkey_evidence_replayed
 *   checkout_invalid / card_data_refused / payment_rail_unsupported /
 *   token_binding_invalid / intent_invalid
 *
 * Each refusal is recorded (status `refused`, no token). An issued mandate is
 * signed by the active OACP issuer key inside the transaction that allocates
 * its Token Status List entry and writes its row.
 *
 * G45, a Grantex extension: a `human_present` cart mandate is issued only with
 * a WebAuthn assertion, by one of the buyer's registered passkeys, whose
 * challenge is the cart's AP2 `checkout_hash`. The assertion is kept as a
 * `GrantexWebAuthnAssertion` (lib/webauthn-evidence.ts) and named in the
 * mandate's `webauthn` claim. AP2 and Verifiable Intent define no passkey
 * binding (Verifiable Intent credentials are not WebAuthn credentials); this
 * anchors the cart to a user-verified ceremony over exactly that cart.
 */
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { queries, type TxSql } from '../../db/client.js';
import { newOacpMandateJti, newOacpMandateRefusalId } from './ids.js';
import { verifyCommercePassport, type VerifiedPassport } from './passport.js';
import { findConsentById, isPresenceMode, type PresenceMode } from './consent.js';
import { getActiveOacpSigner, listOacpIssuerJwksKeys } from './oacp-issuer-keys.js';
import { allocateOacpStatusEntry, assertOacpStatusBaseUsable, readOacpStatus, setOacpStatus } from './oacp-status.js';
import { canonicalizeOacpPayload } from './oacp-trust-artifacts.js';
import { AcpAllowanceError, assertNoCardData, PAYMENT_INITIATE_SCOPE } from './acp-delegate-payment.js';
import {
  OACP_MANDATE_MAX_LIFETIME_SECONDS,
  OACP_MANDATE_VERSION,
  OACP_PAYMENT_RAILS,
  oacpCheckoutHash,
  oacpMandateHash,
  oacpMandateStatusRefusal,
  sha256b64url,
  signOacpMandate,
  verifyOacpMandateSignatureAndClaims,
  type OacpCartClaims,
  type OacpCartWebAuthnRef,
  type OacpIntentClaims,
  type OacpMandateClaims,
  type OacpMandateCommonClaims,
  type OacpMandateType,
  type OacpMandateVerification,
  type OacpPaymentClaims,
  type OacpPaymentRail,
} from './oacp-mandate-jwt.js';
import { appendCommerceAudit } from './audit.js';
import { createWebAuthnEvidence, verifyPortableWebAuthnEvidence, type WebAuthnAssertionEvidence } from '../webauthn-evidence.js';

type Sql = ReturnType<typeof postgres>;

export type OacpMandateIssueRefusalCode =
  | 'passport_invalid'
  | 'passport_revoked'
  | 'passport_not_checkout'
  | 'passport_scope_missing'
  | 'passport_cap_missing'
  | 'consent_not_active'
  | 'passport_cap_exceeded'
  | 'currency_mismatch'
  | 'merchant_not_allowed'
  | 'presence_mismatch'
  | 'parent_mandate_expired'
  | 'parent_mandate_revoked'
  | 'parent_mandate_suspended'
  | 'parent_mandate_invalid'
  | 'mandate_chain_mismatch'
  | 'intent_cap_exceeded'
  | 'intent_invalid'
  | 'passkey_evidence_required'
  | 'passkey_evidence_invalid'
  | 'passkey_evidence_replayed'
  | 'checkout_invalid'
  | 'card_data_refused'
  | 'payment_rail_unsupported'
  | 'token_binding_invalid';

/** A refused issuance: HTTP status, code, and the refusal record id once written. */
export class OacpMandateRefusal extends Error {
  refusalRecordId: string | null = null;
  auditEventId: string | null = null;

  constructor(readonly code: OacpMandateIssueRefusalCode, readonly status: 403 | 422, message: string) {
    super(message);
    this.name = 'OacpMandateRefusal';
  }
}

/** The passport's revocation state could not be read: fail closed, retry later. */
export class OacpMandateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OacpMandateUnavailableError';
  }
}

export interface OacpMandateIssued {
  mandate: string;
  jti: string;
  mandate_type: OacpMandateType;
  /** NumericDate. */
  exp: number;
  status: { status_list: { idx: number; uri: string } };
  /** Lowercase hex SHA-256 of `mandate`. */
  mandate_hash: string;
  claims: OacpMandateClaims;
  /** The `oacp.mandate.issued` row in commerce_audit_events, written in the issuing transaction. */
  audit_event_id: string;
}

interface CommonInput {
  tenant_id: string;
  passport_jwt: string;
  presence?: unknown;
  request_id?: string | null | undefined;
}

export interface IntentMandateInput extends CommonInput {
  /** The natural-language summary the buyer delegated; only its hash is kept. */
  description: unknown;
  max_amount: unknown;
  merchants?: unknown;
  expires_at?: unknown;
}

export interface CartMandateInput extends CommonInput {
  intent_mandate: unknown;
  /** The UCP-shaped checkout object whose RFC 8785 hash is the AP2 `checkout_hash`. */
  checkout: unknown;
  /** G45: WebAuthn AuthenticationResponseJSON over `checkout_hash`. */
  webauthn_assertion?: unknown;
}

export interface PaymentMandateInput extends CommonInput {
  cart_mandate: unknown;
  rail: unknown;
  token_binding: unknown;
}

const MAX_CHECKOUT_BYTES = 64 * 1024;
const MAX_LINE_ITEMS = 200;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(code: OacpMandateIssueRefusalCode, message: string, status: 403 | 422 = 422): never {
  throw new OacpMandateRefusal(code, status, message);
}

function upperCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

async function verifiedPassport(sql: Sql, redis: Redis | null, input: CommonInput): Promise<VerifiedPassport> {
  const result = await verifyCommercePassport(sql, redis, input.passport_jwt, {
    mode: 'payment_affecting',
    expectedTenantId: input.tenant_id,
  });
  if (!result.ok) {
    if (result.error.kind === 'revocation_unavailable') {
      throw new OacpMandateUnavailableError('Passport revocation state is unavailable; refusing');
    }
    if (result.error.kind === 'revoked') refuse('passport_revoked', 'The passport is revoked', 403);
    refuse('passport_invalid', `Passport verification failed (${result.error.kind})`, 403);
  }
  const passport = result.passport;
  if (passport.passportType !== 'checkout') refuse('passport_not_checkout', 'Mandates need a checkout Commerce Passport');
  if (!passport.scopes.includes(PAYMENT_INITIATE_SCOPE)) {
    refuse('passport_scope_missing', `The passport does not carry ${PAYMENT_INITIATE_SCOPE}`, 403);
  }
  if (passport.maxAmount === null || !Number.isSafeInteger(passport.maxAmount) || passport.maxAmount < 0
    || upperCurrency(passport.currency) === null) {
    refuse('passport_cap_missing', 'The passport carries no amount cap and currency');
  }
  const consent = await findConsentById(sql, passport.consentRecordId);
  if (!consent || consent.status !== 'granted' || consent.tenantId !== passport.tenantId) {
    refuse('consent_not_active', 'The consent behind the passport is not active', 403);
  }
  return passport;
}

/** The presence asked for, defaulting to the passport's; never looser than a human-present floor. */
function presenceFor(requested: unknown, floor: PresenceMode): PresenceMode {
  if (requested !== undefined && !isPresenceMode(requested)) {
    refuse('presence_mismatch', 'presence must be "human_present" or "human_not_present"');
  }
  const presence = (requested as PresenceMode | undefined) ?? floor;
  if (floor === 'human_present' && presence !== 'human_present') {
    refuse('presence_mismatch', 'The buyer consented to confirm each purchase; a human_not_present mandate is refused', 403);
  }
  return presence;
}

function withinPassportCap(passport: VerifiedPassport, amount: number, currency: string): void {
  if (currency !== upperCurrency(passport.currency)) refuse('currency_mismatch', 'currency must equal the passport currency');
  if (amount > (passport.maxAmount as number)) refuse('passport_cap_exceeded', 'amount exceeds the passport amount cap');
}

function common(passport: VerifiedPassport, presence: PresenceMode, amr: string[], jti: string,
  iat: number, exp: number, status: { idx: number; uri: string }): OacpMandateCommonClaims {
  return {
    iss: config.jwtIssuer,
    sub: passport.subject,
    aud: passport.merchantId,
    iat,
    exp,
    jti,
    mandate_version: OACP_MANDATE_VERSION,
    tenant_id: passport.tenantId,
    merchant_id: passport.merchantId,
    buyer_agent_id: passport.agentId,
    presence,
    amr,
    passport_ref: passport.jti,
    consent_ref: passport.consentRecordId,
    status: { status_list: { idx: status.idx, uri: status.uri } },
  };
}

/** The published JWKS of OACP issuer keys, for verifying a parent or a presented mandate. */
async function oacpJwks(sql: Sql): Promise<{ keys: Array<Record<string, unknown>> }> {
  return { keys: await listOacpIssuerJwksKeys(sql) };
}

/**
 * Verify a mandate the way a relying party does, against this issuer's JWKS
 * and its own status list. `status` reports the stored row when there is one.
 */
export async function verifyStoredOacpMandate(
  sql: Sql,
  mandate: unknown,
  options: { expected_type?: OacpMandateType | undefined; expected_audience?: string | undefined; now?: Date | undefined } = {},
): Promise<OacpMandateVerification> {
  const now = options.now ?? new Date();
  const result = verifyOacpMandateSignatureAndClaims({
    mandate,
    jwks: await oacpJwks(sql),
    issuer: config.jwtIssuer,
    now_seconds: Math.floor(now.getTime() / 1000),
    expected_type: options.expected_type,
    expected_audience: options.expected_audience,
  });
  if (!result.valid) return result;
  const { uri, idx } = result.claims.status.status_list;
  let status: number | 'unavailable';
  try {
    status = (await readOacpStatus(uri, idx)) ?? 'unavailable';
  } catch {
    status = 'unavailable';
  }
  const code = oacpMandateStatusRefusal(result.claims, status);
  return code === null ? result : { valid: false, refusal_code: code, mandate_type: result.mandate_type, claims: result.claims as unknown as Record<string, unknown> };
}

async function verifiedParent<T extends OacpMandateClaims>(
  sql: Sql,
  mandate: unknown,
  type: 'intent' | 'cart',
  passport: VerifiedPassport,
): Promise<T> {
  const result = await verifyStoredOacpMandate(sql, mandate, { expected_type: type, expected_audience: passport.merchantId });
  if (!result.valid) {
    if (result.refusal_code === 'mandate_expired') refuse('parent_mandate_expired', `The ${type} mandate has expired`);
    if (result.refusal_code === 'mandate_revoked') refuse('parent_mandate_revoked', `The ${type} mandate is revoked`, 403);
    if (result.refusal_code === 'mandate_suspended') refuse('parent_mandate_suspended', `The ${type} mandate is suspended`, 403);
    if (result.refusal_code === 'mandate_audience_mismatch') refuse('mandate_chain_mismatch', `The ${type} mandate is for another merchant`);
    refuse('parent_mandate_invalid', `The ${type} mandate does not verify (${result.refusal_code})`);
  }
  const claims = result.claims as T;
  if (claims.tenant_id !== passport.tenantId || claims.sub !== passport.subject || claims.buyer_agent_id !== passport.agentId
    || claims.consent_ref !== passport.consentRecordId || claims.merchant_id !== passport.merchantId) {
    refuse('mandate_chain_mismatch', `The ${type} mandate belongs to another buyer, consent, merchant or agent`);
  }
  const rows = await sql<Array<{ status: string }>>`SELECT status FROM oacp_mandates WHERE jti = ${claims.jti}`;
  if (rows[0]?.status !== 'issued') refuse('parent_mandate_revoked', `The ${type} mandate is not live at this issuer`, 403);
  return claims;
}

/**
 * AP2 open mandates carry `cnf` (RFC 7800 §3.1) naming the agent key that may
 * act on them; here, the buyer agent's registered ES256 public key, when it
 * has one (agents may authenticate with an API key only).
 */
async function buyerAgentCnf(sql: Sql, passport: VerifiedPassport): Promise<{ jwk: Record<string, unknown> } | null> {
  const rows = await sql<Array<{ public_key_jwk: Record<string, unknown> | null }>>`
    SELECT public_key_jwk FROM commerce_agents WHERE tenant_id = ${passport.tenantId} AND id = ${passport.agentId} LIMIT 1
  `;
  const jwk = rows[0]?.public_key_jwk;
  if (!isRecord(jwk) || jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256' || typeof jwk['x'] !== 'string' || typeof jwk['y'] !== 'string') return null;
  return { jwk: { kty: 'EC', crv: 'P-256', x: jwk['x'], y: jwk['y'] } };
}

/** Expiry: the requested one, capped by the passport, the parent and the profile lifetime. */
function expiryFor(nowSeconds: number, caps: number[]): number {
  const exp = Math.min(nowSeconds + OACP_MANDATE_MAX_LIFETIME_SECONDS, ...caps);
  if (exp <= nowSeconds) refuse('parent_mandate_expired', 'The authority behind this mandate has expired');
  return exp;
}

interface CheckoutSummary {
  checkout_hash: string;
  checkout_id: string;
  line_items: Array<{ id: string; quantity: number; digest: string }>;
  total: { value: number; currency: string };
}

/** Validate the UCP-shaped checkout object and derive the AP2 checkout hash, line-item digests and total. */
export function summariseCheckout(checkout: unknown, merchantId: string): CheckoutSummary {
  if (!isRecord(checkout)) refuse('checkout_invalid', 'checkout must be a JSON object');
  try {
    assertNoCardData(checkout);
  } catch (err) {
    if (err instanceof AcpAllowanceError) refuse('card_data_refused', err.message);
    throw err;
  }
  let canonical: string;
  try {
    canonical = canonicalizeOacpPayload(checkout);
  } catch {
    refuse('checkout_invalid', 'checkout has no RFC 8785 form (floats or non-JSON values)');
  }
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CHECKOUT_BYTES) refuse('checkout_invalid', 'checkout exceeds 64 KiB');
  const id = checkout['id'];
  const currency = upperCurrency(checkout['currency']);
  const lineItems = checkout['line_items'];
  const totals = checkout['totals'];
  if (typeof id !== 'string' || !REF.test(id)) refuse('checkout_invalid', 'checkout.id is required');
  if (currency === null) refuse('checkout_invalid', 'checkout.currency must be an ISO 4217 code');
  if (!Array.isArray(lineItems) || lineItems.length === 0 || lineItems.length > MAX_LINE_ITEMS) {
    refuse('checkout_invalid', `checkout.line_items must hold 1 to ${MAX_LINE_ITEMS} items`);
  }
  const items = lineItems.map((item) => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0
      || typeof item['quantity'] !== 'number' || !Number.isSafeInteger(item['quantity']) || item['quantity'] < 1) {
      refuse('checkout_invalid', 'each line item needs an id and an integer quantity of at least 1');
    }
    return { id: item['id'] as string, quantity: item['quantity'] as number, digest: sha256b64url(canonicalizeOacpPayload(item)) };
  });
  const total = Array.isArray(totals) ? totals.filter((entry) => isRecord(entry) && entry['type'] === 'total') : [];
  const amount = total.length === 1 ? (total[0] as Record<string, unknown>)['amount'] : undefined;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    refuse('checkout_invalid', 'checkout.totals must hold exactly one total with a non-negative integer amount in minor units');
  }
  const merchant = checkout['merchant'];
  if (merchant !== undefined && (!isRecord(merchant) || merchant['id'] !== merchantId)) {
    refuse('merchant_not_allowed', 'checkout.merchant.id must be the passport merchant');
  }
  return { checkout_hash: oacpCheckoutHash(checkout), checkout_id: id, line_items: items, total: { value: amount, currency } };
}

interface PasskeyProof {
  evidence: WebAuthnAssertionEvidence;
  assertionHash: string;
  credentialRowId: string;
  newCounter: number;
  previousCounter: number;
  ref: OacpCartWebAuthnRef;
}

/**
 * G45: verify a WebAuthn assertion whose challenge must be `checkoutHash`,
 * made by a passkey the buyer (passport subject) registered with a developer
 * of the passport's commerce tenant. Reuses the portable evidence format and
 * verifier of lib/webauthn-evidence.ts.
 */
async function verifyCartPasskey(
  sql: Sql,
  assertion: unknown,
  checkoutHash: string,
  passport: VerifiedPassport,
  jti: string,
): Promise<PasskeyProof> {
  if (assertion === undefined || assertion === null) {
    refuse('passkey_evidence_required', 'A human_present cart mandate needs a WebAuthn assertion over its checkout_hash', 403);
  }
  const a = assertion as Record<string, unknown>;
  const response = isRecord(a) && isRecord(a['response']) ? a['response'] : null;
  const strings = response ? ['clientDataJSON', 'authenticatorData', 'signature'].map((k) => response[k]) : [];
  if (!isRecord(a) || a['type'] !== 'public-key' || typeof a['id'] !== 'string' || !/^[A-Za-z0-9_-]{16,1024}$/.test(a['id'])
    || !response || !strings.every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,16384}$/.test(v))) {
    refuse('passkey_evidence_invalid', 'webauthn_assertion must be a WebAuthn AuthenticationResponseJSON');
  }
  const [clientDataJSON, authenticatorData, signature] = strings as [string, string, string];
  const credentials = await sql<Array<{ id: string; credential_id: string; public_key: string; counter: string | number }>>`
    SELECT c.id, c.credential_id, c.public_key, c.counter
      FROM webauthn_credentials c
     WHERE c.credential_id = ${a['id'] as string}
       AND c.principal_id = ${passport.subject}
       AND c.developer_id IN (
         SELECT developer_id FROM commerce_developer_tenants WHERE tenant_id = ${passport.tenantId}
       )
     LIMIT 1
  `;
  const credential = credentials[0];
  if (!credential) refuse('passkey_evidence_invalid', 'The assertion is not from a passkey the buyer registered', 403);
  const assertionHash = createHash('sha256').update(`${credential.credential_id}.${signature}`).digest('hex');
  const used = await sql`SELECT 1 FROM oacp_mandates WHERE webauthn_assertion_hash = ${assertionHash} LIMIT 1`;
  if (used[0]) refuse('passkey_evidence_replayed', 'This WebAuthn assertion already backs a mandate', 403);
  const previousCounter = Number(credential.counter);
  const evidence = createWebAuthnEvidence({
    authRequestId: jti,
    credentialId: credential.credential_id,
    credentialPublicKey: credential.public_key,
    previousCounter,
    rpId: config.fidoRpId,
    origin: config.fidoOrigin,
    challenge: checkoutHash,
    clientDataJSON,
    authenticatorData,
    signature,
    userVerified: true,
    assertedAt: new Date().toISOString(),
  });
  // Checks the authenticator signature, the RP id, the origin, user
  // verification, the counter, and that the signed challenge is the cart's
  // checkout_hash.
  if (!await verifyPortableWebAuthnEvidence(evidence, { rpId: config.fidoRpId, origin: config.fidoOrigin })) {
    refuse('passkey_evidence_invalid', 'The WebAuthn assertion does not verify over this cart\'s checkout_hash', 403);
  }
  const authData = Buffer.from(authenticatorData, 'base64url');
  const newCounter = authData.length >= 37 ? authData.readUInt32BE(33) : 0;
  return {
    evidence,
    assertionHash,
    credentialRowId: credential.id,
    newCounter,
    previousCounter,
    ref: {
      digest: evidence.digest,
      rp_id: evidence.rpId,
      origin: evidence.origin,
      challenge: checkoutHash,
      user_verified: true,
      asserted_at: evidence.assertedAt,
      credential_ref: createHash('sha256').update(credential.credential_id).digest('hex'),
    },
  };
}

interface Persist {
  type: OacpMandateType;
  passport: VerifiedPassport;
  presence: PresenceMode;
  amr: string[];
  parentJti: string | null;
  exp: number;
  checkoutHash: string | null;
  amount: number | null;
  currency: string | null;
  requestId: string | null;
  passkey: PasskeyProof | null;
  jti?: string;
  claims: (base: OacpMandateCommonClaims) => OacpMandateClaims;
}

async function signAndPersist(sql: Sql, p: Persist): Promise<OacpMandateIssued> {
  assertOacpStatusBaseUsable();
  const signer = await getActiveOacpSigner(sql);
  const jti = p.jti ?? newOacpMandateJti();
  const iat = Math.floor(Date.now() / 1000);
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const status = await allocateOacpStatusEntry(tx, jti);
    const claims = p.claims(common(p.passport, p.presence, p.amr, jti, iat, p.exp, status));
    const mandate = signOacpMandate(p.type, claims, signer);
    const self = verifyOacpMandateSignatureAndClaims({
      mandate, jwks: { keys: [signer.publicJwk] }, issuer: config.jwtIssuer, now_seconds: iat, expected_type: p.type,
    });
    if (!self.valid) throw new Error(`issued ${p.type} mandate failed self-verification: ${self.refusal_code}`);
    if (p.passkey) {
      // The counter moves forward exactly once per assertion (clone and replay detection).
      const moved = await tx`
        UPDATE webauthn_credentials SET counter = ${p.passkey.newCounter}, last_used_at = NOW()
         WHERE id = ${p.passkey.credentialRowId} AND counter = ${p.passkey.previousCounter}
        RETURNING id
      `;
      if (!moved[0]) refuse('passkey_evidence_replayed', 'The passkey counter changed; make a new assertion', 403);
    }
    const mandateHash = oacpMandateHash(mandate);
    try {
      await tx`
        INSERT INTO oacp_mandates (
          jti, mandate_type, tenant_id, merchant_id, buyer_agent_id, subject, presence, amr,
          passport_jti, consent_record_id, parent_jti, issuer_key_id, jwt, jwt_sha256, claims,
          checkout_hash, amount, currency, webauthn_evidence, webauthn_assertion_hash,
          status_list_uri, status_idx, issued_at, expires_at, status, request_id
        ) VALUES (
          ${jti}, ${p.type}, ${p.passport.tenantId}, ${p.passport.merchantId}, ${p.passport.agentId},
          ${p.passport.subject}, ${p.presence}, ${p.amr}, ${p.passport.jti}, ${p.passport.consentRecordId},
          ${p.parentJti}, ${signer.kid}, ${mandate}, ${mandateHash}, ${tx.json(claims as never)},
          ${p.checkoutHash}, ${p.amount}, ${p.currency},
          ${p.passkey ? tx.json(p.passkey.evidence as never) : null}, ${p.passkey?.assertionHash ?? null},
          ${status.uri}, ${status.idx}, to_timestamp(${iat}), to_timestamp(${p.exp}), 'issued', ${p.requestId}
        )
      `;
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && String((err as { constraint_name?: string }).constraint_name ?? '').includes('webauthn_assertion_hash')) {
        refuse('passkey_evidence_replayed', 'This WebAuthn assertion already backs a mandate', 403);
      }
      throw err;
    }
    const audit = await appendCommerceAudit(tx as unknown as Sql, {
      tenantId: p.passport.tenantId,
      merchantId: p.passport.merchantId,
      agentId: p.passport.agentId,
      userPrincipalId: p.passport.subject,
      eventType: 'oacp.mandate.issued',
      resourceType: 'oacp_mandate',
      resourceId: jti,
      passportJti: p.passport.jti,
      policyVersion: p.passport.policyVersion,
      requestId: p.requestId,
      metadata: {
        mandate_type: p.type,
        presence: p.presence,
        amr: p.amr,
        parent_jti: p.parentJti,
        mandate_hash: mandateHash,
        issuer_key_id: signer.kid,
        checkout_hash: p.checkoutHash,
        amount: p.amount,
        currency: p.currency,
        expires_at: new Date(p.exp * 1000).toISOString(),
        passkey_evidence_digest: p.passkey?.evidence.digest ?? null,
      },
    });
    return {
      mandate, jti, mandate_type: p.type, exp: p.exp, status: { status_list: status }, mandate_hash: mandateHash, claims,
      audit_event_id: audit.id,
    };
  }) as OacpMandateIssued;
}

/**
 * Record a refused issuance: what was asked, the code, never a token. The
 * `oacp.mandate.refused` audit event is written in the same transaction when
 * the tenant is a commerce tenant (commerce_audit_events references
 * commerce_tenants); a request naming no known tenant is recorded in
 * oacp_mandates only.
 */
export async function recordOacpMandateRefusal(
  sql: Sql,
  input: { type: OacpMandateType; tenant_id: unknown; code: string; message: string; passport: VerifiedPassport | null; request_id: string | null },
): Promise<{ id: string; audit_event_id: string | null }> {
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as Sql;
    return await recordRefusalTx(tx, input);
  }) as { id: string; audit_event_id: string | null };
}

async function recordRefusalTx(
  sql: Sql,
  input: { type: OacpMandateType; tenant_id: unknown; code: string; message: string; passport: VerifiedPassport | null; request_id: string | null },
): Promise<{ id: string; audit_event_id: string | null }> {
  const id = newOacpMandateRefusalId();
  const tenant = typeof input.tenant_id === 'string' && input.tenant_id.length <= 256 ? input.tenant_id : null;
  await queries(sql)`
    INSERT INTO oacp_mandates (
      jti, mandate_type, tenant_id, merchant_id, buyer_agent_id, subject, passport_jti, consent_record_id,
      claims, status, refusal_code, request_id
    ) VALUES (
      ${id}, ${input.type}, ${input.passport?.tenantId ?? tenant}, ${input.passport?.merchantId ?? null},
      ${input.passport?.agentId ?? null}, ${input.passport?.subject ?? null}, ${input.passport?.jti ?? null},
      ${input.passport?.consentRecordId ?? null},
      ${queries(sql).json({ refusal_code: input.code, message: input.message } as never)}, 'refused', ${input.code}, ${input.request_id}
    )
  `;
  const tenantId = input.passport?.tenantId ?? tenant;
  if (tenantId === null) return { id, audit_event_id: null };
  const known = await sql`SELECT 1 FROM commerce_tenants WHERE id = ${tenantId}`;
  if (!known[0]) return { id, audit_event_id: null };
  const audit = await appendCommerceAudit(sql, {
    tenantId,
    merchantId: input.passport?.merchantId ?? null,
    agentId: input.passport?.agentId ?? null,
    userPrincipalId: input.passport?.subject ?? null,
    eventType: 'oacp.mandate.refused',
    resourceType: 'oacp_mandate',
    resourceId: id,
    passportJti: input.passport?.jti ?? null,
    requestId: input.request_id,
    metadata: { mandate_type: input.type, refusal_code: input.code },
  });
  return { id, audit_event_id: audit.id };
}

/** Run an issuance, recording any refusal before rethrowing it. */
async function withRefusalRecord<T>(
  sql: Sql,
  type: OacpMandateType,
  input: CommonInput,
  run: (setPassport: (p: VerifiedPassport) => void) => Promise<T>,
): Promise<T> {
  let passport: VerifiedPassport | null = null;
  try {
    return await run((p) => { passport = p; });
  } catch (err) {
    if (err instanceof OacpMandateRefusal) {
      const recorded = await recordOacpMandateRefusal(sql, {
        type, tenant_id: input.tenant_id, code: err.code, message: err.message, passport, request_id: input.request_id ?? null,
      });
      err.refusalRecordId = recorded.id;
      err.auditEventId = recorded.audit_event_id;
    }
    throw err;
  }
}

export async function issueIntentMandate(sql: Sql, redis: Redis | null, input: IntentMandateInput): Promise<OacpMandateIssued> {
  return withRefusalRecord(sql, 'intent', input, async (setPassport) => {
    const passport = await verifiedPassport(sql, redis, input);
    setPassport(passport);
    const presence = presenceFor(input.presence, passport.presence);
    if (typeof input.description !== 'string' || input.description.trim().length === 0 || input.description.length > 4000) {
      refuse('intent_invalid', 'description must be the natural-language summary the buyer delegated (1 to 4000 characters)');
    }
    const max = input.max_amount;
    const currency = isRecord(max) ? upperCurrency(max['currency']) : null;
    if (!isRecord(max) || typeof max['value'] !== 'number' || !Number.isSafeInteger(max['value']) || max['value'] < 0 || currency === null) {
      refuse('intent_invalid', 'max_amount must be {value: integer minor units, currency: ISO 4217}');
    }
    const value = max['value'] as number;
    withinPassportCap(passport, value, currency);
    const merchants = input.merchants === undefined ? [passport.merchantId] : input.merchants;
    if (!Array.isArray(merchants) || merchants.length === 0 || !merchants.every((m) => m === passport.merchantId)) {
      refuse('merchant_not_allowed', 'merchants may name only the merchant the passport is bound to');
    }
    const now = Math.floor(Date.now() / 1000);
    const caps = [passport.expiresAt];
    if (input.expires_at !== undefined) {
      const requested = typeof input.expires_at === 'string' ? Date.parse(input.expires_at) : Number.NaN;
      if (!Number.isFinite(requested)) refuse('intent_invalid', 'expires_at must be an RFC 3339 timestamp');
      caps.push(Math.floor(requested / 1000));
    }
    const exp = expiryFor(now, caps);
    const cnf = await buyerAgentCnf(sql, passport);
    const descriptionHash = sha256b64url(input.description.normalize('NFC'));
    return signAndPersist(sql, {
      type: 'intent', passport, presence, amr: passport.amr, parentJti: null, exp,
      checkoutHash: null, amount: value, currency, requestId: input.request_id ?? null, passkey: null,
      claims: (base): OacpIntentClaims => ({
        ...base,
        intent: {
          description_hash: descriptionHash,
          max_amount: { value, currency },
          merchants: [passport.merchantId],
          expires_at: new Date(exp * 1000).toISOString(),
          // AP2 v0.2 open-mandate constraints (checkout.allowed_merchants,
          // payment.amount_range); Grantex derives them, it accepts no others.
          constraints: [
            { type: 'checkout.allowed_merchants', allowed: [{ id: passport.merchantId }] },
            { type: 'payment.amount_range', currency, max: value },
          ],
        },
        ...(cnf ? { cnf } : {}),
      }),
    });
  });
}

export async function issueCartMandate(sql: Sql, redis: Redis | null, input: CartMandateInput): Promise<OacpMandateIssued> {
  return withRefusalRecord(sql, 'cart', input, async (setPassport) => {
    const passport = await verifiedPassport(sql, redis, input);
    setPassport(passport);
    const intent = await verifiedParent<OacpIntentClaims>(sql, input.intent_mandate, 'intent', passport);
    const floor: PresenceMode = passport.presence === 'human_present' || intent.presence === 'human_present' ? 'human_present' : 'human_not_present';
    const presence = presenceFor(input.presence ?? intent.presence, floor);
    const summary = summariseCheckout(input.checkout, passport.merchantId);
    if (summary.total.currency !== intent.intent.max_amount.currency) refuse('currency_mismatch', 'checkout currency must equal the intent currency');
    if (summary.total.value > intent.intent.max_amount.value) refuse('intent_cap_exceeded', 'checkout total exceeds the intent mandate cap');
    withinPassportCap(passport, summary.total.value, summary.total.currency);
    const jti = newOacpMandateJti();
    let passkey: PasskeyProof | null = null;
    if (presence === 'human_present') {
      passkey = await verifyCartPasskey(sql, input.webauthn_assertion, summary.checkout_hash, passport, jti);
    } else if (input.webauthn_assertion !== undefined) {
      refuse('presence_mismatch', 'A webauthn_assertion is accepted only on a human_present cart');
    }
    const amr = passkey ? [...new Set([...passport.amr, 'passkey'])] : passport.amr;
    const exp = expiryFor(Math.floor(Date.now() / 1000), [passport.expiresAt, intent.exp]);
    return signAndPersist(sql, {
      type: 'cart', passport, presence, amr, parentJti: intent.jti, exp, jti,
      checkoutHash: summary.checkout_hash, amount: summary.total.value, currency: summary.total.currency,
      requestId: input.request_id ?? null, passkey,
      claims: (base): OacpCartClaims => ({
        ...base,
        cart: summary,
        intent_mandate_jti: intent.jti,
        ...(passkey ? { webauthn: passkey.ref } : {}),
      }),
    });
  });
}

export async function issuePaymentMandate(sql: Sql, redis: Redis | null, input: PaymentMandateInput): Promise<OacpMandateIssued> {
  return withRefusalRecord(sql, 'payment', input, async (setPassport) => {
    const passport = await verifiedPassport(sql, redis, input);
    setPassport(passport);
    const cart = await verifiedParent<OacpCartClaims>(sql, input.cart_mandate, 'cart', passport);
    if (input.presence !== undefined && input.presence !== cart.presence) {
      refuse('presence_mismatch', 'A payment mandate carries its cart mandate\'s presence');
    }
    if (typeof input.rail !== 'string' || !(OACP_PAYMENT_RAILS as readonly string[]).includes(input.rail)) {
      refuse('payment_rail_unsupported', `rail must be one of ${OACP_PAYMENT_RAILS.join(', ')}`);
    }
    try {
      assertNoCardData(input.token_binding);
    } catch (err) {
      if (err instanceof AcpAllowanceError) refuse('card_data_refused', err.message);
      throw err;
    }
    const binding = input.token_binding;
    if (!isRecord(binding) || Object.keys(binding).some((k) => k !== 'type' && k !== 'id')
      || typeof binding['type'] !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(binding['type'])
      || typeof binding['id'] !== 'string' || !REF.test(binding['id'])) {
      refuse('token_binding_invalid', 'token_binding must be {type, id}: a token type and an opaque token reference');
    }
    withinPassportCap(passport, cart.cart.total.value, cart.cart.total.currency);
    const exp = expiryFor(Math.floor(Date.now() / 1000), [passport.expiresAt, cart.exp]);
    const rail = input.rail as OacpPaymentRail;
    return signAndPersist(sql, {
      type: 'payment', passport, presence: cart.presence, amr: cart.amr, parentJti: cart.jti, exp,
      checkoutHash: cart.cart.checkout_hash, amount: cart.cart.total.value, currency: cart.cart.total.currency,
      requestId: input.request_id ?? null, passkey: null,
      claims: (base): OacpPaymentClaims => ({
        ...base,
        payment: {
          transaction_id: cart.cart.checkout_hash,
          amount: cart.cart.total.value,
          currency: cart.cart.total.currency,
          payee: { id: passport.merchantId },
          rail,
          token_binding: { type: binding['type'] as string, id: binding['id'] as string },
          cart_mandate_jti: cart.jti,
        },
      }),
    });
  });
}

export class OacpMandateStoreError extends Error {
  constructor(readonly code: 'mandate_not_found' | 'mandate_not_revocable' | 'mandate_not_suspendable', message: string) {
    super(message);
    this.name = 'OacpMandateStoreError';
  }
}

const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface OacpMandateRecord {
  jti: string;
  mandate_type: OacpMandateType;
  tenant_id: string | null;
  status: 'issued' | 'refused' | 'revoked';
  parent_jti: string | null;
}

export async function getOacpMandateRecord(sql: Sql, jti: string): Promise<OacpMandateRecord | null> {
  const rows = await sql<OacpMandateRecord[]>`
    SELECT jti, mandate_type, tenant_id, status, parent_jti FROM oacp_mandates WHERE jti = ${jti}
  `;
  return rows[0] ?? null;
}

/**
 * Revoke a mandate and every mandate issued under it (an intent's carts, a
 * cart's payments): each Token Status List entry is set INVALID (final) and
 * each row marked `revoked`, in one transaction. Idempotent.
 */
export async function revokeOacpMandate(
  sql: Sql,
  jti: string,
  options: { reason_code?: string | undefined; now?: Date | undefined; request_id?: string | null | undefined } = {},
): Promise<{ jti: string; status: 'revoked'; revoked_at: string; revocation_reason: string; revoked_jtis: string[]; already_revoked: boolean }> {
  const reason = options.reason_code && REASON_RE.test(options.reason_code) ? options.reason_code : 'issuer_revoked';
  const nowIso = (options.now ?? new Date()).toISOString();
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const [root] = await tx`SELECT jti, status, revoked_at, revocation_reason FROM oacp_mandates WHERE jti = ${jti} FOR UPDATE`;
    if (!root) throw new OacpMandateStoreError('mandate_not_found', 'OACP mandate not found');
    if (root['status'] === 'refused') throw new OacpMandateStoreError('mandate_not_revocable', 'A refused issuance has no mandate to revoke');
    const tree = await tx`
      WITH RECURSIVE tree AS (
        SELECT jti FROM oacp_mandates WHERE jti = ${jti}
        UNION
        SELECT m.jti FROM oacp_mandates m JOIN tree t ON m.parent_jti = t.jti
      )
      SELECT m.jti, m.status, m.status_list_uri, m.status_idx, m.mandate_type, m.tenant_id, m.merchant_id,
             m.buyer_agent_id, m.subject, m.passport_jti
        FROM oacp_mandates m JOIN tree t ON t.jti = m.jti
       WHERE m.status = 'issued'
       ORDER BY m.jti
       FOR UPDATE OF m
    `;
    const revoked: string[] = [];
    for (const row of tree) {
      await setOacpStatus(tx, row['status_list_uri'] as string, Number(row['status_idx']), 'invalid');
      await tx`
        UPDATE oacp_mandates SET status = 'revoked', revoked_at = ${nowIso}, revocation_reason = ${reason}
         WHERE jti = ${row['jti'] as string} AND status = 'issued'
      `;
      await appendCommerceAudit(tx as unknown as Sql, {
        tenantId: row['tenant_id'] as string,
        merchantId: row['merchant_id'] as string,
        agentId: row['buyer_agent_id'] as string,
        userPrincipalId: row['subject'] as string,
        eventType: 'oacp.mandate.revoked',
        resourceType: 'oacp_mandate',
        resourceId: row['jti'] as string,
        passportJti: row['passport_jti'] as string,
        requestId: options.request_id ?? null,
        metadata: { mandate_type: row['mandate_type'], reason_code: reason, revoked_with: jti },
      });
      revoked.push(row['jti'] as string);
    }
    const alreadyRevoked = root['status'] === 'revoked';
    const revokedAt = alreadyRevoked
      ? (root['revoked_at'] instanceof Date ? root['revoked_at'].toISOString() : String(root['revoked_at']))
      : nowIso;
    return {
      jti,
      status: 'revoked' as const,
      revoked_at: revokedAt,
      revocation_reason: alreadyRevoked ? String(root['revocation_reason'] ?? reason) : reason,
      revoked_jtis: revoked,
      already_revoked: alreadyRevoked,
    };
  }) as { jti: string; status: 'revoked'; revoked_at: string; revocation_reason: string; revoked_jtis: string[]; already_revoked: boolean };
}

/**
 * Suspend (status 2) or reinstate (status 0) one issued mandate on its Token
 * Status List (draft-ietf-oauth-status-list section 7.1), with its
 * `oacp.mandate.suspended` / `oacp.mandate.reinstated` audit event, in one
 * transaction. Reversible, unlike revocation, and applied to the named mandate
 * only: no mandate is issued under a suspended parent
 * (`parent_mandate_suspended`), and relying parties verify every mandate of a
 * chain. Refused for refusal records and revoked mandates. Idempotent:
 * `changed` is false when the mandate was already in the asked state.
 */
export async function setOacpMandateSuspension(
  sql: Sql,
  jti: string,
  suspend: boolean,
  options: { reason_code?: string | undefined; now?: Date | undefined; request_id?: string | null | undefined } = {},
): Promise<{ jti: string; suspended: boolean; suspended_at: string | null; suspension_reason: string | null; changed: boolean }> {
  const reason = options.reason_code && REASON_RE.test(options.reason_code) ? options.reason_code : 'issuer_suspended';
  const nowIso = (options.now ?? new Date()).toISOString();
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const [row] = await tx`
      SELECT jti, status, mandate_type, tenant_id, merchant_id, buyer_agent_id, subject, passport_jti,
             status_list_uri, status_idx, suspended_at, suspension_reason
        FROM oacp_mandates WHERE jti = ${jti} FOR UPDATE
    `;
    if (!row) throw new OacpMandateStoreError('mandate_not_found', 'OACP mandate not found');
    if (row['status'] !== 'issued') {
      throw new OacpMandateStoreError('mandate_not_suspendable', 'Only issued, unrevoked mandates can be suspended or reinstated');
    }
    const iso = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
    const isSuspended = row['suspended_at'] !== null && row['suspended_at'] !== undefined;
    if (isSuspended === suspend) {
      return { jti, suspended: isSuspended, suspended_at: iso(row['suspended_at']), suspension_reason: (row['suspension_reason'] as string | null) ?? null, changed: false };
    }
    await setOacpStatus(tx, row['status_list_uri'] as string, Number(row['status_idx']), suspend ? 'suspended' : 'valid');
    await tx`
      UPDATE oacp_mandates
         SET suspended_at = ${suspend ? nowIso : null}, suspension_reason = ${suspend ? reason : null}
       WHERE jti = ${jti}
    `;
    await appendCommerceAudit(tx as unknown as Sql, {
      tenantId: row['tenant_id'] as string,
      merchantId: row['merchant_id'] as string,
      agentId: row['buyer_agent_id'] as string,
      userPrincipalId: row['subject'] as string,
      eventType: suspend ? 'oacp.mandate.suspended' : 'oacp.mandate.reinstated',
      resourceType: 'oacp_mandate',
      resourceId: jti,
      passportJti: row['passport_jti'] as string,
      requestId: options.request_id ?? null,
      metadata: { mandate_type: row['mandate_type'], ...(suspend ? { reason_code: reason } : {}) },
    });
    return { jti, suspended: suspend, suspended_at: suspend ? nowIso : null, suspension_reason: suspend ? reason : null, changed: true };
  }) as { jti: string; suspended: boolean; suspended_at: string | null; suspension_reason: string | null; changed: boolean };
}
