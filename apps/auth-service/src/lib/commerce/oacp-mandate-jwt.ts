// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * OACP mandates as signed JWTs (G41): the claim layout, the signer and the
 * verifier. Pure: no database, no clock of its own. The issuing service
 * (mandates.ts), the verification route and the SDK verifiers
 * (`verifyOacpMandate` in packages/sdk-ts) implement this one profile, and the
 * shared vectors in `spec/examples/oacp/oacp-mandates-v1.json` pin it.
 *
 * Representation (decision recorded in docs/guides/oacp/mandates-decision.mdx):
 * a compact JWS (RFC 7515) / JWT (RFC 7519) signed ES256 on P-256 (RFC 7518
 * §3.4, 64-byte r||s) with an OACP issuer key (`oacp-` kid, published in
 * /.well-known/jwks.json). Three types, named in `typ` (RFC 7515 §4.1.9,
 * RFC 8725 §3.11 explicit typing):
 *
 *   oacp-intent-mandate+jwt   what the buyer delegated: caps, merchants, expiry
 *   oacp-cart-mandate+jwt     one cart: AP2 `checkout_hash`, line-item digests,
 *                             total; for `human_present`, the WebAuthn assertion
 *                             whose challenge is the `checkout_hash` (G45)
 *   oacp-payment-mandate+jwt  one payment: AP2 `transaction_id` = the cart's
 *                             `checkout_hash`, amount, rail, token binding
 *
 * Claims carry AP2 v0.2 member names where AP2 has one (`checkout_hash`,
 * `transaction_id`, `constraints` with `checkout.allowed_merchants` and
 * `payment.amount_range`, `payee`, `cnf`). Every mandate is on the OACP Token
 * Status List: `status: {status_list: {idx, uri}}` (draft-ietf-oauth-status-
 * list §6.1, referenced token), revocation sets it INVALID (G46).
 *
 * Verification order and refusal codes (every verifier):
 *   1. compact JWS, three non-empty base64url parts     mandate_malformed
 *   2. header JSON object, no repeated member names      mandate_malformed
 *      alg ES256                                        mandate_algorithm_unsupported
 *      exactly alg, kid, typ; kid a string             mandate_malformed
 *      typ one of the three (and the expected one)      mandate_type_mismatch
 *   3. exactly one usable ES256 P-256 JWK for kid       issuer_key_untrusted
 *   4. ECDSA over header.payload                        mandate_signature_invalid
 *   5. payload JSON object, no repeated member names     mandate_malformed
 *   6. iss is the pinned issuer                         mandate_issuer_mismatch
 *   7. claims present and well-typed for the type       mandate_claims_invalid
 *   8. iat <= now + 60 s                                mandate_not_yet_valid
 *      now < exp                                        mandate_expired
 *      exp - iat <= 600 s                               mandate_lifetime_exceeded
 *   9. aud is the expected merchant (when given)        mandate_audience_mismatch
 *  10. Token Status List entry: 0 valid, 1              mandate_revoked
 *      2                                                mandate_suspended
 *      unreadable or not an https list                  revocation_status_unavailable
 */
import { createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { canonicalizeOacpPayload } from './oacp-trust-artifacts.js';
import { parseJsonRejectingDuplicates } from '../evidence/canonical.js';
import { OACP_PAYMENT_RAILS, type OacpPaymentRail } from './payment-providers/mandate-rails.js';
import { OACP_KID_PREFIX, isOacpStatusUriAllowed, oacpTrustedKey, type OacpJwks, type OacpSigningKey } from './oacp-jws.js';

export const OACP_MANDATE_TYPES = ['intent', 'cart', 'payment'] as const;
export type OacpMandateType = typeof OACP_MANDATE_TYPES[number];

export const OACP_MANDATE_TYP: Record<OacpMandateType, string> = {
  intent: 'oacp-intent-mandate+jwt',
  cart: 'oacp-cart-mandate+jwt',
  payment: 'oacp-payment-mandate+jwt',
};

export const OACP_MANDATE_VERSION = 'oacp.mandate.v1';
/** Longest mandate a verifier accepts, `exp - iat` (checkout passports live 600 s). */
export const OACP_MANDATE_MAX_LIFETIME_SECONDS = 600;
export const OACP_MANDATE_CLOCK_SKEW_SECONDS = 60;

export { OACP_PAYMENT_RAILS, type OacpPaymentRail } from './payment-providers/mandate-rails.js';

export type OacpPresence = 'human_present' | 'human_not_present';

export type OacpMandateRefusalCode =
  | 'mandate_malformed'
  | 'mandate_algorithm_unsupported'
  | 'mandate_type_mismatch'
  | 'issuer_key_untrusted'
  | 'mandate_signature_invalid'
  | 'mandate_issuer_mismatch'
  | 'mandate_claims_invalid'
  | 'mandate_not_yet_valid'
  | 'mandate_expired'
  | 'mandate_lifetime_exceeded'
  | 'mandate_audience_mismatch'
  | 'revocation_status_unavailable'
  | 'mandate_revoked'
  | 'mandate_suspended';

export interface OacpAmount {
  /** Integer minor units (ISO 4217), as AP2 v0.2 `payment_amount.amount`. */
  value: number;
  /** Upper-case ISO 4217 code. */
  currency: string;
}

export interface OacpMandateCommonClaims {
  iss: string;
  /** Buyer principal reference (the passport subject). */
  sub: string;
  /** The merchant id. */
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  mandate_version: typeof OACP_MANDATE_VERSION;
  tenant_id: string;
  merchant_id: string;
  buyer_agent_id: string;
  presence: OacpPresence;
  amr: string[];
  passport_ref: string;
  consent_ref: string;
  status: { status_list: { idx: number; uri: string } };
}

export interface OacpIntentClaims extends OacpMandateCommonClaims {
  intent: {
    /** b64url SHA-256 of the UTF-8 natural-language summary the buyer delegated. */
    description_hash: string;
    max_amount: OacpAmount;
    merchants: string[];
    expires_at: string;
    /** AP2 v0.2 open-mandate constraint shapes. */
    constraints: Array<Record<string, unknown>>;
  };
  /** RFC 7800 §3.1: the buyer agent's registered public key, when it has one. */
  cnf?: { jwk: Record<string, unknown> };
}

export interface OacpCartWebAuthnRef {
  /** `GrantexWebAuthnAssertion` digest (lib/webauthn-evidence.ts). */
  digest: string;
  rp_id: string;
  origin: string;
  /** The WebAuthn challenge: always the cart's `checkout_hash`. */
  challenge: string;
  user_verified: boolean;
  asserted_at: string;
  /** Hex SHA-256 of the credential id: names the passkey without publishing it. */
  credential_ref: string;
}

export interface OacpCartClaims extends OacpMandateCommonClaims {
  cart: {
    /** AP2 `checkout_hash`: b64url SHA-256 of the RFC 8785 checkout object. */
    checkout_hash: string;
    checkout_id: string;
    line_items: Array<{ id: string; quantity: number; digest: string }>;
    total: OacpAmount;
  };
  intent_mandate_jti: string;
  /** Present exactly when `presence` is `human_present` (G45). */
  webauthn?: OacpCartWebAuthnRef;
}

export interface OacpPaymentClaims extends OacpMandateCommonClaims {
  payment: {
    /** AP2 `transaction_id`: the cart's `checkout_hash`. */
    transaction_id: string;
    amount: number;
    currency: string;
    /** AP2 `payee`. */
    payee: { id: string };
    rail: OacpPaymentRail;
    /** AP2 `payment_instrument` {type, id}: a token reference, never card data. */
    token_binding: { type: string; id: string };
    cart_mandate_jti: string;
  };
}

export type OacpMandateClaims = OacpIntentClaims | OacpCartClaims | OacpPaymentClaims;

export type OacpMandateVerification =
  | { valid: true; refusal_code: null; mandate_type: OacpMandateType; claims: OacpMandateClaims; kid: string }
  | { valid: false; refusal_code: OacpMandateRefusalCode; mandate_type: OacpMandateType | null; claims: Record<string, unknown> | null };

const B64URL = /^[A-Za-z0-9_-]+$/;
const HASH_B64URL = /^[A-Za-z0-9_-]{43}$/;
const CURRENCY = /^[A-Z]{3}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

const b64url = (data: Uint8Array | string): string => Buffer.from(data).toString('base64url');

function b64urlDecode(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  return b64url(raw) === text ? raw : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRef(value: unknown): value is string {
  return typeof value === 'string' && REF.test(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAmount(value: unknown): value is OacpAmount {
  return isRecord(value) && isNonNegativeInt(value['value']) && typeof value['currency'] === 'string' && CURRENCY.test(value['currency']);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** b64url SHA-256 (AP2 `checkout_hash` encoding). */
export function sha256b64url(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('base64url');
}

/** AP2 `checkout_hash` of a checkout object: b64url SHA-256 of its RFC 8785 form. */
export function oacpCheckoutHash(checkout: unknown): string {
  return sha256b64url(canonicalizeOacpPayload(checkout));
}

/** Lowercase hex SHA-256 of the compact JWT: what AgenticOrg stores as `mandate_hash`. */
export function oacpMandateHash(compactJwt: string): string {
  return createHash('sha256').update(compactJwt, 'ascii').digest('hex');
}

/** Sign mandate claims as a compact JWT with an OACP issuer key. */
export function signOacpMandate(type: OacpMandateType, claims: OacpMandateClaims, signer: OacpSigningKey): string {
  if (!signer.kid.startsWith(OACP_KID_PREFIX)) throw new Error('OACP mandates are signed with oacp- issuer keys');
  const details = signer.privateKey.asymmetricKeyDetails ?? {};
  if (signer.privateKey.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') {
    throw new Error('OACP mandates are signed with ES256 (P-256) keys only');
  }
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: signer.kid, typ: OACP_MANDATE_TYP[type] }));
  const payload = b64url(JSON.stringify(claims));
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    key: signer.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

function typeForTyp(typ: unknown): OacpMandateType | null {
  for (const type of OACP_MANDATE_TYPES) {
    if (OACP_MANDATE_TYP[type] === typ) return type;
  }
  return null;
}

function commonClaimsValid(c: Record<string, unknown>): boolean {
  const status = isRecord(c['status']) && isRecord(c['status']['status_list']) ? c['status']['status_list'] : null;
  return typeof c['iss'] === 'string'
    && isRef(c['sub'])
    && isRef(c['aud'])
    && isNonNegativeInt(c['iat'])
    && isNonNegativeInt(c['exp'])
    && isRef(c['jti'])
    && c['mandate_version'] === OACP_MANDATE_VERSION
    && isRef(c['tenant_id'])
    && isRef(c['merchant_id'])
    && c['aud'] === c['merchant_id']
    && isRef(c['buyer_agent_id'])
    && (c['presence'] === 'human_present' || c['presence'] === 'human_not_present')
    && Array.isArray(c['amr']) && c['amr'].every((m) => typeof m === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(m))
    && isRef(c['passport_ref'])
    && isRef(c['consent_ref'])
    && status !== null
    && Object.keys(status).length === 2
    && typeof status['uri'] === 'string'
    && isNonNegativeInt(status['idx']);
}

function intentClaimsValid(c: Record<string, unknown>): boolean {
  const intent = c['intent'];
  if (!isRecord(intent)) return false;
  return typeof intent['description_hash'] === 'string' && HASH_B64URL.test(intent['description_hash'])
    && isAmount(intent['max_amount'])
    && isStringArray(intent['merchants']) && intent['merchants'].includes(c['merchant_id'] as string)
    && typeof intent['expires_at'] === 'string' && Number.isFinite(Date.parse(intent['expires_at']))
    && Array.isArray(intent['constraints']) && intent['constraints'].every((item) => isRecord(item) && typeof item['type'] === 'string')
    && (c['cnf'] === undefined || (isRecord(c['cnf']) && isRecord(c['cnf']['jwk'])));
}

function cartClaimsValid(c: Record<string, unknown>): boolean {
  const cart = c['cart'];
  if (!isRecord(cart)) return false;
  const lineItems = cart['line_items'];
  const cartOk = typeof cart['checkout_hash'] === 'string' && HASH_B64URL.test(cart['checkout_hash'])
    && isRef(cart['checkout_id'])
    && Array.isArray(lineItems) && lineItems.length > 0
    && lineItems.every((item) => isRecord(item) && typeof item['id'] === 'string' && item['id'].length > 0
      && typeof item['quantity'] === 'number' && Number.isSafeInteger(item['quantity']) && item['quantity'] >= 1
      && typeof item['digest'] === 'string' && HASH_B64URL.test(item['digest']))
    && isAmount(cart['total'])
    && isRef(c['intent_mandate_jti']);
  if (!cartOk) return false;
  const webauthn = c['webauthn'];
  if (c['presence'] === 'human_present') {
    // G45: a human-present cart carries the passkey assertion over its own hash.
    return isRecord(webauthn)
      && typeof webauthn['digest'] === 'string' && /^[a-f0-9]{64}$/.test(webauthn['digest'])
      && webauthn['challenge'] === cart['checkout_hash']
      && typeof webauthn['rp_id'] === 'string' && typeof webauthn['origin'] === 'string'
      && webauthn['user_verified'] === true
      && typeof webauthn['asserted_at'] === 'string'
      && typeof webauthn['credential_ref'] === 'string' && /^[a-f0-9]{64}$/.test(webauthn['credential_ref'])
      && (c['amr'] as string[]).includes('passkey');
  }
  return webauthn === undefined;
}

function paymentClaimsValid(c: Record<string, unknown>): boolean {
  const payment = c['payment'];
  if (!isRecord(payment)) return false;
  const binding = payment['token_binding'];
  const payee = payment['payee'];
  return typeof payment['transaction_id'] === 'string' && HASH_B64URL.test(payment['transaction_id'])
    && isNonNegativeInt(payment['amount'])
    && typeof payment['currency'] === 'string' && CURRENCY.test(payment['currency'])
    && isRecord(payee) && payee['id'] === c['merchant_id']
    && (OACP_PAYMENT_RAILS as readonly unknown[]).includes(payment['rail'])
    && isRecord(binding) && typeof binding['type'] === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(binding['type'])
    && isRef(binding['id'])
    && isRef(payment['cart_mandate_jti']);
}

const TYPE_CHECK: Record<OacpMandateType, (c: Record<string, unknown>) => boolean> = {
  intent: intentClaimsValid,
  cart: cartClaimsValid,
  payment: paymentClaimsValid,
};

/**
 * The status the relying party read for this mandate from its Token Status
 * List (0 VALID, 1 INVALID, 2 SUSPENDED), or 'unavailable'.
 */
export type OacpMandateStatusValue = number | 'unavailable';

/**
 * Steps 1-9 of the profile: everything but the status list. The caller then
 * reads `claims.status.status_list` and finishes with `oacpMandateStatusRefusal`
 * (or calls `verifyOacpMandate` with the status already read).
 */
export function verifyOacpMandateSignatureAndClaims(input: {
  mandate: unknown;
  jwks: OacpJwks | null | undefined;
  issuer: string;
  now_seconds: number;
  expected_type?: OacpMandateType | undefined;
  expected_audience?: string | undefined;
}): OacpMandateVerification {
  const refuse = (code: OacpMandateRefusalCode, type: OacpMandateType | null = null, claims: Record<string, unknown> | null = null): OacpMandateVerification =>
    ({ valid: false, refusal_code: code, mandate_type: type, claims });

  // 1.
  const parts = typeof input.mandate === 'string' ? input.mandate.split('.') : [];
  if (parts.length !== 3 || !parts.every((part) => part.length > 0 && B64URL.test(part))) return refuse('mandate_malformed');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // 2.
  let header: unknown = null;
  const headerRaw = b64urlDecode(headerB64);
  if (headerRaw) {
    try { header = parseJsonRejectingDuplicates(new TextDecoder('utf-8', { fatal: true }).decode(headerRaw)); } catch { header = null; }
  }
  if (!isRecord(header)) return refuse('mandate_malformed');
  if (header['alg'] !== 'ES256') return refuse('mandate_algorithm_unsupported');
  if (Object.keys(header).length !== 3 || typeof header['kid'] !== 'string' || !('typ' in header)) return refuse('mandate_malformed');
  const type = typeForTyp(header['typ']);
  if (type === null || (input.expected_type !== undefined && type !== input.expected_type)) {
    return refuse('mandate_type_mismatch', type);
  }

  // 3.
  const key = oacpTrustedKey(input.jwks, header['kid']);
  if (!key) return refuse('issuer_key_untrusted', type);

  // 4.
  const signature = b64urlDecode(signatureB64);
  const signed = signature !== null && signature.length === 64
    && cryptoVerify('sha256', Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!signed) return refuse('mandate_signature_invalid', type);

  // 5.
  let claims: unknown = null;
  const payloadRaw = b64urlDecode(payloadB64);
  if (payloadRaw) {
    try { claims = parseJsonRejectingDuplicates(new TextDecoder('utf-8', { fatal: true }).decode(payloadRaw)); } catch { claims = null; }
  }
  if (!isRecord(claims)) return refuse('mandate_malformed', type);

  // 6.
  if (claims['iss'] !== input.issuer) return refuse('mandate_issuer_mismatch', type, claims);

  // 7.
  if (!commonClaimsValid(claims) || !TYPE_CHECK[type](claims)) return refuse('mandate_claims_invalid', type, claims);

  // 8.
  const iat = claims['iat'] as number;
  const exp = claims['exp'] as number;
  if (iat > input.now_seconds + OACP_MANDATE_CLOCK_SKEW_SECONDS) return refuse('mandate_not_yet_valid', type, claims);
  if (input.now_seconds >= exp) return refuse('mandate_expired', type, claims);
  if (exp <= iat || exp - iat > OACP_MANDATE_MAX_LIFETIME_SECONDS) return refuse('mandate_lifetime_exceeded', type, claims);

  // 9.
  if (input.expected_audience !== undefined && claims['aud'] !== input.expected_audience) {
    return refuse('mandate_audience_mismatch', type, claims);
  }
  return { valid: true, refusal_code: null, mandate_type: type, claims: claims as unknown as OacpMandateClaims, kid: header['kid'] };
}

/** Step 10: null when the status list says VALID, else the refusal. */
export function oacpMandateStatusRefusal(claims: OacpMandateClaims, status: OacpMandateStatusValue): OacpMandateRefusalCode | null {
  if (!isOacpStatusUriAllowed(claims.status.status_list.uri)) return 'revocation_status_unavailable';
  if (status === 0) return null;
  if (status === 1) return 'mandate_revoked';
  if (status === 2) return 'mandate_suspended';
  return 'revocation_status_unavailable';
}

/** Steps 1-10 with the status the caller already read. */
export function verifyOacpMandate(input: {
  mandate: unknown;
  jwks: OacpJwks | null | undefined;
  issuer: string;
  now_seconds: number;
  status: OacpMandateStatusValue;
  expected_type?: OacpMandateType | undefined;
  expected_audience?: string | undefined;
}): OacpMandateVerification {
  const result = verifyOacpMandateSignatureAndClaims(input);
  if (!result.valid) return result;
  const code = oacpMandateStatusRefusal(result.claims, input.status);
  return code === null ? result : { valid: false, refusal_code: code, mandate_type: result.mandate_type, claims: result.claims as unknown as Record<string, unknown> };
}

/**
 * The chain a relying party checks across verified mandates: the cart names
 * the intent and stays within it, the payment names the cart and pays exactly
 * its total for its `checkout_hash`, and all three share the tenant, merchant,
 * buyer, buyer agent and consent. Null when consistent, else
 * `mandate_chain_mismatch`.
 */
export function oacpMandateChainRefusal(chain: {
  intent?: OacpIntentClaims | undefined;
  cart?: OacpCartClaims | undefined;
  payment?: OacpPaymentClaims | undefined;
}): 'mandate_chain_mismatch' | null {
  const { intent, cart, payment } = chain;
  const same = (a: OacpMandateCommonClaims, b: OacpMandateCommonClaims) =>
    a.tenant_id === b.tenant_id && a.merchant_id === b.merchant_id && a.sub === b.sub
    && a.buyer_agent_id === b.buyer_agent_id && a.consent_ref === b.consent_ref && a.iss === b.iss;
  if (intent && cart) {
    if (!same(intent, cart) || cart.intent_mandate_jti !== intent.jti) return 'mandate_chain_mismatch';
    if (cart.cart.total.currency !== intent.intent.max_amount.currency || cart.cart.total.value > intent.intent.max_amount.value) {
      return 'mandate_chain_mismatch';
    }
    if (!intent.intent.merchants.includes(cart.merchant_id) || cart.exp > intent.exp) return 'mandate_chain_mismatch';
    if (intent.presence === 'human_present' && cart.presence !== 'human_present') return 'mandate_chain_mismatch';
  }
  if (cart && payment) {
    if (!same(cart, payment) || payment.payment.cart_mandate_jti !== cart.jti) return 'mandate_chain_mismatch';
    if (payment.payment.transaction_id !== cart.cart.checkout_hash
      || payment.payment.amount !== cart.cart.total.value
      || payment.payment.currency !== cart.cart.total.currency
      || payment.presence !== cart.presence
      || payment.exp > cart.exp) {
      return 'mandate_chain_mismatch';
    }
  }
  if (intent && payment && !cart) return 'mandate_chain_mismatch';
  return null;
}
