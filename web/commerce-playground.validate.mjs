import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const currentDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(currentDir, 'commerce-playground.html'), 'utf8');
const repoRoot = join(currentDir, '..');
const catalogSource = readFileSync(join(repoRoot, 'apps', 'auth-service', 'src', 'lib', 'commerce', 'catalog.ts'), 'utf8');
const lt = String.fromCharCode(60);
const gt = String.fromCharCode(62);
const slash = String.fromCharCode(47);
const scriptTag = ['s', 'c', 'r', 'i', 'p', 't'].join('');
const scriptOpen = `${lt}${scriptTag}${gt}`;
const scriptClose = `${lt}${slash}${scriptTag}${gt}`;
const manifestOpen = `${lt}${scriptTag} type="application/json" id="commerce-playground-manifest"${gt}`;

function extractStaticBlock(source, openMarker, closeMarker, label, fromIndex = 0) {
  const openIndex = source.indexOf(openMarker, fromIndex);
  assert.notEqual(openIndex, -1, `${label} open marker is present`);
  const contentStart = openIndex + openMarker.length;
  const closeIndex = source.indexOf(closeMarker, contentStart);
  assert.notEqual(closeIndex, -1, `${label} close marker is present`);
  return {
    content: source.slice(contentStart, closeIndex),
    endIndex: closeIndex + closeMarker.length,
  };
}

const manifestBlock = extractStaticBlock(
  html,
  manifestOpen,
  scriptClose,
  'commerce playground manifest',
);
assert.ok(manifestBlock.content.trim().length > 0, 'commerce playground manifest is present');

const manifest = JSON.parse(manifestBlock.content);
const expectedTools = [
  'merchant.get_profile',
  'catalog.search',
  'catalog.get_item',
  'inventory.check',
  'cart.create',
  'checkout.create',
  'payment.create_intent',
  'payment.get_status',
];
const serverToolsMatch = catalogSource.match(/export const V1_COMMERCE_TOOLS = \[([\s\S]*?)\] as const;/);
assert.ok(serverToolsMatch, 'server V1_COMMERCE_TOOLS export is present');
const serverTools = [...serverToolsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);

assert.deepEqual(manifest.tools, expectedTools, 'playground tool list matches Commerce V1 tools');
assert.deepEqual(manifest.tools, serverTools, 'playground tool list matches auth-service V1 tool export');
assert.deepEqual(
  Object.keys(manifest.request_examples),
  expectedTools,
  'request examples cover each Commerce V1 tool in order',
);

for (const tool of expectedTools) {
  assert.equal(typeof manifest.request_examples[tool], 'object', `${tool} has an object request example`);
}

assert.ok(html.includes("sendJsonRpc('initialize'"), 'initialize request path is wired');
assert.ok(html.includes("sendJsonRpc('tools/list'"), 'tools/list request path is wired');
assert.ok(html.includes("sendJsonRpc('tools/call'"), 'tools/call request path is wired');
assert.ok(html.includes('/.well-known/grantex-commerce'), 'well-known profile request is wired');
assert.ok(html.includes('Live payment mode unavailable'), 'live payment mode is visibly blocked');
assert.ok(html.includes('Plural provider blocked until configured'), 'Plural provider blocked state is visible');
assert.ok(html.includes('Tokens and passports stay in memory'), 'secret handling note is present');
assert.equal(html.includes('sessionStorage'), false, 'playground does not use sessionStorage');

const storageKeys = [...html.matchAll(/localStorage\.(?:setItem|getItem)\('([^']+)'/g)]
  .map((match) => match[1]);
assert.deepEqual(
  [...new Set(storageKeys)].sort(),
  [
    'grantex-commerce-playground-api-base',
    'grantex-commerce-playground-merchant-id',
  ],
  'localStorage is limited to non-secret connection settings',
);

const browserScript = extractStaticBlock(html, scriptOpen, scriptClose, 'playground browser script', manifestBlock.endIndex);
assert.ok(browserScript.content.trim().length > 0, 'playground browser script is present');
assert.equal(html.indexOf(scriptOpen, browserScript.endIndex), -1, 'playground has one runnable browser script');
new Function(browserScript.content);

assert.equal(/[^\u0000-\u007F]/.test(html), false, 'playground HTML stays ASCII-only');
assert.equal(
  /\b(UCP|ACP|AP2|MPP|A2A)\b|certif/i.test(html),
  false,
  'playground does not claim external protocol certification',
);
assert.equal(
  /(sk_live|pk_live|grtx_live|BEGIN PRIVATE KEY|provider_secret|plural_secret)/i.test(html),
  false,
  'playground does not contain hardcoded production credentials or secret material',
);

console.log('commerce-playground static validation passed');
