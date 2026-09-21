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

export const migrationsTotal = new Counter({
  name: 'grantex_migrations_total',
  help: 'Migration files handled at startup, by outcome (applied, changed, missing, repaired_index)',
  labelNames: ['outcome'] as const,
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

export const commerceCriticalFlowTotal = new Counter({
  name: 'grantex_commerce_critical_flow_total',
  help: 'Total commerce critical flow events',
  labelNames: ['flow', 'status', 'error_code'] as const,
  registers: [registry],
});

export const commerceAuditWriteFailuresTotal = new Counter({
  name: 'grantex_commerce_audit_write_failures_total',
  help: 'Total failed commerce audit writes',
  labelNames: ['event_type'] as const,
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

// ── Decision grants (PRD G-3) ─────────────────────────────────────────────────
// Labels are fixed enumerations: never ids, subjects or case identifiers.

export const decisionGrantsMintedTotal = new Counter({
  name: 'grantex_decision_grants_minted_total',
  help: 'Decision grants minted, by approvals the decision requires (1, or 2 for four eyes), approval position and dwell-time source',
  labelNames: ['approvals_required', 'position', 'dwell_source'] as const,
  registers: [registry],
});

export const decisionGrantsConsumedTotal = new Counter({
  name: 'grantex_decision_grants_consumed_total',
  help: 'Decision grants consumed (one per grant, so a four-eyes decision counts two)',
  registers: [registry],
});

export const decisionGrantsRejectedTotal = new Counter({
  name: 'grantex_decision_grants_rejected_total',
  help: 'Refused decision-grant operations, by stage (sign_in, request, approve, consume, case) and sub-reason',
  labelNames: ['stage', 'reason'] as const,
  registers: [registry],
});

export const decisionDwellSeconds = new Histogram({
  name: 'grantex_decision_dwell_seconds',
  help: 'Time an approver looked at a decision before approving it, in seconds, by dwell-time source',
  labelNames: ['dwell_source'] as const,
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});
