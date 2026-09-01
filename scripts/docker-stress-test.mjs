#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

function arg(name, fallback = undefined) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function requireLocalOrigin(value) {
  const parsed = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (parsed.protocol !== 'http:' || !localHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error('Refusing to run stress tests against a non-local HTTP endpoint');
  }
  return parsed.origin;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

async function timedRequest(url, options, timeoutMs = 10_000) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    await response.arrayBuffer();
    return { status: response.status, elapsedMs: performance.now() - started };
  } catch (error) {
    return {
      status: controller.signal.aborted ? 'timeout' : 'network_error',
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(input) {
  const targetDurationMs = input.durationMs;
  const target = targetDurationMs === undefined
    ? `${input.requests} requests`
    : `${round(targetDurationMs / 1_000)} seconds`;
  process.stderr.write(`[stress] ${input.name}: ${target} at concurrency ${input.concurrency}\n`);
  let next = 0;
  let completed = 0;
  let unexpected = 0;
  let serverErrors = 0;
  let networkErrors = 0;
  const latencies = [];
  const statusCounts = {};
  const started = performance.now();
  const deadline = targetDurationMs === undefined ? null : started + targetDurationMs;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (deadline === null ? index >= input.requests : performance.now() >= deadline) return;
      const result = await timedRequest(
        `${baseUrl}${input.path(index)}`,
        input.options(index),
        input.timeoutMs,
      );
      completed += 1;
      latencies.push(result.elapsedMs);
      const key = String(result.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
      if (!input.acceptedStatuses.has(result.status)) unexpected += 1;
      if (typeof result.status === 'number' && result.status >= 500) serverErrors += 1;
      if (result.status === 'network_error' || result.status === 'timeout') networkErrors += 1;
    }
  };
  await Promise.all(Array.from({ length: input.concurrency }, worker));
  const elapsedMs = performance.now() - started;
  const rps = completed / (elapsedMs / 1000);
  const p95Ms = percentile(latencies, 0.95);
  const passed = unexpected === 0
    && serverErrors === 0
    && (input.allowNetworkErrors === true || networkErrors === 0)
    && (input.p95TargetMs === undefined || (p95Ms !== null && p95Ms <= input.p95TargetMs))
    && (input.minimumRps === undefined || rps >= input.minimumRps)
    && (input.validate === undefined || input.validate(statusCounts));
  return {
    name: input.name,
    requests: completed,
    concurrency: input.concurrency,
    requested_duration_seconds: targetDurationMs === undefined ? null : round(targetDurationMs / 1_000),
    duration_ms: round(elapsedMs),
    requests_per_second: round(rps),
    p50_ms: round(percentile(latencies, 0.5)),
    p95_ms: round(p95Ms),
    p99_ms: round(percentile(latencies, 0.99)),
    max_ms: round(percentile(latencies, 1)),
    status_counts: statusCounts,
    unexpected_statuses: unexpected,
    server_errors: serverErrors,
    network_errors: networkErrors,
    allowed_network_errors: input.allowNetworkErrors === true,
    p95_target_ms: input.p95TargetMs ?? null,
    minimum_rps: input.minimumRps ?? null,
    passed,
  };
}

async function scrapeMetrics() {
  const headers = metricsKey ? { authorization: `Bearer ${metricsKey}` } : {};
  const response = await fetch(`${baseUrl}/metrics`, { headers });
  if (!response.ok) throw new Error(`Metrics scrape failed with HTTP ${response.status}`);
  return response.text();
}

function httpHistogramSeries(metrics) {
  return metrics.split(/\r?\n/)
    .filter((line) => line.startsWith('grantex_http_request_duration_seconds_count{'));
}

function dockerStats(container) {
  if (!container) return null;
  try {
    const output = execFileSync(
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}', container],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    return output ? JSON.parse(output) : null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Pin the Docker-published IPv4 socket. On Windows with WSL enabled,
// `localhost` can resolve to an unrelated ::1 relay before Docker's listener.
const baseUrl = requireLocalOrigin(arg('--base-url', process.env.STRESS_BASE_URL ?? 'http://127.0.0.1:3001'));
const apiKey = arg('--api-key', process.env.STRESS_API_KEY ?? 'dev-api-key-local');
const metricsKey = arg('--metrics-key', process.env.STRESS_METRICS_API_KEY ?? 'local-metrics-api-key');
const reportPath = arg('--report');
const container = arg('--container');
const soakSeconds = Number(arg('--soak-seconds', '15'));
const allowThresholdFail = process.argv.includes('--allow-threshold-fail');
const auth = { authorization: `Bearer ${apiKey}` };

const healthProbe = await fetch(`${baseUrl}/health`);
if (healthProbe.status !== 200) {
  throw new Error(`Local auth-service is not healthy: HTTP ${healthProbe.status}`);
}
await healthProbe.arrayBuffer();

// Warm pools and JIT paths before collecting latency percentiles.
await runScenario({
  name: 'warmup',
  requests: 50,
  concurrency: 10,
  path: () => '/.well-known/jwks.json',
  options: () => ({}),
  acceptedStatuses: new Set([200]),
});

const resourceBefore = dockerStats(container);
const scenarios = [];

const metricsBefore = await scrapeMetrics();
const seriesBefore = httpHistogramSeries(metricsBefore);
scenarios.push(await runScenario({
  name: 'unmatched_route_cardinality_attack',
  requests: 1_200,
  concurrency: 80,
  path: (index) => `/stress/missing/${index}`,
  options: () => ({}),
  acceptedStatuses: new Set([401]),
  p95TargetMs: 300,
  minimumRps: 500,
}));
const metricsAfterCardinality = await scrapeMetrics();
const seriesAfter = httpHistogramSeries(metricsAfterCardinality);
const cardinality = {
  series_before: seriesBefore.length,
  series_after: seriesAfter.length,
  series_delta: seriesAfter.length - seriesBefore.length,
  metrics_bytes_before: Buffer.byteLength(metricsBefore),
  metrics_bytes_after: Buffer.byteLength(metricsAfterCardinality),
  passed: seriesAfter.length - seriesBefore.length <= 3,
};

scenarios.push(await runScenario({
  name: 'readiness_dependency_pressure',
  requests: 1_500,
  concurrency: 50,
  path: () => '/health',
  options: () => ({}),
  acceptedStatuses: new Set([200]),
  p95TargetMs: 250,
  minimumRps: 300,
}));

scenarios.push(await runScenario({
  name: 'invalid_api_key_database_pressure',
  requests: 1_000,
  concurrency: 50,
  path: () => '/v1/me',
  options: (index) => ({ headers: { authorization: `Bearer invalid-stress-key-${String(index).padStart(8, '0')}` } }),
  acceptedStatuses: new Set([401]),
  p95TargetMs: 300,
  minimumRps: 300,
}));

scenarios.push(await runScenario({
  name: 'jwks_public_key_distribution',
  requests: 5_000,
  concurrency: 100,
  path: () => '/.well-known/jwks.json',
  options: () => ({}),
  acceptedStatuses: new Set([200]),
  p95TargetMs: 200,
  minimumRps: 1_000,
}));

scenarios.push(await runScenario({
  name: 'authenticated_database_and_redis_path',
  requests: 80,
  concurrency: 20,
  path: () => '/v1/me',
  options: () => ({ headers: auth }),
  acceptedStatuses: new Set([200]),
  p95TargetMs: 250,
  minimumRps: 75,
}));

scenarios.push(await runScenario({
  name: 'authenticated_plan_limit_burst',
  requests: 80,
  concurrency: 20,
  path: () => '/v1/me',
  options: () => ({ headers: auth }),
  acceptedStatuses: new Set([200, 429]),
  p95TargetMs: 250,
  validate: (counts) => (counts['429'] ?? 0) > 0,
}));

const oversizedPayload = JSON.stringify({ name: 'x'.repeat(1_050_000) });
scenarios.push(await runScenario({
  name: 'oversized_body_protection',
  requests: 25,
  concurrency: 10,
  path: () => '/v1/signup',
  options: () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: oversizedPayload,
  }),
  acceptedStatuses: new Set([413, 'network_error']),
  // Fastify may reset the upload socket after detecting Content-Length above
  // bodyLimit, before the client finishes transmitting. A 413 response or an
  // early reset both demonstrate bounded server-side body handling.
  allowNetworkErrors: true,
  p95TargetMs: 500,
  validate: (counts) => (counts['413'] ?? 0) > 0,
}));

if (!Number.isFinite(soakSeconds) || soakSeconds < 1 || soakSeconds > 300) {
  throw new Error('--soak-seconds must be between 1 and 300');
}
scenarios.push(await runScenario({
  name: 'jwks_sustained_soak',
  durationMs: soakSeconds * 1_000,
  concurrency: 75,
  path: () => '/.well-known/jwks.json',
  options: () => ({}),
  acceptedStatuses: new Set([200]),
  p95TargetMs: 200,
  minimumRps: 1_000,
}));

scenarios.push(await runScenario({
  name: 'post_pressure_recovery',
  requests: 100,
  concurrency: 10,
  path: () => '/health',
  options: () => ({}),
  acceptedStatuses: new Set([200]),
  p95TargetMs: 150,
  minimumRps: 150,
}));

const resourceAfter = dockerStats(container);
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  local_only: true,
  base_url: baseUrl,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  resources: { before: resourceBefore, after: resourceAfter },
  cardinality,
  scenarios,
  passed: cardinality.passed && scenarios.every((scenario) => scenario.passed),
};

const output = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  const absolute = resolve(reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, output, 'utf8');
}
process.stdout.write(output);
if (!report.passed && !allowThresholdFail) process.exitCode = 1;
