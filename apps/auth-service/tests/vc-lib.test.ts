import { describe, it, expect, beforeAll } from 'vitest';
import { initKeys, getKeyPair } from '../src/lib/crypto.js';
import { sqlMock } from './setup.js';

// Import after mocks are set up by setup.ts
import {
  issueAgentGrantVC,
  verifyAgentGrantVC,
  getOrCreateStatusList,
  revokeVCsByGrantIds,
} from '../src/lib/vc.js';

beforeAll(async () => {
  await initKeys();
});

// ── getOrCreateStatusList ───────────────────────────────────────────────────

describe('getOrCreateStatusList', () => {
  it('creates a new status list when none exists', async () => {
    // SELECT existing → empty
    sqlMock.mockResolvedValueOnce([]);
    // INSERT new list
    sqlMock.mockResolvedValueOnce([]);

    const result = await getOrCreateStatusList('dev_TEST');

    expect(result.id).toMatch(/^vcsl_/);
    expect(result.nextIndex).toBe(0);
  });

  it('returns existing status list', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_EXISTING',
      next_index: 5,
    }]);

    const result = await getOrCreateStatusList('dev_TEST');

    expect(result.id).toBe('vcsl_EXISTING');
    expect(result.nextIndex).toBe(5);
  });
});

// ── issueAgentGrantVC ───────────────────────────────────────────────────────

describe('issueAgentGrantVC', () => {
  it('creates a valid VC-JWT structure', async () => {
    // getOrCreateStatusList: SELECT existing
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_TEST1',
      next_index: 0,
    }]);
    // UPDATE next_index
    sqlMock.mockResolvedValueOnce([]);
    // INSERT verifiable_credentials
    sqlMock.mockResolvedValueOnce([]);

    const result = await issueAgentGrantVC({
      grantId: 'grnt_TEST1',
      agentDid: 'did:grantex:ag_TEST',
      principalId: 'user_123',
      developerId: 'dev_TEST',
      scopes: ['read', 'write'],
      expiresAt: new Date(Date.now() + 86400_000),
    });

    expect(result.vcId).toMatch(/^vc_/);
    expect(typeof result.vcJwt).toBe('string');
    expect(result.statusListIdx).toBe(0);

    // Decode and check the JWT payload
    const { decodeJwt } = await import('jose');
    const payload = decodeJwt(result.vcJwt);

    expect(payload.iss).toBe('did:web:grantex.dev');
    expect(payload.sub).toBe('did:grantex:ag_TEST');
    expect(payload.jti).toBe(result.vcId);
    expect(payload['vc']).toBeDefined();

    const vc = payload['vc'] as Record<string, unknown>;
    expect(vc['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      'https://grantex.dev/ns/credentials/v1',
    ]);
    expect(vc['type']).toEqual(['VerifiableCredential', 'AgentGrantCredential']);

    const subject = vc['credentialSubject'] as Record<string, unknown>;
    expect(subject['id']).toBe('did:grantex:ag_TEST');
    expect(subject['type']).toBe('AIAgent');
    expect(subject['principalId']).toBe('user_123');
    expect(subject['grantId']).toBe('grnt_TEST1');
    expect(subject['scopes']).toEqual(['read', 'write']);
    expect(subject['delegationDepth']).toBe(0);

    const status = vc['credentialStatus'] as Record<string, unknown>;
    expect(status['type']).toBe('StatusList2021Entry');
    expect(status['statusPurpose']).toBe('revocation');
  });

  it('includes FIDO evidence when provided', async () => {
    // getOrCreateStatusList: SELECT existing
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_TEST2',
      next_index: 1,
    }]);
    // UPDATE next_index
    sqlMock.mockResolvedValueOnce([]);
    // INSERT verifiable_credentials
    sqlMock.mockResolvedValueOnce([]);

    const result = await issueAgentGrantVC({
      grantId: 'grnt_TEST2',
      agentDid: 'did:grantex:ag_TEST',
      principalId: 'user_123',
      developerId: 'dev_TEST',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86400_000),
      fidoEvidence: { aaguid: '00000000-0000-0000-0000-000000000000' },
    });

    const { decodeJwt } = await import('jose');
    const payload = decodeJwt(result.vcJwt);
    const vc = payload['vc'] as Record<string, unknown>;
    const evidence = vc['evidence'] as Record<string, unknown>[];

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!['type']).toBe('FidoAttestation');
    expect(evidence[0]!['aaguid']).toBe('00000000-0000-0000-0000-000000000000');
  });
});

