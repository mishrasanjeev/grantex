/**
 * Revocation metrics (PRD G-6, section 10). Low cardinality: the action, the
 * cause that triggered it, and the propagation stage being timed.
 */
import { Counter, Histogram } from 'prom-client';
import { registry } from '../metrics.js';

export const grantRevocationsTotal = new Counter({
  name: 'grantex_grant_revocations_total',
  help: 'Grants revoked, suspended or resumed, counted per grant, by cause',
  labelNames: ['action', 'cause'] as const,
  registers: [registry],
});

/**
 * How long a revocation takes to propagate, in stages:
 * - `event_to_commit`: a verified event arriving to the revocation committed;
 * - `commit_to_feed`: commit to the revocation feed delivering it to subscribers.
 */
export const revocationPropagationSeconds = new Histogram({
  name: 'grantex_revocation_propagation_seconds',
  help: 'Revocation propagation latency by stage',
  labelNames: ['stage'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const emergencyStopsTotal = new Counter({
  name: 'grantex_emergency_stops_total',
  help: 'Emergency stops by scope and outcome (applied, dry_run, refused)',
  labelNames: ['scope', 'outcome'] as const,
  registers: [registry],
});

/** Lockouts placed, reaffirmed by a later stop, and lifted, by scope type. */
export const issuanceFreezeChangesTotal = new Counter({
  name: 'grantex_issuance_freeze_changes_total',
  help: 'Issuance freezes placed, reaffirmed and lifted, by scope type',
  labelNames: ['action', 'scope'] as const,
  registers: [registry],
});

/**
 * Issuance refused by a lockout: `frozen` when a freeze covers the request,
 * `freeze_state_unavailable` when the freeze state could not be read and the
 * path failed closed. `path` is one of a fixed set of issuance routes.
 */
export const issuanceRefusalsTotal = new Counter({
  name: 'grantex_issuance_refusals_total',
  help: 'Grant and token issuance refused by an emergency stop lockout, by path and reason',
  labelNames: ['path', 'reason'] as const,
  registers: [registry],
});
