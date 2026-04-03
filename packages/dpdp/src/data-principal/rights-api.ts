/**
 * Data principal rights — access, withdrawal, erasure.
 *
 * DPDP Act 2023, Sections 11-13 — the data principal has the right to
 * obtain a summary of personal data being processed and request erasure.
 */

import type { DataPrincipalRecords, ErasureRequest } from '../types.js';
import { DpdpError } from '../errors.js';

/**
 * Fetch all consent records belonging to a data principal.
 *
 * `GET /v1/dpdp/data-principals/:id/records`
 */
export async function getDataPrincipalRecords(
  principalId: string,
  apiKey: string,
  baseUrl: string,
): Promise<DataPrincipalRecords> {
  const res = await fetch(
    `${baseUrl}/v1/dpdp/data-principals/${encodeURIComponent(principalId)}/records`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) {
    throw new DpdpError(
      `Failed to fetch records for principal ${principalId} (${res.status})`,
      'RIGHTS_ACCESS_FAILED',
      res.status,
    );
  }

  return (await res.json()) as DataPrincipalRecords;
}

/**
 * Submit a data erasure request for a data principal.
 *
 * `POST /v1/dpdp/data-principals/:id/erasure`
 */
export async function requestDataErasure(
  principalId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ErasureRequest> {
  const res = await fetch(
    `${baseUrl}/v1/dpdp/data-principals/${encodeURIComponent(principalId)}/erasure`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ dataPrincipalId: principalId }),
    },
  );

  if (!res.ok) {
    throw new DpdpError(
      `Failed to submit erasure request for principal ${principalId} (${res.status})`,
      'ERASURE_REQUEST_FAILED',
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    requestId: data.requestId as string,
    dataPrincipalId: data.dataPrincipalId as string,
    status: data.status as ErasureRequest['status'],
    submittedAt: new Date(data.submittedAt as string),
    expectedCompletionBy: new Date(data.expectedCompletionBy as string),
  };
}
