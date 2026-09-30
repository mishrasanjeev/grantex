/**
 * Shared request logic for the compliance export routes.
 */

import type { ComplianceExportRequest, ComplianceExportResult, ComplianceExportType } from '../types.js';
import { ExportError, ExportExpiredError } from '../errors.js';
import { dpdpRequest, dpdpUrl, opt, seg } from '../http.js';
import { decodeExport } from '../decode.js';

/** Export request parameters without `type` (the function sets it). */
export type ExportParams = Omit<ComplianceExportRequest, 'type'>;

/**
 * `POST /v1/dpdp/exports`. Only the fields given are sent: the server defaults
 * `format` to 'json' and both include flags to true. Only JSON is produced, so
 * any other format is rejected here.
 */
export async function requestExport(
  type: ComplianceExportType,
  params: ExportParams,
  apiKey: string,
  baseUrl: string,
  label: string,
): Promise<ComplianceExportResult> {
  const format = (params as { format?: unknown }).format;
  if (format !== undefined && format !== 'json') {
    throw new ExportError(`format must be 'json' (the only format produced); got '${String(format)}'`);
  }

  const body = {
    type,
    dateFrom: params.dateFrom.toISOString(),
    dateTo: params.dateTo.toISOString(),
    ...opt('format', params.format),
    ...opt('includeActionLog', params.includeActionLog),
    ...opt('includeConsentRecords', params.includeConsentRecords),
    ...opt('dataPrincipalId', params.dataPrincipalId),
  };

  const { data } = await dpdpRequest(
    { method: 'POST', url: dpdpUrl(baseUrl, [seg('exports')]), apiKey, body },
    (f) => new ExportError(f.message ?? `${label} export failed (${f.statusCode})`, f),
  );
  return decodeExport(data);
}

/**
 * `GET /v1/dpdp/exports/:id`. An expired export (410 `GONE`) throws
 * {@link ExportExpiredError}.
 */
export async function fetchExport(
  exportId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  const { data } = await dpdpRequest(
    { method: 'GET', url: dpdpUrl(baseUrl, [seg('exports'), exportId]), apiKey },
    (f) => {
      const message = f.message ?? `Failed to get export ${exportId} (${f.statusCode})`;
      return f.statusCode === 410 ? new ExportExpiredError(message, f) : new ExportError(message, f);
    },
  );
  return decodeExport(data);
}
