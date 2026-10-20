/**
 * Relying-party verification of OACP mandates (profile `oacp.mandate.v1`).
 *
 * Grantex issues Intent, Cart and Payment mandates as compact ES256 JWTs
 * (RFC 7519, RFC 7518 §3.4) signed by its OACP issuer key (`oacp-` kid in the
 * issuer JWK Set), with `typ` `oacp-intent-mandate+jwt`,
 * `oacp-cart-mandate+jwt` or `oacp-payment-mandate+jwt`. The claims carry AP2
 * v0.2 member names where AP2 has one (`checkout_hash`, `transaction_id`,
 * constraints, `cnf`, `payee`), and every mandate names its entry on the OACP
 * Token Status List (`status.status_list`, draft-ietf-oauth-status-list §6.1).
 *
 * `verifyOacpMandate` mirrors the auth service verifier
 * (`apps/auth-service/src/lib/commerce/oacp-mandate-jwt.ts`) and stops at the
 * first failure, in this order:
 *
 *  1. three non-empty base64url parts (`mandate_malformed`);
 *  2. header JSON object (`mandate_malformed`), alg ES256
 *     (`mandate_algorithm_unsupported`), exactly alg/kid/typ
 *     (`mandate_malformed`), typ one of the three and the expected one
 *     (`mandate_type_mismatch`);
 *  3. exactly one usable P-256 key with an `oacp-` kid (`issuer_key_untrusted`);
 *  4. the ES256 signature (`mandate_signature_invalid`);
 *  5. claims JSON object (`mandate_malformed`);
 *  6. `iss` is the pinned issuer (`mandate_issuer_mismatch`);
 *  7. claims present and well-typed for the type (`mandate_claims_invalid`);
 *  8. `iat` at most 60 s ahead (`mandate_not_yet_valid`), not expired
 *     (`mandate_expired`), `exp - iat` at most 600 s
 *     (`mandate_lifetime_exceeded`);
 *  9. `aud` is the expected merchant (`mandate_audience_mismatch`);
 * 10. Token Status List VALID (`mandate_revoked`, `mandate_suspended`,
 *     `revocation_status_unavailable`: fail closed).
 *
 * `checkOacpMandateChain` then checks that the cart names the intent and
 * stays within it and that the payment names the cart and pays exactly its
 * total for its `checkout_hash` (`mandate_chain_mismatch`).
 *
 * Shared test vectors: `spec/examples/oacp/oacp-mandates-v1.json`.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../canonical.js';
import { decodeBase64urlStrict, decodeJsonSegment, selectVerificationKey, verifyJwsSignature, type OacpJwks } from './jose.js';
import { OACP_TOKEN_STATUS, readOacpStatus } from './status-list.js';
import { isLoopbackHost, type OacpJwksSource, type OacpStatusListFetcher } from './fetchers.js';

export const OACP_MANDATE_TYPES = ['intent', 'cart', 'payment'] as const;
export type OacpMandateType = typeof OACP_MANDATE_TYPES[number];
export const OACP_MANDATE_TYP: Readonly<Record<OacpMandateType, string>> = Object.freeze({
  intent: 'oacp-intent-mandate+jwt',
  cart: 'oacp-cart-mandate+jwt',
  payment: 'oacp-payment-mandate+jwt',
});
export const OACP_MANDATE_VERSION = 'oacp.mandate.v1';
export const OACP_MANDATE_MAX_LIFETIME_SECONDS = 600;
export const OACP_MANDATE_CLOCK_SKEW_SECONDS = 60;
export const OACP_PAYMENT_RAILS = ['plural', 'upi_autopay', 'card_network_token'] as const;

/** Every refusal code `verifyOacpMandate` returns, in check order. */
export const OACP_MANDATE_REFUSAL_CODES = [
  'mandate_malformed',
  'mandate_algorithm_unsupported',
  'mandate_type_mismatch',
  'issuer_key_untrusted',
  'mandate_signature_invalid',
  'mandate_issuer_mismatch',
  'mandate_claims_invalid',
  'mandate_not_yet_valid',
  'mandate_expired',
  'mandate_lifetime_exceeded',
  'mandate_audience_mismatch',
  'revocation_status_unavailable',
  'mandate_revoked',
  'mandate_suspended',
] as const;
export type OacpMandateRefusalCode = typeof OACP_MANDATE_REFUSAL_CODES[number];

