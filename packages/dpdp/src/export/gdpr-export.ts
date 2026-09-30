/**
 * GDPR Article 15 data export.
 *
 * Generates a machine-readable export of all personal data processed
 * for a data subject, including purposes, recipients, and retention periods.
 */

import type { ComplianceExportResult } from '../types.js';
import { requestExport, type ExportParams } from './request.js';

/**
 * Request a GDPR Article 15 export.
 *
 * `POST /v1/dpdp/exports` with `type: 'gdpr-article-15'`
 */
export async function requestGdprExport(
  params: ExportParams,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  return requestExport('gdpr-article-15', params, apiKey, baseUrl, 'GDPR');
}
