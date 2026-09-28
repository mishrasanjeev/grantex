// SPDX-License-Identifier: Apache-2.0
/**
 * The child grant examples in spec/passport-binding.md §8 and
 * docs/concepts/passport-vs-grant.md are what the auth service takes and
 * produces: each is run through the code that reads or builds it, and the
 * refusal table is compared with the errors the code raises.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TYPE,
  CHILD_GRANT_MAX_LIFETIME_SECONDS,
  ChildGrantError,
  TOKEN_EXCHANGE_GRANT_TYPE,
  attenuateConstraints,
  parseAuthorizeCommerceDetails,
  parseTokenExchangeRequest,
} from '../src/lib/registry/child-grant.js';
import { commerceAuthorizationDetail, parseStoredBinding } from '../src/lib/registry/passport-binding.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Line endings as checked out (core.autocrlf on Windows) do not matter.
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf-8').replace(/\r\n/g, '\n');
const SPEC = read('spec', 'passport-binding.md');
const CONCEPT = read('docs', 'concepts', 'passport-vs-grant.md');

function example(name: string): unknown {
  const match = SPEC.match(new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match) throw new Error(`spec/passport-binding.md has no example ${name}`);
  return JSON.parse(match[1]!) as unknown;
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

function refusalOf(run: () => unknown): ChildGrantError {
  try {
    run();
  } catch (err) {
    if (err instanceof ChildGrantError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('spec/passport-binding.md §8 examples', () => {
  const parent = parseAuthorizeCommerceDetails(example('authorize-commerce-details'));

  it('the authorization request\'s commerce details', () => {
    expect(parent.allowed_merchants).toEqual(['https://merchant.example', 'https://shop.merchant.example']);
  });

  it('the exchange request, and the child commerce entry it produces', () => {
    const request = example('exchange-request') as Record<string, unknown>;
    expect(request['grant_type']).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
    const parsed = parseTokenExchangeRequest(request);
    expect(parsed).toMatchObject({ merchant: 'https://merchant.example', scopes: ['read'] });
    const child = attenuateConstraints(parent, parsed.merchant, parsed.authorizationDetails);
    expect(commerceAuthorizationDetail(binding, child)).toEqual(example('child-commerce-detail'));
  });

  it('the exchange response', () => {
    const response = example('exchange-response') as Record<string, unknown>;
    expect(response).toMatchObject({ issued_token_type: ACCESS_TOKEN_TYPE, token_type: 'DPoP', scope: 'read' });
    expect(response['expires_in']).toBe(CHILD_GRANT_MAX_LIFETIME_SECONDS);
  });

  it('the refusal table: each code with its HTTP status and error', () => {
    const rows = Object.fromEntries([...SPEC.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \| `([a-z_]+)` \|$/gm)]
      .map((match) => [match[1]!, [Number(match[2]), match[3]!]]));
    const merchant = 'https://merchant.example';
    const raised: Record<string, ChildGrantError> = {
      invalid_request: refusalOf(() => parseTokenExchangeRequest({ subject_token_type: ACCESS_TOKEN_TYPE, resource: merchant })),
      invalid_target: refusalOf(() => parseTokenExchangeRequest({
        subject_token: 't', subject_token_type: ACCESS_TOKEN_TYPE, resource: `${merchant}/checkout`,
      })),
      invalid_scope: refusalOf(() => parseTokenExchangeRequest({
        subject_token: 't', subject_token_type: ACCESS_TOKEN_TYPE, resource: merchant, scope: '',
      })),
      invalid_authorization_details: refusalOf(() => attenuateConstraints(parent, merchant,
        [{ type: 'urn:grantex:commerce:v1', budget: { amount: '999.00', currency: 'EUR' } }])),
      audience_mismatch: refusalOf(() => attenuateConstraints(parent, 'https://elsewhere.example', undefined)),
    };
    // status_stale is the binding recheck's, mapped by the route; the
    // Postgres suite answers it (503, invalid_request) end to end.
    expect(rows['status_stale']).toEqual([503, 'invalid_request']);
    delete rows['status_stale'];
    expect(Object.keys(rows).sort()).toEqual(Object.keys(raised).sort());
    for (const [code, err] of Object.entries(raised)) {
      expect(err.code).toBe(code);
      expect([err.statusCode, err.error]).toEqual(rows[code]);
    }
  });
});

describe('docs/concepts/passport-vs-grant.md child grant examples', () => {
  it('the commerce details and the exchange request', () => {
    const blocks = [...CONCEPT.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!) as unknown);
    const [details, request] = blocks.slice(-2) as [unknown, Record<string, unknown>];
    const parent = parseAuthorizeCommerceDetails(details);
    const parsed = parseTokenExchangeRequest(request);
    expect(attenuateConstraints(parent, parsed.merchant, parsed.authorizationDetails)).toEqual({
      allowed_merchants: ['https://merchant.example'],
      amount_range: { currency: 'EUR', max: '250.00' },
      budget: { amount: '500.00', currency: 'EUR' },
    });
  });
});
