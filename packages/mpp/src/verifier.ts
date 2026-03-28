import * as jose from 'jose';
import { PassportVerificationError } from './errors.js';
import type {
  AgentPassportCredential,
  MPPCategory,
  VerifiedPassport,
  VerifyPassportOptions,
} from './types.js';

const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';
const DEFAULT_TRUSTED_ISSUERS = ['did:web:grantex.dev'];
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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

  // Check trusted issuers
  const trustedIssuers = options?.trustedIssuers ?? DEFAULT_TRUSTED_ISSUERS;
  if (!trustedIssuers.includes(credential.issuer)) {
    throw new PassportVerificationError(
      'UNTRUSTED_ISSUER',
      `Issuer ${credential.issuer} is not in the trusted issuers list`,
    );
  }

  // Check expiry
  const expiresAt = new Date(credential.validUntil);
  if (expiresAt.getTime() <= Date.now()) {
    throw new PassportVerificationError(
      'PASSPORT_EXPIRED',
      `Passport expired at ${credential.validUntil}`,
    );
  }

  // Verify Ed25519 signature via JWKS
  const jwksUri = options?.jwksUri ?? DEFAULT_JWKS_URI;
  const jwks = await fetchJwks(jwksUri);

  try {
    // The proof.proofValue is the detached JWS — verify using the JWKS keyset
    const keyStore = jose.createLocalJWKSet(jwks);
    // Reconstruct compact JWS from proof for verification
    const proofValue = credential.proof.proofValue;
    // Verify the JWS — the proofValue is a compact JWS of the credential
    await jose.compactVerify(proofValue, keyStore);
  } catch (err) {
    try {
      const keyStore = jose.createLocalJWKSet(jwks);
      await jose.jwtVerify(credential.proof.proofValue, keyStore);
    } catch {
      throw new PassportVerificationError(
        'INVALID_SIGNATURE',
        `Signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Check revocation if requested
  if (options?.checkRevocation) {
    const revocationEndpoint = options.revocationEndpoint;
    if (!revocationEndpoint) {
      throw new Error('revocationEndpoint is required when checkRevocation is true');
    }

    const response = await fetch(revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: credential.proof.proofValue }),
    });

    if (response.ok) {
      const result = (await response.json()) as { valid: boolean };
      if (!result.valid) {
        throw new PassportVerificationError(
          'PASSPORT_REVOKED',
          'Passport has been revoked',
        );
      }
    }
  }

  // Check required categories
  const subject = credential.credentialSubject;
  if (options?.requiredCategories) {
    const missing = options.requiredCategories.filter(
      (c) => !subject.allowedMPPCategories.includes(c),
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
    if (subject.maxTransactionAmount.amount < options.maxAmount) {
      throw new PassportVerificationError(
        'AMOUNT_EXCEEDED',
        `Passport max amount (${subject.maxTransactionAmount.amount}) is less than required (${options.maxAmount})`,
      );
    }
  }

  return {
    valid: true,
    passportId: credential.id,
    agentDID: subject.id,
    humanDID: subject.humanPrincipal,
    organizationDID: subject.organizationDID,
    grantId: subject.grantId,
    allowedCategories: subject.allowedMPPCategories,
    maxTransactionAmount: subject.maxTransactionAmount,
    delegationDepth: subject.delegationDepth,
    expiresAt,
    issuer: credential.issuer,
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
