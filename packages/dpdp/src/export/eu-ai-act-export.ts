/**
 * EU AI Act conformance report export.
 *
 * Generates a structured report covering EU AI Act articles related to
 * transparency, human oversight, data governance, and record-keeping
 * for AI systems operating under Grantex authorization.
 */

import type { ComplianceExportResult } from '../types.js';
import { requestExport, type ExportParams } from './request.js';

/**
 * EU AI Act (Regulation (EU) 2024/1689) articles covered by the conformance report.
 * General-purpose AI model obligations are in Articles 53-55, not Article 50.
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
  {
    article: '50',
    title: 'Transparency Obligations for Providers and Deployers of Certain AI Systems',
    description: 'Disclosure when people interact with an AI system, marking of synthetic content, and disclosure of deep fakes and emotion recognition',
  },
] as const;

/**
 * Request an EU AI Act conformance report.
 *
 * `POST /v1/dpdp/exports` with `type: 'eu-ai-act-conformance'`
 */
export async function requestEuAiActExport(
  params: ExportParams,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  return requestExport('eu-ai-act-conformance', params, apiKey, baseUrl, 'EU AI Act');
}
