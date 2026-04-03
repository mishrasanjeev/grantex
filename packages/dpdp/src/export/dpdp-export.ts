/**
 * DPDP Act audit export.
 *
 * Generates a structured export of consent records, processing actions,
 * and audit trail suitable for submission to the Data Protection Board of India.
 */

import type { ComplianceExportRequest, ComplianceExportResult } from '../types.js';
import { ExportError } from '../errors.js';

/**
 * Request a DPDP audit export.
 *
 * `POST /v1/dpdp/exports` with `type: 'dpdp-audit'`
 */
export async function requestDpdpExport(
  params: Omit<ComplianceExportRequest, 'type'>,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  const body: ComplianceExportRequest = {
    ...params,
    type: 'dpdp-audit',
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
      (errBody.message as string) ?? `DPDP export failed (${res.status})`,
    );
  }

  return deserializeExportResult(await res.json());
}

/**
 * Get the status/result of an export by ID.
 *
 * `GET /v1/dpdp/exports/:id`
 */
export async function getExportStatus(
  exportId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  const res = await fetch(
    `${baseUrl}/v1/dpdp/exports/${encodeURIComponent(exportId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) {
    throw new ExportError(`Failed to get export ${exportId} (${res.status})`);
  }

  return deserializeExportResult(await res.json());
}

function deserializeExportResult(raw: unknown): ComplianceExportResult {
  const data = raw as Record<string, unknown>;
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
