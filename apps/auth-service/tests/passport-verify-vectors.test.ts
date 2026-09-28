// SPDX-License-Identifier: Apache-2.0
/**
 * The auth service verifies Agent Passports with a copy of the verification
 * half of packages/agent-passport (src/lib/registry/passport-verify.ts): the
 * service image is built from apps/auth-service alone and cannot depend on a
 * workspace package. This file holds the copy to the shared vectors in
 * spec/examples/agent-passport-vectors.json, which both published libraries
 * also pass, so the three cannot drift apart unnoticed.
 *
 * The copy never checks a Key Binding JWT: the registry refuses any KB-JWT at
 * consent time (spec/passport-binding.md §3). Vectors that require key
 * binding are therefore out of its scope and counted, not run.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PassportVerifyError,
  externalCredentialHash,
  jwkThumbprint,
  keysEqual,
  verifyPassportPresentation,
  type PassportJwk,
} from '../src/lib/registry/passport-verify.js';

interface VerifyVector {
  name: string;
  compact: string;
  options: {
    now: number;
    allowEdDSA?: boolean;
    paymentsRails?: boolean;
    clockSkewSeconds?: number;
    keyBinding?: unknown;
  };
  expect:
    | { ok: true; disclosed: Record<string, unknown>; cnfThumbprint: string; externalCredentialHash: string }
    | { ok: false; code: string; reason: string };
}

interface Vectors {
  issuers: Record<string, PassportJwk[]>;
  verify: VerifyVector[];
  hash: Array<{ name: string; input: string; hash: string }>;
  thumbprints: Array<{ name: string; jwk: PassportJwk; thumbprint: string }>;
  keysEqual: Array<{ name: string; a: PassportJwk; b: PassportJwk; equal: boolean }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, '..', '..', '..', 'spec', 'examples', 'agent-passport-vectors.json'), 'utf8'),
) as Vectors;

const withoutKeyBinding = vectors.verify.filter((vector) => vector.options.keyBinding === undefined);

describe('passport-verify against the shared Agent Passport vectors', () => {
  it('runs every vector that does not require key binding', () => {
    // 53 vectors, 9 of which require a KB-JWT (spec/agent-passport-1.0.md §5).
    expect(vectors.verify).toHaveLength(53);
    expect(withoutKeyBinding).toHaveLength(44);
  });

  for (const vector of withoutKeyBinding) {
    it(vector.name, async () => {
      const run = verifyPassportPresentation({
        compact: vector.compact,
        issuerKeys: async (iss) => vectors.issuers[iss] ?? [],
        now: vector.options.now,
        ...(vector.options.allowEdDSA !== undefined ? { allowEdDSA: vector.options.allowEdDSA } : {}),
        ...(vector.options.paymentsRails !== undefined ? { paymentsRails: vector.options.paymentsRails } : {}),
        ...(vector.options.clockSkewSeconds !== undefined ? { clockSkewSeconds: vector.options.clockSkewSeconds } : {}),
      });
      if (vector.expect.ok) {
        const result = await run;
        expect(result.disclosed).toEqual(vector.expect.disclosed);
        expect(result.cnfThumbprint).toBe(vector.expect.cnfThumbprint);
        expect(result.externalCredentialHash).toBe(vector.expect.externalCredentialHash);
      } else {
        const error = await run.then(() => null, (err: unknown) => err);
        expect(error).toBeInstanceOf(PassportVerifyError);
        expect((error as PassportVerifyError).code).toBe(vector.expect.code);
        expect((error as PassportVerifyError).reason).toBe(vector.expect.reason);
      }
    });
  }

  it('refuses every key-binding presentation, since consent takes none', async () => {
    const presentation = vectors.verify.find((vector) => vector.name === 'SD-JWT+KB presentation')!;
    const error = await verifyPassportPresentation({
      compact: presentation.compact,
      issuerKeys: async (iss) => vectors.issuers[iss] ?? [],
      now: presentation.options.now,
    }).then(() => null, (err: unknown) => err);
    expect((error as PassportVerifyError).code).toBe('passport_malformed');
    expect((error as PassportVerifyError).reason).toBe('unexpected_key_binding');
  });

  for (const vector of vectors.hash) {
    it(`hash rule: ${vector.name}`, () => {
      expect(externalCredentialHash(vector.input)).toBe(vector.hash);
    });
  }

  it('hash rule: refuses input that is not an SD-JWT', () => {
    expect(() => externalCredentialHash('not-a-passport')).toThrow(PassportVerifyError);
    expect(() => externalCredentialHash('a.b~')).toThrow(PassportVerifyError);
  });

  for (const vector of vectors.thumbprints) {
    it(`thumbprint: ${vector.name}`, () => {
      expect(jwkThumbprint(vector.jwk)).toBe(vector.thumbprint);
    });
  }

  for (const vector of vectors.keysEqual) {
    it(`key rule: ${vector.name}`, () => {
      expect(keysEqual(vector.a, vector.b)).toBe(vector.equal);
    });
  }
});
