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
  type PassportStatus,
  type StatusResolver,
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

/** Token Status List values by status list uri, then by idx. */
type StatusLists = Record<string, Record<string, string>>;

interface StatusVector {
  name: string;
  /** The verify vector whose passport is checked. */
  vector: string;
  /** The status lists the relying party's resolver answers from; an absent entry makes the resolver fail. */
  statusLists: StatusLists;
  expect: { ok: true } | { ok: false; code: string; reason: string };
}

interface Vectors {
  issuers: Record<string, Jwk[]>;
  statusLists: StatusLists;
  verify: VerifyVector[];
  status: StatusVector[];
  hash: Array<{ name: string; input: string; hash: string }>;
  thumbprints: Array<{ name: string; jwk: Jwk; thumbprint: string }>;
  keysEqual: Array<{ name: string; a: Jwk; b: Jwk; equal: boolean }>;
}

const vectorsPath = fileURLToPath(new URL('../../../spec/examples/agent-passport-vectors.json', import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors;

/** A status resolver over the vectors' status lists; an entry that is not there is a resolver failure. */
function statusResolverFor(lists: StatusLists): StatusResolver {
  return (uri, idx) => {
    const value = lists[uri]?.[String(idx)];
    if (value === undefined) throw new Error(`no status list entry for ${uri} ${idx}`);
    return value as PassportStatus;
  };
}

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
        statusResolver: statusResolverFor(vectors.statusLists),
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

describe('shared vectors: status', () => {
  it('has a status vector for VALID, INVALID, SUSPENDED, an unknown value and a failing resolver', () => {
    const outcomes = new Set(
      vectors.status.map((v) => (v.expect.ok ? 'ok' : `${v.expect.code}/${v.expect.reason}`)),
    );
    for (const outcome of [
      'ok',
      'passport_revoked/status_invalid',
      'passport_revoked/status_suspended',
      'status_stale/status_unknown',
      'status_stale/status_unresolved',
    ]) {
      expect(outcomes).toContain(outcome);
    }
  });

  for (const vector of vectors.status) {
    it(vector.name, async () => {
      const base = vectors.verify.find((v) => v.name === vector.vector);
      expect(base?.expect.ok).toBe(true);
      const opts: VerifyPassportOptions = {
        compact: (base as VerifyVector).compact,
        issuerKeys: (iss: string) => vectors.issuers[iss] ?? [],
        statusResolver: statusResolverFor(vector.statusLists),
        ...(base as VerifyVector).options,
      };
      const outcome = await verifyPassport(opts).then(
        (result) => ({ ok: true as const, statusCheckedBy: result.statusCheckedBy }),
        (e: unknown) => e,
      );
      if (vector.expect.ok) {
        expect(outcome).toEqual({ ok: true, statusCheckedBy: 'resolver' });
      } else {
        expect(outcome).toBeInstanceOf(PassportError);
        expect({ code: (outcome as PassportError).code, reason: (outcome as PassportError).reason }).toEqual({
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
