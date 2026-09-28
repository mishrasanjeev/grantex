/**
 * Revocation feed metrics (PRD G-6, section 10). Low cardinality: an outcome
 * label on polls and a source label on deliveries.
 */
import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from '../metrics.js';

/**
 * Commit to delivery: how long after a revocation was written it reached the
 * clients watching the feed. The other half of the propagation budget — the
 * event arriving to the revocation committing — is measured where the
 * revocation happens.
 */
export const revocationFeedDeliverySeconds = new Histogram({
  name: 'grantex_revocation_feed_delivery_seconds',
  help: 'Seconds between a revocation being recorded and the feed delivering it',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const revocationFeedPollsTotal = new Counter({
  name: 'grantex_revocation_feed_polls_total',
  help: 'Revocation feed polls by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const revocationFeedEntriesTotal = new Counter({
  name: 'grantex_revocation_feed_entries_total',
  help: 'Revocation feed entries delivered to subscribers, by action',
  labelNames: ['action'] as const,
  registers: [registry],
});

export const revocationFeedSubscribers = new Gauge({
  name: 'grantex_revocation_feed_subscribers',
  help: 'Live revocation feed streams on this instance',
  registers: [registry],
});

export const revocationFeedStaleSeconds = new Gauge({
  name: 'grantex_revocation_feed_stale_seconds',
  help: 'Seconds since the revocation feed last read the database successfully',
  registers: [registry],
});

/** Feed entries removed by the prune worker (FINDINGS G-66). */
export const revocationFeedPrunedTotal = new Counter({
  name: 'grantex_revocation_feed_pruned_total',
  help: 'Revocation feed entries deleted by the prune worker after their retention',
  registers: [registry],
});

/**
 * Prune runs by outcome: complete (nothing left past retention), capped (hit
 * the per-run limit; the next run continues), skipped_locked (another instance
 * was pruning), failed.
 */
export const revocationFeedPruneRunsTotal = new Counter({
  name: 'grantex_revocation_feed_prune_runs_total',
  help: 'Revocation feed prune runs by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
