// SPDX-License-Identifier: Apache-2.0
//
// Identity, possession proof and Agent Passport issuance.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PASSPORT_VCT,
  PassportError,
  externalCredentialHash,
  jwkThumbprint,
  verifyPassport,
} from '@grantex/agent-passport';
import {
  MOCK_ISSUER_ENTITY_ID,
  MOCK_ISSUER_STATUS_LIST_BASE,
  MockIssuer,
  MockIssuerError,
  POSSESSION_PROOF_TYP,
  signPossessionProof,
} from '../src/index.ts';
import { AGENT_DID, PROFILE, agentKeyPair, decodeJws, tempDir } from './helpers.ts';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function issueFor(issuer: MockIssuer, agent = agentKeyPair()) {
  const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
  const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk });
  return {
    agent,
    issued: issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE }),
  };
}

describe('identity', () => {
  it('has the mock entity id and a static JWKS of one public ES256 key', () => {
    const issuer = MockIssuer.create();
    expect(issuer.entityId).toBe('https://mock-issuer.example');
    expect(MOCK_ISSUER_ENTITY_ID).toBe('https://mock-issuer.example');
    expect(issuer.statusListBase).toBe(MOCK_ISSUER_STATUS_LIST_BASE);
    expect(MOCK_ISSUER_STATUS_LIST_BASE).toBe('https://mock-issuer.example/status/');
    const { keys } = issuer.jwks();
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: issuer.kid });
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) expect(key).not.toHaveProperty(member);
  });

  it('generates a new key at each start without a directory', () => {
    expect(MockIssuer.create().kid).not.toBe(MockIssuer.create().kid);
  });

  it('persists the key to a caller-given directory and loads it again', () => {
    const dir = tempDir();
    cleanups.push(dir.remove);
    const first = MockIssuer.create({ dir: dir.path });
    const second = MockIssuer.create({ dir: dir.path });
    expect(second.kid).toBe(first.kid);
    expect(second.jwks()).toEqual(first.jwks());
    const keyFile = join(dir.path, 'issuer-key.json');
    expect(readdirSync(dir.path)).toContain('issuer-key.json');
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o077).toBe(0);
  });

  it('refuses a key file that is not a private P-256 key', async () => {
    const dir = tempDir();
    cleanups.push(dir.remove);
    MockIssuer.create({ dir: dir.path });
    const { writeFileSync } = await import('node:fs');
    const keyFile = join(dir.path, 'issuer-key.json');
    const stored = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>;
    delete stored.d;
    writeFileSync(keyFile, JSON.stringify(stored));
    expect(() => MockIssuer.create({ dir: dir.path })).toThrow(MockIssuerError);
  });
});

describe('possession proof', () => {
  it('issues a challenge bound to the agent key, audience and subject', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
    expect(challenge).toMatchObject({
      thumbprint: jwkThumbprint(agent.publicJwk),
      audience: MOCK_ISSUER_ENTITY_ID,
      subject: AGENT_DID,
      typ: POSSESSION_PROOF_TYP,
      alg: 'ES256',
    });
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const proof = decodeJws(signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk }));
    expect(proof.header).toMatchObject({ alg: 'ES256', typ: 'agent-key-proof+jwt', kid: challenge.thumbprint });
    expect(proof.payload).toMatchObject({ aud: MOCK_ISSUER_ENTITY_ID, sub: AGENT_DID, nonce: challenge.challenge });
  });

  it('refuses to issue without a proof', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const attempt = () =>
      issuer.issuePassport({
        agentDid: AGENT_DID,
        agentPublicJwk: agent.publicJwk,
        possessionProof: undefined as unknown as string,
        ...PROFILE,
      });
    expect(attempt).toThrow(expect.objectContaining({ code: 'key_unproven' }));
  });

  it('refuses a proof signed by another key with key_unproven, as the registry does', () => {
    // spec/agent-keys.md section 4.3: a signature that does not verify with the key is key_unproven.
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const other = agentKeyPair();
    const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
    const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: other.privateJwk });
    expect(() =>
      issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE }),
    ).toThrow(expect.objectContaining({ code: 'key_unproven' }));
  });

  it('refuses a proof whose kid is not the key thumbprint with key_binding_mismatch', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
    const possessionProof = signPossessionProof({
      challenge: { ...challenge, thumbprint: 'A'.repeat(43) },
      agentPrivateJwk: agent.privateJwk,
    });
    expect(() =>
      issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE }),
    ).toThrow(expect.objectContaining({ code: 'key_binding_mismatch' }));
  });

  it('refuses a proof for another audience, another subject or an unknown challenge', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
    const issue = (possessionProof: string) =>
      issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE });
    const sign = (overrides: Partial<typeof challenge>) =>
      signPossessionProof({ challenge: { ...challenge, ...overrides }, agentPrivateJwk: agent.privateJwk });
    expect(() => issue(sign({ audience: 'https://issuer.example' }))).toThrow(
      expect.objectContaining({ code: 'audience_mismatch' }),
    );
    expect(() => issue(sign({ subject: 'did:web:provider.example:agents:other' }))).toThrow(
      expect.objectContaining({ code: 'key_binding_mismatch' }),
    );
    expect(() => issue(sign({ challenge: 'A'.repeat(43) }))).toThrow(expect.objectContaining({ code: 'key_unproven' }));
    expect(() => issue('not-a-jws')).toThrow(expect.objectContaining({ code: 'key_unproven' }));
  });

  it('refuses a proof that answers another key\'s challenge', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const other = agentKeyPair();
    const otherChallenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: other.publicJwk });
    // Signed by the key being bound, but over the nonce issued for another key.
    const possessionProof = signPossessionProof({
      challenge: { ...otherChallenge, thumbprint: jwkThumbprint(agent.publicJwk) },
      agentPrivateJwk: agent.privateJwk,
    });
    expect(() =>
      issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE }),
    ).toThrow(expect.objectContaining({ code: 'key_unproven' }));
  });

  it('uses a challenge once', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
    const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk });
    const params = { agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE };
    issuer.issuePassport(params);
    expect(() => issuer.issuePassport(params)).toThrow(expect.objectContaining({ code: 'key_unproven' }));
  });

  it('refuses an expired challenge and a stale proof', () => {
    let now = 1_790_000_000;
    const issuer = MockIssuer.create({ clock: () => now });
    const agent = agentKeyPair();
    const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
    const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk, iat: now });
    now += 301;
    expect(() =>
      issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE }),
    ).toThrow(expect.objectContaining({ code: 'key_unproven' }));
  });

  it('refuses a private agent key as the key to bind', () => {
    const issuer = MockIssuer.create();
    const agent = agentKeyPair();
    expect(() => issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.privateJwk })).toThrow(
      MockIssuerError,
    );
  });
});

