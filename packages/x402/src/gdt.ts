/**
 * GDT (Grantex Delegation Token) issuance.
 *
 * Issues a W3C VC 2.0 credential encoded as a JWT, signed with Ed25519 (EdDSA).
 */

import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { importPrivateKey, derivePublicKey } from './crypto.js';
import { getAuditLog } from './audit.js';
import type { IssueGDTParams, GDTToken, GDTJWTPayload, VCPayload } from './types.js';

/** W3C VC 2.0 context URLs. */
const VC_CONTEXT = [
  'https://www.w3.org/ns/credentials/v2',
  'https://grantex.dev/v1/x402',
] as const;

/** VC types for a GDT. */
const VC_TYPES = ['VerifiableCredential', 'GrantexDelegationToken'] as const;

/**
 * Parse an expiry string into epoch seconds.
 *
 * Supports:
 * - ISO 8601 durations: "PT24H", "PT1H", "P7D", "P30D"
 * - Shorthand: "1h", "24h", "7d", "30d"
 * - ISO 8601 datetime: "2026-03-22T00:00:00Z"
 */
export function parseExpiry(expiry: string): number {
  // ISO 8601 datetime (contains 'T' and digits around it, or ends with 'Z')
  if (/^\d{4}-\d{2}-\d{2}/.test(expiry)) {
    const ms = Date.parse(expiry);
    if (isNaN(ms)) throw new Error(`Invalid expiry datetime: ${expiry}`);
    return Math.floor(ms / 1000);
  }

  const now = Math.floor(Date.now() / 1000);

  // ISO 8601 duration or shorthand
  const upper = expiry.toUpperCase();

  // PT<N>H — hours
  let match = upper.match(/^PT?(\d+)H$/);
  if (match) return now + parseInt(match[1]!, 10) * 3600;

  // P<N>D — days
  match = upper.match(/^P(\d+)D$/);
  if (match) return now + parseInt(match[1]!, 10) * 86400;

  // Shorthand: <N>h, <N>d
  match = expiry.match(/^(\d+)([hd])$/i);
  if (match) {
    const n = parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();
    if (unit === 'h') return now + n * 3600;
    if (unit === 'd') return now + n * 86400;
  }

  throw new Error(
    `Invalid expiry format: "${expiry}". Use ISO 8601 duration (PT24H, P7D), shorthand (24h, 7d), or datetime (2026-03-22T00:00:00Z).`,
  );
}

/**
 * Issue a Grantex Delegation Token (GDT).
 *
 * Creates a W3C VC 2.0 JWT encoding the delegation scope, spend limit,
 * expiry, agent DID, and principal DID. Signed with Ed25519 (EdDSA).
 *
 * @returns The signed JWT string (compact serialization).
 */
export async function issueGDT(params: IssueGDTParams): Promise<GDTToken> {
  const { agentDID, scope, spendLimit, expiry, signingKey, delegationChain, paymentChain } = params;

  // Validate inputs
  if (!agentDID || !agentDID.startsWith('did:')) {
    throw new Error('agentDID must be a valid DID string');
  }
  if (!scope || scope.length === 0) {
    throw new Error('scope must be a non-empty array of resource:action strings');
  }
  if (spendLimit.amount <= 0) {
    throw new Error('spendLimit.amount must be positive');
  }
  if (signingKey.length !== 32) {
    throw new Error('signingKey must be a 32-byte Ed25519 private key seed');
  }

  // Derive principal identity
  const { publicKey, did: derivedDID } = derivePublicKey(signingKey);
  const principalDID = params.principalDID ?? derivedDID;

  // Build VC payload
  const vc: VCPayload = {
    '@context': [...VC_CONTEXT],
    type: [...VC_TYPES],
    credentialSubject: {
      id: agentDID,
      scope,
      spendLimit,
      paymentChain: paymentChain ?? 'base',
      delegationChain: delegationChain ?? [principalDID],
    },
  };

  const jti = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const exp = parseExpiry(expiry);

  if (exp <= iat) {
    throw new Error('Expiry must be in the future');
  }

  // Sign JWT
  const key = await importPrivateKey(signingKey, publicKey);
  const token = await new SignJWT({ vc } as never)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(principalDID)
    .setSubject(agentDID)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);

  // Audit log
  const auditLog = getAuditLog();
  await auditLog.log({
    eventType: 'issuance',
    agentDID,
    principalDID,
    scope,
    tokenId: jti,
    details: { spendLimit, expiry, paymentChain: paymentChain ?? 'base' },
  });

  return token;
}