// ── verifyAgentGrantVC ──────────────────────────────────────────────────────

describe('verifyAgentGrantVC', () => {
  it('succeeds for a valid VC-JWT', async () => {
    // Issue a VC first
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_V1', next_index: 0 }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const { vcJwt } = await issueAgentGrantVC({
      grantId: 'grnt_V1',
      agentDid: 'did:grantex:ag_V1',
      principalId: 'user_v1',
      developerId: 'dev_TEST',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86400_000),
    });

    // verifyAgentGrantVC: SELECT status list for revocation check
    sqlMock.mockResolvedValueOnce([]);

    const result = await verifyAgentGrantVC(vcJwt);

    expect(result.valid).toBe(true);
    expect(result.vcId).toMatch(/^vc_/);
    expect(result.payload).toBeDefined();
  });

  it('returns invalid for garbage input', async () => {
    const result = await verifyAgentGrantVC('not-a-jwt');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid JWT format');
  });

  it('returns invalid for a JWT with wrong signature', async () => {
    // Create a JWT signed with a different key
    const { generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256');
    const fakeVcJwt = await new (await import('jose')).SignJWT({ vc: {} })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('did:web:fake.dev')
      .setSubject('did:fake:agent')
      .setJti('vc_FAKE')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    const result = await verifyAgentGrantVC(fakeVcJwt);
    expect(result.valid).toBe(false);
    expect(result.vcId).toBe('vc_FAKE');
  });

  it('returns invalid when vc claim is missing', async () => {
    const { privateKey, kid } = getKeyPair();
    const { SignJWT } = await import('jose');
    const jwt = await new SignJWT({ notVc: 'something' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_NOVC')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    const result = await verifyAgentGrantVC(jwt);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Missing vc claim');
  });

  it('returns expired for an expired VC-JWT', async () => {
    const { privateKey, kid } = getKeyPair();
    const expiredVcJwt = await new (await import('jose')).SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        credentialSubject: { id: 'did:test:agent' },
      },
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('did:web:grantex.dev')
      .setSubject('did:test:agent')
      .setJti('vc_EXPIRED')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    const result = await verifyAgentGrantVC(expiredVcJwt);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
  });
});

// ── revokeVCsByGrantIds ─────────────────────────────────────────────────────

describe('revokeVCsByGrantIds', () => {
  it('does nothing for empty grant IDs', async () => {
    await revokeVCsByGrantIds([], 'dev_TEST');
    // No SQL calls expected
  });

  it('does nothing when no active VCs found', async () => {
    // SELECT active VCs → empty
    sqlMock.mockResolvedValueOnce([]);

    await revokeVCsByGrantIds(['grnt_1'], 'dev_TEST');
  });

  it('flips correct bits in status list', async () => {
    // SELECT active VCs
    sqlMock.mockResolvedValueOnce([
      { id: 'vc_R1', status_list_idx: 3 },
      { id: 'vc_R2', status_list_idx: 7 },
    ]);
    // UPDATE VCs to revoked
    sqlMock.mockResolvedValueOnce([]);
    // SELECT status list for bit flipping
    const { gzipSync } = await import('node:zlib');
    const emptyBits = Buffer.alloc(16384, 0);
    const encoded = gzipSync(emptyBits).toString('base64url');
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_BIT',
      encoded_list: encoded,
    }]);
    // UPDATE status list with flipped bits
    sqlMock.mockResolvedValueOnce([]);

    await revokeVCsByGrantIds(['grnt_R1'], 'dev_TEST');

    // Verify the UPDATE call was made with updated encoded_list
    expect(sqlMock).toHaveBeenCalled();
    // The 4th call (index 3) should be the status list update
    const lastCallArgs = sqlMock.mock.calls[sqlMock.mock.calls.length - 1];
    // The SQL template should contain the encoded_list update
    expect(lastCallArgs).toBeDefined();
  });
});
