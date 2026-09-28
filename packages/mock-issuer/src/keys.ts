// SPDX-License-Identifier: Apache-2.0
//
// The mock issuer's signing key: one ES256 (P-256) key pair, generated at
// start. With a directory, the private key is written there once (mode 0600)
// and read back on later starts, so a CI run can issue in one process and
// serve in another. The directory is scratch space: never commit it.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jwkThumbprint, type Jwk } from '@grantex/agent-passport';
import { hasPrivateMembers, keyKind } from './jose.ts';
import { MockIssuerError } from './errors.ts';

export const ISSUER_KEY_FILE = 'issuer-key.json';

export interface IssuerKey {
  /** The private JWK, with kid and alg. Never published or printed. */
  privateJwk: Jwk;
  /** The public JWK as published in the JWKS: kty, crv, x, y, kid, alg, use. */
  publicJwk: Jwk;
  kid: string;
}

function fromPrivateJwk(privateJwk: Jwk): IssuerKey {
  if (keyKind(privateJwk) !== 'P-256' || typeof privateJwk.d !== 'string') {
    throw new MockIssuerError('state_unreadable', 'the issuer key is not a private P-256 JWK');
  }
  const kid = typeof privateJwk.kid === 'string' && privateJwk.kid !== ''
    ? privateJwk.kid
    : `mock-issuer-${jwkThumbprint(privateJwk).slice(0, 16)}`;
  const publicJwk: Jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: privateJwk.x as string,
    y: privateJwk.y as string,
    kid,
    alg: 'ES256',
    use: 'sig',
  };
  if (hasPrivateMembers(publicJwk)) throw new MockIssuerError('state_unreadable', 'public key carries private members');
  return { privateJwk: { ...privateJwk, kid, alg: 'ES256' }, publicJwk, kid };
}

export function generateIssuerKey(): IssuerKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return fromPrivateJwk(privateKey.export({ format: 'jwk' }) as Jwk);
}

/** Read the key from `dir`, or generate one and write it there. */
export function loadOrCreateIssuerKey(dir: string): IssuerKey {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ISSUER_KEY_FILE);
  if (existsSync(file)) {
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch (cause) {
      // An unreadable key is never replaced silently: a new key would make
      // every passport issued so far unverifiable against the served JWKS.
      throw new MockIssuerError('state_unreadable', `${ISSUER_KEY_FILE} is not JSON`, { cause });
    }
    return fromPrivateJwk(stored as Jwk);
  }
  const key = generateIssuerKey();
  try {
    // 'wx': never overwrite a key another process wrote in the meantime.
    writeFileSync(file, `${JSON.stringify(key.privateJwk)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateIssuerKey(dir);
    throw error;
  }
  return key;
}
