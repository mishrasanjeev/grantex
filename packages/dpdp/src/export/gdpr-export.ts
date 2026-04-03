/**
 * GDPR Article 15 data export.
 *
 * Generates a machine-readable export of all personal data processed
 * for a data subject, including purposes, recipients, and retention periods.
 */

import type { ComplianceExportRequest, ComplianceExportResult } from '../types.js';
import { ExportError } from '../errors.js';

/**
 * Request a GDPR Article 15 export.
 *
 * `POST /v1/dpdp/exports` with `type: 'gdpr-article-15'`
 */
export async function requestGdprExport(
  params: Omit<ComplianceExportRequest, 'type'>,
  apiKey: string,
  baseUrl: string,
): Promise<ComplianceExportResult> {
  const body: ComplianceExportRequest = {
    ...params,
    type: 'gdpr-article-15',
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
      (errBody.message as string) ?? `GDPR export failed (${res.status})`,
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
