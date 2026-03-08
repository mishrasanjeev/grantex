/**
 * SD-JWT (Selective Disclosure JWT) implementation per draft-ietf-oauth-selective-disclosure-jwt.
 *
 * SD-JWT format: <issuer-jwt>~<disclosure1>~<disclosure2>~...~<optional-kb-jwt>
 * Each disclosure is: base64url(JSON([salt, claim_name, claim_value]))
 *
 * Uses the existing RS256 key pair from crypto.ts and `jose` for JWT operations.
 */

import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify, decodeJwt, decodeProtectedHeader } from 'jose';
import { getKeyPair } from './crypto.js';
import { newVerifiableCredentialId } from './ids.js';
import { config } from '../config.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SDJWTIssueParams {
  grantId: string;
  agentDid: string;
  principalId: string;
  developerId: string;
  scopes: string[];
  expiresAt: Date;
  delegationDepth?: number;
  selectiveFields?: string[];
}

export interface SDJWTVerifyResult {
  valid: boolean;
  vcId?: string;
  disclosedClaims?: Record<string, unknown>;
  error?: string;
}

export interface Disclosure {
  salt: string;
  claimName: string;
  claimValue: unknown;
  encoded: string;
  digest: string;
}

// Default fields that are selectively disclosable
const DEFAULT_SELECTIVE_FIELDS = ['principalId', 'developerId', 'scopes', 'delegationDepth'];

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random salt as base64url string.
 */
function generateSalt(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Create a disclosure triplet [salt, claimName, claimValue] and encode it.
 */
function createDisclosure(claimName: string, claimValue: unknown): Disclosure {
  const salt = generateSalt();
  const triplet = JSON.stringify([salt, claimName, claimValue]);
  const encoded = Buffer.from(triplet, 'utf-8').toString('base64url');
  const digest = hashDisclosure(encoded);
  return { salt, claimName, claimValue, encoded, digest };
}

/**
 * SHA-256 hash of a disclosure, returned as base64url string.
 */
function hashDisclosure(encodedDisclosure: string): string {
  return createHash('sha256').update(encodedDisclosure, 'ascii').digest().toString('base64url');
}

/**
 * Decode a base64url-encoded disclosure back to [salt, claimName, claimValue].
 */
function decodeDisclosure(encoded: string): { salt: string; claimName: string; claimValue: unknown } | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [salt, claimName, claimValue] = parsed as [string, string, unknown];
    if (typeof salt !== 'string' || typeof claimName !== 'string') return null;
    return { salt, claimName, claimValue };
  } catch {
    return null;
  }
}

// ── SD-JWT Issuance ─────────────────────────────────────────────────────────

/**
 * Issue an SD-JWT with selective disclosure for credential subject fields.
 *
 * Returns the full SD-JWT string: <issuer-jwt>~<disclosure1>~<disclosure2>~...~
 */
