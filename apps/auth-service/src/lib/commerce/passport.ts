import {
  SignJWT,
  jwtVerify,
  importJWK,
  decodeProtectedHeader,
  decodeJwt,
  type KeyLike,
  type JWTPayload,
  type JWK,
} from 'jose';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { newCommercePassportJti } from './ids.js';
import {
  getActiveCommercePassportSigner,
  findPublicKeyByKid,
} from './passport-keys.js';
import { checkPassportRevocation, type RevocationCheck } from './revocation.js';

type Sql = ReturnType<typeof postgres>;

// Spec §6: kid format namespace. Verifier rejects any header.kid that
// doesn't match this prefix, blocking cross-namespace kid confusion
// (e.g., a forged passport claiming to be signed by the platform RS256
// kid `grantex-2026-05`).
const COMMERCE_KID_RE = /^commerce-passport-[0-9]{8}-[a-z0-9]{8}$/;

const PASSPORT_AUDIENCE = 'grantex-commerce';
const CLOCK_SKEW_SECONDS = 30;

export type PassportType = 'browse' | 'checkout';
export type Environment = 'sandbox' | 'live';

/**
 * Spec §6 maximum passport lifetimes. Verification rejects any token
 * whose declared (exp - iat) exceeds these caps. This blocks the
 * "stolen retired key sets a far-future exp" vector — even if a key
 * were leaked the verifier refuses to honour any token claiming a
 * lifetime longer than what the platform issues.
 */
export const MAX_PASSPORT_LIFETIME_SECONDS: Record<PassportType, number> = {
  browse: 3600,
  checkout: 600,
};

export interface PassportClaimsToSign {
  jti: string;
  passportType: PassportType;
  tenantId: string;
  merchantId: string;
  agentId: string;
  consentRecordId: string;
  subject: string;                      // user_principal_id
  scopes: string[];
  maxAmount?: number | null;
  currency?: string | null;
  policyVersion?: string | null;
  environment: Environment;
  issuedAt: number;                     // epoch seconds
  notBefore: number;
  expiresAt: number;
}

export interface SignPassportResult {
  jwt: string;
  kid: string;
  jti: string;
}

export async function signCommercePassport(
  sql: Sql,
  claims: PassportClaimsToSign,
): Promise<SignPassportResult> {
  const signer = await getActiveCommercePassportSigner(sql);
  const jwt = await new SignJWT({
    passport_type: claims.passportType,
    tenant_id: claims.tenantId,
    merchant_id: claims.merchantId,
    agent_id: claims.agentId,
    consent_record_id: claims.consentRecordId,
    scopes: claims.scopes,
    ...(claims.maxAmount !== undefined && claims.maxAmount !== null
      ? { max_amount: claims.maxAmount } : {}),
    ...(claims.currency ? { currency: claims.currency } : {}),
    ...(claims.policyVersion ? { policy_version: claims.policyVersion } : {}),
    env: claims.environment,
    ver: '1',
  } satisfies JWTPayload)
    .setProtectedHeader({ alg: 'ES256', kid: signer.kid })
    .setIssuer(config.jwtIssuer)
    .setAudience(PASSPORT_AUDIENCE)
    .setSubject(claims.subject)
    .setJti(claims.jti)
    .setIssuedAt(claims.issuedAt)
    .setNotBefore(claims.notBefore)
    .setExpirationTime(claims.expiresAt)
    .sign(signer.privateKey);

  return { jwt, kid: signer.kid, jti: claims.jti };
}

export interface VerifiedPassport {
  jti: string;
  kid: string;
  passportType: PassportType;
  tenantId: string;
  merchantId: string;
  agentId: string;
  consentRecordId: string;
  subject: string;
  scopes: string[];
  maxAmount: number | null;
  currency: string | null;
  policyVersion: string | null;
  environment: Environment;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
}

