// SPDX-License-Identifier: Apache-2.0
//
// Keys are generated at run time and never written anywhere but a temporary
// directory that the test removes.

import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Jwk } from '@grantex/agent-passport';

export interface AgentKeyPair {
  privateJwk: Jwk;
  publicJwk: Jwk;
}

export function agentKeyPair(type: 'ec' | 'ed25519' = 'ec'): AgentKeyPair {
  const { privateKey, publicKey } =
    type === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  return {
    privateJwk: privateKey.export({ format: 'jwk' }) as Jwk,
    publicJwk: publicKey.export({ format: 'jwk' }) as Jwk,
  };
}

export const AGENT_DID = 'did:web:provider.example:agents:shopper-01';

export const PROFILE = {
  provider: { did: 'did:web:provider.example', name: 'Provider Example Ltd' },
  agent: {
    software_name: 'Nimbus Shopper',
    software_version: '2.4',
    declared_limits: { max_transaction: { amount: '500.00', currency: 'USD' } },
  },
  verification: { level: 'standard', types: ['business_registry', 'domain_control'] },
};

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'mock-issuer-test-'));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** Split a compact JWS into its decoded header and payload (no signature check). */
export function decodeJws(jws: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = jws.split('.');
  return {
    header: JSON.parse(Buffer.from(h as string, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p as string, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

/**
 * Check an ES256 compact JWS with node:crypto directly, independent of the
 * mock's own JWS code: R || S (RFC 7518 section 3.4) over the signing input.
 */
export function verifiedEs256(jws: string, publicJwk: Jwk): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const segments = jws.split('.');
  if (segments.length !== 3) throw new Error('not a compact JWS');
  const [h, p, s] = segments as [string, string, string];
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicJwk.x as string, y: publicJwk.y as string }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('the ES256 signature does not verify');
  return decodeJws(jws);
}
