import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real webauthn lib (global setup.ts mocks it)
vi.unmock('../src/lib/webauthn.js');

// Hoist mocks so they're available in vi.mock factories
const {
  mockGenerateRegistrationOptions,
  mockVerifyRegistrationResponse,
  mockGenerateAuthenticationOptions,
  mockVerifyAuthenticationResponse,
} = vi.hoisted(() => ({
  mockGenerateRegistrationOptions: vi.fn(),
  mockVerifyRegistrationResponse: vi.fn(),
  mockGenerateAuthenticationOptions: vi.fn(),
  mockVerifyAuthenticationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
}));

vi.mock('../src/config.js', () => ({
  config: {
    fidoRpId: 'grantex.dev',
    fidoOrigin: 'https://grantex.dev',
  },
}));

import {
  generateRegOptions,
  verifyRegResponse,
  generateAuthOptions,
  verifyAuthResponse,
} from '../src/lib/webauthn.js';
import type { StoredCredential } from '../src/lib/webauthn.js';

beforeEach(() => {
  mockGenerateRegistrationOptions.mockReset();
  mockVerifyRegistrationResponse.mockReset();
  mockGenerateAuthenticationOptions.mockReset();
  mockVerifyAuthenticationResponse.mockReset();
});

// ---------------------------------------------------------------
// generateRegOptions
// ---------------------------------------------------------------
describe('generateRegOptions', () => {
  it('calls generateRegistrationOptions with correct params', async () => {
    const mockResult = { challenge: 'abc123', rp: { name: 'TestApp', id: 'grantex.dev' } };
    mockGenerateRegistrationOptions.mockResolvedValueOnce(mockResult);

    const result = await generateRegOptions('user_42', 'TestApp', []);

    expect(result).toEqual(mockResult);
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledOnce();

    const args = mockGenerateRegistrationOptions.mock.calls[0]![0];
    expect(args.rpName).toBe('TestApp');
    expect(args.rpID).toBe('grantex.dev');
    expect(args.userName).toBe('user_42');
    expect(args.attestationType).toBe('direct');
    expect(args.authenticatorSelection).toEqual({
      residentKey: 'preferred',
      userVerification: 'preferred',
    });
    expect(args.excludeCredentials).toEqual([]);
  });

  it('encodes principalId as userID via TextEncoder', async () => {
    mockGenerateRegistrationOptions.mockResolvedValueOnce({});

    await generateRegOptions('alice', 'App', []);

    const args = mockGenerateRegistrationOptions.mock.calls[0]![0];
    const expected = new TextEncoder().encode('alice');
    expect(new Uint8Array(args.userID)).toEqual(expected);
  });

  it('maps existingCredentials to excludeCredentials', async () => {
    mockGenerateRegistrationOptions.mockResolvedValueOnce({});

    const creds: StoredCredential[] = [
      { credentialId: 'cred-aaa', publicKey: 'AQID', counter: 3, transports: ['usb', 'nfc'] },
      { credentialId: 'cred-bbb', publicKey: 'BAUG', counter: 0, transports: ['internal'] },
    ];

    await generateRegOptions('user_1', 'App', creds);

    const args = mockGenerateRegistrationOptions.mock.calls[0]![0];
    expect(args.excludeCredentials).toEqual([
      { id: 'cred-aaa', transports: ['usb', 'nfc'] },
      { id: 'cred-bbb', transports: ['internal'] },
    ]);
  });

  it('handles empty transports in credentials', async () => {
    mockGenerateRegistrationOptions.mockResolvedValueOnce({});

    const creds: StoredCredential[] = [
      { credentialId: 'cred-x', publicKey: 'key', counter: 0, transports: [] },
    ];

    await generateRegOptions('user_2', 'App', creds);

    const args = mockGenerateRegistrationOptions.mock.calls[0]![0];
    expect(args.excludeCredentials).toEqual([
      { id: 'cred-x', transports: [] },
    ]);
  });
});

// ---------------------------------------------------------------
// verifyRegResponse
// ---------------------------------------------------------------
describe('verifyRegResponse', () => {
  it('calls verifyRegistrationResponse with correct params', async () => {
    const mockVerification = { verified: true, registrationInfo: { credential: {} } };
    mockVerifyRegistrationResponse.mockResolvedValueOnce(mockVerification);

    const fakeResponse = {
      id: 'cred-id',
      rawId: 'cred-id',
      type: 'public-key' as const,
      response: { clientDataJSON: 'abc', attestationObject: 'def' },
      clientExtensionResults: {},
    };

    const result = await verifyRegResponse(fakeResponse as any, 'challenge-xyz');

    expect(result).toEqual(mockVerification);
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledOnce();

    const args = mockVerifyRegistrationResponse.mock.calls[0]![0];
    expect(args.response).toBe(fakeResponse);
    expect(args.expectedChallenge).toBe('challenge-xyz');
    expect(args.expectedOrigin).toBe('https://grantex.dev');
    expect(args.expectedRPID).toBe('grantex.dev');
  });

  it('returns the upstream result unchanged', async () => {
    const upstream = { verified: false };
    mockVerifyRegistrationResponse.mockResolvedValueOnce(upstream);

    const result = await verifyRegResponse({} as any, 'ch');

    expect(result).toBe(upstream);
  });
});

