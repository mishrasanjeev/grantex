/**
 * DPDP Act audit export.
 *
 * A structured JSON export of consent records, the audit log and grievances
 * for a date range, for the data fiduciary's own records and regulator requests.
 */

import type { ComplianceExportResult } from '../types.js';
import { fetchExport, requestExport, type ExportParams } from './request.js';

/**
 * Request a DPDP audit export.
 *
 * `POST /v1/dpdp/exports` with `type: 'dpdp-audit'`
 */
export async function requestDpdpExport(
  params: ExportParams,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  return requestExport('dpdp-audit', params, apiKey, baseUrl, 'DPDP');
}

/**
 * Get an export by ID, with its data.
 *
 * `GET /v1/dpdp/exports/:id`. Throws `ExportExpiredError` (410 `GONE`) once the
 * export has expired and its data was purged.
 */
export async function getExportStatus(
  exportId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  return fetchExport(exportId, apiKey, baseUrl);
}
