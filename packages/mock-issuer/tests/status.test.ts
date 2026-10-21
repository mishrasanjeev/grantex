// SPDX-License-Identifier: Apache-2.0
//
// The issuer's own passport status lists: allocation, the two published
// formats, and revoke / suspend / reinstate.

import { describe, expect, it } from 'vitest';
import {
  CI_STATUS_TTL_SECONDS,
  MOCK_ISSUER_STATUS_LIST_BASE,
  MockIssuer,
  PassportStatusStore,
  STANDARD_STATUS_TTL_SECONDS,
  STATUS_LIST_CAPACITY,
  decodeBitstringStatusList,
  decodeTokenStatusList,
  signPossessionProof,
} from '../src/index.ts';
import { AGENT_DID, PROFILE, agentKeyPair, decodeJws, verifiedEs256 } from './helpers.ts';

function issue(issuer: MockIssuer) {
  const agent = agentKeyPair();
  const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
  const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk });
  return issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE });
}

function listNumberOf(uri: string): number {
  expect(uri.startsWith(MOCK_ISSUER_STATUS_LIST_BASE)).toBe(true);
  return Number(uri.slice(MOCK_ISSUER_STATUS_LIST_BASE.length));
}

/** Verify a signed list with the issuer's published JWKS, as a relying party would. */
function verified(issuer: MockIssuer, jws: string) {
  const key = issuer.jwks().keys.find((k) => k.kid === decodeJws(jws).header.kid);
  expect(key).toBeDefined();
  return verifiedEs256(jws, key!);
}

function tslStatus(issuer: MockIssuer, uri: string, idx: number): number {
  const { payload } = verified(issuer, issuer.tokenStatusList(listNumberOf(uri)));
  const statusList = payload.status_list as { bits: number; lst: string };
  return decodeTokenStatusList(statusList).statusAt(idx);
}

function bslSet(issuer: MockIssuer, uri: string, idx: number, purpose: 'revocation' | 'suspension'): boolean {
  const { payload } = verified(issuer, issuer.bitstringStatusListCredential(listNumberOf(uri), purpose));
  const subject = payload.credentialSubject as { encodedList: string };
  return decodeBitstringStatusList(subject.encodedList).isSet(idx);
}

describe('allocation', () => {
  it('holds at least 131,072 entries per list', () => {
    expect(STATUS_LIST_CAPACITY).toBeGreaterThanOrEqual(131_072);
    expect(() => new PassportStatusStore({ capacity: 1024 })).toThrow();
  });

  it('allocates unique, randomly placed indices', () => {
    const store = new PassportStatusStore();
    const refs = Array.from({ length: 5000 }, () => store.allocate());
    const keys = new Set(refs.map((r) => `${r.list}:${r.idx}`));
    expect(keys.size).toBe(refs.length);
    const indices = refs.map((r) => r.idx);
    // Not handed out in order: sequential allocation would make every step +1.
    const ascendingSteps = indices.slice(1).filter((idx, i) => idx === indices[i]! + 1).length;
    expect(ascendingSteps).toBeLessThan(10);
    // Spread over the whole list rather than packed at its start.
    expect(Math.max(...indices)).toBeGreaterThan(STATUS_LIST_CAPACITY / 2);
    expect(Math.min(...indices)).toBeLessThan(STATUS_LIST_CAPACITY / 2);
    for (const idx of indices) expect(idx).toBeLessThan(STATUS_LIST_CAPACITY);
  });

  it('opens a new list when the current one is three quarters allocated', () => {
    const store = new PassportStatusStore();
    const threeQuarters = (STATUS_LIST_CAPACITY * 3) / 4;
    let last = store.allocate();
    for (let i = 1; i < threeQuarters; i += 1) last = store.allocate();
    expect(last.list).toBe(1);
    expect(store.allocate().list).toBe(2);
  });
});

describe('Token Status List (draft-ietf-oauth-status-list-21 section 5.1)', () => {
  it('is a statuslist+jwt signed by the issuer key with the draft claims', () => {
    const issuer = MockIssuer.create();
    const issued = issue(issuer);
    const { uri } = issued.status.status_list;
    const { header, payload } = verified(issuer, issuer.tokenStatusList(listNumberOf(uri)));
    expect(header).toEqual({ alg: 'ES256', typ: 'statuslist+jwt', kid: issuer.kid });
    // Section 5.1: sub equals the uri in the referenced token.
    expect(payload.sub).toBe(uri);
    expect(payload.iss).toBe(issuer.entityId);
    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(payload.exp as number).toBeGreaterThan(payload.iat as number);
    expect(payload.ttl).toBe(CI_STATUS_TTL_SECONDS);
    expect(CI_STATUS_TTL_SECONDS).toBe(1);
    const statusList = payload.status_list as { bits: number; lst: string };
    expect(statusList.bits).toBe(2);
    expect(decodeTokenStatusList(statusList).size).toBe(STATUS_LIST_CAPACITY);
  });

  it('uses 600 s outside CI, or a ttl the caller sets', () => {
    expect(STANDARD_STATUS_TTL_SECONDS).toBe(600);
    for (const [options, ttl] of [
      [{ ttlProfile: 'standard' as const }, 600],
      [{ ttlSeconds: 42 }, 42],
    ] as const) {
      const issuer = MockIssuer.create(options);
      const { uri } = issue(issuer).status.status_list;
      expect(verified(issuer, issuer.tokenStatusList(listNumberOf(uri))).payload.ttl).toBe(ttl);
      const bsl = verified(issuer, issuer.bitstringStatusListCredential(listNumberOf(uri), 'revocation'));
      expect((bsl.payload.credentialSubject as { ttl: number }).ttl).toBe(ttl * 1000);
    }
    expect(() => MockIssuer.create({ ttlSeconds: 0 })).toThrow();
  });

  it('refuses a list that was never opened', () => {
    const issuer = MockIssuer.create();
    expect(() => issuer.tokenStatusList(7)).toThrow(expect.objectContaining({ code: 'status_list_not_found' }));
  });
});

