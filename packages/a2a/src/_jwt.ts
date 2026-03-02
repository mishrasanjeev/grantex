/**
 * Lightweight offline JWT decode for A2A grant token inspection.
 *
 * For full verification with JWKS, use the @grantex/sdk tokens.verify() method.
 * This module only performs base64 decoding of the JWT payload.
 */

export interface JwtPayload {
  iss?: string;
  sub?: string;
  agt?: string;
  dev?: string;
  scp?: string[];
  jti?: string;
  grnt?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  bdg?: number;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
}

/**
 * Decode a JWT payload without verification.
 * Throws if the token is not a valid JWT format.
 */
export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format: expected 3 parts');
  }

  const payload = parts[1]!;
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(decoded) as JwtPayload;
}

/**
 * Check if a decoded JWT is expired.
 */
export function isTokenExpired(payload: JwtPayload): boolean {
  if (!payload.exp) return false;
  return Date.now() >= payload.exp * 1000;
}
