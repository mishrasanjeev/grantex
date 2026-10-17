import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createProcessor } from '@mdx-js/mdx';
import { parse as parseYaml } from 'yaml';
import { expectedMcpLimitationIds, stalePublicSelectors } from '../../scripts/check-seo-aeo.mjs';

test('the CERT-In article preserves workflow navigation and explicit responsibility limits', () => {
  const html = readFileSync(new URL('../../web/blog/cert-in-ai-agent-security.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<figure class="workflow"/g) || []).length, 3);
  assert.equal((html.match(/class="step-no"/g) || []).length, 12);
  for (const id of ['pilot-checklist', 'boundaries', 'grantex-controls', 'restricted-profile',
    'tenant-sso', 'financial-example', 'stop-flow', 'operator-duties', 'adoption']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /<details>\s*<summary>In this article<\/summary>/);
  assert.match(html, /not a CERT-In certification, endorsement or complete compliance solution/);
  assert.match(html, /not in a published SDK release/);
  assert.match(html, /no enforcing Kubernetes CNI was tested/);
  assert.match(html, /signature-only offline check cannot learn about revocation/);
  assert.match(html, /does not revoke a stolen upstream API key/);
  assert.match(html, /sandbox-only/);
  assert.match(html, /within Indian jurisdiction/);
  assert.match(html, /CIAD-2026-0049/);
  const structured = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(structured.mainEntityOfPage, 'https://grantex.dev/blog/cert-in-ai-agent-security');
  assert.equal(structured.image, 'https://grantex.dev/blog/cert-in-agent-boundaries.png');
  const png = readFileSync(new URL('../../web/blog/cert-in-agent-boundaries.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

function documentParts(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { metadata: {}, body: source };
  return { metadata: parseYaml(match[1]), body: source.slice(match[0].length) };
}

test('the SAML callback supplies an explicit title and preserves its protocol selector', () => {
  const { metadata } = documentParts(readFileSync(new URL('../../docs/api-reference/sso/saml-callback.mdx', import.meta.url), 'utf8'));
  assert.equal(metadata.title, 'SAML sign-in callback');
  assert.equal(metadata.openapi, 'post /sso/callback/saml');
  assert.match(metadata.description, /certificate-backed signature checks/);
});

function contactHarness(fetch, fields = {}) {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const snippet = html.split('/* Contact form */')[1].split('/* Install command copy */')[0];
  const button = { disabled: false, textContent: '' };
  const message = { className: '', textContent: '' };
  let submit;
  let resetCount = 0;
  let timeout;
  const events = [];
  const form = {
    action: 'https://app.agenticorg.ai/api/v1/demo-request',
    addEventListener: (_, handler) => { submit = handler; },
    querySelector: () => button,
    reset: () => { resetCount++; },
  };
  runInNewContext(snippet, {
    document: { getElementById: (id) => id === 'contact-form' ? form : message },
    fetch, FormData: class { get(key) { return fields[key] ?? ''; } }, AbortController,
    setTimeout: (handler) => { timeout = handler; return 1; },
    clearTimeout: () => {}, gtag: (...args) => events.push(args),
  });
  return { button, message, events, submit: () => submit({ preventDefault() {} }),
    expire: () => timeout(), resets: () => resetCount };
}

test('contact intake prevents duplicate pending requests and does not leak form data to analytics', async () => {
  let finish;
  let requests = 0;
  const contact = contactHarness(() => { requests++; return new Promise(resolve => { finish = resolve; }); });
  contact.submit();
  contact.submit();
  assert.equal(requests, 1);
  assert.equal(contact.button.disabled, true);
  finish({ ok: true, json: async () => ({ status: 'received', delivery_request_id: 'synthetic-request' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(contact.message.textContent, /enquiry was accepted/);
  assert.equal(contact.resets(), 1);
  assert.equal(contact.button.disabled, false);
  assert.equal(JSON.stringify(contact.events), '[["event","contact_form_submit",{"event_category":"engagement"}]]');
});

test('contact uses bounded shared SMTP intake without cookies or caller-selected recipients', async () => {
  let request;
  const contact = contactHarness(async (url, options) => {
    request = { url, ...options };
    return { ok: true, json: async () => ({ status: 'received', delivery_request_id: 'synthetic-request' }) };
  }, { name: 'Synthetic owner', email: 'buyer@example.org', company: 'Example', message: 'A question\nSecond line' });
  contact.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.url, 'https://app.agenticorg.ai/api/v1/demo-request');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), {
    product: 'grantex', source: 'grantex_contact', name: 'Synthetic owner',
    email: 'buyer@example.org', company: 'Example', message: 'A question\nSecond line', website: '',
  });
  assert.equal(contact.resets(), 1);
});

test('without JavaScript the JSON-only form is hidden and direct email stays available', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const fallback = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];
  assert.ok(fallback);
  assert.match(fallback, /#contact-form\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(fallback, /href="mailto:sanjeev@orchestrum.in"/);
});

test('a successful HTTP response without a durable receipt is not accepted as enquiry success', async () => {
  const contact = contactHarness(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }));
  contact.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(contact.message.textContent, /could not confirm receipt/);
  assert.equal(contact.resets(), 0);
  assert.equal(contact.events.length, 0);
});

test('failed or timed-out contact requests retain the enquiry and expose only safe recovery wording', async () => {
  for (const failure of ['rejected', 'timeout']) {
    const contact = contactHarness((_, options) => failure === 'rejected'
      ? Promise.resolve({ ok: false, json: () => { throw new Error('private provider detail'); } })
      : new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('private detail')))));
    contact.submit();
    if (failure === 'timeout') contact.expire();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(contact.message.textContent, /could not confirm receipt/);
    assert.match(contact.message.textContent, /sanjeev@orchestrum.in/);
    assert.doesNotMatch(contact.message.textContent, /private/);
    assert.equal(contact.resets(), 0);
    assert.equal(contact.events.length, 0);
    assert.equal(contact.button.disabled, false);
  }
});

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

function publicDocumentationPages() {
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
  return pages;
}

test('navigable documentation does not duplicate its generated H1', () => {
  const pages = publicDocumentationPages();
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

test('every navigable guide has meaningful search metadata', () => {
  for (const page of publicDocumentationPages()) {
    const sourceUrl = ['mdx', 'md'].map(extension =>
      new URL(`../../docs/${page}.${extension}`, import.meta.url)).find(existsSync);
    const { metadata } = documentParts(readFileSync(sourceUrl, 'utf8'));
    assert.equal(typeof metadata.description, 'string', page + ' needs a search description');
    assert.ok(metadata.description.trim().length >= 40, page + ' needs more than a generic label');
  }
});

test('the heading check distinguishes content headings from fenced examples', () => {
  assert.equal(bodyH1Count('## Section\n\n```md\n# Example\n```'), 0);
  assert.equal(bodyH1Count('# Duplicate title'), 1);
  assert.equal(bodyH1Count('<h1>Duplicate title</h1>'), 1);
});

test('public disclosure and relying-party documents have one generated title and search metadata', () => {
  for (const page of [
    'compliance/cookie-policy', 'compliance/data-residency', 'compliance/dpa',
    'compliance/privacy-policy', 'compliance/sub-processors',
    'compliance/terms-of-service', 'relying-parties/verifying-agents',
  ]) {
    const { metadata, body } = documentParts(readFileSync(
      new URL(`../../docs/${page}.md`, import.meta.url), 'utf8'));
    assert.equal(typeof metadata.title, 'string', page + ' needs an explicit title');
    assert.equal(bodyH1Count(body), 0, page + ' must not duplicate the rendered title');
    assert.equal(typeof metadata.description, 'string', page + ' needs a description');
    assert.ok(metadata.description.length >= 70 && metadata.description.length <= 160, page);
  }
});

test('migration guide repository references resolve outside the documentation host', () => {
  const source = readFileSync(new URL('../../docs/migration-0.6.md', import.meta.url), 'utf8');
  const tree = createProcessor().parse(documentParts(source).body);
  const urls = [];
  function visit(node) {
    if (node.type === 'link') urls.push(node.url);
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  assert.equal(urls.filter(url => url.startsWith('../')).length, 0,
    'repository-relative links become nonexistent routes on the documentation host');
  for (const file of [
    'CHANGELOG.md', 'SPEC.md', 'spec/manifest-0.6.md',
    'spec/manifest-0.6.schema.json', 'spec/grant-token-0.6.md',
  ]) {
    assert.ok(urls.includes('https://github.com/mishrasanjeev/grantex/blob/main/' + file), file);
    assert.ok(existsSync(new URL('../../' + file, import.meta.url)), file + ' exists in the repository');
  }
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

const agentAuthorityPages = {
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

function apiMetadata(page) {
  return documentParts(readFileSync(
    new URL(`../../docs/api-reference/${page}.mdx`, import.meta.url), 'utf8')).metadata;
}

test('agent onboarding and authorization reference pages have distinct sourced descriptions', () => {
  const api = parseYaml(readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'));
  const descriptions = new Set();
  for (const [page, selector] of Object.entries(agentAuthorityPages)) {
    const header = apiMetadata(page);
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
  assert.match(apiMetadata('authorization/approve-an-authorization-request').description, /testing.*production.*consent UI/i);
  assert.match(apiMetadata('tokens/refresh-a-grant-token').description, /without extending.*grant.*expiry/i);
  assert.match(apiMetadata('grants/delegate-a-grant-to-a-sub-agent').description, /narrower scopes.*parent.*expiry/i);
  assert.match(apiMetadata('grants/revoke-a-grant').description, /descendant.*delegated grants/i);
  assert.match(apiMetadata('tokens/verify-a-grant-token-online').description, /current revocation state/i);
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
