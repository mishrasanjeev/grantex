// SPDX-License-Identifier: Apache-2.0
//
// The attestation compact JWS (PRD Appendix A) and posting it to a registry.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { externalCredentialHash, jwkThumbprint } from '@grantex/agent-passport';
import {
  ATTESTATION_MEDIA_TYPE,
  ATTESTATION_TYP,
  MAX_REGISTRY_RESPONSE_BYTES,
  MockIssuer,
  TRUST_MARK_AGENT_IDENTITY,
  TRUST_MARK_PROVIDER_ENTITY,
  decodeTokenStatusList,
  postAttestation,
  signPossessionProof,
} from '../src/index.ts';
import { AGENT_DID, PROFILE, agentKeyPair, verifiedEs256 } from './helpers.ts';

function setup() {
  const issuer = MockIssuer.create();
  const agent = agentKeyPair();
  const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
  const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk });
  const issued = issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE });
  return { issuer, agent, issued };
}

function verified(issuer: MockIssuer, jws: string) {
  return verifiedEs256(jws, issuer.jwks().keys[0]!);
}

describe('agent identity attestation', () => {
  it('has the Appendix A header and payload', () => {
    const { issuer, agent, issued } = setup();
    const { header, payload } = verified(issuer, issuer.buildAttestation({ attestationId: issued.attestationId }));
    expect(header).toEqual({ alg: 'ES256', typ: 'grantex-attestation+jwt', kid: issuer.kid });
    expect(ATTESTATION_TYP).toBe('grantex-attestation+jwt');
    expect(Object.keys(payload).sort()).toEqual(
      [
        'id', 'iss', 'sub', 'type', 'key_thumbprint', 'external_credential_id', 'external_credential_hash',
        'level', 'declared_limits', 'iat', 'exp', 'status',
      ].sort(),
    );
    expect(payload).toMatchObject({
      id: issued.attestationId,
      iss: 'https://mock-issuer.example',
      sub: AGENT_DID,
      type: 'urn:grantex:tm:agent.identity',
      key_thumbprint: jwkThumbprint(agent.publicJwk),
      external_credential_id: issued.passportId,
      level: 'standard',
      declared_limits: PROFILE.agent.declared_limits,
      exp: issued.exp,
      status: issued.status,
    });
    expect(TRUST_MARK_AGENT_IDENTITY).toBe('urn:grantex:tm:agent.identity');
    expect(payload.id).toMatch(/^att_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.external_credential_id).toMatch(/^ppt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.iat as number).toBeLessThan(payload.exp as number);
  });

  it('follows the hash rule over the issued passport', () => {
    const { issuer, issued } = setup();
    const { payload } = verified(issuer, issuer.buildAttestation({ attestationId: issued.attestationId }));
    const issuerSignedJwt = issued.compact.slice(0, issued.compact.indexOf('~'));
    const expected = `sha-256:${createHash('sha256').update(issuerSignedJwt, 'ascii').digest('base64url')}`;
    expect(payload.external_credential_hash).toBe(expected);
    expect(payload.external_credential_hash).toBe(externalCredentialHash(issued.compact));
  });

  it('refuses an attestation id it never issued', () => {
    const { issuer } = setup();
    expect(() => issuer.buildAttestation({ attestationId: 'att_01J00000000000000000000000' })).toThrow(
      expect.objectContaining({ code: 'attestation_not_registered' }),
    );
  });

  it('refuses to attest a revoked passport', () => {
    const { issuer, issued } = setup();
    issuer.revokePassport(issued.attestationId);
    expect(() => issuer.buildAttestation({ attestationId: issued.attestationId })).toThrow(
      expect.objectContaining({ code: 'passport_revoked' }),
    );
  });
});

