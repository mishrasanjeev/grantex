import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const api = parseYaml(readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'));
const pages = {
  'agents/delete-an-agent': 'delete /v1/agents/{id}',
  'agents/get-agent-by-id': 'get /v1/agents/{id}',
  'agents/list-all-agents': 'get /v1/agents',
  'agents/register-a-new-agent': 'post /v1/agents',
  'agents/update-an-agent': 'patch /v1/agents/{id}',
  'authorization/approve-an-authorization-request': 'post /v1/authorize/{id}/approve',
  'authorization/create-an-authorization-request': 'post /v1/authorize',
  'authorization/deny-an-authorization-request': 'post /v1/authorize/{id}/deny',
  'tokens/exchange-authorization-code-for-grant-token': 'post /v1/token',
  'tokens/refresh-a-grant-token': 'post /v1/token/refresh',
  'tokens/revoke-a-grant-token': 'post /v1/tokens/revoke',
  'tokens/verify-a-grant-token-online': 'post /v1/tokens/verify',
  'grants/delegate-a-grant-to-a-sub-agent': 'post /v1/grants/delegate',
  'grants/get-grant-by-id': 'get /v1/grants/{id}',
  'grants/list-grants': 'get /v1/grants',
  'grants/revoke-a-grant': 'delete /v1/grants/{id}',
  'grants/verify-a-grant-tokens-revocation-status': 'post /v1/grants/verify',
};

function metadata(page) {
  const source = readFileSync(new URL(`../../docs/api-reference/${page}.mdx`, import.meta.url), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  assert.ok(match, page + ' needs structured frontmatter');
  return parseYaml(match[1]);
}

test('agent onboarding and authorization reference pages have distinct sourced descriptions', () => {
  const descriptions = new Set();
  for (const [page, selector] of Object.entries(pages)) {
    const header = metadata(page);
    assert.equal(header.openapi, selector, page + ' must retain its API operation');
    const [method, path] = selector.split(' ');
    assert.ok(api.paths[path]?.[method], page + ' resolves to the current OpenAPI contract');
    assert.equal(typeof header.description, 'string', page + ' needs explicit search metadata');
    assert.ok(header.description.length >= 70 && header.description.length <= 180, page);
    assert.ok(!descriptions.has(header.description), page + ' needs operation-specific copy');
    assert.doesNotMatch(header.description, /certified|guaranteed|unrestricted|unlimited|compliant/i);
    descriptions.add(header.description);
  }
});

test('search descriptions preserve authorization and expiry boundaries', () => {
  assert.match(metadata('authorization/approve-an-authorization-request').description, /testing.*production.*consent UI/i);
  assert.match(metadata('tokens/refresh-a-grant-token').description, /without extending.*grant.*expiry/i);
  assert.match(metadata('grants/delegate-a-grant-to-a-sub-agent').description, /narrower scopes.*parent.*expiry/i);
  assert.match(metadata('grants/revoke-a-grant').description, /descendant.*delegated grants/i);
  assert.match(metadata('tokens/verify-a-grant-token-online').description, /current revocation state/i);
});
