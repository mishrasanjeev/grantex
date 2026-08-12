import { describe, it, expect, beforeAll } from 'vitest';
import { initKeys, getKeyPair } from '../src/lib/crypto.js';
import { sqlMock } from './setup.js';

// Import after mocks are set up by setup.ts
import {
  issueAgentGrantVC,
  verifyAgentGrantVC,
  allocateStatusListIndex,
  revokeVCsByGrantIds,
} from '../src/lib/vc.js';

beforeAll(async () => {
  await initKeys();
});

// ── allocateStatusListIndex ─────────────────────────────────────────────────

describe('allocateStatusListIndex', () => {
  it('claims a slot from an existing list in a single statement', async () => {
    // UPDATE ... RETURNING id, next_index - 1
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_EXISTING', allocated_index: 5 }]);

    const result = await allocateStatusListIndex('dev_TEST');

    expect(result).toEqual({ listId: 'vcsl_EXISTING', index: 5 });
    // A read-then-increment pair would have taken two statements and could hand
    // the same index to a concurrent issuer.
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('creates a new list when none exists', async () => {
    sqlMock.mockResolvedValueOnce([]);   // no list with capacity
    sqlMock.mockResolvedValueOnce([]);   // advisory lock
    sqlMock.mockResolvedValueOnce([]);   // re-check after lock
    sqlMock.mockResolvedValueOnce([]);   // INSERT new list

    const result = await allocateStatusListIndex('dev_TEST');

    expect(result.listId).toMatch(/^vcsl_/);
    expect(result.index).toBe(0);
  });

  it('rolls over to a new list once the current one is full', async () => {
    // The claim query filters on next_index < size, so a full list returns no
    // row and allocation falls through to creating the next list.
    sqlMock.mockResolvedValueOnce([]);   // current list is full
    sqlMock.mockResolvedValueOnce([]);   // advisory lock
    sqlMock.mockResolvedValueOnce([]);   // still full after lock
    sqlMock.mockResolvedValueOnce([]);   // INSERT rollover list

    const result = await allocateStatusListIndex('dev_FULL');

    expect(result.listId).toMatch(/^vcsl_/);
    expect(result.index).toBe(0);
  });

  it('uses the list another caller created while waiting on the lock', async () => {
    sqlMock.mockResolvedValueOnce([]);   // no list with capacity
    sqlMock.mockResolvedValueOnce([]);   // advisory lock
    // Another request created the list first; re-check finds it.
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_RACED', allocated_index: 0 }]);

    const result = await allocateStatusListIndex('dev_TEST');

    expect(result).toEqual({ listId: 'vcsl_RACED', index: 0 });
  });
});

// ── issueAgentGrantVC ───────────────────────────────────────────────────────

describe('issueAgentGrantVC', () => {
  it('creates a valid VC-JWT structure', async () => {
    // allocateStatusListIndex: single UPDATE ... RETURNING
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_TEST1', allocated_index: 0 }]);
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
    // allocateStatusListIndex: single UPDATE ... RETURNING
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_TEST2', allocated_index: 1 }]);
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
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_V1', allocated_index: 0 }]);
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
    const { gzipSync, gunzipSync } = await import('node:zlib');
    const encoded = gzipSync(Buffer.alloc(16384, 0)).toString('base64url');

    // SELECT active VCs
    sqlMock.mockResolvedValueOnce([
      { id: 'vc_R1', status_list_id: 'vcsl_BIT', status_list_idx: 3 },
      { id: 'vc_R2', status_list_id: 'vcsl_BIT', status_list_idx: 7 },
    ]);
    // setRevocationBits: SELECT ... FOR UPDATE
    sqlMock.mockResolvedValueOnce([{ encoded_list: encoded }]);
    // setRevocationBits: UPDATE encoded_list
    sqlMock.mockResolvedValueOnce([]);
    // UPDATE VCs to revoked
    sqlMock.mockResolvedValueOnce([]);

    await revokeVCsByGrantIds(['grnt_R1'], 'dev_TEST');

    // The UPDATE that writes the list back carries the new bitstring as a
    // template parameter; decode it and confirm both bits are set.
    const updateCall = sqlMock.mock.calls.find((call) => {
      const fragments = call[0] as unknown as string[];
      return Array.isArray(fragments) && fragments.some((f) => f.includes('SET encoded_list'));
    });
    expect(updateCall).toBeDefined();

    const written = updateCall![1] as string;
    const bits = gunzipSync(Buffer.from(written, 'base64url'));
    const bitAt = (i: number) => (bits[Math.floor(i / 8)]! >> (7 - (i % 8))) & 1;
    expect(bitAt(3)).toBe(1);
    expect(bitAt(7)).toBe(1);
    expect(bitAt(4)).toBe(0);
  });

  it('groups revocations by the list each credential was allocated from', async () => {
    const { gzipSync } = await import('node:zlib');
    const encoded = gzipSync(Buffer.alloc(16384, 0)).toString('base64url');

    // Two credentials sharing index 0 but living on different lists — the
    // situation rollover creates. Flipping index 0 on one list must not be
    // mistaken for revoking the other.
    sqlMock.mockResolvedValueOnce([
      { id: 'vc_A', status_list_id: 'vcsl_ONE', status_list_idx: 0 },
      { id: 'vc_B', status_list_id: 'vcsl_TWO', status_list_idx: 0 },
    ]);
    sqlMock.mockResolvedValueOnce([{ encoded_list: encoded }]);  // list one SELECT
    sqlMock.mockResolvedValueOnce([]);                            // list one UPDATE
    sqlMock.mockResolvedValueOnce([{ encoded_list: encoded }]);  // list two SELECT
    sqlMock.mockResolvedValueOnce([]);                            // list two UPDATE
    sqlMock.mockResolvedValueOnce([]);                            // mark revoked

    await revokeVCsByGrantIds(['grnt_A'], 'dev_TEST');

    const listIdsTouched = sqlMock.mock.calls
      .filter((call) => {
        const fragments = call[0] as unknown as string[];
        return Array.isArray(fragments) && fragments.some((f) => f.includes('FOR UPDATE'));
      })
      .map((call) => call[1] as string);

    expect(listIdsTouched).toEqual(['vcsl_ONE', 'vcsl_TWO']);
  });

  it('skips credentials with no recorded status list', async () => {
    sqlMock.mockResolvedValueOnce([
      { id: 'vc_ORPHAN', status_list_id: null, status_list_idx: 2 },
    ]);
    sqlMock.mockResolvedValueOnce([]); // mark revoked

    await revokeVCsByGrantIds(['grnt_O'], 'dev_TEST');

    const touchedList = sqlMock.mock.calls.some((call) => {
      const fragments = call[0] as unknown as string[];
      return Array.isArray(fragments) && fragments.some((f) => f.includes('FOR UPDATE'));
    });
    expect(touchedList).toBe(false);
  });
});
