#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(root, 'docs');
const webRoot = path.join(root, 'web');
const live = process.argv.includes('--live');
const failures = [];
const warnings = [];

const normalize = (value) => value.split(path.sep).join('/');
const relative = (file) => normalize(path.relative(root, file));

async function walk(directory, predicate = () => true) {
  const output = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute, predicate));
    else if (predicate(absolute)) output.push(absolute);
  }
  return output;
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function stripCode(text) {
  const tick = String.fromCharCode(96);
  const fences = new RegExp(tick.repeat(3) + '[\\s\\S]*?' + tick.repeat(3), 'g');
  const inline = new RegExp(tick + '[^' + tick + '\\n]*' + tick, 'g');
  return text
    .replace(fences, (block) => block.replace(/[^\n]/g, ' '))
    .replace(inline, (block) => ' '.repeat(block.length));
}

function addRouteAliases(routes, route) {
  routes.add(route || '/');
  if (route.endsWith('/index')) routes.add(route.slice(0, -6) || '/');
  if (route.endsWith('/overview')) routes.add(route.slice(0, -9) || '/');
}

function collectNavigationPages(node, output) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.pages)) {
    for (const page of node.pages) {
      if (typeof page === 'string') output.add(page.replace(/^\/+/, ''));
      else collectNavigationPages(page, output);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'pages' && value && typeof value === 'object') {
      collectNavigationPages(value, output);
    }
  }
}

