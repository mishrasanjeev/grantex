// SPDX-License-Identifier: Apache-2.0
//
// The README example, run as written (with fresh agent keys), and a check
// that every line of the README block appears in this test.

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Jwk } from '@grantex/agent-passport';
import { MockIssuer, signPossessionProof, startMockIssuerServer } from '../src/index.ts';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

describe('README example', () => {
  it('issues, attests, serves and revokes', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const agentPrivateJwk = privateKey.export({ format: 'jwk' }) as Jwk;
    const agentPublicJwk = publicKey.export({ format: 'jwk' }) as Jwk;
    const agentDid = 'did:web:provider.example:agents:shopper-01';
    const logged: unknown[][] = [];
    const console = { log: (...args: unknown[]) => logged.push(args) };

    // README: Use it from a test
    const issuer = MockIssuer.create(); // a new ES256 key; status list ttl 1 s
    // Agent side: prove possession of the key the passport will bind.
    const challenge = issuer.createPossessionChallenge({ agentDid, agentPublicJwk });
    const possessionProof = signPossessionProof({ challenge, agentPrivateJwk });
    // Issuer side: refused with key_unproven without a valid proof.
    const passport = issuer.issuePassport({
      agentDid,
      agentPublicJwk,
      possessionProof,
      provider: { did: 'did:web:provider.example' },
      agent: { software_name: 'Nimbus Shopper', software_version: '2.4' },
      verification: { level: 'standard' },
    });
    const attestation = issuer.buildAttestation({ attestationId: passport.attestationId });
    const server = await startMockIssuerServer({ issuer }); // 127.0.0.1, ephemeral port
    console.log(server.originMapEntry); // for REGISTRY_DEV_ISSUER_ORIGIN_MAP
    issuer.revokePassport(passport.attestationId);
    await server.close();

    expect(attestation.split('.')).toHaveLength(3);
    expect(logged[0]?.[0]).toMatch(/^https:\/\/mock-issuer\.example=http:\/\/127\.0\.0\.1:\d+$/);
    expect(issuer.passportStatus(passport.attestationId)).toBe('invalid');
  });

  it('matches the README block line for line', () => {
    const readme = readFileSync(README, 'utf8').replaceAll('\r\n', '\n');
    const block = readme.match(/## Use it from a test[\s\S]*?```ts\n([\s\S]*?)```/)?.[1];
    expect(block).toBeDefined();
    const source = readFileSync(SELF, 'utf8');
    for (const line of block!.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('import '))) {
      expect(source).toContain(line);
    }
  });
});
