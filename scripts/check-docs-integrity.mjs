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
    [/\bfully[- ]compliant OAuth 2\.1 authorization server\b/gi, 'unsupported MCP Auth conformance claim'],
    [/\bproduction-ready OAuth 2\.1(?: \+ PKCE)? authorization server\b/gi, 'unsupported MCP Auth production-readiness claim'],
    [/In-memory\s*\(stateless,\s*horizontal scale\)/gi, 'incorrect MCP Auth horizontal-scaling claim'],
    [/Custom consent page via\s+`?consentUi`?\s+config/gi, 'incorrect MCP Auth consent-page claim'],
    [/default consent page works out of the box/gi, 'incorrect MCP Auth consent-page claim'],
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

function hasReleasePair(text, name, version) {
  const escape = (value) => value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const namePattern = '(?:^|[^0-9A-Za-z@/._-])' + escape(name) + '(?=$|[^0-9A-Za-z/._-])';
  const versionPattern = '(?:^|[^0-9A-Za-z.])' + escape(version) + '(?=$|[^0-9A-Za-z.])';
  const pairPattern = new RegExp(namePattern + '[\\s\\S]*?' + versionPattern);
  const releaseCards = text.match(/<a\b[^>]*\brelease-card\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  return [...text.split(/\r?\n/), ...releaseCards].some((segment) => pairPattern.test(segment));
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function releaseDateForms(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return [value];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = months[Number(match[2]) - 1];
  const day = Number(match[3]);
  return [value, day + ' ' + month + ' ' + match[1], month + ' ' + day + ', ' + match[1]];
}

function hasReleaseDate(text, value) {
  const datePattern = releaseDateForms(value).join('|');
  const pattern = new RegExp('(?:verified|updated|release snapshot).{0,160}(?:' + datePattern + ')', 'i');
  return text.split(/\r?\n/).some((line) => pattern.test(line));
}

async function loadReleaseSnapshot() {
  const snapshotPath = path.join(root, 'release-status.json');
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  } catch (error) {
    failures.push('release-status.json is unreadable or invalid JSON: ' + error.message);
    return { schemaVersion: 1, verifiedAt: '', artifacts: [] };
  }

  if (snapshot.schemaVersion !== 1) {
    failures.push('release-status.json must use schemaVersion 1');
  }
  if (typeof snapshot.verifiedAt !== 'string' || !isValidIsoDate(snapshot.verifiedAt)) {
    failures.push('release-status.json must have a verifiedAt date in YYYY-MM-DD format');
  }

  const required = new Map([
    ['typescript-sdk', {
      name: '@grantex/sdk',
      ecosystem: 'npm',
      registryUrl: 'https://registry.npmjs.org/%40grantex%2Fsdk/latest',
    }],
    ['python-sdk', {
      name: 'grantex',
      ecosystem: 'pypi',
      registryUrl: 'https://pypi.org/pypi/grantex/json',
    }],
    ['go-sdk', {
      name: 'github.com/mishrasanjeev/grantex-go',
      ecosystem: 'go',
      registryUrl: 'https://proxy.golang.org/github.com/mishrasanjeev/grantex-go/@latest',
    }],
    ['mcp-auth', {
      name: '@grantex/mcp-auth',
      ecosystem: 'npm',
      registryUrl: 'https://registry.npmjs.org/%40grantex%2Fmcp-auth/latest',
    }],
  ]);
  const expectedStatus = new Map([
    ['typescript-sdk', 'published'],
    ['python-sdk', 'published'],
    ['go-sdk', 'published-with-known-limitations'],
    ['mcp-auth', 'published-with-known-limitations'],
  ]);
  const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
  if (!Array.isArray(snapshot.artifacts)) {
    failures.push('release-status.json artifacts must be an array');
  }

  const seenIds = new Set();
  const seenNames = new Set();
  for (const artifact of artifacts) {
    for (const field of ['id', 'label', 'ecosystem', 'name', 'version', 'status', 'registryUrl']) {
      if (typeof artifact?.[field] !== 'string' || !artifact[field]) {
        failures.push('release-status.json artifact is missing string field ' + field);
      }
    }
    if (!artifact?.id) continue;
    if (seenIds.has(artifact.id)) failures.push('release-status.json repeats artifact id ' + artifact.id);
    if (artifact.name && seenNames.has(artifact.name)) failures.push('release-status.json repeats artifact name ' + artifact.name);
    seenIds.add(artifact.id);
    if (artifact.name) seenNames.add(artifact.name);

    if (!['published', 'published-with-known-limitations'].includes(artifact.status)) {
      failures.push('release-status.json artifact ' + artifact.id + ' has invalid status ' + artifact.status);
    }
    if (artifact.id && expectedStatus.has(artifact.id) && artifact.status !== expectedStatus.get(artifact.id)) {
      failures.push('release-status.json artifact ' + artifact.id + ' must use status ' + expectedStatus.get(artifact.id));
    }
    if (artifact.status === 'published-with-known-limitations' && (
      !Array.isArray(artifact.limitations)
      || artifact.limitations.length === 0
      || artifact.limitations.some((item) => typeof item !== 'string' || !item)
    )) {
      failures.push('release-status.json artifact ' + artifact.id + ' must list its known limitations');
    }

    const expected = required.get(artifact.id);
    if (expected && (
      artifact.name !== expected.name
      || artifact.ecosystem !== expected.ecosystem
      || artifact.registryUrl !== expected.registryUrl
    )) {
      failures.push('release-status.json artifact ' + artifact.id + ' must use the canonical ' + expected.ecosystem + ' identity and registry URL for ' + expected.name);
    }
    try {
      const target = new URL(artifact.registryUrl);
      if (
        target.protocol !== 'https:'
        || !allowedRegistryOrigins.has(target.origin)
        || target.username
        || target.password
      ) {
        failures.push('release-status.json has an unapproved registry URL for ' + artifact.id);
      }
    } catch {
      failures.push('release-status.json has an invalid registry URL for ' + artifact.id);
    }
  }
  for (const id of required.keys()) {
    if (!seenIds.has(id)) failures.push('release-status.json is missing required artifact ' + id);
  }

  const validArtifacts = artifacts.filter((artifact) => artifact
    && ['id', 'label', 'ecosystem', 'name', 'version', 'status', 'registryUrl']
      .every((field) => typeof artifact[field] === 'string' && artifact[field]));
  return { ...snapshot, artifacts: validArtifacts };
}

async function validateReleaseCopy() {
  async function readVersionSource(sourcePath, label) {
    try {
      return await fs.readFile(sourcePath, 'utf8');
    } catch (error) {
      failures.push(label + ' version source is unreadable (' + relative(sourcePath) + '): ' + error.message);
      return '';
    }
  }

  async function readPackageVersion(sourcePath, expectedName) {
    const source = await readVersionSource(sourcePath, expectedName);
    if (!source) return null;
    try {
      const manifest = JSON.parse(source);
      if (manifest.name !== expectedName || typeof manifest.version !== 'string' || !manifest.version) {
        failures.push(relative(sourcePath) + ' has no version for ' + expectedName);
        return null;
      }
      return manifest.version;
    } catch (error) {
      failures.push(relative(sourcePath) + ' is not valid JSON: ' + error.message);
      return null;
    }
  }

  const releaseSnapshot = await loadReleaseSnapshot();
  const releaseById = new Map(releaseSnapshot.artifacts.map((artifact) => [artifact.id, artifact]));

  const localVersions = new Map();
  localVersions.set('typescript-sdk', await readPackageVersion(
    path.join(root, 'packages', 'sdk-ts', 'package.json'),
    '@grantex/sdk',
  ));
  localVersions.set('mcp-auth', await readPackageVersion(
    path.join(root, 'packages', 'mcp-auth', 'package.json'),
    '@grantex/mcp-auth',
  ));

  const pythonSourcePath = path.join(root, 'packages', 'sdk-py', 'pyproject.toml');
  const pythonSource = await readVersionSource(pythonSourcePath, 'grantex');
  const pythonProject = pythonSource.match(/\[project\]([\s\S]*?)(?=\n\[|$)/);
  const pythonVersion = pythonProject?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1] || null;
  if (pythonSource && !pythonVersion) {
    failures.push(relative(pythonSourcePath) + ' has no [project] version for grantex');
  }
  localVersions.set('python-sdk', pythonVersion);

  const goSourcePath = path.join(root, 'packages', 'go-sdk', 'http.go');
  const goSource = await readVersionSource(goSourcePath, 'Grantex Go SDK');
  const goSdkVersion = goSource.match(/const\s+sdkVersion\s*=\s*"([^"]+)"/)?.[1] || null;
  if (goSource && !goSdkVersion) {
    failures.push(relative(goSourcePath) + ' has no sdkVersion for release-copy checking');
  }
  localVersions.set('go-sdk', goSdkVersion
    ? (goSdkVersion.startsWith('v') ? goSdkVersion : 'v' + goSdkVersion)
    : null);

  for (const [id, localVersion] of localVersions) {
    const published = releaseById.get(id);
    if (localVersion && published && compareVersions(localVersion, published.version) < 0) {
      failures.push('Local ' + published.label + ' version is behind the published snapshot (' + localVersion + ' < ' + published.version + ')');
    }
  }

  const overviewFilesById = new Map([
    ['typescript-sdk', ['docs/sdks/typescript/overview.mdx']],
    ['python-sdk', ['docs/sdks/python/overview.mdx']],
    ['go-sdk', ['docs/sdks/go/overview.mdx']],
    ['mcp-auth', [
      'docs/features/mcp-auth-server.mdx',
      'docs/integrations/mcp-auth.mdx',
    ]],
  ]);
  const artifacts = [...overviewFilesById].flatMap(([id, overviewFiles]) => {
    const published = releaseById.get(id);
    return published
      ? [{ label: published.label, name: published.name, version: published.version, overviewFiles }]
      : [];
  });

  const globalFiles = [
    'README.md',
    'COMPATIBILITY.md',
    'web/index.html',
    'web/llms.txt',
    'web/llms-full.txt',
    'docs/release-status.mdx',
    'docs/protocol/changelog.mdx',
  ];
  const contentByFile = new Map();
  async function readReleaseTarget(file) {
    if (contentByFile.has(file)) return contentByFile.get(file);
    const target = path.join(root, ...file.split('/'));
    try {
      const text = await fs.readFile(target, 'utf8');
      contentByFile.set(file, text);
      return text;
    } catch (error) {
      failures.push('Release-copy target is unreadable (' + file + '): ' + error.message);
      contentByFile.set(file, null);
      return null;
    }
  }

  for (const file of globalFiles) {
    const text = await readReleaseTarget(file);
    if (text === null) continue;
    for (const artifact of artifacts) {
      if (!hasReleasePair(text, artifact.name, artifact.version)) {
        failures.push(file + ' must associate ' + artifact.name + ' with current ' + artifact.label + ' version ' + artifact.version);
      }
    }
    if (!hasReleaseDate(text, releaseSnapshot.verifiedAt)) {
      failures.push(file + ' must display release snapshot date ' + releaseSnapshot.verifiedAt);
    }
  }

  for (const artifact of artifacts) {
    for (const file of artifact.overviewFiles) {
      const text = await readReleaseTarget(file);
      if (text !== null && !hasReleasePair(text, artifact.name, artifact.version)) {
        failures.push(file + ' must associate ' + artifact.name + ' with current ' + artifact.label + ' version ' + artifact.version);
      }
    }
  }
  const stalePatterns = [
    [/\bMCP Auth Server v2\.0\.1\b/i, 'MCP Auth Server v2.0.1'],
    [/(?:TypeScript(?: SDK)?|@grantex\/sdk)[^\n]{0,120}\b0\.3\.13\b[^\n]{0,80}\bunreleased\b/i, 'TypeScript 0.3.13 marked unreleased'],
    [/(?:TypeScript(?: SDK)?|@grantex\/sdk)[^\n]{0,120}\b0\.3\.13\b[^\n]{0,80}\bprepared for publication\b/i, 'TypeScript 0.3.13 prepared for publication'],
    [/\blatest published(?: version)?(?:\s+is)?\s+0\.3\.12\b/i, 'latest published 0.3.12'],
    [/TypeScript\s+0\.3\.12[^\n]{0,80}Python\s+0\.3\.13[^\n]{0,80}Go\s+v0\.1\.9/i, 'stale three-SDK release summary'],
    [/AgentID:\s+agent\.ID\b/, 'Go v0.1.10 empty Agent.ID used in a request'],
    [/client\.Audit\.Log\s*\([\s\S]{0,160}?grantex\.LogAuditParams\s*\{/m, 'Go v0.1.10 audit payload documented as usable'],
  ];
  const staleFiles = new Set([
    ...globalFiles,
    ...artifacts.flatMap((artifact) => artifact.overviewFiles),
    'CHANGELOG.md',
    'docs/quickstart.mdx',
    'docs/sdks/go/audit.mdx',
  ]);
  for (const file of staleFiles) {
    const text = await readReleaseTarget(file);
    if (text === null) continue;
    for (const [pattern, label] of stalePatterns) {
      const match = pattern.exec(text);
      if (match) {
        failures.push(file + ':' + lineAt(text, match.index) + ' contains stale current-release copy: ' + label);
      }
    }
  }

  return releaseSnapshot;
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

const allowedRegistryOrigins = new Set([
  'https://registry.npmjs.org',
  'https://pypi.org',
  'https://proxy.golang.org',
]);
const npmRegistryUrls = new Map([
  ['@grantex/a2a', 'https://registry.npmjs.org/%40grantex%2Fa2a/latest'],
  ['@grantex/adapters', 'https://registry.npmjs.org/%40grantex%2Fadapters/latest'],
  ['@grantex/anthropic', 'https://registry.npmjs.org/%40grantex%2Fanthropic/latest'],
  ['@grantex/autogen', 'https://registry.npmjs.org/%40grantex%2Fautogen/latest'],
  ['@grantex/cli', 'https://registry.npmjs.org/%40grantex%2Fcli/latest'],
  ['@grantex/conformance', 'https://registry.npmjs.org/%40grantex%2Fconformance/latest'],
  ['@grantex/destinations', 'https://registry.npmjs.org/%40grantex%2Fdestinations/latest'],
  ['@grantex/dpdp', 'https://registry.npmjs.org/%40grantex%2Fdpdp/latest'],
  ['@grantex/express', 'https://registry.npmjs.org/%40grantex%2Fexpress/latest'],
  ['@grantex/gateway', 'https://registry.npmjs.org/%40grantex%2Fgateway/latest'],
  ['@grantex/gemma', 'https://registry.npmjs.org/%40grantex%2Fgemma/latest'],
  ['@grantex/langchain', 'https://registry.npmjs.org/%40grantex%2Flangchain/latest'],
  ['@grantex/mcp', 'https://registry.npmjs.org/%40grantex%2Fmcp/latest'],
  ['@grantex/mcp-auth', 'https://registry.npmjs.org/%40grantex%2Fmcp-auth/latest'],
  ['@grantex/mpp', 'https://registry.npmjs.org/%40grantex%2Fmpp/latest'],
  ['@grantex/sdk', 'https://registry.npmjs.org/%40grantex%2Fsdk/latest'],
  ['@grantex/strands', 'https://registry.npmjs.org/%40grantex%2Fstrands/latest'],
  ['@grantex/vercel-ai', 'https://registry.npmjs.org/%40grantex%2Fvercel-ai/latest'],
  ['@grantex/x402', 'https://registry.npmjs.org/%40grantex%2Fx402/latest'],
]);
const pypiRegistryUrls = new Map([
  ['grantex', 'https://pypi.org/pypi/grantex/json'],
  ['grantex-a2a', 'https://pypi.org/pypi/grantex-a2a/json'],
  ['grantex-adk', 'https://pypi.org/pypi/grantex-adk/json'],
  ['grantex-crewai', 'https://pypi.org/pypi/grantex-crewai/json'],
  ['grantex-fastapi', 'https://pypi.org/pypi/grantex-fastapi/json'],
  ['grantex-gemma', 'https://pypi.org/pypi/grantex-gemma/json'],
  ['grantex-openai-agents', 'https://pypi.org/pypi/grantex-openai-agents/json'],
  ['grantex-strands', 'https://pypi.org/pypi/grantex-strands/json'],
]);

async function fetchJson(url) {
  const target = new URL(url);
  if (
    target.protocol !== 'https:'
    || !allowedRegistryOrigins.has(target.origin)
    || target.username
    || target.password
  ) {
    throw new Error('Refusing non-registry URL: ' + target.origin);
  }
  const response = await fetch(target, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
  return response.json();
}

async function validatePublishedVersions(releaseSnapshot) {
  const releaseByName = new Map(releaseSnapshot.artifacts.map((artifact) => [artifact.name, artifact]));

  const manifests = await walk(path.join(root, 'packages'), (file) => path.basename(file) === 'package.json');
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest.private || !manifest.name?.startsWith('@grantex/') || !manifest.version) continue;
    const advertised = releaseByName.get(manifest.name);
    const registryUrl = advertised?.registryUrl || npmRegistryUrls.get(manifest.name);
    if (!registryUrl) {
      failures.push(relative(manifestPath) + ' has no approved npm registry URL');
      continue;
    }
    try {
      const metadata = await fetchJson(registryUrl);
      const publishedVersion = String(metadata.version || '');
      if (!publishedVersion) throw new Error('npm response has no version');
      if (advertised) {
        if (advertised.version !== publishedVersion) {
          failures.push('release-status.json is out of sync with npm for ' + manifest.name + ' (' + advertised.version + ' != ' + publishedVersion + ')');
        }
      } else if (compareVersions(manifest.version, publishedVersion) < 0) {
        failures.push(relative(manifestPath) + ' is behind npm (' + manifest.version + ' < ' + publishedVersion + ')');
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
    const advertised = releaseByName.get(name);
    const registryUrl = advertised?.registryUrl || pypiRegistryUrls.get(name);
    if (!registryUrl) {
      failures.push(relative(projectPath) + ' has no approved PyPI registry URL');
      continue;
    }
    try {
      const metadata = await fetchJson(registryUrl);
      const publishedVersion = String(metadata.info?.version || '');
      if (!publishedVersion) throw new Error('PyPI response has no version');
      if (advertised) {
        if (advertised.version !== publishedVersion) {
          failures.push('release-status.json is out of sync with PyPI for ' + name + ' (' + advertised.version + ' != ' + publishedVersion + ')');
        }
      } else if (compareVersions(version, publishedVersion) < 0) {
        failures.push(relative(projectPath) + ' is behind PyPI (' + version + ' < ' + publishedVersion + ')');
      }
    } catch (error) {
      warnings.push('Could not verify PyPI package ' + name + ': ' + error.message);
    }
  }

  const goModule = 'github.com/mishrasanjeev/grantex-go';
  const advertisedGo = releaseByName.get(goModule);
  if (!advertisedGo) {
    failures.push('release-status.json is missing the Go SDK');
  } else {
    try {
      const metadata = await fetchJson(advertisedGo.registryUrl);
      const publishedVersion = String(metadata.Version || '');
      if (!publishedVersion) throw new Error('Go proxy response has no Version');
      if (advertisedGo.version !== publishedVersion) {
        failures.push('release-status.json is out of sync with the Go proxy (' + advertisedGo.version + ' != ' + publishedVersion + ')');
      }
    } catch (error) {
      warnings.push('Could not verify Go SDK version: ' + error.message);
    }
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
const releaseSnapshot = await validateReleaseCopy();
if (live) {
  await validatePublishedVersions(releaseSnapshot);
  await validateLiveUrls(publicContent);
  if (warnings.length) {
    failures.push('Live checks were incomplete because ' + warnings.length + ' network verification warning(s) occurred');
  }
}

for (const warning of warnings) console.warn('WARN:', warning);
if (failures.length) {
  console.error('\nDocumentation integrity check failed:');
  for (const failure of failures) console.error(' - ' + failure);
  process.exitCode = 1;
} else {
  console.log('Documentation integrity check passed' + (live ? ' (including live checks).' : '.'));
}