export type VerifyPassportError =
  | { kind: 'malformed'; reason: string }
  | { kind: 'kid_required' }
  | { kind: 'kid_unknown'; kid: string }
  | { kind: 'kid_wrong_namespace'; kid: string }
  | { kind: 'kid_retired_iat_after'; kid: string; retiredAtUnix: number }
  | { kind: 'kid_retired_window_exceeded'; kid: string; retiredAtUnix: number; maxExpUnix: number }
  | { kind: 'algorithm_rejected'; alg: string }
  | { kind: 'signature_invalid'; reason: string }
  | { kind: 'expired' }
  | { kind: 'not_yet_valid' }
  | { kind: 'wrong_audience'; aud: unknown }
  | { kind: 'wrong_issuer'; iss: unknown }
  | { kind: 'missing_claims'; fields: string[] }
  | { kind: 'temporal_claim_invalid'; reason: string }
  | { kind: 'lifetime_exceeded'; passportType: PassportType; declaredLifetime: number; maxLifetime: number }
  | { kind: 'invalid_passport_type'; value: unknown }
  | { kind: 'revoked'; reason?: string }
  | { kind: 'revocation_unavailable'; error: string }
  | { kind: 'tenant_mismatch'; expected: string; actual: string }
  | { kind: 'merchant_mismatch'; expected: string; actual: string };

export type VerifyPassportResult =
  | { ok: true; passport: VerifiedPassport }
  | { ok: false; error: VerifyPassportError };

export interface VerifyOptions {
  /** When set, rejects with tenant_mismatch if passport.tenant_id !== expectedTenantId. */
  expectedTenantId?: string;
  /** When set, rejects with merchant_mismatch. */
  expectedMerchantId?: string;
  /**
   * `payment_affecting` triggers an online revocation check; on
   * revocation infrastructure failure the result is `revocation_unavailable`
   * (caller fails closed). `read_only` skips the online check and returns
   * ok=true even when Redis/Postgres are degraded — appropriate only for
   * non-payment reads.
   */
  mode: 'payment_affecting' | 'read_only';
}

