// SPDX-License-Identifier: Apache-2.0
//
// Test keys are generated at run time and never written to disk.

import { generateKeyPairSync } from 'node:crypto';
import type { IssuePassportParams, Jwk } from '../src/index.ts';

export interface TestKeyPair {
  privateJwk: Jwk;
  publicJwk: Jwk;
}

export function p256KeyPair(kid?: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' }) as Jwk;
  const publicJwk = publicKey.export({ format: 'jwk' }) as Jwk;
  if (kid !== undefined) {
    privateJwk.kid = kid;
    publicJwk.kid = kid;
  }
  return { privateJwk, publicJwk };
}

export function ed25519KeyPair(kid?: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' }) as Jwk;
  const publicJwk = publicKey.export({ format: 'jwk' }) as Jwk;
  if (kid !== undefined) {
    privateJwk.kid = kid;
    publicJwk.kid = kid;
  }
  return { privateJwk, publicJwk };
}

export const ISSUER = 'https://mock-issuer.example';
export const AGENT_DID = 'did:web:provider.example:agents:shopper-01';
export const IAT = 1_790_000_000;
export const NOW = IAT + 60;

export const PROFILE_CLAIMS = {
  provider: {
    did: 'did:web:provider.example',
    legal_identifiers: [{ scheme: 'registration_number', value: 'EX-0000001' }],
    name: 'Provider Example Ltd',
  },
  agent: {
    software_name: 'Nimbus Shopper',
    software_version: '2.4',
    cimd_uri: 'https://provider.example/agents/shopper-01/client-metadata.json',
    categories: ['shopping'],
    declared_limits: { max_transaction: { amount: '500.00', currency: 'USD' } },
  },
  verification: {
    level: 'standard',
    types: ['business_registry', 'domain_control'],
    performed_at: IAT - 86_400,
  },
  attestation_id: 'att_01J00000000000000000000000',
};

export function passportParams(
  issuer: TestKeyPair,
  holder: TestKeyPair,
  overrides: Partial<IssuePassportParams> = {},
): IssuePassportParams {
  return {
    issuerKey: issuer.privateJwk,
    iss: ISSUER,
    sub: AGENT_DID,
    cnfJwk: holder.publicJwk,
    iat: IAT,
    exp: IAT + 30 * 86_400,
    status: { status_list: { uri: 'https://mock-issuer.example/status/1', idx: 42 } },
    claims: structuredClone(PROFILE_CLAIMS),
    ...overrides,
  };
}

export function resolverFor(...keys: Jwk[]) {
  return (iss: string): Jwk[] => (iss === ISSUER ? keys : []);
}

/** A small deterministic PRNG (mulberry32) so property tests replay the same cases. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
