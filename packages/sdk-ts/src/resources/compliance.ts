import type { HttpClient } from '../http.js';
import type {
  ComplianceAuditExport,
  ComplianceExportAuditParams,
  ComplianceExportGrantsParams,
  ComplianceGrantsExport,
  ComplianceSummary,
  EvidencePack,
  EvidencePackParams,
} from '../types.js';

export class ComplianceClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Get an org-wide compliance summary (agents, grants, audit, policies, plan). */
  getSummary(params?: { since?: string; until?: string }): Promise<ComplianceSummary> {
    const query = buildQuery(params);
    const path = query ? `/v1/compliance/summary?${query}` : '/v1/compliance/summary';
    return this.#http.get<ComplianceSummary>(path);
  }

  /** Export all grants (optionally filtered). */
  exportGrants(params?: ComplianceExportGrantsParams): Promise<ComplianceGrantsExport> {
    const query = buildQuery(params);
    const path = query
      ? `/v1/compliance/export/grants?${query}`
      : '/v1/compliance/export/grants';
    return this.#http.get<ComplianceGrantsExport>(path);
  }

  /** Export all audit entries (optionally filtered). */
  exportAudit(params?: ComplianceExportAuditParams): Promise<ComplianceAuditExport> {
    const query = buildQuery(params);
    const path = query
      ? `/v1/compliance/export/audit?${query}`
      : '/v1/compliance/export/audit';
    return this.#http.get<ComplianceAuditExport>(path);
  }

  /** Generate a full SOC2/GDPR evidence pack with chain integrity verification. */
  evidencePack(params?: EvidencePackParams): Promise<EvidencePack> {
    const query = buildQuery(params);
    const path = query
      ? `/v1/compliance/evidence-pack?${query}`
      : '/v1/compliance/evidence-pack';
    return this.#http.get<EvidencePack>(path);
  }
}

function buildQuery(params?: object): string {
  if (!params) return '';
  const entries = (Object.entries(params) as Array<[string, unknown]>).filter(
    ([, v]) => v !== undefined && v !== null,
  ) as Array<[string, string]>;
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
