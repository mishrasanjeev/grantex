// SPDX-License-Identifier: Apache-2.0
/**
 * The examples in spec/passport-binding.md and docs/concepts/passport-vs-grant.md
 * are what the auth service takes and produces: each marked JSON block is
 * compared with the output built from the same values, and the refusal table
 * with the statuses the route answers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMERCE_DETAIL_TYPE,
  PASSPORT_REFUSAL_STATUS,
  checkPassportParameter,
  commerceAuthorizationDetail,
  consentViewOf,
  parseStoredBinding,
} from '../src/lib/registry/passport-binding.js';
import { unverifiedPassportIssuer } from '../src/lib/registry/passport-verify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Line endings as checked out (core.autocrlf on Windows) do not matter.
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf-8').replace(/\r\n/g, '\n');
const SPEC = read('spec', 'passport-binding.md');
const CONCEPT = read('docs', 'concepts', 'passport-vs-grant.md');

function example(name: string): Record<string, unknown> {
  const match = SPEC.match(new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match) throw new Error(`spec/passport-binding.md has no example ${name}`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!.replace(
    '"<the Agent Passport SD-JWT, with the disclosures the agent chooses>"', '"placeholder~"')) as unknown);
}

const binding = parseStoredBinding({
  issuer: 'https://issuer.example',
  attestation_id: 'att-01',
  registry_attestation_id: 'ratt_01J8Z3K4M5N6P7Q8R9S0T1V2W3',
  external_credential_id: 'ppt-01',
  hash: 'sha-256:vDGKR0eipzfsrEgKMqXzI0NWGjZnjYVkBXW4Vf6PjcE',
  key_thumbprint: 'gzr6dlS40bV-rn_SVrIuqv36jX1W6ZnTeGkVbXr-SgY',
  acceptance: { uri: 'https://registry.example/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3', idx: 4127 },
  passport_exp: 1_790_000_000,
});

describe('spec/passport-binding.md examples', () => {
  it('authorization request: a passport the parameter check accepts, naming its issuer', () => {
    const request = example('authorize-request');
    expect(checkPassportParameter(request['passport'])).toBe(request['passport']);
    expect(unverifiedPassportIssuer(request['passport'])).toBe('https://issuer.example');
    expect(request['audience']).toBe('https://merchant.example/checkout');
  });

  it('the urn:grantex:commerce:v1 entry', () => {
    expect(example('commerce-detail')).toEqual(commerceAuthorizationDetail(binding));
    expect(COMMERCE_DETAIL_TYPE).toBe('urn:grantex:commerce:v1');
  });

  it('the consent view', () => {
    const view = example('consent-view');
    expect(consentViewOf({
      ...binding,
      consent: {
        trust_level: view['trustLevel'],
        verification_level: view['verificationLevel'],
        issuers: view['issuers'],
        declared_limits: view['declaredLimits'],
        software_name: view['softwareName'],
        software_version: view['softwareVersion'],
      },
    })).toEqual(view);
  });

  it('the refusal table lists every code with the status the route answers', () => {
    const rows = [...SPEC.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|$/gm)].map((match) => [match[1]!, Number(match[2])]);
    expect(Object.fromEntries(rows)).toEqual(PASSPORT_REFUSAL_STATUS);
  });
});

describe('docs/concepts/passport-vs-grant.md examples', () => {
  it('the request and the commerce entry', () => {
    const [request, detail] = jsonBlocks(CONCEPT) as [Record<string, unknown>, Record<string, unknown>];
    expect(checkPassportParameter(request['passport'])).toBe('placeholder~');
    expect(request).toMatchObject({ scopes: ['read'], audience: 'https://merchant.example/checkout' });
    expect(detail).toEqual(commerceAuthorizationDetail(binding));
  });
});
