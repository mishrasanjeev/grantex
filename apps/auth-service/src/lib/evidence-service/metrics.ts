/**
 * Evidence metrics and the chain-verification failure alert hook (PRD G-5,
 * section 10). Labels are low cardinality: outcome, record type, check source
 * and a fixed set of verification codes.
 */
import { Counter, Histogram } from 'prom-client';
import { logger, type AppLogger } from '../logger.js';
import { registry } from '../metrics.js';

export const evidenceExportDuration = new Histogram({
  name: 'grantex_evidence_export_duration_seconds',
  help: 'Evidence package export duration in seconds',
  labelNames: ['outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10],
  registers: [registry],
});

export const evidenceRecordsTotal = new Counter({
  name: 'grantex_evidence_records_total',
  help: 'Evidence records accepted or rejected',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const evidenceChainVerificationFailuresTotal = new Counter({
  name: 'grantex_evidence_chain_verification_failures_total',
  help: 'Evidence chain verification failures (source audit entries or assembled packages)',
  labelNames: ['source', 'code'] as const,
  registers: [registry],
});

export type ChainFailureSource = 'source_audit' | 'package';

export interface ChainVerificationFailure {
  source: ChainFailureSource;
  code: string;
  developerId: string;
  caseId: string;
  auditEntryId?: string;
  fieldPath?: string | null;
}

type AlertHook = (failure: ChainVerificationFailure) => void;
const hooks = new Set<AlertHook>();

/** Register an extra alert sink (paging, incident webhook). Returns an unregister function. */
export function onChainVerificationFailure(hook: AlertHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/**
 * Count, log and fan out a chain-verification failure. The structured log line
 * carries `alert: "evidence_chain_verification_failure"` for log-based alerting;
 * the Prometheus rule in deploy/prometheus/evidence-alerts.yml alerts on the counter.
 * Hook errors are logged and never mask the failure.
 */
export function reportChainVerificationFailure(failure: ChainVerificationFailure, log: AppLogger = logger): void {
  evidenceChainVerificationFailuresTotal.inc({ source: failure.source, code: failure.code });
  log.error({ alert: 'evidence_chain_verification_failure', ...failure }, 'evidence chain verification failed');
  for (const hook of hooks) {
    try {
      hook(failure);
    } catch (err) {
      log.error({ err, alert: 'evidence_chain_verification_failure' }, 'evidence alert hook failed');
    }
  }
}