async function validateNavigation(routes, docFiles) {
  const navigation = JSON.parse(await fs.readFile(path.join(docsRoot, 'docs.json'), 'utf8'));
  const pages = new Set();
  collectNavigationPages(navigation, pages);
  for (const page of pages) {
    const candidates = [
      path.join(docsRoot, page + '.mdx'),
      path.join(docsRoot, page + '.md'),
      path.join(docsRoot, page, 'index.mdx'),
      path.join(docsRoot, page, 'index.md'),
    ];
    if (!(await Promise.all(candidates.map(exists))).some(Boolean)) {
      failures.push('Navigation page has no source file: ' + page);
    }
  }

  const markdownFiles = [
    path.join(root, 'README.md'),
    path.join(root, 'COMPATIBILITY.md'),
    path.join(root, 'DEPLOYMENT.md'),
    path.join(root, 'SECURITY.md'),
    ...docFiles,
    ...await walk(path.join(root, 'packages'), (file) => /README\.md$/i.test(file)),
    ...await walk(path.join(root, 'examples'), (file) => /README\.md$/i.test(file)),
  ];
  for (const file of markdownFiles) {
    if (!(await exists(file))) continue;
    const original = await fs.readFile(file, 'utf8');
    const content = stripCode(original);
    const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g;
    for (const match of content.matchAll(pattern)) {
      let target = match[1].replace(/^<|>$/g, '');
      if (!target || /^(?:https?:|mailto:|tel:|data:|#)/i.test(target)) continue;
      target = target.split('#')[0].split('?')[0];
      if (!target || target.includes('{') || target.includes('*')) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        failures.push(relative(file) + ':' + lineAt(original, match.index) + ' has invalid URL encoding');
        continue;
      }
      const base = target.startsWith('/') && file.startsWith(docsRoot)
        ? path.join(docsRoot, target.replace(/^\/+/, ''))
        : path.resolve(path.dirname(file), target);
      if (!base.startsWith(root)) continue;
      const candidates = path.extname(base)
        ? [base]
        : [base, base + '.md', base + '.mdx', path.join(base, 'README.md'), path.join(base, 'index.md'), path.join(base, 'index.mdx')];
      if (!(await Promise.all(candidates.map(exists))).some(Boolean)) {
        failures.push(relative(file) + ':' + lineAt(original, match.index) + ' links to missing local target ' + match[1]);
      }
    }
  }
}

async function validatePublicReferences(routes, docFiles) {
  const publicFiles = [
    path.join(root, 'README.md'),
    path.join(root, 'COMPATIBILITY.md'),
    path.join(root, 'DEPLOYMENT.md'),
    path.join(root, 'SECURITY.md'),
    ...docFiles,
    ...await walk(webRoot, (file) => /\.(html|md|txt|xml)$/i.test(file)),
    ...await walk(path.join(root, 'packages'), (file) => /(?:README\.md|pyproject\.toml)$/i.test(file)),
  ];
  const publicContent = [];
  for (const file of publicFiles) {
    if (!(await exists(file))) continue;
    const text = await fs.readFile(file, 'utf8');
    publicContent.push({ file, text });
    const pattern = /https:\/\/docs\.grantex\.dev(\/[^\s"'<>)]*)?/g;
    for (const match of text.matchAll(pattern)) {
      let route = (match[1] || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
      try { route = decodeURIComponent(route); } catch { continue; }
      if (!routes.has(route) && !['/', '/api-reference', '/blog', '/llms.txt', '/llms-full.txt', '/sitemap.xml'].includes(route)) {
        failures.push(relative(file) + ':' + lineAt(text, match.index) + ' links to unknown docs route ' + route);
      }
    }
  }
  const retired = [
    [/\/integrations\/frameworks\//g, 'retired framework documentation route'],
    [/\/getting-started\/quickstart\b/g, 'retired quickstart route'],
    [/\bGrantexToolkit\b/g, 'removed GrantexToolkit API'],
    [/\bGrantexCrewTools\b/g, 'removed GrantexCrewTools API'],
    [/\bGrantexADKTools\b/g, 'removed GrantexADKTools API'],
    [/\bGrantexAutoGen\b/g, 'removed GrantexAutoGen API'],
    [/\bGrantexTools\b/g, 'removed GrantexTools API'],
    [/\bGrantexMCPAuth\b/g, 'removed GrantexMCPAuth API'],
    [/\bcreateGrantexTools\b/g, 'removed createGrantexTools API'],
    [/\bauth\.requireScopes\s*\(/g, 'removed auth.requireScopes API'],
    [/\/v1\/anomalies\/(?:alerts|channels|metrics|rules)\b/g, 'incorrect plural anomaly endpoint'],
    [/\/v1\/me\/rotate-key\b/g, 'retired key rotation endpoint'],
    [/\b13\s+MCP\s+tools\b/gi, 'stale MCP tool count'],
    [/failures\s+are\s+never\s+retried/gi, 'incorrect webhook retry claim'],
    [/DNS-TXT,\s+manual,\s+or\s+SOC\s+2\s+verification/gi, 'unsupported Trust Registry verification methods'],
    [/https:\/\/grantex\.dev\/integrations\/anthropic\b/g, 'incorrect Anthropic documentation host'],
  ];
  for (const { file, text } of publicContent) {
    for (const [pattern, label] of retired) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) failures.push(relative(file) + ':' + lineAt(text, match.index) + ' contains ' + label);
    }
  }
  return publicContent;
}

function matchesHostingSource(route, source) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = /\*\*|\*|:[A-Za-z][A-Za-z0-9_]*/g;
  let pattern = '';
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    pattern += escape(source.slice(cursor, match.index));
    pattern += match[0] === '**' ? '.*' : match[0] === '*' ? '[^/]*' : '[^/]+';
    cursor = match.index + match[0].length;
  }
  pattern += escape(source.slice(cursor));
  return new RegExp('^' + pattern + '$').test(route);
}

async function validatePublicHtmlLinks() {
  const config = JSON.parse(await fs.readFile(path.join(root, 'firebase.json'), 'utf8'));
  const hosting = Array.isArray(config.hosting) ? config.hosting : [config.hosting];
  const hostingSources = hosting.flatMap((item) => [
    ...(item?.redirects || []).map((entry) => entry.source),
    ...(item?.rewrites || []).map((entry) => entry.source),
  ]).filter((value) => typeof value === 'string');
  const htmlFiles = await walk(webRoot, (file) => /\.html$/i.test(file));

  for (const file of htmlFiles) {
    const html = await fs.readFile(file, 'utf8');
    const pattern = /\b(?:href|src)\s*=\s*["'](\/[^"']*)["']/gi;
    for (const match of html.matchAll(pattern)) {
      let target = match[1].split(/[?#]/)[0];
      if (!target || target.startsWith('//')) continue;
      try { target = decodeURIComponent(target); } catch { continue; }
      const relativeTarget = target.replace(/^\/+/, '');
      const base = path.join(webRoot, relativeTarget);
      const candidates = target === '/'
        ? [path.join(webRoot, 'index.html')]
        : path.extname(base)
          ? [base]
          : [base, base + '.html', path.join(base, 'index.html')];
      const isHostedRoute = hostingSources.some((source) => matchesHostingSource(target, source));
      if (!isHostedRoute && !(await Promise.all(candidates.map(exists))).some(Boolean)) {
        failures.push(relative(file) + ':' + lineAt(html, match.index) + ' links to missing public route ' + match[1]);
      }
    }
  }
}

async function validateLocks() {
  const manifests = await walk(path.join(root, 'packages'), (file) => path.basename(file) === 'package.json');
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (!manifest.version) continue;
    const lockPath = path.join(path.dirname(manifestPath), 'package-lock.json');
    if (!(await exists(lockPath))) continue;
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    const lockVersion = lock.packages?.['']?.version ?? lock.version;
    if (lockVersion && lockVersion !== manifest.version) {
      failures.push(relative(lockPath) + ' root version ' + lockVersion + ' differs from manifest ' + manifest.version);
    }
  }
}

async function validateContexts() {
  const config = JSON.parse(await fs.readFile(path.join(root, 'firebase.json'), 'utf8'));
  const hosting = Array.isArray(config.hosting) ? config.hosting : [config.hosting];
  const rewrites = hosting.flatMap((item) => item?.rewrites || []);
  for (const route of ['/contexts/mpp/v1', '/ns/credentials/v1', '/v1/identity', '/v1/x402']) {
    const rewrite = rewrites.find((item) => item.source === route && typeof item.destination === 'string');
    if (!rewrite) {
      failures.push('firebase.json has no static rewrite for JSON-LD context ' + route);
    } else if (!(await exists(path.join(webRoot, rewrite.destination.replace(/^\/+/, ''))))) {
      failures.push('JSON-LD context ' + route + ' rewrites to missing file ' + rewrite.destination);
    }
  }
  const commerceDiscovery = rewrites.find((item) =>
    item.source === '/.well-known/grantex-commerce'
    && item.run?.serviceId === 'grantex-auth'
  );
  if (!commerceDiscovery) {
    failures.push('firebase.json does not route Commerce discovery to the auth service');
  }
}

async function validateYamlArtifacts() {
  const yamlFiles = new Set([
    ...await walk(path.join(root, '.github', 'workflows'), (file) => /\.ya?ml$/i.test(file)),
    ...await walk(docsRoot, (file) => /\.ya?ml$/i.test(file)),
    path.join(root, 'packages', 'gateway', 'gateway.example.yaml'),
    path.join(root, 'deploy', 'helm', 'grantex', 'values.yaml'),
  ]);

  for (const file of yamlFiles) {
    if (!(await exists(file))) continue;
    try {
      parseYaml(await fs.readFile(file, 'utf8'));
    } catch (error) {
      failures.push(relative(file) + ' is invalid YAML: ' + error.message);
    }
  }
}

async function validateOpenApi() {
  const text = await fs.readFile(path.join(docsRoot, 'openapi.yaml'), 'utf8');
  const paths = [...text.matchAll(/^  (\/[^:\n]+):\s*$/gm)].map((match) => match[1]);
  const families = ['/v1/usage', '/v1/domains', '/v1/vault', '/v1/budget', '/v1/dpdp', '/v1/passports', '/v1/registry'];
  for (const family of families) {
    if (!paths.some((entry) => entry === family || entry.startsWith(family + '/'))) {
      failures.push('OpenAPI is missing public route family ' + family);
    }
  }

  const lines = text.split('\n');
  const operations = new Map();
  let currentPath;
  for (let index = 0; index < lines.length; index += 1) {
    const pathMatch = /^  (\/[^:]+):\s*$/.exec(lines[index]);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete|head|options):\s*$/.exec(lines[index]);
    if (!currentPath || !methodMatch) continue;
    let end = index + 1;
    while (end < lines.length && !/^  \/[^:]+:\s*$/.test(lines[end]) && !/^    (?:get|post|put|patch|delete|head|options):\s*$/.test(lines[end])) end += 1;
    operations.set(methodMatch[1].toUpperCase() + ' ' + currentPath, lines.slice(index, end).join('\n'));
  }

  const requiredOperations = [
    'GET /v1/registry/orgs',
    'GET /v1/registry/orgs/{did}',
    'GET /v1/registry/orgs/{did}/jwks',
    'GET /v1/mcp/servers',
    'POST /v1/mcp/servers',
    'GET /v1/mcp/servers/{serverId}',
    'GET /metrics',
    'POST /v1/credentials/present',
    'POST /v1/vault/credentials/exchange',
    'GET /v1/usage/history',
    'GET /v1/dpdp/consent-records',
  ];
  for (const operation of requiredOperations) {
    if (!operations.has(operation)) failures.push('OpenAPI is missing critical operation ' + operation);
  }

  for (const operation of [
    'GET /v1/registry/orgs',
    'GET /v1/registry/orgs/{did}',
    'GET /v1/registry/orgs/{did}/jwks',
    'GET /v1/mcp/servers',
    'GET /v1/mcp/servers/{serverId}',
    'POST /v1/credentials/present',
  ]) {
    const block = operations.get(operation);
    if (block && !/^      security:\s*\[\]\s*$/m.test(block)) {
      failures.push(operation + ' must explicitly override global developer bearer auth with security: []');
    }
  }

  const vaultExchange = operations.get('POST /v1/vault/credentials/exchange') || '';
  if (!/grantTokenAuth/.test(vaultExchange)) failures.push('Vault credential exchange must document grant-token bearer auth');
  const metrics = operations.get('GET /metrics') || '';
  if (!/metricsBearerAuth/.test(metrics) || /^ +- bearerAuth:/m.test(metrics)) {
    failures.push('Metrics must document METRICS_API_KEY auth rather than developer bearer auth');
  }
  const mcpCreate = operations.get('POST /v1/mcp/servers') || '';
  if (!/required:\s*\[name\]/.test(mcpCreate)) failures.push('MCP server registration must require name');
  const credentialPresent = operations.get('POST /v1/credentials/present') || '';
  if (!/required:\s*\[sdJwt\]/.test(credentialPresent)) failures.push('Credential presentation must require sdJwt');
  const usageHistory = operations.get('GET /v1/usage/history') || '';
  if (!/maximum:\s*90\b/.test(usageHistory) || /maximum:\s*365\b/.test(usageHistory)) failures.push('Usage history must document the runtime 90-day maximum');
  const dpdpList = operations.get('GET /v1/dpdp/consent-records') || '';
  if (/name:\s*status\b/.test(dpdpList)) failures.push('DPDP consent list documents unsupported status query filtering');
}

function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
  return response.json();
}

async function validatePublishedVersions() {
  const expectedAheadNpm = new Set(['@grantex/sdk']);
  const expectedAheadPyPi = new Set(['grantex']);
  const manifests = await walk(path.join(root, 'packages'), (file) => path.basename(file) === 'package.json');
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest.private || !manifest.name?.startsWith('@grantex/') || !manifest.version) continue;
    try {
      const metadata = await fetchJson('https://registry.npmjs.org/' + encodeURIComponent(manifest.name) + '/latest');
      const comparison = compareVersions(manifest.version, metadata.version);
      if (comparison < 0) {
        failures.push(relative(manifestPath) + ' is behind npm (' + manifest.version + ' < ' + metadata.version + ')');
      } else if (expectedAheadNpm.has(manifest.name) && comparison === 0) {
        failures.push(relative(manifestPath) + ' is expected to be ahead of npm but equals published ' + metadata.version);
      }
    } catch (error) {
      warnings.push('Could not verify npm package ' + manifest.name + ': ' + error.message);
    }
  }

  const projects = await walk(path.join(root, 'packages'), (file) => path.basename(file) === 'pyproject.toml');
  for (const projectPath of projects) {
    const text = await fs.readFile(projectPath, 'utf8');
    const project = text.match(/\[project\]([\s\S]*?)(?=\n\[|$)/);
    const name = project?.[1].match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = project?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!name?.startsWith('grantex') || !version) continue;
    try {
      const metadata = await fetchJson('https://pypi.org/pypi/' + encodeURIComponent(name) + '/json');
      const comparison = compareVersions(version, metadata.info.version);
      if (comparison < 0) {
        failures.push(relative(projectPath) + ' is behind PyPI (' + version + ' < ' + metadata.info.version + ')');
      } else if (expectedAheadPyPi.has(name) && comparison === 0) {
        failures.push(relative(projectPath) + ' is expected to be ahead of PyPI but equals published ' + metadata.info.version);
      }
    } catch (error) {
      warnings.push('Could not verify PyPI package ' + name + ': ' + error.message);
    }
  }

  try {
    const goSourcePath = path.join(root, 'packages', 'go-sdk', 'http.go');
    const goSource = await fs.readFile(goSourcePath, 'utf8');
    const localVersion = goSource.match(/const\s+sdkVersion\s*=\s*"([^"]+)"/)?.[1];
    if (!localVersion) {
      failures.push('packages/go-sdk/http.go has no sdkVersion for release-integrity checking');
    } else {
      const metadata = await fetchJson('https://proxy.golang.org/github.com/mishrasanjeev/grantex-go/@latest');
      const publishedVersion = String(metadata.Version || '').replace(/^v/, '');
      if (!publishedVersion) throw new Error('Go proxy response has no Version');
      if (compareVersions(localVersion, publishedVersion) <= 0) {
        failures.push('packages/go-sdk/http.go is expected to be ahead of the Go proxy (' + localVersion + ' <= ' + publishedVersion + ')');
      }
    }
  } catch (error) {
    warnings.push('Could not verify Go SDK version: ' + error.message);
  }
}