describe('Bitstring Status List credential (W3C Bitstring Status List v1.0 section 2.2)', () => {
  it('is a VC-JWT BitstringStatusListCredential signed by the issuer key', () => {
    const issuer = MockIssuer.create();
    const { uri } = issue(issuer).status.status_list;
    for (const purpose of ['revocation', 'suspension'] as const) {
      const { header, payload } = verified(issuer, issuer.bitstringStatusListCredential(listNumberOf(uri), purpose));
      expect(header).toEqual({ alg: 'ES256', typ: 'vc+jwt', cty: 'vc', kid: issuer.kid });
      const id = purpose === 'revocation' ? `${uri}/bitstring` : `${uri}/bitstring/suspension`;
      expect(payload).toMatchObject({
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        id,
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        issuer: issuer.entityId,
        credentialSubject: { id: `${id}#list`, type: 'BitstringStatusList', statusPurpose: purpose, ttl: 1000 },
      });
      // VC-JOSE-COSE section 3.1.1: the credential is the claims set; no vc claim.
      expect(payload).not.toHaveProperty('vc');
      expect(Date.parse(payload.validUntil as string)).toBeGreaterThan(Date.parse(payload.validFrom as string));
      const subject = payload.credentialSubject as { encodedList: string };
      expect(decodeBitstringStatusList(subject.encodedList).length).toBe(STATUS_LIST_CAPACITY);
    }
  });
});

describe('revoke, suspend and reinstate', () => {
  it('flips the entry in both formats, each built from the store', () => {
    const issuer = MockIssuer.create();
    const issued = issue(issuer);
    const bystander = issue(issuer);
    const { uri, idx } = issued.status.status_list;
    const check = (tsl: number, revoked: boolean, suspended: boolean) => {
      expect(tslStatus(issuer, uri, idx)).toBe(tsl);
      expect(bslSet(issuer, uri, idx, 'revocation')).toBe(revoked);
      expect(bslSet(issuer, uri, idx, 'suspension')).toBe(suspended);
    };

    check(0, false, false);
    expect(issuer.passportStatus(issued.attestationId)).toBe('valid');

    issuer.suspendPassport(issued.attestationId);
    expect(issuer.passportStatus(issued.attestationId)).toBe('suspended');
    check(2, false, true);

    issuer.reinstatePassport(issued.attestationId);
    expect(issuer.passportStatus(issued.attestationId)).toBe('valid');
    check(0, false, false);

    issuer.revokePassport(issued.attestationId);
    expect(issuer.passportStatus(issued.attestationId)).toBe('invalid');
    check(1, true, false);

    // Other passports are untouched.
    const other = bystander.status.status_list;
    expect(tslStatus(issuer, other.uri, other.idx)).toBe(0);
  });

  it('makes revocation final', () => {
    const issuer = MockIssuer.create();
    const issued = issue(issuer);
    issuer.revokePassport(issued.attestationId);
    expect(() => issuer.reinstatePassport(issued.attestationId)).toThrow(
      expect.objectContaining({ code: 'passport_revoked' }),
    );
    expect(() => issuer.suspendPassport(issued.attestationId)).toThrow(
      expect.objectContaining({ code: 'passport_revoked' }),
    );
    issuer.revokePassport(issued.attestationId);
    expect(issuer.passportStatus(issued.attestationId)).toBe('invalid');
  });

  it('refuses an attestation it never issued', () => {
    const issuer = MockIssuer.create();
    for (const action of [
      () => issuer.revokePassport('att_01J00000000000000000000000'),
      () => issuer.suspendPassport('att_01J00000000000000000000000'),
      () => issuer.reinstatePassport('att_01J00000000000000000000000'),
      () => issuer.passportStatus('att_01J00000000000000000000000'),
    ]) {
      expect(action).toThrow(expect.objectContaining({ code: 'attestation_not_registered' }));
    }
  });
});
