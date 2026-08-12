import * as jose from 'jose';
import { PassportVerificationError } from './errors.js';
import type {
  AgentPassportCredential,
  VerifiedPassport,
  VerifyPassportOptions,
} from './types.js';

const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';
const DEFAULT_TRUSTED_ISSUERS = ['did:web:grantex.dev'];
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Tolerance for issuer/verifier clock drift when applying validFrom. */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

interface JwksCacheEntry {
  jwks: jose.JSONWebKeySet;
  fetchedAt: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();

async function fetchJwks(jwksUri: string): Promise<jose.JSONWebKeySet> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.jwks;
  }

  const response = await fetch(jwksUri, {
    headers: { 'Accept': 'application/json' },
  });
  if (!response.ok) {
    throw new PassportVerificationError(
      'INVALID_SIGNATURE',
      `Failed to fetch JWKS from ${jwksUri}: ${response.status}`,
    );
  }

  const jwks = (await response.json()) as jose.JSONWebKeySet;
  jwksCache.set(jwksUri, { jwks, fetchedAt: Date.now() });
  return jwks;
}

function decodePassport(encodedCredential: string): AgentPassportCredential {
  try {
    const json = Buffer.from(encodedCredential, 'base64url').toString('utf-8');
    return JSON.parse(json) as AgentPassportCredential;
  } catch {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      'Failed to decode passport: invalid base64url or JSON',
    );
  }
}

function validateStructure(credential: AgentPassportCredential): void {
  if (
    !credential['@context'] ||
    !credential.type?.includes('AgentPassportCredential') ||
    !credential.credentialSubject ||
    !credential.proof ||
    !credential.id ||
    !credential.issuer ||
    !credential.validFrom ||
    !credential.validUntil
  ) {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      'Credential is missing required W3C VC 2.0 fields',
    );
  }
}

/**
 * Claims read out of the *verified* JWS. Everything an authorization decision
 * depends on has to come from here — the surrounding credential envelope is
 * attacker-supplied and is only ever used to cross-check these values.
 */
interface SignedClaims {
  issuer: string;
  passportId: string;
  subject: AgentPassportCredential['credentialSubject'];
  expiresAt: Date;
  notBefore: Date | null;
}

/** Stable stringify so key ordering cannot make two equal objects compare unequal. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Verify `proof.proofValue` against the trusted keyset and extract the claims it
 * actually attests to.
 *
 * The proof is a VC-JWT: `vc.credentialSubject` carries the subject, and the
 * registered claims (`iss`, `jti`, `exp`, `nbf`/`iat`) carry the envelope. Both
 * the issuer's `vc` claim shapes — subject-only and full-credential — expose the
 * same fields, so one extraction covers both.
 */
async function verifyProof(
  proofValue: string,
  jwks: jose.JSONWebKeySet,
): Promise<SignedClaims> {
  if (typeof proofValue !== 'string' || proofValue.length === 0) {
    throw new PassportVerificationError(
      'INVALID_SIGNATURE',
      'Credential proof is missing a proofValue',
    );
  }

  const keyStore = jose.createLocalJWKSet(jwks);
  let payload: jose.JWTPayload;
  try {
    // jwtVerify enforces the signature *and* the signed exp/nbf window.
    ({ payload } = await jose.jwtVerify(proofValue, keyStore));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof jose.errors.JWTExpired) {
      throw new PassportVerificationError(
        'PASSPORT_EXPIRED',
        `Passport proof has expired: ${message}`,
      );
    }
    if (err instanceof jose.errors.JWTClaimValidationFailed && err.claim === 'nbf') {
      throw new PassportVerificationError(
        'PASSPORT_NOT_YET_VALID',
        `Passport proof is not yet valid: ${message}`,
      );
    }
    throw new PassportVerificationError(
      'INVALID_SIGNATURE',
      `Signature verification failed: ${message}`,
    );
  }

  const vc = payload['vc'] as { credentialSubject?: unknown } | undefined;
  const subject = vc?.credentialSubject as
    | AgentPassportCredential['credentialSubject']
    | undefined;

  if (!subject || typeof subject !== 'object') {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      'Signed proof does not carry a vc.credentialSubject claim',
    );
  }
  if (typeof payload.iss !== 'string' || typeof payload.jti !== 'string') {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      'Signed proof is missing the iss or jti claim',
    );
  }
  if (typeof payload.exp !== 'number') {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      'Signed proof is missing the exp claim',
    );
  }

  const notBeforeSeconds = typeof payload.nbf === 'number' ? payload.nbf : null;

  return {
    issuer: payload.iss,
    passportId: payload.jti,
    subject,
    expiresAt: new Date(payload.exp * 1000),
    notBefore: notBeforeSeconds !== null ? new Date(notBeforeSeconds * 1000) : null,
  };
}

