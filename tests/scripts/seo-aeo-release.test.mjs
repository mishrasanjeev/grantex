import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedMcpLimitationIds, stalePublicSelectors } from '../../scripts/check-seo-aeo.mjs';

test('immutable MCP Auth 2.0.2 retains all six historical limitations', () => {
  assert.deepEqual(expectedMcpLimitationIds('2.0.2'), [
    'mcp-process-local-codes', 'mcp-consent-metadata-only',
    'mcp-code-handoff-incomplete', 'mcp-no-live-revocation-lookup',
    'mcp-token-issued-hook-unused', 'mcp-redirect-allowlist-not-global',
  ]);
});

test('MCP Auth 3 requires current operator boundaries, not resolved v2 defects', () => {
  assert.deepEqual(expectedMcpLimitationIds('3.0.0'), [
    'mcp-shared-storage-configuration', 'mcp-upstream-authority-check',
    'mcp-principal-handoff',
  ]);
});

test('unknown or absent MCP profiles cannot satisfy the limitation check', () => {
  for (const version of [undefined, '', '2.0.3', '5.0.0']) {
    assert.deepEqual(expectedMcpLimitationIds(version), []);
  }
});

test('MCP Auth 4 retains deployment responsibilities without resurrecting v2 defects', () => {
  assert.deepEqual(expectedMcpLimitationIds('4.0.0'), expectedMcpLimitationIds('3.0.0'));
});

test('public install selectors stay aligned with the published release manifest', () => {
  const artifacts = [
    { id: 'typescript-sdk', version: '0.8.1' },
    { id: 'mcp-auth', version: '4.0.0' },
    { id: 'x402', version: '0.4.1' },
    { id: 'python-sdk', version: '0.7.1' },
    { id: 'go-sdk', version: 'v0.4.2' },
  ];
  assert.deepEqual(stalePublicSelectors('npm install @grantex/mcp-auth@4.0.0 @grantex/sdk@0.8.1', artifacts), []);
  assert.deepEqual(stalePublicSelectors('grantex==0.7.1 grantex-go@v0.4.2 @grantex/x402@0.4.1', artifacts), []);
  assert.deepEqual(stalePublicSelectors('npm install @grantex/mcp-auth@2.0.2 @grantex/sdk@0.7.1', artifacts), [
    '@grantex/mcp-auth@2.0.2', '@grantex/sdk@0.7.1',
  ]);
});