// ---------------------------------------------------------------
// generateAuthOptions
// ---------------------------------------------------------------
describe('generateAuthOptions', () => {
  it('calls generateAuthenticationOptions with correct params', async () => {
    const mockResult = { challenge: 'auth-challenge', rpId: 'grantex.dev' };
    mockGenerateAuthenticationOptions.mockResolvedValueOnce(mockResult);

    const result = await generateAuthOptions([]);

    expect(result).toEqual(mockResult);
    expect(mockGenerateAuthenticationOptions).toHaveBeenCalledOnce();

    const args = mockGenerateAuthenticationOptions.mock.calls[0]![0];
    expect(args.rpID).toBe('grantex.dev');
    expect(args.userVerification).toBe('preferred');
    expect(args.allowCredentials).toEqual([]);
  });

  it('maps credentials to allowCredentials', async () => {
    mockGenerateAuthenticationOptions.mockResolvedValueOnce({});

    const creds: StoredCredential[] = [
      { credentialId: 'cred-111', publicKey: 'pk1', counter: 10, transports: ['ble'] },
      { credentialId: 'cred-222', publicKey: 'pk2', counter: 20, transports: ['usb', 'internal'] },
    ];

    await generateAuthOptions(creds);

    const args = mockGenerateAuthenticationOptions.mock.calls[0]![0];
    expect(args.allowCredentials).toEqual([
      { id: 'cred-111', transports: ['ble'] },
      { id: 'cred-222', transports: ['usb', 'internal'] },
    ]);
  });

  it('preserves credential order in allowCredentials', async () => {
    mockGenerateAuthenticationOptions.mockResolvedValueOnce({});

    const creds: StoredCredential[] = [
      { credentialId: 'z-last', publicKey: 'k', counter: 0, transports: [] },
      { credentialId: 'a-first', publicKey: 'k', counter: 0, transports: [] },
    ];

    await generateAuthOptions(creds);

    const args = mockGenerateAuthenticationOptions.mock.calls[0]![0];
    expect(args.allowCredentials[0].id).toBe('z-last');
    expect(args.allowCredentials[1].id).toBe('a-first');
  });
});

// ---------------------------------------------------------------
// verifyAuthResponse
// ---------------------------------------------------------------
describe('verifyAuthResponse', () => {
  it('calls verifyAuthenticationResponse with correct params', async () => {
    const mockResult = { verified: true, authenticationInfo: { newCounter: 6 } };
    mockVerifyAuthenticationResponse.mockResolvedValueOnce(mockResult);

    const fakeResponse = {
      id: 'cred-id',
      rawId: 'cred-id',
      type: 'public-key' as const,
      response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
      clientExtensionResults: {},
    };

    const credential: StoredCredential = {
      credentialId: 'cred-id',
      publicKey: 'AQIDBA', // base64url for [1, 2, 3, 4]
      counter: 5,
      transports: ['internal'],
    };

    const result = await verifyAuthResponse(fakeResponse as any, 'challenge-abc', credential);

    expect(result).toEqual(mockResult);
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledOnce();

    const args = mockVerifyAuthenticationResponse.mock.calls[0]![0];
    expect(args.response).toBe(fakeResponse);
    expect(args.expectedChallenge).toBe('challenge-abc');
    expect(args.expectedOrigin).toBe('https://grantex.dev');
    expect(args.expectedRPID).toBe('grantex.dev');
    expect(args.credential.id).toBe('cred-id');
    expect(args.credential.counter).toBe(5);
    expect(args.credential.transports).toEqual(['internal']);
  });

  it('converts base64url publicKey to Uint8Array via Buffer', async () => {
    mockVerifyAuthenticationResponse.mockResolvedValueOnce({ verified: true });

    // base64url encoding of bytes [1, 2, 3, 4]
    const credential: StoredCredential = {
      credentialId: 'cred-buf',
      publicKey: 'AQIDBA',
      counter: 0,
      transports: [],
    };

    await verifyAuthResponse({} as any, 'ch', credential);

    const args = mockVerifyAuthenticationResponse.mock.calls[0]![0];
    const key = args.credential.publicKey;

    // Should be a Buffer (Uint8Array subclass) with the decoded bytes
    expect(key).toBeInstanceOf(Uint8Array);
    expect(Array.from(key)).toEqual([1, 2, 3, 4]);
  });

  it('handles longer base64url publicKey values', async () => {
    mockVerifyAuthenticationResponse.mockResolvedValueOnce({ verified: true });

    // 32 bytes of key material
    const keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) keyBytes[i] = i;
    const b64url = Buffer.from(keyBytes).toString('base64url');

    const credential: StoredCredential = {
      credentialId: 'cred-long',
      publicKey: b64url,
      counter: 100,
      transports: ['usb'],
    };

    await verifyAuthResponse({} as any, 'ch', credential);

    const args = mockVerifyAuthenticationResponse.mock.calls[0]![0];
    expect(Array.from(args.credential.publicKey)).toEqual(Array.from(keyBytes));
  });

  it('returns the upstream result unchanged', async () => {
    const upstream = { verified: false, authenticationInfo: { newCounter: 0 } };
    mockVerifyAuthenticationResponse.mockResolvedValueOnce(upstream);

    const credential: StoredCredential = {
      credentialId: 'c',
      publicKey: 'AA',
      counter: 0,
      transports: [],
    };

    const result = await verifyAuthResponse({} as any, 'ch', credential);

    expect(result).toBe(upstream);
  });
});
