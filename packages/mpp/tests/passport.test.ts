import { describe, it, expect, vi, afterEach } from 'vitest';
import { issuePassport } from '../src/passport.js';
import type { AgentPassportCredential, IssuePassportResponse } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGrantexClient(opts?: { baseUrl?: string; apiKey?: string }) {
  return {
    _baseUrl: opts?.baseUrl ?? 'https://api.grantex.dev',
    _apiKey: opts?.apiKey ?? 'test_key_123',
  } as unknown as import('@grantex/sdk').Grantex;
}

function makeMockResponse(): IssuePassportResponse {
  return {
    passportId: 'urn:grantex:passport:01HXYZ',
    credential: {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://grantex.dev/contexts/mpp/v1',
      ],
      type: ['VerifiableCredential', 'AgentPassportCredential'],
      id: 'urn:grantex:passport:01HXYZ',
      issuer: 'did:web:grantex.dev',
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86400_000).toISOString(),
      credentialSubject: {
        id: 'did:grantex:ag_01HXYZ',
        type: 'AIAgent',
        humanPrincipal: 'did:grantex:user_01ABC',
        organizationDID: 'did:web:acme.com',
        grantId: 'grnt_01HXYZ',
        allowedMPPCategories: ['inference', 'compute'],
        maxTransactionAmount: { amount: 50, currency: 'USDC' },
        paymentRails: ['tempo'],
        delegationDepth: 0,
      },
      credentialStatus: {
        id: 'https://api.grantex.dev/v1/credentials/status/vcsl_01#0',
        type: 'StatusList2021Entry',
        statusPurpose: 'revocation',
        statusListIndex: '0',
        statusListCredential: 'https://api.grantex.dev/v1/credentials/status/vcsl_01',
      },
      proof: {
        type: 'Ed25519Signature2020',
        created: new Date().toISOString(),
        verificationMethod: 'did:web:grantex.dev#key-2',
        proofPurpose: 'assertionMethod',
        proofValue: 'mock-proof-value',
      },
    } satisfies AgentPassportCredential,
    encodedCredential: 'bW9jay1lbmNvZGVk',
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('issuePassport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues a passport with valid options', async () => {
    const mockResponse = makeMockResponse();
    const fetchMock = mockFetch(200, mockResponse);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeGrantexClient();
    const result = await issuePassport(client, {
      agentId: 'ag_01HXYZ',
      grantId: 'grnt_01HXYZ',
      allowedMPPCategories: ['inference', 'compute'],
      maxTransactionAmount: { amount: 50, currency: 'USDC' },
    });

    expect(result.passportId).toBe('urn:grantex:passport:01HXYZ');
    expect(result.credential).toBeDefined();
    expect(result.encodedCredential).toBe('bW9jay1lbmNvZGVk');
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Verify the fetch call
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.grantex.dev/v1/passport/issue');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.agentId).toBe('ag_01HXYZ');
    expect(body.grantId).toBe('grnt_01HXYZ');
    expect(body.allowedMPPCategories).toEqual(['inference', 'compute']);
    expect(body.maxTransactionAmount).toEqual({ amount: 50, currency: 'USDC' });
    expect(body.expiresIn).toBe('24h'); // default
  });

  it('throws on invalid MPP categories', async () => {
    const client = makeGrantexClient();
    await expect(
      issuePassport(client, {
        agentId: 'ag_01HXYZ',
        grantId: 'grnt_01HXYZ',
        allowedMPPCategories: ['invalid-category' as never],
        maxTransactionAmount: { amount: 50, currency: 'USDC' },
      }),
    ).rejects.toThrow('Invalid MPP categories');
  });

  it('throws when expiresIn exceeds 720 hours', async () => {
    const client = makeGrantexClient();
    await expect(
      issuePassport(client, {
        agentId: 'ag_01HXYZ',
        grantId: 'grnt_01HXYZ',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 50, currency: 'USDC' },
        expiresIn: '721h',
      }),
    ).rejects.toThrow('exceeds maximum');
  });

  it('throws with error message from API on failure', async () => {
    const fetchMock = mockFetch(400, { message: 'SCOPE_INSUFFICIENT', code: 'SCOPE_INSUFFICIENT' });
    vi.stubGlobal('fetch', fetchMock);

    const client = makeGrantexClient();
    await expect(
      issuePassport(client, {
        agentId: 'ag_01HXYZ',
        grantId: 'grnt_01HXYZ',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 50, currency: 'USDC' },
      }),
    ).rejects.toThrow('SCOPE_INSUFFICIENT');
  });
});