export interface VerifyOacpMandateOptions {
  /** The pinned issuer identifier; `iss` must equal it. */
  issuer: string;
  /** The issuer's JWK Set, or a source bound to its pinned JWKS URI (`createOacpJwksFetcher`). */
  jwks: OacpJwksSource;
  /** The time to verify at. Default now. */
  now?: Date;
  /** Refuse a mandate of another type (`mandate_type_mismatch`). */
  expectedType?: OacpMandateType;
  /** Refuse a mandate for another merchant (`mandate_audience_mismatch`). */
  expectedAudience?: string;
  /** Fetches the Token Status List the mandate names (`createOacpStatusListFetcher`). */
  statusListFetcher?: OacpStatusListFetcher;
  /**
   * The status already read for this mandate by other means (0 VALID,
   * 1 INVALID, 2 SUSPENDED, or 'unavailable'); used instead of fetching.
   */
  status?: number | 'unavailable';
  /** Set false only to verify signatures offline: the result says `status: 'not_checked'`. Default true. */
  checkStatus?: boolean;
  /** Accept an http status URI on a loopback host (local development only). Default false. */
  allowLoopbackHttp?: boolean;
}

export type OacpMandateClaims = Record<string, unknown> & {
  iss: string; sub: string; aud: string; iat: number; exp: number; jti: string;
  tenant_id: string; merchant_id: string; buyer_agent_id: string;
  presence: 'human_present' | 'human_not_present'; amr: string[];
  passport_ref: string; consent_ref: string;
  status: { status_list: { idx: number; uri: string } };
};

export type OacpMandateVerification =
  | {
    valid: true;
    mandateType: OacpMandateType;
    jti: string;
    kid: string;
    /** Lowercase hex SHA-256 of the compact JWT (the ledger's `mandate_hash`). */
    mandateHash: string;
    claims: OacpMandateClaims;
    status: 'valid' | 'not_checked';
  }
  | {
    valid: false;
    refusalCode: OacpMandateRefusalCode;
    message: string;
    mandateType: OacpMandateType | null;
  };

const B64URL = /^[A-Za-z0-9_-]+$/;
const HASH_B64URL = /^[A-Za-z0-9_-]{43}$/;
const CURRENCY = /^[A-Z]{3}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isRef = (v: unknown): v is string => typeof v === 'string' && REF.test(v);
const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isAmount = (v: unknown): boolean => isPlainObject(v) && isNonNegativeInt(v['value']) && typeof v['currency'] === 'string' && CURRENCY.test(v['currency']);

/** AP2 `checkout_hash` of a checkout object: b64url SHA-256 of its RFC 8785 form. */
export function oacpCheckoutHash(checkout: unknown): string {
  return createHash('sha256').update(canonicalize(checkout), 'utf8').digest('base64url');
}

/** Lowercase hex SHA-256 of a compact mandate JWT. */
export function oacpMandateHash(mandate: string): string {
  return createHash('sha256').update(mandate, 'ascii').digest('hex');
}

