import { describe, expect, it, vi } from 'vitest';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';

vi.unmock('../src/lib/webauthn.js');
vi.unmock('@simplewebauthn/server');

import { generateAuthOptions, generateRegOptions, verifyAuthResponse, verifyRegResponse } from '../src/lib/webauthn.js';

describe('WebAuthn upstream compatibility', () => {
  const credential = { credentialId: 'AQIDBA', publicKey: 'AQIDBA', counter: 1, transports: ['internal', 'hybrid', 'usb'] };

  it('generates fresh registration challenges and preserves credential transports', async () => {
    const first = await generateRegOptions('principal-test', 'Grantex', [credential]) as PublicKeyCredentialCreationOptionsJSON;
    const second = await generateRegOptions('principal-test', 'Grantex', []) as PublicKeyCredentialCreationOptionsJSON;
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.challenge).not.toBe(second.challenge);
    expect(first.user.id).toBe(Buffer.from('principal-test').toString('base64url'));
    expect(first.excludeCredentials).toEqual([{ id: credential.credentialId, type: 'public-key', transports: credential.transports }]);
  });

  it('generates authentication options with all stored transport hints', async () => {
    const options = await generateAuthOptions([credential]) as PublicKeyCredentialRequestOptionsJSON;
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(options.allowCredentials).toEqual([{ id: credential.credentialId, type: 'public-key', transports: credential.transports }]);
    expect(options.userVerification).toBe('preferred');
  });

  it('rejects malformed registration evidence without creating a credential', async () => {
    await expect(verifyRegResponse({ id: 'AQIDBA', rawId: 'AQIDBA', type: 'public-key', response: { clientDataJSON: '', attestationObject: '' }, clientExtensionResults: {} }, 'expected-challenge')).rejects.toThrow();
  });

  it('rejects malformed authentication evidence without accepting an assertion', async () => {
    await expect(verifyAuthResponse({ id: 'AQIDBA', rawId: 'AQIDBA', type: 'public-key', response: { clientDataJSON: '', authenticatorData: '', signature: '' }, clientExtensionResults: {} }, 'expected-challenge', credential)).rejects.toThrow();
  });
});
