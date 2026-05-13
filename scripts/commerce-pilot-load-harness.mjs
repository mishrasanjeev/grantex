#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const targets = [
  {
    key: 'payment_intent_create',
    method: 'POST',
    path: '/v1/commerce/payments/intents',
    rate_per_second: 10,
    duration_seconds: 10,
    p95_target_ms: 500,
    excludes: 'provider latency',
  },
  {
    key: 'catalog_search',
    method: 'POST',
    path: '/v1/commerce/catalog/search',
    rate_per_second: 50,
    duration_seconds: 10,
    p95_target_ms: 300,
    excludes: 'none',
  },
  {
    key: 'mock_provider_webhook',
    method: 'POST',
    path: '/v1/webhooks/providers/mock',
    rate_per_second: 5,
    duration_seconds: 10,
    p95_target_ms: 500,
    excludes: 'provider verification latency',
  },
];

function arg(name, fallback = undefined) {
  const eqPrefix = `${name}=`;
  const eqFound = process.argv.find((item) => item.startsWith(eqPrefix));
  if (eqFound) return eqFound.slice(eqPrefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function boolArg(name) {
  return process.argv.includes(name);
}

function isLocalBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function requireLocalBaseUrl(value) {
  if (!isLocalBaseUrl(value)) {
    throw new Error('Refusing to run commerce pilot load harness against a non-local API base URL');
  }
  return new URL(value).origin;
}

function parseCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadEnvFile(path) {
  if (!path) return {};
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (out.COMMERCE_LOAD_API_BASE) {
    out.COMMERCE_LOAD_API_BASE = requireLocalBaseUrl(out.COMMERCE_LOAD_API_BASE);
  }
  return out;
}

function envValue(envFileValues, name, fallback = '') {
  return process.env[name] ?? envFileValues[name] ?? fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function max(values) {
  if (values.length === 0) return null;
  return Math.round(Math.max(...values) * 100) / 100;
}

function statusCodeCounts(results) {
  const out = {};
  for (const result of results) {
    const key = String(result.status);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function safeErrorCounts(results) {
  const out = {};
  for (const result of results) {
    const code = result.error_code;
    if (code) out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

async function timedFetch(baseUrl, path, options) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, options);
  } catch (err) {
    const elapsed = performance.now() - started;
    return {
      ok: false,
      status: 'network_error',
      elapsed,
      error_code: 'network_error',
      error_message: err instanceof Error ? err.message : 'network error',
      json: null,
    };
  }
  const elapsed = performance.now() - started;
  const bodyText = await res.text().catch(() => '');
  let json = null;
  if (bodyText.length > 0) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
  }
  const error = json && typeof json === 'object' && 'error' in json
    ? json.error
    : null;
  const errorCode = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : null;
  const errorMessage = error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : null;
  return {
    ok: res.ok,
    status: res.status,
    elapsed,
    error_code: errorCode,
    error_message: errorMessage,
    json,
  };
}

function mockWebhookHeaders(payload, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${raw}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-mock-timestamp': String(timestampSeconds),
    'x-mock-signature': `sha256=${signature}`,
  };
}

function dryRunReport() {
  return {
    mode: 'dry-run',
    local_only: true,
    targets,
    result_schema: {
      request_count: 'number',
      success_count: 'number',
      error_count: 'number',
      p50_ms: 'number|null',
      p95_ms: 'number|null',
      max_ms: 'number|null',
      passed: 'boolean',
      duplicate_payment_transition_count: 'number for mock_provider_webhook',
    },
    status: 'not_executed',
    blocker: 'Run mode requires a local auth-service, local auth, seeded sandbox merchant/cart/payment data, and mock provider inputs.',
    seed_command: 'node scripts/commerce-pilot-seed-local.mjs --run --migrate --env-output=.tmp/commerce-pilot-load.env',
    measured_command: 'node scripts/commerce-pilot-load-harness.mjs --run --env-file=.tmp/commerce-pilot-load.env --report=docs/reports/commerce-v1-local-pilot-load.md',
    not_ready_if: [
      'api_base_is_not_localhost',
      'production_or_live_payment_credentials_are_required',
      'mock_provider_inputs_are_missing',
      'p95_target_fails',
      'duplicate_payment_transition_detected',
    ],
  };
}

function authHeaders(context) {
  return context.authToken
    ? { authorization: context.authToken.startsWith('Bearer ') ? context.authToken : `Bearer ${context.authToken}` }
    : {};
}

function paymentIntentRequest(target, context, index) {
  return {
    path: target.path,
    options: {
      method: target.method,
      headers: {
        'content-type': 'application/json',
        ...authHeaders(context),
        'idempotency-key': `pilot-load-${randomUUID()}`,
      },
      body: JSON.stringify({
        merchant_id: context.merchantId,
        agent_id: context.agentId,
        cart_id: context.cartIds[index],
        passport_jwt: context.checkoutPassport,
        amount_minor_units: context.amountMinorUnits,
        currency: context.currency,
        provider_key: 'mock',
      }),
    },
  };
}

function catalogSearchRequest(target, context) {
  return {
    path: target.path,
    options: {
      method: target.method,
      headers: { 'content-type': 'application/json', ...authHeaders(context) },
      body: JSON.stringify({ merchant_id: context.merchantId, query: context.catalogQuery, limit: 10 }),
    },
  };
}

function webhookRequest(target, context, providerPaymentId, eventId = `evt_pilot_${randomUUID()}`) {
  const payload = {
    event_id: eventId,
    event_type: 'payment.updated',
    merchant_ref: context.merchantId,
    provider_payment_id: providerPaymentId,
    status: 'paid',
  };
  return {
    path: target.path,
    options: {
      method: target.method,
      headers: mockWebhookHeaders(payload, context.mockWebhookSecret),
      body: JSON.stringify(payload),
    },
    eventId,
    providerPaymentId,
  };
}

function buildRequest(target, context, index) {
  if (target.key === 'catalog_search') return catalogSearchRequest(target, context);
  if (target.key === 'payment_intent_create') return paymentIntentRequest(target, context, index);
  if (target.key === 'mock_provider_webhook') {
    return webhookRequest(target, context, context.providerPaymentIds[index + 1]);
  }
  throw new Error(`Unsupported target: ${target.key}`);
}

async function runScheduledRequests(baseUrl, target, context, requestCount, offset = 0) {
  const results = [];
  const intervalMs = 1000 / target.rate_per_second;
  const started = performance.now();
  const pending = [];
  for (let i = 0; i < requestCount; i += 1) {
    const plannedAt = started + i * intervalMs;
    const delay = plannedAt - performance.now();
    if (delay > 0) await sleep(delay);
    const req = buildRequest(target, context, i + offset);
    pending.push(timedFetch(baseUrl, req.path, req.options));
  }
  const fetched = await Promise.all(pending);
  results.push(...fetched);
  return results;
}

function summarizeTarget(target, results, extra = {}) {
  const latencies = results.map((result) => result.elapsed);
  const successCount = results.filter((result) => result.ok).length;
  const errorCount = results.length - successCount;
  const p95 = percentile(latencies, 95);
  return {
    key: target.key,
    request_count: results.length,
    success_count: successCount,
    error_count: errorCount,
    p50_ms: percentile(latencies, 50),
    p95_ms: p95,
    max_ms: max(latencies),
    p95_target_ms: target.p95_target_ms,
    rate_per_second: target.rate_per_second,
    duration_seconds: target.duration_seconds,
    excludes: target.excludes,
    status_code_counts: statusCodeCounts(results),
    error_code_counts: safeErrorCounts(results),
    passed: errorCount === 0 && p95 !== null && p95 <= target.p95_target_ms,
    ...extra,
  };
}

function webhookTransitionEvidence(results, duplicateProbe) {
  const processedPaymentIntentIds = new Set();
  let duplicatePaymentTransitionCount = 0;
  for (const result of results) {
    const data = result.json && typeof result.json === 'object' ? result.json.data : null;
    if (!data || typeof data !== 'object') continue;
    const status = data.status;
    const paymentIntentId = data.payment_intent_id;
    if (status === 'processed' && typeof paymentIntentId === 'string') {
      if (processedPaymentIntentIds.has(paymentIntentId)) duplicatePaymentTransitionCount += 1;
      processedPaymentIntentIds.add(paymentIntentId);
    }
    if (data.reason === 'transition_already_applied' || result.error_code === 'invalid_payment_status_transition') {
      duplicatePaymentTransitionCount += 1;
    }
  }
  return {
    duplicate_payment_transition_count: duplicatePaymentTransitionCount,
    processed_payment_intent_count: processedPaymentIntentIds.size,
    duplicate_event_probe: duplicateProbe,
  };
}

async function runWebhookTarget(baseUrl, target, context) {
  const total = target.rate_per_second * target.duration_seconds;
  const duplicateProviderPaymentId = context.providerPaymentIds[0];
  const duplicateEventId = `evt_pilot_duplicate_${randomUUID()}`;
  const firstProbe = webhookRequest(target, context, duplicateProviderPaymentId, duplicateEventId);
  const firstProbeResult = await timedFetch(baseUrl, firstProbe.path, firstProbe.options);
  const secondProbe = webhookRequest(target, context, duplicateProviderPaymentId, duplicateEventId);
  const secondProbeResult = await timedFetch(baseUrl, secondProbe.path, secondProbe.options);
  const loadResults = await runScheduledRequests(baseUrl, target, context, total, 0);
  const allResults = [firstProbeResult, secondProbeResult, ...loadResults];
  const firstData = firstProbeResult.json && typeof firstProbeResult.json === 'object'
    ? firstProbeResult.json.data
    : null;
  const secondData = secondProbeResult.json && typeof secondProbeResult.json === 'object'
    ? secondProbeResult.json.data
    : null;
  const duplicateProbe = {
    event_id: duplicateEventId,
    first_status: firstData && typeof firstData === 'object' ? firstData.status ?? null : null,
    second_status: secondData && typeof secondData === 'object' ? secondData.status ?? null : null,
    passed: firstProbeResult.ok
      && secondProbeResult.ok
      && secondData
      && typeof secondData === 'object'
      && secondData.status === 'duplicate',
  };
  const evidence = webhookTransitionEvidence(allResults, duplicateProbe);
  const summary = summarizeTarget(target, allResults, evidence);
  return {
    ...summary,
    passed: summary.passed
      && evidence.duplicate_payment_transition_count === 0
      && duplicateProbe.passed === true,
  };
}

async function runTarget(baseUrl, target, context) {
  if (target.key === 'mock_provider_webhook') return runWebhookTarget(baseUrl, target, context);
  const total = target.rate_per_second * target.duration_seconds;
  const results = await runScheduledRequests(baseUrl, target, context, total);
  return summarizeTarget(target, results);
}

function selectedTargets() {
  const requested = parseCsv(arg('--targets', targets.map((target) => target.key).join(',')));
  const selected = targets.filter((target) => requested.includes(target.key));
  if (selected.length === 0) {
    throw new Error(`No valid targets selected. Valid targets: ${targets.map((target) => target.key).join(', ')}`);
  }
  return selected;
}

function buildContext(selected, envFileValues) {
  const context = {
    authToken: envValue(envFileValues, 'COMMERCE_LOAD_AUTH_TOKEN'),
    merchantId: envValue(envFileValues, 'COMMERCE_LOAD_MERCHANT_ID'),
    agentId: envValue(envFileValues, 'COMMERCE_LOAD_AGENT_ID'),
    cartIds: parseCsv(envValue(
      envFileValues,
      'COMMERCE_LOAD_CART_IDS',
      envValue(envFileValues, 'COMMERCE_LOAD_CART_ID'),
    )),
    checkoutPassport: envValue(envFileValues, 'COMMERCE_LOAD_CHECKOUT_PASSPORT'),
    amountMinorUnits: Number.parseInt(envValue(envFileValues, 'COMMERCE_LOAD_AMOUNT_MINOR_UNITS', '1000'), 10),
    currency: envValue(envFileValues, 'COMMERCE_LOAD_CURRENCY', 'INR'),
    catalogQuery: envValue(envFileValues, 'COMMERCE_LOAD_CATALOG_QUERY', 'pilot'),
    providerPaymentIds: parseCsv(
      envValue(
        envFileValues,
        'COMMERCE_LOAD_PROVIDER_PAYMENT_IDS',
        envValue(envFileValues, 'COMMERCE_LOAD_PROVIDER_PAYMENT_ID'),
      ),
    ),
    mockWebhookSecret: envValue(envFileValues, 'COMMERCE_LOAD_MOCK_WEBHOOK_SECRET', 'mock-webhook-secret'),
  };
  const missing = [];
  if (!context.authToken) missing.push('COMMERCE_LOAD_AUTH_TOKEN');
  if (!context.merchantId) missing.push('COMMERCE_LOAD_MERCHANT_ID');
  for (const target of selected) {
    const total = target.rate_per_second * target.duration_seconds;
    if (target.key === 'payment_intent_create') {
      if (!context.agentId) missing.push('COMMERCE_LOAD_AGENT_ID');
      if (!context.checkoutPassport) missing.push('COMMERCE_LOAD_CHECKOUT_PASSPORT');
      if (context.cartIds.length < total) {
        missing.push(`COMMERCE_LOAD_CART_IDS(${total}_unique_cart_ids_required)`);
      }
    }
    if (target.key === 'mock_provider_webhook' && context.providerPaymentIds.length < total + 1) {
      missing.push(`COMMERCE_LOAD_PROVIDER_PAYMENT_IDS(${total + 1}_pending_provider_payment_ids_required)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing local load harness inputs: ${[...new Set(missing)].join(', ')}`);
  }
  return context;
}

function markdownReport(report) {
  const rows = report.results.map((result) => (
    `| ${result.key} | ${result.request_count} | ${result.success_count} | ${result.error_count} | ${result.p50_ms ?? 'n/a'} | ${result.p95_ms ?? 'n/a'} | ${result.max_ms ?? 'n/a'} | ${result.p95_target_ms} | ${result.passed ? 'pass' : 'fail'} |`
  )).join('\n');
  const duplicate = report.results.find((result) => result.key === 'mock_provider_webhook');
  return `# Commerce V1 Local Pilot Load Report

Generated at: ${report.generated_at}

Mode: ${report.mode}
API base: ${report.base_url}
Local only: ${report.local_only}
Overall status: ${report.passed ? 'pass' : 'fail'}

Required Local Setup:

- Start the local stack with \`docker compose up --build -d\`.
- Seed local sandbox data with \`commerce-pilot-seed-local.mjs\`.
- Keep this run local-only with mock provider inputs and live Plural disabled.

Measured targets:

- Payment intent create: \`POST /v1/commerce/payments/intents\`.
- Catalog search: \`POST /v1/commerce/catalog/search\`.
- Mock provider webhooks: \`POST /v1/webhooks/providers/mock\`.

| Target | Requests | Success | Errors | p50 ms | p95 ms | max ms | p95 target ms | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

Duplicate webhook transition evidence:

- Duplicate webhook transition count: ${duplicate?.duplicate_payment_transition_count ?? 'n/a'}
- Duplicate payment transition count: ${duplicate?.duplicate_payment_transition_count ?? 'n/a'}
- Duplicate event probe passed: ${duplicate?.duplicate_event_probe?.passed ?? 'n/a'}

Human review of the generated report:

- Confirm all target rows pass before using this as readiness evidence.
- Confirm duplicate webhook transition count remains 0.
- Confirm this was generated against localhost and sandbox/mock inputs only.

This report must be generated only against a local auth-service using mock provider and sandbox data.
`;
}

function writeReportIfRequested(report) {
  const reportPath = arg('--report');
  if (!reportPath) return;
  const resolved = resolve(reportPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, markdownReport(report), 'utf8');
}

async function main() {
  const dryRun = boolArg('--dry-run') || !boolArg('--run');
  if (dryRun) {
    console.log(JSON.stringify(dryRunReport(), null, 2));
    return;
  }

  const envFileValues = loadEnvFile(arg('--env-file'));
  const baseUrl = requireLocalBaseUrl(arg(
    '--api-base',
    envValue(envFileValues, 'COMMERCE_LOAD_API_BASE', 'http://localhost:3001'),
  ));

  const selected = selectedTargets();
  const context = buildContext(selected, envFileValues);
  const results = [];
  for (const target of selected) {
    results.push(await runTarget(baseUrl, target, context));
  }
  const report = {
    mode: 'run',
    local_only: true,
    base_url: baseUrl,
    generated_at: new Date().toISOString(),
    targets: selected.map((target) => target.key),
    results,
    passed: results.every((result) => result.passed),
  };
  writeReportIfRequested(report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