function commonValid(c: Record<string, unknown>): boolean {
  const status = isPlainObject(c['status']) && isPlainObject(c['status']['status_list']) ? c['status']['status_list'] : null;
  return typeof c['iss'] === 'string' && isRef(c['sub']) && isRef(c['aud'])
    && isNonNegativeInt(c['iat']) && isNonNegativeInt(c['exp']) && isRef(c['jti'])
    && c['mandate_version'] === OACP_MANDATE_VERSION
    && isRef(c['tenant_id']) && isRef(c['merchant_id']) && c['aud'] === c['merchant_id']
    && isRef(c['buyer_agent_id'])
    && (c['presence'] === 'human_present' || c['presence'] === 'human_not_present')
    && Array.isArray(c['amr']) && c['amr'].every((m) => typeof m === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(m))
    && isRef(c['passport_ref']) && isRef(c['consent_ref'])
    && status !== null && Object.keys(status).length === 2
    && typeof status['uri'] === 'string' && isNonNegativeInt(status['idx']);
}

function typeValid(type: OacpMandateType, c: Record<string, unknown>): boolean {
  if (type === 'intent') {
    const i = c['intent'];
    return isPlainObject(i)
      && typeof i['description_hash'] === 'string' && HASH_B64URL.test(i['description_hash'])
      && isAmount(i['max_amount'])
      && Array.isArray(i['merchants']) && i['merchants'].every((m) => typeof m === 'string' && m.length > 0)
      && i['merchants'].includes(c['merchant_id'])
      && typeof i['expires_at'] === 'string' && Number.isFinite(Date.parse(i['expires_at']))
      && Array.isArray(i['constraints']) && i['constraints'].every((x) => isPlainObject(x) && typeof x['type'] === 'string')
      && (c['cnf'] === undefined || (isPlainObject(c['cnf']) && isPlainObject(c['cnf']['jwk'])));
  }
  if (type === 'cart') {
    const cart = c['cart'];
    if (!isPlainObject(cart)) return false;
    const items = cart['line_items'];
    const ok = typeof cart['checkout_hash'] === 'string' && HASH_B64URL.test(cart['checkout_hash'])
      && isRef(cart['checkout_id'])
      && Array.isArray(items) && items.length > 0
      && items.every((item) => isPlainObject(item) && typeof item['id'] === 'string' && item['id'].length > 0
        && typeof item['quantity'] === 'number' && Number.isSafeInteger(item['quantity']) && item['quantity'] >= 1
        && typeof item['digest'] === 'string' && HASH_B64URL.test(item['digest']))
      && isAmount(cart['total'])
      && isRef(c['intent_mandate_jti']);
    if (!ok) return false;
    const w = c['webauthn'];
    if (c['presence'] === 'human_present') {
      return isPlainObject(w)
        && typeof w['digest'] === 'string' && /^[a-f0-9]{64}$/.test(w['digest'])
        && w['challenge'] === cart['checkout_hash']
        && typeof w['rp_id'] === 'string' && typeof w['origin'] === 'string'
        && w['user_verified'] === true && typeof w['asserted_at'] === 'string'
        && typeof w['credential_ref'] === 'string' && /^[a-f0-9]{64}$/.test(w['credential_ref'])
        && (c['amr'] as string[]).includes('passkey');
    }
    return w === undefined;
  }
  const p = c['payment'];
  if (!isPlainObject(p)) return false;
  const binding = p['token_binding'];
  const payee = p['payee'];
  return typeof p['transaction_id'] === 'string' && HASH_B64URL.test(p['transaction_id'])
    && isNonNegativeInt(p['amount'])
    && typeof p['currency'] === 'string' && CURRENCY.test(p['currency'])
    && isPlainObject(payee) && payee['id'] === c['merchant_id']
    && (OACP_PAYMENT_RAILS as readonly unknown[]).includes(p['rail'])
    && isPlainObject(binding) && typeof binding['type'] === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(binding['type'])
    && isRef(binding['id'])
    && isRef(p['cart_mandate_jti']);
}

function statusUriAllowed(uri: string, allowLoopbackHttp: boolean): boolean {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.protocol === 'https:') return true;
  return allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

async function loadJwks(source: OacpJwksSource, refresh: boolean): Promise<OacpJwks> {
  return typeof source === 'function' ? source({ refresh }) : source;
}

