// SPDX-License-Identifier: Apache-2.0
/**
 * Status-list reconciliation metrics (lib/registry/status-reconciliation.ts).
 * Low cardinality: no issuer, list, attestation or grant appears in a label;
 * every label takes one of a fixed, small set of values. The Prometheus
 * rules in deploy/prometheus/registry-status-alerts.yml alert on them.
 */
import { Counter, Gauge } from 'prom-client';
import { registry } from '../metrics.js';

/** One count per list fetched: `ok` read and recorded, `failed` not readable. */
export const registryStatusListPollsTotal = new Counter({
  name: 'grantex_registry_status_list_polls_total',
  help: 'Issuer status list polls by outcome (ok, failed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Why a poll failed: the fetch reasons of lib/registry/issuer-fetcher.ts
 * (unreachable, http_status, content_type, too_large, dev_map_refused),
 * `invalid` for a list that was fetched but did not verify or decode,
 * `not_under_base` and `issuer_unknown`.
 */
export const registryStatusListPollFailuresTotal = new Counter({
  name: 'grantex_registry_status_list_poll_failures_total',
  help: 'Issuer status list polls that could not be read, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** An attestation's recorded issuer status changed on a poll, by the new status. */
export const registryStatusFlipsTotal = new Counter({
  name: 'grantex_registry_status_flips_total',
  help: 'Attestation issuer status changes seen on issuer status lists, by new status',
  labelNames: ['to'] as const,
  registers: [registry],
});

/**
 * The registry's acceptance entry changed, by new status and cause:
 * `issuer_status` (the issuer's list), `issuer` (the issuer suspended,
 * withdrawn or reinstated), `key_revoked` (the signing key was revoked).
 */
export const registryAcceptanceChangesTotal = new Counter({
  name: 'grantex_registry_acceptance_changes_total',
  help: 'Registry acceptance entry changes made by reconciliation, by new status and cause',
  labelNames: ['to', 'cause'] as const,
  registers: [registry],
});

/** Bound grants (roots and their descendants) acted on by the cascade. */
export const registryCascadeGrantsTotal = new Counter({
  name: 'grantex_registry_cascade_grants_total',
  help: 'Grants revoked, suspended or resumed by the registry status cascade',
  labelNames: ['action'] as const,
  registers: [registry],
});

/** One count per reconciliation run: complete, skipped_locked, failed or disabled. */
export const registryReconcileRunsTotal = new Counter({
  name: 'grantex_registry_status_reconcile_runs_total',
  help: 'Registry status reconciliation runs by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** A step that threw: poll, decide or cascade. The next run tries again. */
export const registryReconcileFailuresTotal = new Counter({
  name: 'grantex_registry_status_reconcile_failures_total',
  help: 'Registry status reconciliation steps that failed, by step',
  labelNames: ['step'] as const,
  registers: [registry],
});

/**
 * How late the most overdue list was when the run started, in seconds (0
 * when none was overdue). Reset to 0 on an instance that did not hold the
 * lock, so `max()` over instances is the lock holder's value.
 */
export const registryStatusPollLagSeconds = new Gauge({
  name: 'grantex_registry_status_poll_lag_seconds',
  help: 'Lag of the most overdue issuer status list poll at the start of the latest run',
  registers: [registry],
});

/**
 * Issuer status lists whose last good read has run out: every accepted
 * attestation on them has stopped counting, and bound grants refuse to
 * refresh with status_stale until a read succeeds. Reset to 0 like the lag.
 */
export const registryStatusListsStale = new Gauge({
  name: 'grantex_registry_status_lists_stale',
  help: 'Issuer status lists that could not be read before their last read went stale',
  registers: [registry],
});
