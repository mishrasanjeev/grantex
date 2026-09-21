/**
 * Event bridge metrics (PRD G-6, section 10). Labels are low cardinality:
 * the source type (`ssf`, `webhook`, or `unknown` before a source is found)
 * and a fixed set of verification failure reasons.
 */
import { Counter } from 'prom-client';
import { logger, type AppLogger } from '../logger.js';
import { registry } from '../metrics.js';
import type { EventVerificationReason } from './errors.js';

export type SourceType = 'ssf' | 'webhook' | 'unknown';

export const eventBridgeEventsReceivedTotal = new Counter({
  name: 'grantex_event_bridge_events_received_total',
  help: 'Event bridge deliveries received, before verification',
  labelNames: ['source_type'] as const,
  registers: [registry],
});

export const eventBridgeEventsVerifiedTotal = new Counter({
  name: 'grantex_event_bridge_events_verified_total',
  help: 'Event bridge deliveries whose signature and claims verified',
  labelNames: ['source_type'] as const,
  registers: [registry],
});

export const eventBridgeVerificationFailuresTotal = new Counter({
  name: 'grantex_event_bridge_verification_failures_total',
  help: 'Event bridge deliveries rejected as unverifiable (never acted on)',
  labelNames: ['source_type', 'reason'] as const,
  registers: [registry],
});

export const eventBridgeEventsUnmappedTotal = new Counter({
  name: 'grantex_event_bridge_events_unmapped_total',
  help: 'Verified events that matched no mapping rule and were ignored',
  labelNames: ['source_type'] as const,
  registers: [registry],
});

export const eventBridgeEventsDuplicateTotal = new Counter({
  name: 'grantex_event_bridge_events_duplicate_total',
  help: 'Verified deliveries of an event id already received (not acted on again)',
  labelNames: ['source_type'] as const,
  registers: [registry],
});

export const eventBridgeRuleMatchesTotal = new Counter({
  name: 'grantex_event_bridge_rule_matches_total',
  help: 'Mapping rules matched by a verified event',
  labelNames: ['action', 'mode'] as const,
  registers: [registry],
});

export const eventBridgeActionsTotal = new Counter({
  name: 'grantex_event_bridge_actions_total',
  help: 'Outcome of each matched mapping rule',
  labelNames: ['action', 'outcome'] as const,
  registers: [registry],
});

export interface VerificationFailure {
  sourceType: SourceType;
  reason: EventVerificationReason;
  sourceId: string;
  developerId?: string;
}

/**
 * Count and log an unverifiable delivery. The log line carries
 * `alert: "event_bridge_verification_failure"` for log-based alerting; the
 * Prometheus rules in deploy/prometheus/event-bridge-alerts.yml alert on the
 * counter. Never logs the payload or any signature material.
 */
export function reportVerificationFailure(failure: VerificationFailure, log: AppLogger = logger): void {
  eventBridgeVerificationFailuresTotal.inc({ source_type: failure.sourceType, reason: failure.reason });
  log.warn({ alert: 'event_bridge_verification_failure', ...failure }, 'event bridge delivery rejected');
}