async function validateLiveUrls(publicContent) {
  const urls = new Set();
  const pattern = /https:\/\/(?:docs\.)?grantex\.dev[^\s"'<>)]*/g;
  for (const { text } of publicContent) {
    for (const match of text.matchAll(pattern)) {
      const url = match[0]
        .replace(/[.,;:]$/, '')
        .replace(new RegExp(String.fromCharCode(96) + '+$'), '');
      if (!/[{}*]/.test(url)) urls.add(url);
    }
  }
  const queue = [...urls];
  const workers = Array.from({ length: 10 }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (response.status === 404 || response.status >= 500) {
          failures.push('Live public URL returned ' + response.status + ': ' + url);
        }
      } catch (error) {
        warnings.push('Could not verify live URL ' + url + ': ' + error.message);
      }
    }
  });
  await Promise.all(workers);
}

const docFiles = await walk(docsRoot, (file) => /\.(md|mdx)$/i.test(file));
const routes = new Set(['/']);
for (const file of docFiles) {
  const route = '/' + normalize(path.relative(docsRoot, file)).replace(/\.(md|mdx)$/i, '');
  addRouteAliases(routes, route);
}

await validateNavigation(routes, docFiles);
const publicContent = await validatePublicReferences(routes, docFiles);
await validatePublicHtmlLinks();
await validateLocks();
await validateContexts();
await validateYamlArtifacts();
await validateOpenApi();
if (live) {
  await validatePublishedVersions();
  await validateLiveUrls(publicContent);
}

for (const warning of warnings) console.warn('WARN:', warning);
if (failures.length) {
  console.error('\nDocumentation integrity check failed:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('Documentation integrity check passed' + (live ? ' (including live checks).' : '.'));
}
