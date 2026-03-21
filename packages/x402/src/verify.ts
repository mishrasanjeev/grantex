/**
 * GDT (Grantex Delegation Token) verification.
 *
 * Validates a GDT JWT against a request context: signature, expiry, scope match,
 * spend limit, and revocation status.
 */

import { jwtVerify, decodeJwt } from 'jose';
import { importPublicKeyFromDID } from './crypto.js';
import { isValidDID } from './did.js';
import { getRevocationRegistry } from './revocation.js';
import { getAuditLog } from './audit.js';
import type { VerifyContext, VerifyResult, GDTJWTPayload, VCPayload } from './types.js';

/** Construct a failed VerifyResult. */
function fail(error: string, partial?: Partial<VerifyResult>): VerifyResult {
  return {
    valid: false,
    agentDID: partial?.agentDID ?? '',
    principalDID: partial?.principalDID ?? '',
    remainingLimit: 0,
    error,
    tokenId: partial?.tokenId ?? '',
    scopes: partial?.scopes ?? [],
    expiresAt: partial?.expiresAt ?? '',
  };
}

/**
 * Verify a Grantex Delegation Token (GDT) against a request context.
 *
 * Checks:
 * 1. JWT signature (Ed25519 / EdDSA)
 * 2. Token expiry
 * 3. Revocation status
 * 4. Scope match — requested resource must be in the granted scopes
 * 5. Spend limit — request amount must not exceed the remaining limit
 * 6. VC structure — W3C VC 2.0 credential format
 *
 * @param token   The GDT JWT string.
 * @param context The request context to verify against.
 * @returns       VerifyResult with valid=true on success or error details on failure.
 */
export async function verifyGDT(token: string, context: VerifyContext): Promise<VerifyResult> {
  let decoded: Record<string, unknown>;

  // Step 0: Decode without verification to extract issuer DID
  try {
    decoded = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return fail('Invalid JWT: unable to decode token');
  }

  const iss = decoded['iss'] as string | undefined;
  const sub = decoded['sub'] as string | undefined;
  const jti = decoded['jti'] as string | undefined;
  const exp = decoded['exp'] as number | undefined;
  const vc = decoded['vc'] as VCPayload | undefined;

  if (!iss || !sub || !jti) {
    return fail('Invalid GDT: missing required claims (iss, sub, jti)');
  }

  const partial: Partial<VerifyResult> = {
    agentDID: sub,
    principalDID: iss,
    tokenId: jti,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : '',
  };

  // Step 1: Validate issuer DID format
  if (!isValidDID(iss)) {
    return fail('Invalid issuer DID format', partial);
  }

  // Step 2: Verify JWT signature using issuer's public key
  try {
    const publicKey = await importPublicKeyFromDID(iss);
    await jwtVerify(token, publicKey, { algorithms: ['EdDSA'] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    if (msg.includes('expired') || msg.includes('"exp" claim')) {
      return fail('Token has expired', partial);
    }
    return fail(`Signature verification failed: ${msg}`, partial);
  }

  // Step 3: Check revocation
  const registry = getRevocationRegistry();
  if (await registry.isRevoked(jti)) {
    await logEvent('rejection', sub, iss, [], jti, { reason: 'revoked' });
    return fail('Token has been revoked', partial);
  }

  // Step 4: Validate VC structure
  if (!vc || !vc.credentialSubject) {
    return fail('Invalid GDT: missing vc.credentialSubject', partial);
  }

  const credSub = vc.credentialSubject;
  const grantedScopes = credSub.scope;
  if (!Array.isArray(grantedScopes) || grantedScopes.length === 0) {
    return fail('Invalid GDT: credentialSubject.scope must be a non-empty array', partial);
  }

  partial.scopes = grantedScopes;

  // Step 5: Check scope match
  if (!scopeMatches(context.resource, grantedScopes)) {
    await logEvent('rejection', sub, iss, grantedScopes, jti, {
      reason: 'scope_mismatch',
      requested: context.resource,
    });
    return fail(
      `Scope mismatch: requested "${context.resource}" is not covered by granted scopes [${grantedScopes.join(', ')}]`,
      partial,
    );
  }

  // Step 6: Check spend limit
  const spendLimit = credSub.spendLimit;
  if (!spendLimit) {
    return fail('Invalid GDT: missing spendLimit in credentialSubject', partial);
  }

  if (context.currency !== spendLimit.currency) {
    return fail(
      `Currency mismatch: request uses ${context.currency} but GDT authorises ${spendLimit.currency}`,
      partial,
    );
  }

  if (context.amount > spendLimit.amount) {
    await logEvent('rejection', sub, iss, grantedScopes, jti, {
      reason: 'spend_limit_exceeded',
      requested: context.amount,
      limit: spendLimit.amount,
    });
    return fail(
      `Spend limit exceeded: request amount ${context.amount} ${context.currency} exceeds limit of ${spendLimit.amount} ${spendLimit.currency}`,
      partial,
    );
  }

  const remainingLimit = spendLimit.amount - context.amount;

  // Step 7: Verify VC types
  const types = vc.type;
  if (
    !Array.isArray(types) ||
    !types.includes('VerifiableCredential') ||
    !types.includes('GrantexDelegationToken')
  ) {
    return fail('Invalid GDT: VC type must include VerifiableCredential and GrantexDelegationToken', partial);
  }

  // Success — log verification
  await logEvent('verification', sub, iss, grantedScopes, jti, {
    resource: context.resource,
    amount: context.amount,
    currency: context.currency,
    remainingLimit,
  });

  return {
    valid: true,
    agentDID: sub,
    principalDID: iss,
    remainingLimit,
    tokenId: jti,
    scopes: grantedScopes,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : '',
  };
}

/**
 * Decode a GDT JWT without verification (for inspection only).
 */
export function decodeGDT(token: string): GDTJWTPayload {
  return decodeJwt(token) as unknown as GDTJWTPayload;
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

/**
 * Check whether a requested resource:action matches any of the granted scopes.
 *
 * Supports wildcard matching:
 * - "weather:*" matches "weather:read", "weather:write"
 * - "*" matches everything
 * - Exact match: "weather:read" matches "weather:read"
 */
function scopeMatches(requested: string, granted: string[]): boolean {
  for (const scope of granted) {
    if (scope === '*') return true;
    if (scope === requested) return true;

    // Wildcard: "weather:*" matches "weather:read"
    if (scope.endsWith(':*')) {
      const prefix = scope.slice(0, -1); // "weather:"
      if (requested.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal audit helper
// ---------------------------------------------------------------------------

async function logEvent(
  eventType: 'verification' | 'rejection',
  agentDID: string,
  principalDID: string,
  scope: string[],
  tokenId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const auditLog = getAuditLog();
    await auditLog.log({ eventType, agentDID, principalDID, scope, tokenId, details });
  } catch {
    // Audit logging should never break the verification flow
  }
}