/** Verifies one OACP mandate. Never throws; a refusal carries its code. */
export async function verifyOacpMandate(mandate: unknown, options: VerifyOacpMandateOptions): Promise<OacpMandateVerification> {
  let mandateType: OacpMandateType | null = null;
  const refuse = (refusalCode: OacpMandateRefusalCode, message: string): OacpMandateVerification =>
    ({ valid: false, refusalCode, message, mandateType });

  // 1.
  const parts = typeof mandate === 'string' && mandate.length <= 32_768 ? mandate.split('.') : [];
  if (parts.length !== 3 || !parts.every((part) => part.length > 0 && B64URL.test(part))) {
    return refuse('mandate_malformed', 'The mandate is not a compact JWS.');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  // 2.
  const header = decodeJsonSegment(headerSegment);
  if (header === null) return refuse('mandate_malformed', 'The header is not a JSON object.');
  if (header['alg'] !== 'ES256') return refuse('mandate_algorithm_unsupported', 'The mandate algorithm is not ES256.');
  if (Object.keys(header).length !== 3 || typeof header['kid'] !== 'string' || !('typ' in header)) {
    return refuse('mandate_malformed', 'The header is not exactly alg, kid and typ.');
  }
  mandateType = OACP_MANDATE_TYPES.find((type) => OACP_MANDATE_TYP[type] === header['typ']) ?? null;
  if (mandateType === null || (options.expectedType !== undefined && mandateType !== options.expectedType)) {
    return refuse('mandate_type_mismatch', 'The mandate typ is not the expected OACP mandate type.');
  }

  // 3.
  const kid = header['kid'];
  if (!kid.startsWith('oacp-')) return refuse('issuer_key_untrusted', 'The kid is not an OACP issuer key.');
  let jwks: OacpJwks;
  try {
    jwks = await loadJwks(options.jwks, false);
  } catch {
    return refuse('issuer_key_untrusted', 'The issuer JWK Set is unavailable.');
  }
  let key = selectVerificationKey(jwks, kid, 'ES256');
  if (!key.ok && typeof options.jwks === 'function') {
    try {
      jwks = await loadJwks(options.jwks, true);
      key = selectVerificationKey(jwks, kid, 'ES256');
    } catch {
      // keep the first answer
    }
  }
  if (!key.ok) return refuse('issuer_key_untrusted', `The issuer key is not trusted: ${key.reason}.`);

  // 4.
  const signature = decodeBase64urlStrict(signatureSegment);
  if (signature === null || !verifyJwsSignature('ES256', key.key, `${headerSegment}.${payloadSegment}`, signature)) {
    return refuse('mandate_signature_invalid', 'The mandate signature does not verify.');
  }

  // 5.
  const claims = decodeJsonSegment(payloadSegment);
  if (claims === null) return refuse('mandate_malformed', 'The claims are not a JSON object.');

  // 6.
  if (claims['iss'] !== options.issuer) return refuse('mandate_issuer_mismatch', 'The mandate names another issuer.');

  // 7.
  if (!commonValid(claims) || !typeValid(mandateType, claims)) {
    return refuse('mandate_claims_invalid', `The ${mandateType} mandate claims are missing or malformed.`);
  }

  // 8.
  const nowS = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const iat = claims['iat'] as number;
  const exp = claims['exp'] as number;
  if (iat > nowS + OACP_MANDATE_CLOCK_SKEW_SECONDS) return refuse('mandate_not_yet_valid', 'The mandate is not yet valid.');
  if (nowS >= exp) return refuse('mandate_expired', 'The mandate has expired.');
  if (exp <= iat || exp - iat > OACP_MANDATE_MAX_LIFETIME_SECONDS) {
    return refuse('mandate_lifetime_exceeded', 'The mandate lifetime exceeds the profile maximum.');
  }

  // 9.
  if (options.expectedAudience !== undefined && claims['aud'] !== options.expectedAudience) {
    return refuse('mandate_audience_mismatch', 'The mandate is for another merchant.');
  }

  const accepted = {
    valid: true as const,
    mandateType,
    jti: claims['jti'] as string,
    kid,
    mandateHash: oacpMandateHash(mandate as string),
    claims: claims as OacpMandateClaims,
  };
  if (options.checkStatus === false) return { ...accepted, status: 'not_checked' };

  // 10.
  const { uri, idx } = (claims as OacpMandateClaims).status.status_list;
  if (!statusUriAllowed(uri, options.allowLoopbackHttp === true)) {
    return refuse('revocation_status_unavailable', 'The mandate does not name an https status list.');
  }
  let status: number | 'unavailable';
  if (options.status !== undefined) {
    status = options.status;
  } else if (!options.statusListFetcher) {
    return refuse('revocation_status_unavailable', 'No status list fetcher is configured.');
  } else {
    try {
      const token = await options.statusListFetcher(uri);
      status = readOacpStatus({ token, uri, idx, jwks, issuer: options.issuer, now: new Date(nowS * 1000) }).status;
    } catch (err) {
      return refuse('revocation_status_unavailable', `The status list cannot be read: ${(err as Error).message}`);
    }
  }
  if (status === OACP_TOKEN_STATUS.INVALID) return refuse('mandate_revoked', 'The mandate is revoked.');
  if (status === OACP_TOKEN_STATUS.SUSPENDED) return refuse('mandate_suspended', 'The mandate is suspended.');
  if (status !== OACP_TOKEN_STATUS.VALID) return refuse('revocation_status_unavailable', 'The mandate status could not be established.');
  return { ...accepted, status: 'valid' };
}

/**
 * Checks verified mandates against each other. Null when consistent, else
 * `mandate_chain_mismatch`. Pass the `claims` of `verifyOacpMandate` results.
 */
export function checkOacpMandateChain(chain: {
  intent?: Record<string, any>;
  cart?: Record<string, any>;
  payment?: Record<string, any>;
}): 'mandate_chain_mismatch' | null {
  const { intent, cart, payment } = chain;
  const same = (a: Record<string, any>, b: Record<string, any>) =>
    a['tenant_id'] === b['tenant_id'] && a['merchant_id'] === b['merchant_id'] && a['sub'] === b['sub']
    && a['buyer_agent_id'] === b['buyer_agent_id'] && a['consent_ref'] === b['consent_ref'] && a['iss'] === b['iss'];
  if (intent && cart) {
    if (!same(intent, cart) || cart['intent_mandate_jti'] !== intent['jti']) return 'mandate_chain_mismatch';
    const cap = intent['intent']?.['max_amount'];
    const total = cart['cart']?.['total'];
    if (!cap || !total || total['currency'] !== cap['currency'] || total['value'] > cap['value']) return 'mandate_chain_mismatch';
    if (!Array.isArray(intent['intent']?.['merchants']) || !intent['intent']['merchants'].includes(cart['merchant_id'])) return 'mandate_chain_mismatch';
    if (cart['exp'] > intent['exp']) return 'mandate_chain_mismatch';
    if (intent['presence'] === 'human_present' && cart['presence'] !== 'human_present') return 'mandate_chain_mismatch';
  }
  if (cart && payment) {
    const p = payment['payment'];
    const c = cart['cart'];
    if (!same(cart, payment) || !p || !c || p['cart_mandate_jti'] !== cart['jti']) return 'mandate_chain_mismatch';
    if (p['transaction_id'] !== c['checkout_hash'] || p['amount'] !== c['total']?.['value']
      || p['currency'] !== c['total']?.['currency'] || payment['presence'] !== cart['presence'] || payment['exp'] > cart['exp']) {
      return 'mandate_chain_mismatch';
    }
  }
  if (intent && payment && !cart) return 'mandate_chain_mismatch';
  return null;
}