/**
 * Reject any envelope that disagrees with what was signed. Without this the
 * envelope is free-form attacker input: a holder of one valid passport could
 * paste its proof next to a self-written subject and mint arbitrary authority.
 */
function assertEnvelopeMatchesProof(
  credential: AgentPassportCredential,
  signed: SignedClaims,
): void {
  if (credential.id !== signed.passportId) {
    throw new PassportVerificationError(
      'CREDENTIAL_MISMATCH',
      `Credential id (${credential.id}) does not match the signed passport id (${signed.passportId})`,
    );
  }
  if (credential.issuer !== signed.issuer) {
    throw new PassportVerificationError(
      'CREDENTIAL_MISMATCH',
      `Credential issuer (${credential.issuer}) does not match the signed issuer (${signed.issuer})`,
    );
  }
  if (canonicalize(credential.credentialSubject) !== canonicalize(signed.subject)) {
    throw new PassportVerificationError(
      'CREDENTIAL_MISMATCH',
      'Credential subject does not match the signed credentialSubject claim',
    );
  }
}

export async function verifyPassport(
  encodedCredential: string,
  options?: VerifyPassportOptions,
): Promise<VerifiedPassport> {
  if (!encodedCredential) {
    throw new PassportVerificationError(
      'MISSING_PASSPORT',
      'No passport credential provided',
    );
  }

  const credential = decodePassport(encodedCredential);
  validateStructure(credential);

  // Reject an untrusted claimed issuer before doing any network work.
  const trustedIssuers = options?.trustedIssuers ?? DEFAULT_TRUSTED_ISSUERS;
  if (!trustedIssuers.includes(credential.issuer)) {
    throw new PassportVerificationError(
      'UNTRUSTED_ISSUER',
      `Issuer ${credential.issuer} is not in the trusted issuers list`,
    );
  }

  // Verify the proof, then pin the envelope to what was actually signed.
  // Every check from here on runs on signed data.
  const jwksUri = options?.jwksUri ?? DEFAULT_JWKS_URI;
  const jwks = await fetchJwks(jwksUri);
  const signed = await verifyProof(credential.proof.proofValue, jwks);
  assertEnvelopeMatchesProof(credential, signed);

  // The signed issuer must independently clear the trust list — the envelope
  // check above was on attacker-supplied data.
  if (!trustedIssuers.includes(signed.issuer)) {
    throw new PassportVerificationError(
      'UNTRUSTED_ISSUER',
      `Signed issuer ${signed.issuer} is not in the trusted issuers list`,
    );
  }

  // Check the validity window. The envelope carries validFrom/validUntil in
  // ISO form and the proof carries nbf/exp; neither may be treated as more
  // permissive than the other, so the narrower of the two bounds wins.
  const now = Date.now();
  const envelopeExpiry = new Date(credential.validUntil);
  if (Number.isNaN(envelopeExpiry.getTime())) {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      `Credential validUntil is not a valid date: ${credential.validUntil}`,
    );
  }
  const expiresAt = new Date(Math.min(envelopeExpiry.getTime(), signed.expiresAt.getTime()));
  if (expiresAt.getTime() <= now) {
    throw new PassportVerificationError(
      'PASSPORT_EXPIRED',
      `Passport expired at ${expiresAt.toISOString()}`,
    );
  }

  const envelopeValidFrom = new Date(credential.validFrom);
  if (Number.isNaN(envelopeValidFrom.getTime())) {
    throw new PassportVerificationError(
      'MALFORMED_CREDENTIAL',
      `Credential validFrom is not a valid date: ${credential.validFrom}`,
    );
  }
  const validFrom = signed.notBefore !== null
    ? new Date(Math.max(envelopeValidFrom.getTime(), signed.notBefore.getTime()))
    : envelopeValidFrom;
  if (validFrom.getTime() > now + CLOCK_SKEW_TOLERANCE_MS) {
    throw new PassportVerificationError(
      'PASSPORT_NOT_YET_VALID',
      `Passport is not valid until ${validFrom.toISOString()}`,
    );
  }

  // Check revocation if requested
  if (options?.checkRevocation) {
    const revocationEndpoint = options.revocationEndpoint;
    if (!revocationEndpoint) {
      throw new Error('revocationEndpoint is required when checkRevocation is true');
    }

    // An unreachable or erroring revocation service must fail closed. Treating
    // it as "not revoked" turns an outage into a window where every revoked
    // passport is accepted again.
    let result: { valid?: boolean };
    try {
      const response = await fetch(revocationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: credential.proof.proofValue }),
      });
      if (!response.ok) {
        throw new Error(`revocation endpoint returned ${response.status}`);
      }
      result = (await response.json()) as { valid?: boolean };
    } catch (err) {
      throw new PassportVerificationError(
        'REVOCATION_CHECK_FAILED',
        `Could not determine revocation status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (result.valid !== true) {
      throw new PassportVerificationError(
        'PASSPORT_REVOKED',
        'Passport has been revoked',
      );
    }
  }

  // Check required categories
  const subject = signed.subject;
  const allowedCategories = Array.isArray(subject.allowedMPPCategories)
    ? subject.allowedMPPCategories
    : [];
  if (options?.requiredCategories) {
    const missing = options.requiredCategories.filter(
      (c) => !allowedCategories.includes(c),
    );
    if (missing.length > 0) {
      throw new PassportVerificationError(
        'CATEGORY_MISMATCH',
        `Passport does not cover required categories: ${missing.join(', ')}`,
      );
    }
  }

  // Check max amount
  if (options?.maxAmount !== undefined) {
    const permitted = subject.maxTransactionAmount?.amount;
    if (typeof permitted !== 'number' || !Number.isFinite(permitted)) {
      throw new PassportVerificationError(
        'MALFORMED_CREDENTIAL',
        'Signed credentialSubject has no numeric maxTransactionAmount.amount',
      );
    }
    if (permitted < options.maxAmount) {
      throw new PassportVerificationError(
        'AMOUNT_EXCEEDED',
        `Passport max amount (${permitted}) is less than required (${options.maxAmount})`,
      );
    }
  }

  return {
    valid: true,
    passportId: signed.passportId,
    agentDID: subject.id,
    humanDID: subject.humanPrincipal,
    organizationDID: subject.organizationDID,
    grantId: subject.grantId,
    allowedCategories,
    maxTransactionAmount: subject.maxTransactionAmount,
    delegationDepth: subject.delegationDepth,
    expiresAt,
    issuer: signed.issuer,
  };
}

// ─── Express middleware ──────────────────────────────────────────────────────

import type { Request, Response, NextFunction, RequestHandler } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentPassport?: VerifiedPassport;
    }
  }
}

export function requireAgentPassport(
  options?: VerifyPassportOptions,
): RequestHandler {
  return (async (req: Request, res: Response, next: NextFunction) => {
    const encoded = req.headers['x-grantex-passport'] as string | undefined;
    if (!encoded) {
      res.status(403).json({
        error: 'MISSING_PASSPORT',
        message: 'X-Grantex-Passport header is required',
      });
      return;
    }

    try {
      const verified = await verifyPassport(encoded, options);
      req.agentPassport = verified;
      next();
    } catch (err) {
      if (err instanceof PassportVerificationError) {
        res.status(403).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      next(err);
    }
  }) as RequestHandler;
}

/** Clear the in-memory JWKS cache. Useful for testing. */
export function clearJwksCache(): void {
  jwksCache.clear();
}
