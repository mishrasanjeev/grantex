// SPDX-License-Identifier: Apache-2.0
/**
 * The examples in spec/attestation-1.0.md and in
 * docs/issuers/becoming-an-accredited-issuer.md are what the registry
 * accepts: each marked JSON block is run through the same checks as a posted
 * attestation or a signed request, signed with a key generated here. The
 * refusal table of the spec matches the route's HTTP statuses, and the
 * OpenAPI description and the self-hosting guide carry the new routes and
 * settings.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_REQUEST_TYP,
  checkAttestationHeader,
  checkAttestationTimes,
  checkExternalCredentialHash,
  parseAttestationPayload,
  verifyAttestationRequest,
  verifyJwsSignature,
} from '../src/lib/registry/attestation-jws.js';
import { ATTESTATION_REFUSAL_STATUS } from '../src/routes/registry-attestations.js';
import { ATTESTATION_EXPIRING_WINDOW_SECONDS, TRUST_FLAGS, TRUST_LEVELS } from '../src/lib/registry/trust-level.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf-8').replace(/\r\n/g, '\n');
const SPEC = read('spec/attestation-1.0.md');
const ISSUER_DOC = read('docs/issuers/becoming-an-accredited-issuer.md');

function example(name: string): Record<string, unknown> {
  const match = SPEC.match(new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match) throw new Error(`spec/attestation-1.0.md has no example ${name}`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

function documented(name: string): Record<string, unknown> {
  // Titled without `.json`, so the accredited-issuer replay test, which takes
  // every `json <name>.json` block as an operator request, does not pick it up.
  const match = ISSUER_DOC.match(new RegExp(`\`\`\`json ${name}\\n([\\s\\S]*?)\`\`\``));
  if (!match) throw new Error(`the issuer guide has no ${name} block`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

async function signed(header: Record<string, unknown>, payload: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: header['kid'] as string };
  const compact = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader(header as never).sign(privateKey);
  return { compact, jwk };
}

describe('spec/attestation-1.0.md examples', () => {
  it('the attestation header and agent payload pass every check', async () => {
    const header = example('attestation-header');
    const payload = example('attestation-payload');
    const { alg } = checkAttestationHeader(header, { eddsaEnabled: false });
    const claims = parseAttestationPayload(payload);
    expect(claims.subjectKind).toBe('agent');
    checkExternalCredentialHash(claims.externalCredentialHash);
    checkAttestationTimes(claims, new Date((claims.iat + 60) * 1000));
    const { compact, jwk } = await signed(header, payload);
    await expect(verifyJwsSignature(compact, jwk, alg)).resolves.toBeUndefined();
  });

  it('the provider payload passes and has no key', () => {
    const claims = parseAttestationPayload(example('provider-attestation-payload'));
    expect(claims.subjectKind).toBe('provider');
    expect(claims.keyThumbprint).toBeNull();
    checkExternalCredentialHash(claims.externalCredentialHash);
  });

  it('the withdrawal request verifies for the registry it names', async () => {
    const header = example('request-header');
    expect(header['typ']).toBe(ATTESTATION_REQUEST_TYP);
    const payload = example('request-payload');
    const { compact, jwk } = await signed(header, payload);
    await expect(verifyAttestationRequest(compact, {
      action: 'withdraw',
      audience: payload['aud'] as string,
      now: new Date((payload['iat'] as number) * 1000),
      resolveKey: async (iss, kid) => (iss === payload['iss'] && kid === jwk.kid ? jwk : null),
      eddsaEnabled: false,
    })).resolves.toMatchObject({ iss: payload['iss'], id: payload['id'] });
  });

  it('the refusal table matches the HTTP statuses the routes send', () => {
    const table = SPEC.slice(SPEC.indexOf('## 9. Refusal codes'), SPEC.indexOf('## 10.'));
    const documentedStatus = new Map<string, number>();
    for (const row of table.matchAll(/^\| (`[^|]+`) \| (\d{3}) \|/gm)) {
      for (const code of row[1]!.matchAll(/`([a-z_]+)`/g)) documentedStatus.set(code[1]!, Number(row[2]));
    }
    expect(Object.fromEntries(documentedStatus)).toEqual(ATTESTATION_REFUSAL_STATUS);
  });

  it('names every level and flag, and the expiring window', () => {
    for (const level of TRUST_LEVELS) expect(SPEC).toContain(`| \`${level}\` |`);
    for (const flag of TRUST_FLAGS) expect(SPEC).toContain(`| \`${flag}\` |`);
    expect(ATTESTATION_EXPIRING_WINDOW_SECONDS / 86_400).toBe(30);
    expect(SPEC).toContain('within 30 days');
  });
});

describe('docs/issuers/becoming-an-accredited-issuer.md', () => {
  it('posts the same attestation and withdrawal request as the spec', () => {
    expect(documented('attestation-payload')).toEqual(example('attestation-payload'));
    expect(documented('withdraw-request')).toEqual(example('request-payload'));
  });
});

describe('docs/openapi.yaml and docs/self-hosting.md', () => {
  it('describe the routes and the settings', () => {
    const openapi = read('docs/openapi.yaml');
    for (const path of ['/v1/registry/attestations:', '/v1/registry/attestations/{id}:', '/v1/registry/attestations/{id}/refresh:']) {
      expect(openapi).toContain(`\n  ${path}\n`);
    }
    for (const code of Object.keys(ATTESTATION_REFUSAL_STATUS)) expect(openapi).toContain(code);
    const selfHosting = read('docs/self-hosting.md');
    expect(selfHosting).toContain('`REGISTRY_DEV_ISSUER_ORIGIN_MAP`');
    expect(selfHosting).toContain('`REGISTRY_ATTESTATION_EDDSA_ENABLED`');
  });
});
