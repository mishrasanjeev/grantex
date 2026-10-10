import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createProcessor } from '@mdx-js/mdx';
import { parse as parseYaml } from 'yaml';
import { expectedMcpLimitationIds, stalePublicSelectors } from '../../scripts/check-seo-aeo.mjs';

function documentParts(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { metadata: {}, body: source };
  return { metadata: parseYaml(match[1]), body: source.slice(match[0].length) };
}

function bodyH1Count(body) {
  const tree = createProcessor().parse(body);
  let count = 0;
  function visit(node) {
    if ((node.type === 'heading' && node.depth === 1) ||
        (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type) && node.name === 'h1')) count += 1;
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return count;
}

test('navigable documentation does not duplicate its generated H1', () => {
  const navigation = JSON.parse(readFileSync(new URL('../../docs/docs.json', import.meta.url), 'utf8'));
  const pages = new Set();
  function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'pages' && Array.isArray(value)) {
        for (const page of value) {
          if (typeof page === 'string') pages.add(page);
          else collect(page);
        }
      } else collect(value);
    }
  }
  collect(navigation.navigation);
  assert.ok(pages.size > 0, 'check every page in the public navigation');
  for (const page of pages) {
    const sourceUrl = ['mdx', 'md'].map((extension) =>
      new URL(`../../docs/${page}.${extension}`, import.meta.url)).find(existsSync);
    assert.ok(sourceUrl, page + ' needs a source document');
    const source = readFileSync(sourceUrl, 'utf8');
    const { metadata, body } = documentParts(source);
    if (metadata.title || metadata.openapi) {
      assert.equal(bodyH1Count(body), 0, page + ' must not duplicate the rendered title');
    }
  }
});

test('the heading check distinguishes content headings from fenced examples', () => {
  assert.equal(bodyH1Count('## Section\n\n```md\n# Example\n```'), 0);
  assert.equal(bodyH1Count('# Duplicate title'), 1);
  assert.equal(bodyH1Count('<h1>Duplicate title</h1>'), 1);
});

test('credential API reference pages supply meaningful unique search descriptions', () => {
  const descriptions = new Set();
  for (const page of ['get-credential', 'list-credentials', 'verify-credential', 'status-list']) {
    const source = readFileSync(new URL(`../../docs/api-reference/credentials/${page}.mdx`, import.meta.url), 'utf8');
    const { metadata } = documentParts(source);
    assert.equal(typeof metadata.description, 'string');
    assert.ok(metadata.description.length >= 70 && metadata.description.length <= 160, page);
    assert.ok(metadata.openapi, 'preserve the API-generated documentation contract');
    assert.ok(!descriptions.has(metadata.description), 'descriptions must describe each endpoint');
    descriptions.add(metadata.description);
  }
});

test('founder profile is factual and linked from the introduction', () => {
  const profile = readFileSync(new URL('../../docs/ownership.mdx', import.meta.url), 'utf8');
  const article = readFileSync(new URL('../../docs/blog/introducing-grantex.mdx', import.meta.url), 'utf8');
  const homepage = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(profile, /Sanjeev Kumar is Founder & CEO of Orchestrum Technologies LLP/);
  assert.match(profile, /\[LinkedIn\]/);
  assert.match(profile, /\[X\]/);
  assert.match(article, /\[author profile and ownership contacts\]\(\/ownership\)/);
  assert.match(homepage, /href="https:\/\/docs\.grantex\.dev\/ownership">About the inventor<\/a>/);
  assert.match(homepage, /"jobTitle": "Founder & CEO"/);
});

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
