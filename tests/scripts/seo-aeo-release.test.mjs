import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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

test('integration and comparison pages record one grouped GA4 page view', async () => {
  for (const [section, group] of [['for', 'integration guide'], ['vs', 'comparison']]) {
    const sectionUrl = new URL(`../../web/${section}/`, import.meta.url);
    const entries = await readdir(sectionUrl, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const html = await readFile(new URL(`${entry.name}/index.html`, sectionUrl), 'utf8');
      const snippet = html.match(/<script>(window\.dataLayer=[\s\S]*?)<\/script>/)?.[1];
      assert.ok(snippet, `${section}/${entry.name} needs a GA4 config snippet`);
      const context = { Date };
      context.window = context;
      runInNewContext(snippet, context);
      assert.equal(context.dataLayer.length, 2, `${section}/${entry.name} sends one config call`);
      assert.equal(context.dataLayer[1][0], 'config');
      assert.equal(context.dataLayer[1][2].content_group, group);
      assert.doesNotMatch(html, /gtag\(['"]event['"],['"]page_view['"]/, `${section}/${entry.name} must not send a second view`);
    }
  }
});
