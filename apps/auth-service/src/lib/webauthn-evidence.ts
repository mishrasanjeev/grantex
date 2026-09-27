import { createHash } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface WebAuthnAssertionEvidence {
  type: 'GrantexWebAuthnAssertion';
  version: 1;
  authRequestId: string;
  credentialId: string;
  credentialPublicKey: string;
  previousCounter: number;
  rpId: string;
  origin: string;
  challenge: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userVerified: boolean;
  assertedAt: string;
  digest: string;
}

export interface GrantWebAuthnEvidence {
  type: 'GrantexWebAuthnAssertion';
  version: 1;
  authRequestId: string;
  rpId: string;
  origin: string;
  userVerified: boolean;
  assertedAt: string;
  digest: string;
}

type EvidenceInput = Omit<WebAuthnAssertionEvidence, 'type' | 'version' | 'digest'>;

export function webAuthnEvidenceDigest(evidence: EvidenceInput): string {
  const fields = [
    evidence.authRequestId, evidence.credentialId, evidence.credentialPublicKey,
    evidence.previousCounter, evidence.rpId, evidence.origin, evidence.challenge,
    evidence.clientDataJSON, evidence.authenticatorData, evidence.signature,
    evidence.userVerified, evidence.assertedAt,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function createWebAuthnEvidence(input: EvidenceInput): WebAuthnAssertionEvidence {
  return {
    type: 'GrantexWebAuthnAssertion',
    version: 1,
    ...input,
    digest: webAuthnEvidenceDigest(input),
  };
}

export function parseWebAuthnEvidence(value: unknown): WebAuthnAssertionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid WebAuthn evidence');
  }
  const evidence = value as Record<string, unknown>;
  const strings = [
    'authRequestId', 'credentialId', 'credentialPublicKey', 'rpId', 'origin',
    'challenge', 'clientDataJSON', 'authenticatorData', 'signature', 'assertedAt',
  ];
  if (evidence['type'] !== 'GrantexWebAuthnAssertion' || evidence['version'] !== 1
      || strings.some((key) => typeof evidence[key] !== 'string' || (evidence[key] as string).length === 0)
      || typeof evidence['userVerified'] !== 'boolean'
      || !Number.isSafeInteger(evidence['previousCounter'])
      || (evidence['previousCounter'] as number) < 0
      || typeof evidence['digest'] !== 'string'
      || !/^[a-f0-9]{64}$/.test(evidence['digest'])) {
    throw new Error('Invalid WebAuthn evidence');
  }
  const parsed = evidence as unknown as WebAuthnAssertionEvidence;
  if (webAuthnEvidenceDigest(parsed) !== parsed.digest) {
    throw new Error('WebAuthn evidence digest mismatch');
  }
  return parsed;
}

export function grantWebAuthnEvidence(evidence: WebAuthnAssertionEvidence): GrantWebAuthnEvidence {
  const { type, version, authRequestId, rpId, origin, userVerified, assertedAt, digest } = evidence;
  return { type, version, authRequestId, rpId, origin, userVerified, assertedAt, digest };
}

export function parseGrantWebAuthnEvidence(value: unknown): GrantWebAuthnEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid grant WebAuthn evidence');
  }
  const claim = value as Record<string, unknown>;
  if (claim['type'] !== 'GrantexWebAuthnAssertion' || claim['version'] !== 1
      || !['authRequestId', 'rpId', 'origin', 'assertedAt'].every(
        (key) => typeof claim[key] === 'string' && (claim[key] as string).length > 0)
      || typeof claim['userVerified'] !== 'boolean'
      || typeof claim['digest'] !== 'string'
      || !/^[a-f0-9]{64}$/.test(claim['digest'])) {
    throw new Error('Invalid grant WebAuthn evidence');
  }
  return claim as unknown as GrantWebAuthnEvidence;
}

/** Verify the authenticator signature, challenge, RP and origin without a database lookup. */
export async function verifyPortableWebAuthnEvidence(
  value: unknown,
  expected: { rpId: string; origin: string },
): Promise<boolean> {
  try {
    const evidence = parseWebAuthnEvidence(value);
    if (evidence.rpId !== expected.rpId || evidence.origin !== expected.origin) return false;
    const response: AuthenticationResponseJSON = {
      id: evidence.credentialId,
      rawId: evidence.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: evidence.clientDataJSON,
        authenticatorData: evidence.authenticatorData,
        signature: evidence.signature,
      },
      clientExtensionResults: {},
    };
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: evidence.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: expected.rpId,
      requireUserVerification: evidence.userVerified,
      credential: {
        id: evidence.credentialId,
        publicKey: Buffer.from(evidence.credentialPublicKey, 'base64url'),
        counter: evidence.previousCounter,
      },
    });
    return result.verified && result.authenticationInfo.userVerified === evidence.userVerified;
  } catch {
    return false;
  }
}