describe('Agent Passport issuance', () => {
  it('issues a passport that verifies with @grantex/agent-passport against the mock JWKS', async () => {
    const issuer = MockIssuer.create();
    const { agent, issued } = issueFor(issuer);
    const passport = await verifyPassport({
      compact: issued.compact,
      issuerKeys: (iss) => (iss === MOCK_ISSUER_ENTITY_ID ? issuer.jwks().keys : []),
      // The issuer's own status store answers for the entry the passport names.
      statusResolver: () => issuer.passportStatus(issued.attestationId),
      paymentsRails: true,
    });
    expect(passport.iss).toBe(MOCK_ISSUER_ENTITY_ID);
    expect(passport.sub).toBe(AGENT_DID);
    expect(passport.vct).toBe(PASSPORT_VCT);
    expect(passport.vct).toBe('urn:grantex:agent-passport:1');
    expect(passport.header.kid).toBe(issuer.kid);
    expect(passport.cnfThumbprint).toBe(jwkThumbprint(agent.publicJwk));
    expect(passport.disclosed.provider).toEqual(PROFILE.provider);
    expect(passport.disclosed.agent).toEqual(PROFILE.agent);
    expect(passport.disclosed.verification).toMatchObject(PROFILE.verification);
    expect(passport.disclosed.attestation_id).toBe(issued.attestationId);
    expect(issued.attestationId).toMatch(/^att_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.attestationId.slice(4)).toMatch(ULID);
    expect(passport.status).toEqual(issued.status);
    expect(issued.status.status_list.uri.startsWith(MOCK_ISSUER_STATUS_LIST_BASE)).toBe(true);
    expect(issued.externalCredentialHash).toBe(externalCredentialHash(issued.compact));
    expect(issued.keyThumbprint).toBe(passport.cnfThumbprint);
  });

  it('does not verify against another issuer key', async () => {
    const { issued } = issueFor(MockIssuer.create());
    const other = MockIssuer.create();
    await expect(
      verifyPassport({ compact: issued.compact, issuerKeys: () => other.jwks().keys, statusCheckedBy: 'caller' }),
    ).rejects.toBeInstanceOf(PassportError);
  });

  it('binds an Ed25519 agent key too', async () => {
    const issuer = MockIssuer.create();
    const { issued } = issueFor(issuer, agentKeyPair('ed25519'));
    const passport = await verifyPassport({
      compact: issued.compact,
      issuerKeys: () => issuer.jwks().keys,
      statusCheckedBy: 'caller',
    });
    expect(passport.cnfJwk.crv).toBe('Ed25519');
  });

  it('keeps passports and status entries in the directory across restarts', () => {
    const dir = tempDir();
    cleanups.push(dir.remove);
    const first = MockIssuer.create({ dir: dir.path });
    const { issued } = issueFor(first);
    first.suspendPassport(issued.attestationId);
    const second = MockIssuer.create({ dir: dir.path });
    expect(second.passport(issued.attestationId)?.compact).toBe(issued.compact);
    expect(second.passportStatus(issued.attestationId)).toBe('suspended');
  });
});
