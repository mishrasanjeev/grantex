import { api } from './client';
import type { ComplianceSummary } from './types';

export function getComplianceSummary(): Promise<ComplianceSummary> {
  return api.get<ComplianceSummary>('/v1/compliance/summary');
}

export function exportGrants(): Promise<{ generatedAt: string; total: number; grants: unknown[] }> {
  return api.get('/v1/compliance/export/grants');
}

export function exportAudit(): Promise<{ generatedAt: string; total: number; entries: unknown[] }> {
  return api.get('/v1/compliance/export/audit');
}

export function exportEvidencePack(framework: string): Promise<Record<string, unknown>> {
  return api.get(`/v1/compliance/evidence-pack?framework=${encodeURIComponent(framework)}`);
}