export async function verifyCommercePassport(
  sql: Sql,
  redis: Redis | null,
  token: string,
  options: VerifyOptions,
): Promise<VerifyPassportResult> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch (err) {
    return { ok: false, error: { kind: 'malformed', reason: err instanceof Error ? err.message : 'decode failed' } };
  }
  if (header.alg && header.alg !== 'ES256') {
    return { ok: false, error: { kind: 'algorithm_rejected', alg: String(header.alg) } };
  }
  if (!header.kid) {
    return { ok: false, error: { kind: 'kid_required' } };
  }
  if (!COMMERCE_KID_RE.test(header.kid)) {
    return { ok: false, error: { kind: 'kid_wrong_namespace', kid: header.kid } };
  }

  const keyRecord = await findPublicKeyByKid(sql, header.kid);
  if (!keyRecord) {
    return { ok: false, error: { kind: 'kid_unknown', kid: header.kid } };
  }
  const publicKey = await importJWK(keyRecord.publicKeyJwk as unknown as JWK, 'ES256') as KeyLike;

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, publicKey, {
      issuer: config.jwtIssuer,
      audience: PASSPORT_AUDIENCE,
      algorithms: ['ES256'],
      clockTolerance: CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') return { ok: false, error: { kind: 'expired' } };
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      const reason = (err as { reason?: string }).reason;
      const claim = (err as { claim?: string }).claim;
      // Recover the unverified payload for error context (signature
      // already failed, but the raw values are useful for the caller).
      let rawPayload: JWTPayload | null = null;
      try { rawPayload = decodeJwt(token); } catch { /* ignore */ }
      if (claim === 'aud') return { ok: false, error: { kind: 'wrong_audience', aud: rawPayload?.aud } };
      if (claim === 'iss') return { ok: false, error: { kind: 'wrong_issuer', iss: rawPayload?.iss } };
      if (claim === 'nbf' || reason === 'nbf') return { ok: false, error: { kind: 'not_yet_valid' } };
    }
    return {
      ok: false,
      error: { kind: 'signature_invalid', reason: err instanceof Error ? err.message : 'verify failed' },
    };
  }

  const required = ['jti', 'sub', 'tenant_id', 'merchant_id', 'agent_id', 'consent_record_id', 'passport_type', 'scopes', 'env'];
  const missing = required.filter((k) => payload[k] === undefined || payload[k] === null);
  if (missing.length) return { ok: false, error: { kind: 'missing_claims', fields: missing } };

  // Temporal claims must be present and numeric. jose's jwtVerify
  // already validates exp/nbf semantics with clock-skew tolerance, but
  // it does NOT check that exp/iat/nbf exist or that exp - iat falls
  // within a sane window. Defense in depth.
  const iat = payload.iat;
  const exp = payload.exp;
  const nbf = payload.nbf;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    return { ok: false, error: { kind: 'temporal_claim_invalid', reason: 'iat missing or non-numeric' } };
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { ok: false, error: { kind: 'temporal_claim_invalid', reason: 'exp missing or non-numeric' } };
  }
  if (typeof nbf !== 'number' || !Number.isFinite(nbf)) {
    return { ok: false, error: { kind: 'temporal_claim_invalid', reason: 'nbf missing or non-numeric' } };
  }
  if (exp <= iat) {
    return { ok: false, error: { kind: 'temporal_claim_invalid', reason: 'exp must be greater than iat' } };
  }

  // Spec §6 max lifetime per passport type. Blocks "leaked key signs a
  // token with iat=valid + exp=999999999" — verifier refuses to honour
  // any token claiming a lifetime longer than what we ever issue. The
  // 30s tolerance matches the JWT clock-skew tolerance everywhere.
  const passportTypeRaw = payload['passport_type'];
  if (passportTypeRaw !== 'browse' && passportTypeRaw !== 'checkout') {
    return { ok: false, error: { kind: 'invalid_passport_type', value: passportTypeRaw } };
  }
  const passportType: PassportType = passportTypeRaw;
  const maxLifetime = MAX_PASSPORT_LIFETIME_SECONDS[passportType];
  const declaredLifetime = exp - iat;
  if (declaredLifetime > maxLifetime + CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      error: {
        kind: 'lifetime_exceeded',
        passportType,
        declaredLifetime,
        maxLifetime,
      },
    };
  }

  // Retired-key gates. Two separate failure modes:
  //   1. iat AFTER retired_at — stolen key trying to mint NEW passports
  //      timestamped post-retirement.
  //   2. iat BEFORE retired_at but exp BEYOND the retired-key window —
  //      stolen key backdates iat then sets exp far in the future to
  //      live on after retirement. Cap exp at retired_at + max_lifetime.
  if (keyRecord.retiredAt) {
    const retiredAtUnix = Math.floor(keyRecord.retiredAt.getTime() / 1000);
    if (iat > retiredAtUnix) {
      return {
        ok: false,
        error: { kind: 'kid_retired_iat_after', kid: header.kid, retiredAtUnix },
      };
    }
    const maxExpUnix = retiredAtUnix + maxLifetime + CLOCK_SKEW_SECONDS;
    if (exp > maxExpUnix) {
      return {
        ok: false,
        error: {
          kind: 'kid_retired_window_exceeded',
          kid: header.kid,
          retiredAtUnix,
          maxExpUnix,
        },
      };
    }
  }

  const tenantId = String(payload['tenant_id']);
  const merchantId = String(payload['merchant_id']);

  if (options.expectedTenantId && options.expectedTenantId !== tenantId) {
    return { ok: false, error: { kind: 'tenant_mismatch', expected: options.expectedTenantId, actual: tenantId } };
  }
  if (options.expectedMerchantId && options.expectedMerchantId !== merchantId) {
    return { ok: false, error: { kind: 'merchant_mismatch', expected: options.expectedMerchantId, actual: merchantId } };
  }

  if (options.mode === 'payment_affecting') {
    const revocation: RevocationCheck = await checkPassportRevocation(sql, redis, String(payload.jti));
    if (revocation.source === 'fail_closed_unavailable') {
      return { ok: false, error: { kind: 'revocation_unavailable', error: revocation.error } };
    }
    if (revocation.revoked) {
      return { ok: false, error: { kind: 'revoked', ...(revocation.source === 'postgres' && revocation.reason !== undefined ? { reason: revocation.reason } : {}) } };
    }
  }

  const passport: VerifiedPassport = {
    jti: String(payload.jti),
    kid: header.kid,
    passportType,                     // narrowed earlier
    tenantId,
    merchantId,
    agentId: String(payload['agent_id']),
    consentRecordId: String(payload['consent_record_id']),
    subject: String(payload.sub),
    scopes: payload['scopes'] as string[],
    maxAmount: typeof payload['max_amount'] === 'number' ? payload['max_amount'] : null,
    currency: typeof payload['currency'] === 'string' ? payload['currency'] : null,
    policyVersion: typeof payload['policy_version'] === 'string' ? payload['policy_version'] : null,
    environment: payload['env'] as Environment,
    issuedAt: iat,
    notBefore: nbf,
    expiresAt: exp,
  };
  return { ok: true, passport };
}

export { newCommercePassportJti };
