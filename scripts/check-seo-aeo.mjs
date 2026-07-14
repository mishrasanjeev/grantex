#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), '..');

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, predicate = () => true) {
  const output = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute, predicate));
    else if (predicate(absolute)) output.push(absolute);
  }
  return output;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isTagBoundary(character) {
  return character === undefined || ' \t\n\f\r/>'.includes(character);
}

function findElementMarker(source, marker, fromIndex) {
  let index = source.indexOf(marker, fromIndex);
  while (index !== -1) {
    if (isTagBoundary(source[index + marker.length])) return index;
    index = source.indexOf(marker, index + marker.length);
  }
  return -1;
}

function removeElementBlocks(value, tagName) {
  const source = String(value);
  const lower = source.toLowerCase();
  const openMarker = '<' + tagName;
  const closeMarker = '</' + tagName;
  let cursor = 0;
  let output = '';

  while (cursor < source.length) {
    const openStart = findElementMarker(lower, openMarker, cursor);
    if (openStart === -1) return output + source.slice(cursor);

    output += source.slice(cursor, openStart) + ' ';
    const closeStart = findElementMarker(lower, closeMarker, openStart + openMarker.length);
    if (closeStart === -1) return output;

    const closeEnd = lower.indexOf('>', closeStart + closeMarker.length);
    if (closeEnd === -1) return output;
    cursor = closeEnd + 1;
  }

  return output;
}

function removeNonVisibleBlocks(value) {
  return removeElementBlocks(removeElementBlocks(value, 'script'), 'style');
}

function normalizeVisibleText(value) {
  return removeNonVisibleBlocks(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|quot|apos|#39|#x27);/gi, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9@./:+-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractJsonLd(html, label, failures) {
  const values = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      values.push(JSON.parse(match[1]));
    } catch (error) {
      failures.push(label + ' has invalid JSON-LD: ' + error.message);
    }
  }
  return values;
}

