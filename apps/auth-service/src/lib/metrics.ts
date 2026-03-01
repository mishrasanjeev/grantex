import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { config } from '../config.js';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'grantex-auth-service' });

if (config.metricsEnabled) {
  collectDefaultMetrics({ register: registry });
}

// ── Counters ──────────────────────────────────────────────────────────────────

export const tokenExchangeTotal = new Counter({
  name: 'grantex_token_exchange_total',
  help: 'Total token exchange attempts',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const authorizeTotal = new Counter({
  name: 'grantex_authorize_total',
  help: 'Total authorization requests',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const grantsRevokedTotal = new Counter({
  name: 'grantex_grants_revoked_total',
  help: 'Total grants revoked',
  registers: [registry],
});

export const webhookDeliveriesTotal = new Counter({
  name: 'grantex_webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const anomaliesDetectedTotal = new Counter({
  name: 'grantex_anomalies_detected_total',
  help: 'Total anomalies detected',
  labelNames: ['type', 'severity'] as const,
  registers: [registry],
});

// ── Histograms ────────────────────────────────────────────────────────────────

export const authorizeDuration = new Histogram({
  name: 'grantex_authorize_duration_seconds',
  help: 'Authorization request duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const tokenExchangeDuration = new Histogram({
  name: 'grantex_token_exchange_duration_seconds',
  help: 'Token exchange duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// ── Gauges ────────────────────────────────────────────────────────────────────

export const activeGrants = new Gauge({
  name: 'grantex_active_grants',
  help: 'Current number of active grants',
  registers: [registry],
});

export const anomaliesUnacknowledged = new Gauge({
  name: 'grantex_anomalies_unacknowledged',
  help: 'Current number of unacknowledged anomalies',
  registers: [registry],
});
