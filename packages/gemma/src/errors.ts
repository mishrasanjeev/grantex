/**
 * Base error for all Grantex authentication / authorization failures.
 */
export class GrantexAuthError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'GrantexAuthError';
    this.code = code;
  }
}

/**
 * Thrown when offline JWT verification fails (bad signature, unknown kid, etc.).
 */
export class OfflineVerificationError extends GrantexAuthError {
  constructor(message: string, code = 'VERIFICATION_FAILED') {
    super(message, code);
    this.name = 'OfflineVerificationError';
  }
}

/**
 * Thrown when a required scope is missing from the grant token.
 */
export class ScopeViolationError extends GrantexAuthError {
  readonly requiredScopes: string[];
  readonly grantScopes: string[];

  constructor(requiredScopes: string[], grantScopes: string[]) {
    super(
      `Scope violation: required [${requiredScopes.join(', ')}] but grant has [${grantScopes.join(', ')}]`,
      'SCOPE_VIOLATION',
    );
    this.name = 'ScopeViolationError';
    this.requiredScopes = requiredScopes;
    this.grantScopes = grantScopes;
  }
}

/**
 * Thrown when a token has expired beyond the allowed clock-skew window.
 */
export class TokenExpiredError extends GrantexAuthError {
  readonly expiredAt: Date;

  constructor(expiredAt: Date) {
    super(`Token expired at ${expiredAt.toISOString()}`, 'TOKEN_EXPIRED');
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
  }
}

/**
 * Thrown when a consent bundle file has been tampered with
 * (decryption or integrity check fails).
 */
export class BundleTamperedError extends GrantexAuthError {
  constructor(message = 'Consent bundle file has been tampered with') {
    super(message, 'BUNDLE_TAMPERED');
    this.name = 'BundleTamperedError';
  }
}

/**
 * Thrown when audit-log hash-chain verification fails.
 */
export class HashChainError extends GrantexAuthError {
  readonly brokenAt: number;

  constructor(brokenAt: number) {
    super(`Hash chain broken at entry ${brokenAt}`, 'HASH_CHAIN_BROKEN');
    this.name = 'HashChainError';
    this.brokenAt = brokenAt;
  }
}