describe('provider entity attestation', () => {
  it('names the provider, carries no key and has a status entry of its own', () => {
    const { issuer, issued } = setup();
    const jws = issuer.buildAttestation({ attestationId: issued.attestationId, type: TRUST_MARK_PROVIDER_ENTITY });
    const { payload } = verified(issuer, jws);
    expect(payload).toMatchObject({
      iss: issuer.entityId,
      sub: PROFILE.provider.did,
      type: 'urn:grantex:tm:provider.entity',
      external_credential_id: issued.passportId,
      external_credential_hash: issued.externalCredentialHash,
      level: 'standard',
    });
    expect(payload).not.toHaveProperty('key_thumbprint');
    expect(payload).not.toHaveProperty('declared_limits');
    expect(payload.id).not.toBe(issued.attestationId);
    const status = payload.status as { status_list: { uri: string; idx: number } };
    expect(status.status_list.uri.startsWith(issuer.statusListBase)).toBe(true);
    expect(status).not.toEqual(issued.status);
    // Asked again, the same provider attestation (same id and entry) is returned.
    const again = verified(issuer, issuer.buildAttestation({ attestationId: issued.attestationId, type: TRUST_MARK_PROVIDER_ENTITY }));
    expect(again.payload.id).toBe(payload.id);
    expect(again.payload.status).toEqual(payload.status);
    // Its entry is revoked on its own.
    issuer.revokePassport(payload.id as string);
    expect(issuer.passportStatus(payload.id as string)).toBe('invalid');
    expect(issuer.passportStatus(issued.attestationId)).toBe('valid');
  });

  it('follows its passport when the passport is suspended, reinstated or revoked', () => {
    const { issuer, issued } = setup();
    const { payload } = verified(issuer, issuer.buildAttestation({ attestationId: issued.attestationId, type: TRUST_MARK_PROVIDER_ENTITY }));
    const providerId = payload.id as string;
    issuer.suspendPassport(issued.attestationId);
    expect(issuer.passportStatus(providerId)).toBe('suspended');
    issuer.reinstatePassport(issued.attestationId);
    expect(issuer.passportStatus(providerId)).toBe('valid');
    issuer.revokePassport(issued.attestationId);
    expect(issuer.passportStatus(providerId)).toBe('invalid');
    // The published lists say the same: the provider attestation's entry is INVALID.
    const status = payload.status as { status_list: { uri: string; idx: number } };
    const list = Number(status.status_list.uri.slice(issuer.statusListBase.length));
    const tsl = verified(issuer, issuer.tokenStatusList(list)).payload.status_list as { bits: number; lst: string };
    expect(decodeTokenStatusList(tsl).statusAt(status.status_list.idx)).toBe(1);
  });

  it('stays revoked when its passport is reinstated after it was revoked on its own', () => {
    const { issuer, issued } = setup();
    const { payload } = verified(issuer, issuer.buildAttestation({ attestationId: issued.attestationId, type: TRUST_MARK_PROVIDER_ENTITY }));
    issuer.revokePassport(payload.id as string);
    issuer.suspendPassport(issued.attestationId);
    issuer.reinstatePassport(issued.attestationId);
    expect(issuer.passportStatus(issued.attestationId)).toBe('valid');
    expect(issuer.passportStatus(payload.id as string)).toBe('invalid');
  });

  it('refuses a trust mark type the mock does not attest', () => {
    const { issuer, issued } = setup();
    expect(() =>
      issuer.buildAttestation({ attestationId: issued.attestationId, type: 'urn:grantex:tm:agent.security' as never }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
});

describe('posting to a registry', () => {
  // The registry's contract for POST /v1/registry/attestations
  // (spec/attestation-1.0.md §5): the body is the compact JWS itself with
  // Content-Type application/jwt or application/grantex-attestation+jwt, at
  // most 16,384 bytes; anything else is 415. There is no API key.
  const REGISTRY_MEDIA_TYPES = ['application/jwt', 'application/grantex-attestation+jwt'];
  const REGISTRY_MAX_BODY_BYTES = 16_384;

  type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

  async function listen(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void) {
    const seen: Seen[] = [];
    const server = createServer((req, res) => handler(req, res, seen));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      seen,
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
  }

  function stubRegistry(status: number) {
    return listen((req, res, seen) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        res.setHeader('content-type', 'application/json');
        if (!REGISTRY_MEDIA_TYPES.includes(type)) {
          res.writeHead(415).end(JSON.stringify({ code: 'UNSUPPORTED_MEDIA_TYPE' }));
        } else if (Buffer.byteLength(body) > REGISTRY_MAX_BODY_BYTES || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(body.trim())) {
          res.writeHead(400).end(JSON.stringify({ code: 'attestation_malformed' }));
        } else {
          res.writeHead(status).end(JSON.stringify(status < 300 ? { id: 'ok' } : { code: 'attestation_not_accepted' }));
        }
      });
    });
  }

  it('POSTs the compact JWS as the body with the attestation media type and no credential', async () => {
    const { issuer, issued } = setup();
    const attestation = issuer.buildAttestation({ attestationId: issued.attestationId });
    const registry = await stubRegistry(201);
    try {
      const result = await postAttestation({ registryBaseUrl: registry.base, attestation });
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ id: 'ok' });
      expect(registry.seen).toHaveLength(1);
      const [request] = registry.seen;
      expect(request!.method).toBe('POST');
      expect(request!.url).toBe('/v1/registry/attestations');
      expect(request!.headers['content-type']).toBe('application/grantex-attestation+jwt');
      expect(ATTESTATION_MEDIA_TYPE).toBe('application/grantex-attestation+jwt');
      expect(request!.headers.authorization).toBeUndefined();
      expect(request!.body).toBe(attestation);
      expect(Buffer.byteLength(request!.body)).toBeLessThanOrEqual(REGISTRY_MAX_BODY_BYTES);
    } finally {
      await registry.close();
    }
  });

  it('fails closed on a refusal', async () => {
    const { issuer, issued } = setup();
    const attestation = issuer.buildAttestation({ attestationId: issued.attestationId });
    const registry = await stubRegistry(422);
    try {
      await expect(postAttestation({ registryBaseUrl: registry.base, attestation })).rejects.toMatchObject({
        code: 'registry_refused',
        httpStatus: 422,
      });
    } finally {
      await registry.close();
    }
  });

  it('gives up on a registry that never answers', async () => {
    const registry = await listen(() => {
      // Accept the connection and never answer.
    });
    try {
      await expect(
        postAttestation({ registryBaseUrl: registry.base, attestation: 'a.b.c', timeoutMs: 200 }),
      ).rejects.toMatchObject({ code: 'registry_unreachable' });
    } finally {
      await registry.close();
    }
  });

  it('refuses an answer larger than the bound without buffering it', async () => {
    const registry = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('x'.repeat(MAX_REGISTRY_RESPONSE_BYTES + 1));
      });
    });
    try {
      await expect(postAttestation({ registryBaseUrl: registry.base, attestation: 'a.b.c' })).rejects.toMatchObject({
        code: 'registry_refused',
      });
    } finally {
      await registry.close();
    }
  });

  it('refuses a registry URL that is not http(s)', async () => {
    await expect(postAttestation({ registryBaseUrl: 'file:///etc/passwd', attestation: 'a.b.c' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
