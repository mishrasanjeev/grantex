// SPDX-License-Identifier: Apache-2.0
//
// Shared vectors: spec/examples/agent-passport-vectors.json is checked by this
// suite and by packages/agent-passport-py/tests/test_vectors.py, so both
// libraries accept and refuse exactly the same inputs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PassportError,
  externalCredentialHash,
  jwkThumbprint,
  keysEqual,
  verifyPassport,
  type Jwk,
  type VerifyPassportOptions,
} from '../src/index.ts';

interface VerifyVector {
  name: string;
  compact: string;
  options: {
    now: number;
    expectedVct?: string;
    paymentsRails?: boolean;
    allowEdDSA?: boolean;
    clockSkewSeconds?: number;
    keyBinding?: { aud: string; nonce: string; maxAgeSeconds?: number };
  };
  expect:
    | { ok: true; disclosed: Record<string, unknown>; cnfThumbprint: string; externalCredentialHash: string; keyBinding?: unknown }
    | { ok: false; code: string; reason: string };
}

interface Vectors {
  issuers: Record<string, Jwk[]>;
  verify: VerifyVector[];
  hash: Array<{ name: string; input: string; hash: string }>;
  thumbprints: Array<{ name: string; jwk: Jwk; thumbprint: string }>;
  keysEqual: Array<{ name: string; a: Jwk; b: Jwk; equal: boolean }>;
}

const vectorsPath = fileURLToPath(new URL('../../../spec/examples/agent-passport-vectors.json', import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors;

describe('shared vectors: verifyPassport', () => {
  it('has refusal vectors for every rule of the profile', () => {
    const reasons = new Set(vectors.verify.filter((v) => !v.expect.ok).map((v) => (v.expect as { reason: string }).reason));
    for (const reason of [
      'wrong_typ',
      'wrong_vct',
      'signature_mismatch',
      'expired',
      'lifetime_exceeds_one_year',
      'disclosure_not_referenced',
      'duplicate_disclosure',
      'cnf_missing',
      'cnf_private_key',
      'cnf_not_p256',
      'header_key_not_allowed',
      'eddsa_not_enabled',
      'audience_mismatch',
      'nonce_mismatch',
      'kb_stale',
      'sd_hash_mismatch',
      'kb_signature_mismatch',
    ]) {
      expect(reasons).toContain(reason);
    }
  });

  for (const vector of vectors.verify) {
    it(vector.name, async () => {
      const opts: VerifyPassportOptions = {
        compact: vector.compact,
        issuerKeys: (iss: string) => vectors.issuers[iss] ?? [],
        ...vector.options,
      };
      if (vector.expect.ok) {
        const result = await verifyPassport(opts);
        expect(result.disclosed).toEqual(vector.expect.disclosed);
        expect(result.cnfThumbprint).toBe(vector.expect.cnfThumbprint);
        expect(result.externalCredentialHash).toBe(vector.expect.externalCredentialHash);
        expect(result.keyBinding).toEqual(vector.expect.keyBinding);
      } else {
        const error = await verifyPassport(opts).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PassportError);
        expect({ code: (error as PassportError).code, reason: (error as PassportError).reason }).toEqual({
          code: vector.expect.code,
          reason: vector.expect.reason,
        });
      }
    });
  }
});

describe('shared vectors: hash and key rules', () => {
  for (const vector of vectors.hash) {
    it(`hash: ${vector.name}`, () => {
      expect(externalCredentialHash(vector.input)).toBe(vector.hash);
    });
  }
  for (const vector of vectors.thumbprints) {
    it(`thumbprint: ${vector.name}`, () => {
      expect(jwkThumbprint(vector.jwk)).toBe(vector.thumbprint);
    });
  }
  for (const vector of vectors.keysEqual) {
    it(`keysEqual: ${vector.name}`, () => {
      expect(keysEqual(vector.a, vector.b)).toBe(vector.equal);
    });
  }
});
