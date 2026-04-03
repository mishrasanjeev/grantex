/**
 * EU AI Act conformance report export.
 *
 * Generates a structured report covering EU AI Act articles related to
 * transparency, human oversight, data governance, and record-keeping
 * for AI systems operating under Grantex authorization.
 */

import type { ComplianceExportRequest, ComplianceExportResult } from '../types.js';
import { ExportError } from '../errors.js';

/**
 * EU AI Act articles covered by the conformance report.
 */
export const EU_AI_ACT_ARTICLES = [
  { article: '9', title: 'Risk Management System', description: 'Risk identification and mitigation for high-risk AI systems' },
  { article: '10', title: 'Data and Data Governance', description: 'Training, validation, and testing data quality requirements' },
  { article: '11', title: 'Technical Documentation', description: 'Documentation of AI system design and development' },
  { article: '12', title: 'Record-keeping', description: 'Automatic recording of events (logs) for traceability' },
  { article: '13', title: 'Transparency', description: 'Information provision to deployers and users' },
  { article: '14', title: 'Human Oversight', description: 'Human oversight measures for high-risk AI systems' },
  { article: '15', title: 'Accuracy, Robustness, Cybersecurity', description: 'Accuracy levels, resilience, and security measures' },
  { article: '26', title: 'Obligations of Deployers', description: 'Deployer responsibilities for high-risk AI systems' },
  { article: '50', title: 'Transparency for GPAI', description: 'Transparency obligations for general-purpose AI' },
] as const;

/**
 * Request an EU AI Act conformance report.
 *
 * `POST /v1/dpdp/exports` with `type: 'eu-ai-act-conformance'`
 */
export async function requestEuAiActExport(
  params: Omit<ComplianceExportRequest, 'type'>,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  const body: ComplianceExportRequest = {
    ...params,
    type: 'eu-ai-act-conformance',
  };

  const res = await fetch(`${baseUrl}/v1/dpdp/exports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...body,
      dateFrom: body.dateFrom.toISOString(),
      dateTo: body.dateTo.toISOString(),
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new ExportError(
      (errBody.message as string) ?? `EU AI Act export failed (${res.status})`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    exportId: data.exportId as string,
    type: data.type as string,
    status: data.status as ComplianceExportResult['status'],
    recordCount: data.recordCount as number,
    data: data.data,
    ...(data.downloadUrl !== undefined ? { downloadUrl: data.downloadUrl as string } : {}),
    ...(data.downloadExpiresAt !== undefined
      ? { downloadExpiresAt: new Date(data.downloadExpiresAt as string) }
      : {}),
  };
}
