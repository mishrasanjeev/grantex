// SPDX-License-Identifier: Apache-2.0
//
// The README examples, run as written (with a stub registry and fresh keys).

import { describe, expect, it } from 'vitest';
import {
  PassportError,
  createKeyBindingJwt,
  externalCredentialHash,
  issuePassport,
  keysEqual,
  selectDisclosures,
  verifyPassport,
  type Jwk,
} from '../src/index.ts';
import { ISSUER, p256KeyPair, passportParams } from './helpers.ts';

describe('README examples', () => {
  it('verify a presentation, present selected claims, hash rule and key rule', async () => {
    const issuer = p256KeyPair('mock-issuer-2026');
    const agent = p256KeyPair();
    const registry = { issuerKeys: (iss: string): Jwk[] => (iss === ISSUER ? [issuer.publicJwk] : []) };
    const now = Math.floor(Date.now() / 1000);
    const passportCompact = issuePassport(passportParams(issuer, agent, { iat: now - 60, exp: now + 86_400 })).compact;
    const agentPrivateJwk = agent.privateJwk;
    const registeredAgentKey = { ...agent.publicJwk, kid: 'shopper-01-key-1' };
    const nonce = 'n-0S6_WzA2Mj';

    // README: Present selected claims
    const presentation = createKeyBindingJwt({
      sdJwt: selectDisclosures(passportCompact, ['provider', 'agent']),
      holderKey: agentPrivateJwk,
      aud: 'https://merchant.example',
      nonce,
    });

    // README: Verify a presentation
    const logged: unknown[][] = [];
    const console = { log: (...args: unknown[]) => logged.push(args) };
    let passport!: Awaited<ReturnType<typeof verifyPassport>>;
    try {
      passport = await verifyPassport({
        compact: presentation,
        // Issuer keys come only from your own trust configuration, never from the token.
        issuerKeys: (issuer) => registry.issuerKeys(issuer),
        keyBinding: { aud: 'https://merchant.example', nonce },
        paymentsRails: true,
      });
      console.log(passport.sub, passport.disclosed.agent?.software_name);
      console.log(passport.externalCredentialHash, passport.cnfThumbprint);
    } catch (error) {
      if (error instanceof PassportError) console.log(error.code, error.reason);
      else throw error;
    }
    expect(logged[0]).toEqual(['did:web:provider.example:agents:shopper-01', 'Nimbus Shopper']);

    // README: Hash rule and key rule
    expect(externalCredentialHash(presentation)).toBe(externalCredentialHash(passportCompact));
    expect(keysEqual(passport.cnfJwk, registeredAgentKey)).toBe(true);

    // The error branch of the README example.
    const refused: unknown[][] = [];
    try {
      await verifyPassport({
        compact: presentation,
        issuerKeys: (issuer) => registry.issuerKeys(issuer),
        keyBinding: { aud: 'https://merchant.example', nonce: 'another' },
        paymentsRails: true,
      });
    } catch (error) {
      if (error instanceof PassportError) refused.push([error.code, error.reason]);
      else throw error;
    }
    expect(refused).toEqual([['key_unproven', 'nonce_mismatch']]);
  });
});
