/**
 * Grievance filing and tracking.
 *
 * DPDP Act 2023, s.13 — a data principal has the right to readily available
 * means of grievance redressal from the data fiduciary. The fiduciary
 * publishes its response period, at most 90 days (DPDP Rules 2025 r.14(3)).
 * The 7-day default here and on the server is a product default, not a
 * statutory period.
 */

import { randomBytes } from 'node:crypto';
import type {
  FileGrievanceParams,
  Grievance,
  GrievancePage,
  GrievanceReceipt,
  ListGrievancesOptions,
  UpdateGrievanceParams,
} from '../types.js';
import { GrievanceError } from '../errors.js';
import { asObject, dpdpRequest, dpdpUrl, nextCursorOf, num, opt, seg, toDate, type HttpFailure } from '../http.js';
import { decodeGrievance, decodeGrievanceSummary } from '../decode.js';

/** Product default response period in days (not a statutory period). */
const DEFAULT_RESPONSE_PERIOD_DAYS = 7;

/** Longest response period DPDP Rules 2025 r.14(3) allows. */
const MAX_RESPONSE_PERIOD_DAYS = 90;

const GRIEVANCES = seg('grievances');

function failure(fallback: string) {
  return (f: HttpFailure) => new GrievanceError(f.message ?? `${fallback} (${f.statusCode})`, f);
}

/**
 * Generate a grievance reference number.
 *
 * @deprecated The server assigns each grievance its reference number
 * (`GRV-YYYY-<id>`, returned by {@link fileGrievance}); use that. This local
 * generator is kept for compatibility and uses a different format:
 * `GRV-YYYY-XXXXXXXXXXXXXXXX`, 16 lowercase hex characters (64 bits) from a
 * cryptographically strong source, so references are not enumerable.
 */
export function generateReferenceNumber(): string {
  const year = new Date().getFullYear();
  const suffix = randomBytes(8).toString('hex');
  return `GRV-${year}-${suffix}`;
}

/**
 * File a grievance.
 *
 * `POST /v1/dpdp/grievances` (202). `recordId`, `evidence` and
 * `responsePeriodDays` are optional; `type` is any string (see `GRIEVANCE_TYPES`).
 */
export async function fileGrievance(
  params: FileGrievanceParams,
  apiKey: string,
  baseUrl: string,
): Promise<GrievanceReceipt> {
  if (!params.dataPrincipalId) {
    throw new GrievanceError('dataPrincipalId is required');
  }
  if (!params.type) {
    throw new GrievanceError('type is required');
  }
  if (!params.description) {
    throw new GrievanceError('description is required');
  }
  const period = params.responsePeriodDays;
  if (
    period !== undefined
    && (!Number.isInteger(period) || period < 1 || period > MAX_RESPONSE_PERIOD_DAYS)
  ) {
    throw new GrievanceError(
      `responsePeriodDays must be an integer from 1 to ${MAX_RESPONSE_PERIOD_DAYS} (DPDP Rules 2025 r.14(3))`,
    );
  }

  const body = {
    dataPrincipalId: params.dataPrincipalId,
    ...opt('recordId', params.recordId || undefined),
    type: params.type,
    description: params.description,
    ...opt('evidence', params.evidence),
    ...opt('responsePeriodDays', period),
  };

  const { data } = await dpdpRequest(
    { method: 'POST', url: dpdpUrl(baseUrl, [GRIEVANCES]), apiKey, body },
    failure('Failed to file grievance'),
  );

  const raw = asObject(data);
  return {
    grievanceId: raw.grievanceId as string,
    referenceNumber: raw.referenceNumber as string,
    type: raw.type as string,
    status: (raw.status as GrievanceReceipt['status']) ?? 'submitted',
    responsePeriodDays: num(raw.responsePeriodDays) ?? period ?? DEFAULT_RESPONSE_PERIOD_DAYS,
    expectedResolutionBy: toDate(raw.expectedResolutionBy) as Date,
    createdAt: toDate(raw.createdAt) as Date,
  };
}

/**
 * Get a grievance by ID.
 *
 * `GET /v1/dpdp/grievances/:id`
 */
export async function getGrievanceStatus(
  grievanceId: string,
  apiKey: string,
  baseUrl: string,
): Promise<Grievance> {
  const { data } = await dpdpRequest(
    { method: 'GET', url: dpdpUrl(baseUrl, [GRIEVANCES, grievanceId]), apiKey },
    failure(`Failed to get grievance ${grievanceId}`),
  );
  return decodeGrievance(data);
}

/**
 * List grievances, newest first.
 *
 * `GET /v1/dpdp/grievances?status=&dataPrincipalId=&limit=&cursor=`
 */
export async function listGrievances(
  options: ListGrievancesOptions,
  apiKey: string,
  baseUrl: string,
): Promise<GrievancePage> {
  const { data } = await dpdpRequest(
    {
      method: 'GET',
      url: dpdpUrl(baseUrl, [GRIEVANCES], {
        status: options.status,
        dataPrincipalId: options.dataPrincipalId,
        limit: options.limit,
        cursor: options.cursor,
      }),
      apiKey,
    },
    failure('Failed to list grievances'),
  );
  const raw = asObject(data);
  const grievances = Array.isArray(raw.grievances) ? raw.grievances : [];
  return {
    grievances: grievances.map(decodeGrievanceSummary),
    nextCursor: nextCursorOf(raw),
  };
}

/**
 * Move a grievance along: submitted -> in_review -> resolved | rejected.
 *
 * `PATCH /v1/dpdp/grievances/:id` with `{ status, resolution }`; `resolution`
 * is required for resolved and rejected. Any other transition fails with 409
 * `INVALID_TRANSITION`.
 */
export async function updateGrievance(
  grievanceId: string,
  params: UpdateGrievanceParams,
  apiKey: string,
  baseUrl: string,
): Promise<Grievance> {
  if (!grievanceId) {
    throw new GrievanceError('grievanceId is required');
  }
  if ((params.status === 'resolved' || params.status === 'rejected') && !params.resolution) {
    throw new GrievanceError(`resolution is required when status is ${params.status}`);
  }

  const { data } = await dpdpRequest(
    {
      method: 'PATCH',
      url: dpdpUrl(baseUrl, [GRIEVANCES, grievanceId]),
      apiKey,
      body: { status: params.status, ...opt('resolution', params.resolution) },
    },
    failure(`Failed to update grievance ${grievanceId}`),
  );
  return decodeGrievance(data);
}

/**
 * Expected resolution date: `days` calendar days after `fromDate`.
 * The default of 7 days is a product default, not a statutory period; pass the
 * response period you publish (at most 90 days, DPDP Rules 2025 r.14(3)).
 */
export function calculateExpectedResolution(
  fromDate: Date = new Date(),
  days: number = DEFAULT_RESPONSE_PERIOD_DAYS,
): Date {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + days);
  return d;
}
