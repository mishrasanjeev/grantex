/**
 * Grievance filing and tracking.
 *
 * DPDP Act 2023, Section 13 — every data fiduciary must provide a
 * grievance redressal mechanism. Grievances must be resolved within
 * a reasonable period (7 days per implementation).
 */

import type { Grievance, FileGrievanceParams } from '../types.js';
import { GrievanceError } from '../errors.js';

/** Resolution period in days (DPDP Act default). */
const GRIEVANCE_RESOLUTION_DAYS = 7;

/**
 * Generate a grievance reference number.
 *
 * Format: `GRV-YYYY-NNNNN` where YYYY is the current year and NNNNN
 * is a zero-padded random 5-digit number.
 */
export function generateReferenceNumber(): string {
  const year = new Date().getFullYear();
  const seq = Math.floor(Math.random() * 100_000)
    .toString()
    .padStart(5, '0');
  return `GRV-${year}-${seq}`;
}

/**
 * File a grievance against a data fiduciary.
 *
 * `POST /v1/dpdp/grievances`
 */
export async function fileGrievance(
  params: FileGrievanceParams,
  apiKey: string,
  baseUrl: string,
): Promise<Grievance> {
  if (!params.dataPrincipalId) {
    throw new GrievanceError('dataPrincipalId is required');
  }
  if (!params.recordId) {
    throw new GrievanceError('recordId is required');
  }
  if (!params.description) {
    throw new GrievanceError('description is required');
  }

  const body = {
    dataPrincipalId: params.dataPrincipalId,
    recordId: params.recordId,
    type: params.type,
    description: params.description,
    ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
  };

  const res = await fetch(`${baseUrl}/v1/dpdp/grievances`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new GrievanceError(
      (errBody.message as string) ?? `Failed to file grievance (${res.status})`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    grievanceId: data.grievanceId as string,
    dataPrincipalId: data.dataPrincipalId as string,
    recordId: data.recordId as string,
    type: data.type as Grievance['type'],
    description: data.description as string,
    ...(data.evidence !== undefined ? { evidence: data.evidence as Grievance['evidence'] } : {}),
    status: (data.status as Grievance['status']) ?? 'submitted',
    referenceNumber: data.referenceNumber as string,
    expectedResolutionBy: new Date(data.expectedResolutionBy as string),
    ...(data.resolvedAt !== undefined ? { resolvedAt: new Date(data.resolvedAt as string) } : {}),
    ...(data.resolution !== undefined ? { resolution: data.resolution as string } : {}),
  };
}

/**
 * Get grievance status by ID.
 *
 * `GET /v1/dpdp/grievances/:id`
 */
export async function getGrievanceStatus(
  grievanceId: string,
  apiKey: string,
  baseUrl: string,
): Promise<Grievance> {
  const res = await fetch(
    `${baseUrl}/v1/dpdp/grievances/${encodeURIComponent(grievanceId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) {
    throw new GrievanceError(
      `Failed to get grievance ${grievanceId} (${res.status})`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    grievanceId: data.grievanceId as string,
    dataPrincipalId: data.dataPrincipalId as string,
    recordId: data.recordId as string,
    type: data.type as Grievance['type'],
    description: data.description as string,
    ...(data.evidence !== undefined ? { evidence: data.evidence as Grievance['evidence'] } : {}),
    status: data.status as Grievance['status'],
    referenceNumber: data.referenceNumber as string,
    expectedResolutionBy: new Date(data.expectedResolutionBy as string),
    ...(data.resolvedAt !== undefined ? { resolvedAt: new Date(data.resolvedAt as string) } : {}),
    ...(data.resolution !== undefined ? { resolution: data.resolution as string } : {}),
  };
}

/**
 * Calculate the expected resolution date (7 calendar days from now).
 */
export function calculateExpectedResolution(fromDate: Date = new Date()): Date {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + GRIEVANCE_RESOLUTION_DAYS);
  return d;
}