export async function issueSDJWT(params: SDJWTIssueParams): Promise<{
  vcId: string;
  sdJwt: string;
  disclosures: string[];
}> {
  const {
    grantId,
    agentDid,
    principalId,
    developerId,
    scopes,
    expiresAt,
    delegationDepth = 0,
  } = params;

  const selectiveFields = params.selectiveFields ?? DEFAULT_SELECTIVE_FIELDS;
  const vcId = newVerifiableCredentialId();
  const { privateKey, kid } = getKeyPair();
  const domain = config.didWebDomain;
  const issuerDid = `did:web:${domain}`;

  // Build the full credential subject
  const allClaims: Record<string, unknown> = {
    id: agentDid,
    type: 'AIAgent',
    principalId,
    developerId,
    grantId,
    scopes,
    delegationDepth,
  };

  // Create disclosures for selective fields
  const disclosures: Disclosure[] = [];
  const sdDigests: string[] = [];
  const visibleClaims: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(allClaims)) {
    if (selectiveFields.includes(key)) {
      const disclosure = createDisclosure(key, value);
      disclosures.push(disclosure);
      sdDigests.push(disclosure.digest);
    } else {
      visibleClaims[key] = value;
    }
  }

  // Build the credentialSubject with _sd array
  const credentialSubject: Record<string, unknown> = {
    ...visibleClaims,
    _sd: sdDigests,
  };

  const vcClaim = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://grantex.dev/ns/credentials/v1',
    ],
    type: ['VerifiableCredential', 'AgentGrantCredential'],
    credentialSubject,
  };

  // Sign the issuer JWT
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);

  const issuerJwt = await new SignJWT({
    vc: vcClaim,
    _sd_alg: 'sha-256',
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'vc+sd-jwt' })
    .setIssuer(issuerDid)
    .setSubject(agentDid)
    .setJti(vcId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  // Build the SD-JWT: <issuer-jwt>~<disclosure1>~<disclosure2>~...~
  const disclosureStrings = disclosures.map((d) => d.encoded);
  const sdJwt = issuerJwt + '~' + disclosureStrings.join('~') + '~';

  return { vcId, sdJwt, disclosures: disclosureStrings };
}

// ── SD-JWT Verification ─────────────────────────────────────────────────────

/**
 * Verify an SD-JWT and return the disclosed claims.
 *
 * Accepts both full SD-JWTs (with all disclosures) and presentations
 * (with a subset of disclosures, optionally with a key-binding JWT).
 */
