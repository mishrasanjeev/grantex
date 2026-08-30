import { createHash } from 'node:crypto';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose';
import { getRedis } from '../redis/client.js';
import { validateAgentPublicJwk } from './agent-security.js';

export const DPOP_SIGNING_ALGORITHMS = ['ES256', 'ES384', 'ES512', 'RS256', 'EdDSA'] as const;

const DPOP_MAX_AGE_SECONDS = 300;
const DPOP_CLOCK_SKEW_SECONDS = 30;
const DPOP_REPLAY_TTL_SECONDS = DPOP_MAX_AGE_SECONDS + DPOP_CLOCK_SKEW_SECONDS;

export class DpopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DpopError';
  }
}

export interface VerifyDpopOptions {
  method: string;
  targetUri: string;
  accessToken?: string;
  recordReplay?: boolean;
}

export interface VerifiedDpopProof {
  thumbprint: string;
  jwk: JWK;
  jti: string;
  issuedAt: number;
}

export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest('base64url');
}

export async function verifyDpopProof(
  proof: unknown,
  options: VerifyDpopOptions,
): Promise<VerifiedDpopProof> {
  if (typeof proof !== 'string' || proof.length === 0 || proof.length > 16_384) {
    throw new DpopError('A DPoP proof is required');
  }

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    throw new DpopError('The DPoP proof is not a valid JWT');
  }

  if (header.typ !== 'dpop+jwt') {
    throw new DpopError('The DPoP proof typ must be dpop+jwt');
  }
  if (typeof header.alg !== 'string'
      || !(DPOP_SIGNING_ALGORITHMS as readonly string[]).includes(header.alg)) {
    throw new DpopError('The DPoP proof uses an unsupported signing algorithm');
  }
  if (!header.jwk || typeof header.jwk !== 'object' || Array.isArray(header.jwk)) {
    throw new DpopError('The DPoP proof must carry a public JWK');
  }

  let publicJwk: JWK;
  let thumbprint: string;
  try {
    const validated = await validateAgentPublicJwk(header.jwk);
    publicJwk = validated.jwk;
    thumbprint = await calculateJwkThumbprint(publicJwk, 'sha256');
  } catch (error) {
    throw new DpopError(error instanceof Error ? error.message : 'The DPoP JWK is invalid');
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    const key = await importJWK(publicJwk, header.alg);
    ({ payload } = await jwtVerify(proof, key, { algorithms: [header.alg] }));
  } catch {
    throw new DpopError('The DPoP proof signature is invalid');
  }

  if (typeof payload.htm !== 'string' || payload.htm.toUpperCase() !== options.method.toUpperCase()) {
    throw new DpopError('The DPoP proof HTTP method does not match this request');
  }
  if (typeof payload.htu !== 'string' || payload.htu !== options.targetUri) {
    throw new DpopError('The DPoP proof target URI does not match this endpoint');
  }
  if (typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 256) {
    throw new DpopError('The DPoP proof jti is missing or invalid');
  }
  if (typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)) {
    throw new DpopError('The DPoP proof iat is missing or invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iat < now - DPOP_MAX_AGE_SECONDS || payload.iat > now + DPOP_CLOCK_SKEW_SECONDS) {
    throw new DpopError('The DPoP proof is outside the accepted freshness window');
  }

  if (options.accessToken !== undefined) {
    const expectedAth = accessTokenHash(options.accessToken);
    if (payload.ath !== expectedAth) {
      throw new DpopError('The DPoP proof access-token hash is missing or invalid');
    }
  } else if (payload.ath !== undefined && typeof payload.ath !== 'string') {
    throw new DpopError('The DPoP proof ath claim is invalid');
  }

  if (options.recordReplay !== false) {
    const redis = getRedis();
    let recorded: unknown;
    try {
      recorded = await redis.set(
        `dpop:proof:${thumbprint}:${payload.jti}`,
        '1',
        'EX',
        DPOP_REPLAY_TTL_SECONDS,
        'NX',
      );
    } catch {
      throw new DpopError('DPoP replay protection is temporarily unavailable');
    }
    if (recorded !== 'OK') {
      throw new DpopError('The DPoP proof has already been used');
    }
  }

  return {
    thumbprint,
    jwk: publicJwk,
    jti: payload.jti,
    issuedAt: payload.iat,
  };
}