function publicFileCandidates(webRoot, url) {
  const pathname = new URL(url).pathname;
  if (pathname === '/') return [path.join(webRoot, 'index.html')];
  const relativePath = pathname.replace(/^\/+|\/+$/g, '');
  if (pathname.endsWith('/')) return [path.join(webRoot, relativePath, 'index.html')];
  return [
    path.join(webRoot, relativePath + '.html'),
    path.join(webRoot, relativePath, 'index.html'),
  ];
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export async function validateSeoAeo(options = {}) {
  const root = options.root || defaultRoot;
  const docsRoot = options.docsRoot || path.join(root, 'docs');
  const webRoot = options.webRoot || path.join(root, 'web');
  const failures = [];

  const canonicalDefinition = 'Grantex is an open-source delegated authorization protocol and reference implementation for AI agents.';
  const definitionFiles = [
    'README.md',
    'docs/introduction.mdx',
    'docs/openapi.yaml',
    'web/index.html',
    'web/llms.txt',
    'web/llms-full.txt',
  ];
  for (const name of definitionFiles) {
    const text = await fs.readFile(path.join(root, ...name.split('/')), 'utf8');
    if (!text.includes(canonicalDefinition)) {
      failures.push(name + ' must contain the canonical Grantex definition');
    }
  }

  let rootRelease;
  let publicRelease;
  try {
    rootRelease = JSON.parse(await fs.readFile(path.join(root, 'release-status.json'), 'utf8'));
    publicRelease = JSON.parse(await fs.readFile(path.join(webRoot, 'release-status.json'), 'utf8'));
  } catch (error) {
    failures.push('Release-status JSON is invalid: ' + error.message);
  }
  if (rootRelease && publicRelease && JSON.stringify(rootRelease) !== JSON.stringify(publicRelease)) {
    failures.push('web/release-status.json must exactly mirror release-status.json');
  }
  if (rootRelease) {
    const mcp = rootRelease.artifacts?.find((artifact) => artifact.id === 'mcp-auth');
    const expected = new Set([
      'mcp-process-local-codes',
      'mcp-consent-metadata-only',
      'mcp-code-handoff-incomplete',
      'mcp-no-live-revocation-lookup',
      'mcp-token-issued-hook-unused',
      'mcp-redirect-allowlist-not-global',
    ]);
    const actual = new Set((mcp?.limitations || []).map((item) => item.id));
    if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id))) {
      failures.push('release-status.json must publish all six MCP Auth 2.0.2 limitations');
    }

    const goSdk = rootRelease.artifacts?.find((artifact) => artifact.id === 'go-sdk');
    const expectedGo = new Set([
      'go-agent-id-response-mapping',
      'go-audit-write-payload',
      'go-list-response-metadata',
      'go-agent-write-payload',
      'go-audit-read-contract',
      'go-query-encoding',
    ]);
    const actualGo = new Set((goSdk?.limitations || []).map((item) => item.id));
    if (actualGo.size !== expectedGo.size || [...expectedGo].some((id) => !actualGo.has(id))) {
      failures.push('release-status.json must publish all six Go SDK v0.1.10 limitations');
    }
  }

  let linkedData = { '@graph': [] };
  try {
    linkedData = JSON.parse(await fs.readFile(path.join(webRoot, 'ld.json'), 'utf8'));
  } catch (error) {
    failures.push('web/ld.json is invalid JSON: ' + error.message);
  }
  const graph = Array.isArray(linkedData['@graph']) ? linkedData['@graph'] : [];
  const requiredTypes = ['Organization', 'WebSite', 'WebPage', 'SoftwareSourceCode', 'TechArticle'];
  const graphTypes = new Set(graph.flatMap((node) => Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']]));
  for (const type of requiredTypes) {
    if (!graphTypes.has(type)) failures.push('web/ld.json is missing ' + type);
  }
  const graphIds = graph.map((node) => node?.['@id']).filter(Boolean);
  if (graphIds.length !== new Set(graphIds).size || graphIds.some((id) => {
    try { return new URL(id).protocol !== 'https:'; } catch { return true; }
  })) {
    failures.push('web/ld.json must use unique stable HTTPS @id values');
  }

  const homepagePath = path.join(webRoot, 'index.html');
  const homepage = await fs.readFile(homepagePath, 'utf8');
  const homepageLd = extractJsonLd(homepage, 'web/index.html', failures);
  const homepageGraph = homepageLd.find((item) => Array.isArray(item?.['@graph'])
    && item['@graph'].some((node) => node?.['@type'] === 'WebSite'));
  if (!homepageGraph) {
    failures.push('web/index.html must embed the canonical connected JSON-LD graph');
  } else if (JSON.stringify(homepageGraph) !== JSON.stringify(linkedData)) {
    failures.push('web/index.html JSON-LD graph must exactly match web/ld.json');
  }

  const visibleHomepage = normalizeVisibleText(homepage);
  const faq = graph.find((node) => node?.['@type'] === 'FAQPage');
  for (const entity of faq?.mainEntity || []) {
    const question = normalizeVisibleText(entity?.name || '');
    const answer = normalizeVisibleText(entity?.acceptedAnswer?.text || '');
    if (!question || !visibleHomepage.includes(question)) {
      failures.push('Homepage FAQ JSON-LD question is not visible: ' + (entity?.name || 'unnamed'));
    }
    if (!answer || !visibleHomepage.includes(answer)) {
      failures.push('Homepage FAQ JSON-LD answer is not visible: ' + (entity?.name || 'unnamed'));
    }
  }

  const docsConfig = await fs.readFile(path.join(docsRoot, 'docs.json'), 'utf8');
  for (const route of [
    'blog/ai-agent-authorization-guide',
    'blog/langchain-agent-permissions',
    'blog/mcp-server-oauth-authentication',
  ]) {
    if (!docsConfig.includes('"' + route + '"')) failures.push('docs/docs.json navigation must include ' + route);
  }

  for (const section of ['for', 'vs']) {
    const sectionRoot = path.join(webRoot, section);
    const entries = await fs.readdir(sectionRoot, { withFileTypes: true });
    const pages = [
      path.join(sectionRoot, 'index.html'),
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sectionRoot, entry.name, 'index.html')),
    ];
    for (const page of pages) {
      const html = await fs.readFile(page, 'utf8');
      const label = relative(root, page);
      const visible = removeNonVisibleBlocks(html);
      if ((visible.match(/<h1\b/gi) || []).length !== 1) failures.push(label + ' must have exactly one visible H1');
      if (/const\s+(?:frameworks|pages)\s*=/.test(html)) failures.push(label + ' must not rely on a client-side content map');
      if (/<title>[^<]*\s\?\s[^<]*<\/title>|(?:guide|documentation|comparison)\s+\?|do\?and|Grantex\s+\?\s+/i.test(html)) {
        failures.push(label + ' contains a generation-corrupted punctuation placeholder');
      }
      if (html.includes('https://grantex.dev/#software')) failures.push(label + ' references the retired #software entity ID');
      const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || '';
      if (description.length < 70 || description.length > 160) failures.push(label + ' meta description must be 70-160 characters');
      if (/noindex/i.test(html.match(/<meta\s+name=["']robots["'][^>]*>/i)?.[0] || '')) failures.push(label + ' must be indexable');
      if (!/rel=["']alternate["'][^>]+href=["']\/llms\.txt["']/i.test(html)) failures.push(label + ' must link /llms.txt');
      if (!/property=["']og:image:width["']/i.test(html)
        || !/property=["']og:image:height["']/i.test(html)
        || !/property=["']og:image:alt["']/i.test(html)) {
        failures.push(label + ' must include complete Open Graph image metadata');
      }
      const jsonLd = extractJsonLd(html, label, failures);
      if (jsonLd.length !== 1 || !Array.isArray(jsonLd[0]?.['@graph'])) failures.push(label + ' must have one connected JSON-LD graph');
    }
  }

  const llms = await fs.readFile(path.join(webRoot, 'llms.txt'), 'utf8');
  if (!/^# Grantex\r?$/m.test(llms) || !/^> /m.test(llms)
    || !/^## Start Here\r?$/m.test(llms) || !/^## Optional\r?$/m.test(llms)) {
    failures.push('web/llms.txt must follow the llms.txt link-index structure');
  }
  const llmsFull = await fs.readFile(path.join(webRoot, 'llms-full.txt'), 'utf8');
  for (const value of ['@grantex/sdk@0.3.13', 'grantex==0.3.14', 'grantex-go@v0.1.10', '@grantex/mcp-auth@2.0.2']) {
    if (!llmsFull.includes(value)) failures.push('web/llms-full.txt is missing current implementation selector ' + value);
  }
  const llmsUpdatedAt = llmsFull.match(/Last updated:\s+(\d{4}-\d{2}-\d{2})/)?.[1];
  const llmsSnapshotAt = llmsFull.match(/Public release snapshot verified:\s+(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!llmsUpdatedAt || !llmsSnapshotAt || llmsSnapshotAt !== rootRelease?.verifiedAt || llmsUpdatedAt < llmsSnapshotAt) {
    failures.push('web/llms-full.txt must display its verified update date');
  }
  if (!llmsFull.includes('Delegated Agent Authorization Protocol (DAAP)')) {
    failures.push('web/llms-full.txt must use the current IETF Internet-Draft title');
  }

  const sitemap = await fs.readFile(path.join(webRoot, 'sitemap.xml'), 'utf8');
  if (/<(?:priority|changefreq)>/i.test(sitemap)) failures.push('web/sitemap.xml must not use ignored priority/changefreq hints');
  const entries = [...sitemap.matchAll(/<url>\s*<loc>(https:\/\/grantex\.dev\/[^<]*)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/url>/g)]
    .map((match) => ({ loc: match[1], lastmod: match[2] }));
  if (!entries.length) failures.push('web/sitemap.xml has no canonical URL entries');
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.loc)) failures.push('web/sitemap.xml repeats ' + entry.loc);
    seen.add(entry.loc);
    const canonicalPath = new URL(entry.loc).pathname;
    if (canonicalPath !== '/' && canonicalPath.endsWith('/')) {
      failures.push('web/sitemap.xml contains a redirecting trailing-slash URL: ' + entry.loc);
    }
    if (!isValidIsoDate(entry.lastmod)) failures.push('web/sitemap.xml has invalid lastmod for ' + entry.loc);
    const candidates = publicFileCandidates(webRoot, entry.loc);
    const availability = await Promise.all(candidates.map(exists));
    const index = availability.findIndex(Boolean);
    if (index < 0) {
      failures.push('Sitemap URL has no public HTML source: ' + entry.loc);
      continue;
    }
    const html = await fs.readFile(candidates[index], 'utf8');
    const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)?.[1];
    if (canonical !== entry.loc) failures.push(relative(root, candidates[index]) + ' canonical differs from sitemap URL ' + entry.loc);
    if (/noindex/i.test(html.match(/<meta\s+name=["']robots["'][^>]*>/i)?.[0] || '')) {
      failures.push(relative(root, candidates[index]) + ' is noindex but appears in the sitemap');
    }
    const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || '';
    if (description.length < 70 || description.length > 160) failures.push(relative(root, candidates[index]) + ' meta description must be 70-160 characters');
    if (!/property=["']og:image:alt["']/i.test(html) || !/name=["']twitter:image:alt["']/i.test(html)) {
      failures.push(relative(root, candidates[index]) + ' must include Open Graph and Twitter image alt text');
    }
  }
  for (const required of [
    'https://grantex.dev/',
    'https://grantex.dev/for',
    'https://grantex.dev/vs',
    'https://grantex.dev/report/state-of-agent-security-2026',
    'https://grantex.dev/commerce',
  ]) {
    if (!seen.has(required)) failures.push('web/sitemap.xml is missing ' + required);
  }

  const robots = await fs.readFile(path.join(webRoot, 'robots.txt'), 'utf8');
  if (/^\s*Disallow:/mi.test(robots)) failures.push('web/robots.txt must keep public pages crawlable so noindex can be read');
  for (const token of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'OAI-AdsBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Applebot', 'Google-Extended', 'Google-Agent', 'Amazonbot', 'Amzn-SearchBot', 'Amzn-User']) {
    if (!robots.includes('User-agent: ' + token)) failures.push('web/robots.txt is missing explicit allowance for ' + token);
  }
  for (const sitemapUrl of ['https://grantex.dev/sitemap.xml', 'https://docs.grantex.dev/sitemap.xml']) {
    if (!robots.includes('Sitemap: ' + sitemapUrl)) failures.push('web/robots.txt is missing ' + sitemapUrl);
  }

  const indexNowWorkflow = await fs.readFile(path.join(root, '.github', 'workflows', 'seo-ping.yml'), 'utf8');
  try {
    parseYaml(indexNowWorkflow);
  } catch (error) {
    failures.push(`IndexNow workflow YAML is invalid: ${error.message}`);
  }
  if (indexNowWorkflow.includes('\\${{')) {
    failures.push('IndexNow workflow contains escaped GitHub expressions');
  }
  if (/^\s*schedule:/m.test(indexNowWorkflow)) {
    failures.push('IndexNow workflow must not resubmit the full site on a recurring schedule');
  }
  if (!indexNowWorkflow.includes('current.get(location) != previous.get(location)')
    || !indexNowWorkflow.includes('No sitemap additions, removals, or lastmod changes')) {
    failures.push('IndexNow workflow must derive submissions from changed sitemap entries');
  }

  const authorityFiles = [
    path.join(webRoot, 'llms.txt'),
    path.join(webRoot, 'llms-full.txt'),
    path.join(webRoot, 'mcp.html'),
    ...await walk(path.join(webRoot, 'for'), (file) => /\.html$/i.test(file)),
    ...await walk(path.join(webRoot, 'vs'), (file) => /\.html$/i.test(file)),
  ];
  const forbidden = [
    [/Agentic Commerce V1 Live Pilot/i, 'superseded commerce pilot language'],
    [/\btamper-proof\b/i, 'tamper-proof claim'],
    [/production-ready OAuth 2\.1(?: \+ PKCE)? authorization server/i, 'MCP Auth production-readiness claim'],
    [/OAuth 2\.1 \+ PKCE authorization for any MCP server/i, 'MCP Auth any-server claim'],
    [/Add enterprise-grade authorization to any MCP server/i, 'MCP any-server claim'],
    [/Why OAuth 2\.0 doesn't work for AI agents/i, 'OAuth replacement framing'],
    [/API keys give AI agents unlimited access/i, 'absolute API-key claim'],
    [/Get started in under 5 minutes/i, 'unsupported setup-time claim'],
  ];
  for (const file of authorityFiles) {
    const text = await fs.readFile(file, 'utf8');
    for (const [pattern, label] of forbidden) {
      const match = pattern.exec(text);
      if (match) failures.push(relative(root, file) + ' contains ' + label);
    }
  }

  const report = await fs.readFile(path.join(webRoot, 'report', 'state-of-agent-security-2026.html'), 'utf8');
  if (/\b(?:0|5|13)\/15\b/.test(report) || /\b30\s+(?:open-source\s+)?projects\b/i.test(report) || /\b500[,.]?000\+?\s+stars\b/i.test(report)) {
    failures.push('Security report contains a retired unsupported benchmark claim');
  }
  if (!/benchmark/i.test(report) || !/publisher conflict/i.test(report)) {
    failures.push('Security report must disclose its non-benchmark and publisher-conflict boundaries');
  }

  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const failures = await validateSeoAeo();
  if (failures.length) {
    console.error('\nSEO/AEO integrity check failed:');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
  } else {
    console.log('SEO/AEO integrity check passed.');
  }
}