export async function verifySDJWT(sdJwt: string): Promise<SDJWTVerifyResult> {
  // Parse the SD-JWT format: <issuer-jwt>~<disclosure1>~...~<optional-kb-jwt>
  const parts = sdJwt.split('~');
  if (parts.length < 2) {
    return { valid: false, error: 'Invalid SD-JWT format' };
  }

  const issuerJwt = parts[0]!;
  // The last element after splitting on ~ is either empty string (trailing ~),
  // a KB-JWT, or a disclosure
  const remaining = parts.slice(1);

  // Filter out empty strings and separate disclosures from potential KB-JWT
  const nonEmpty = remaining.filter((p) => p.length > 0);

  // Try to detect if the last element is a KB-JWT (has JWT structure with 2 dots)
  let kbJwt: string | undefined;
  const disclosureStrings: string[] = [];

  for (const part of nonEmpty) {
    const dotCount = part.split('.').length - 1;
    if (dotCount === 2) {
      // Could be a KB-JWT — try to decode header
      try {
        const header = decodeProtectedHeader(part);
        if (header.typ === 'kb+jwt') {
          kbJwt = part;
          continue;
        }
      } catch {
        // Not a JWT, treat as disclosure
      }
    }
    disclosureStrings.push(part);
  }

  // Verify the issuer JWT signature
  const { publicKey } = getKeyPair();

  let decoded: Record<string, unknown>;
  try {
    decoded = decodeJwt(issuerJwt) as Record<string, unknown>;
  } catch {
    return { valid: false, error: 'Invalid JWT format' };
  }

  const vcId = decoded['jti'] as string | undefined;
  const vcIdFields = vcId !== undefined ? { vcId } : {};

  try {
    await jwtVerify(issuerJwt, publicKey, {
      algorithms: ['RS256'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    if (message.includes('exp') || message.includes('expired')) {
      return { valid: false, ...vcIdFields, error: 'SD-JWT expired' };
    }
    return { valid: false, ...vcIdFields, error: message };
  }

  // Verify _sd_alg is present and supported
  const sdAlg = decoded['_sd_alg'] as string | undefined;
  if (sdAlg && sdAlg !== 'sha-256') {
    return { valid: false, ...vcIdFields, error: `Unsupported _sd_alg: ${sdAlg}` };
  }

  // Extract the vc claim
  const vc = decoded['vc'] as Record<string, unknown> | undefined;
  if (!vc) {
    return { valid: false, ...vcIdFields, error: 'Missing vc claim' };
  }

  const credentialSubject = vc['credentialSubject'] as Record<string, unknown> | undefined;
  if (!credentialSubject) {
    return { valid: false, ...vcIdFields, error: 'Missing credentialSubject' };
  }

  const sdDigests = credentialSubject['_sd'] as string[] | undefined;

  // Decode and verify disclosures
  const disclosedClaims: Record<string, unknown> = {};

  // Start with visible (non-selective) claims from credentialSubject
  for (const [key, value] of Object.entries(credentialSubject)) {
    if (key !== '_sd') {
      disclosedClaims[key] = value;
    }
  }

  // Process each disclosure
  for (const encodedDisclosure of disclosureStrings) {
    const disclosure = decodeDisclosure(encodedDisclosure);
    if (!disclosure) {
      return { valid: false, ...vcIdFields, error: 'Invalid disclosure format' };
    }

    // Verify the disclosure hash is in the _sd array
    const digest = hashDisclosure(encodedDisclosure);
    if (!sdDigests || !sdDigests.includes(digest)) {
      return { valid: false, ...vcIdFields, error: 'Disclosure hash not found in _sd array — possible tampering' };
    }

    disclosedClaims[disclosure.claimName] = disclosure.claimValue;
  }

  // If a key-binding JWT is present, verify it
  if (kbJwt !== undefined) {
    try {
      const kbDecoded = decodeJwt(kbJwt) as Record<string, unknown>;
      // KB-JWT should contain nonce and aud claims
      if (!kbDecoded['nonce'] && !kbDecoded['aud']) {
        return { valid: false, ...vcIdFields, error: 'KB-JWT missing nonce or aud' };
      }
    } catch {
      return { valid: false, ...vcIdFields, error: 'Invalid KB-JWT format' };
    }
  }

  return {
    valid: true,
    ...vcIdFields,
    disclosedClaims,
  };
}

// ── SD-JWT Presentation ─────────────────────────────────────────────────────

/**
 * Create a presentation from an SD-JWT by selecting which fields to disclose.
 *
 * Takes a full SD-JWT and returns a new SD-JWT with only the specified
 * disclosures included. Optionally includes a key-binding JWT.
 */
export function createPresentation(
  sdJwt: string,
  fieldsToDisclose: string[],
  options?: { nonce?: string; audience?: string },
): string {
  // Parse the SD-JWT
  const parts = sdJwt.split('~');
  if (parts.length < 2) {
    throw new Error('Invalid SD-JWT format');
  }

  const issuerJwt = parts[0]!;
  const remaining = parts.slice(1).filter((p) => p.length > 0);

  // Decode each disclosure and filter by requested fields
  const selectedDisclosures: string[] = [];
  for (const encoded of remaining) {
    // Skip if it looks like a KB-JWT
    const dotCount = encoded.split('.').length - 1;
    if (dotCount === 2) {
      try {
        const header = decodeProtectedHeader(encoded);
        if (header.typ === 'kb+jwt') continue;
      } catch {
        // Not a JWT, process as disclosure
      }
    }

    const disclosure = decodeDisclosure(encoded);
    if (disclosure && fieldsToDisclose.includes(disclosure.claimName)) {
      selectedDisclosures.push(encoded);
    }
  }

  // Build the presentation SD-JWT
  let presentation = issuerJwt + '~' + selectedDisclosures.join('~') + '~';

  // If nonce/audience provided, note where KB-JWT would go
  // (KB-JWT creation requires holder's private key, which is beyond this scope.
  //  For server-side verification, we pass nonce/audience as query params.)
  if (options?.nonce !== undefined || options?.audience !== undefined) {
    // In a real implementation, the holder would sign a KB-JWT here.
    // For Grantex, the presentation endpoint accepts nonce/audience in the request body.
    // We leave the trailing ~ which signals no KB-JWT.
  }

  return presentation;
}
