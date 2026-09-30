/**
 * Data principal rights — access and erasure.
 *
 * DPDP Act 2023, s.11 — right to access information about personal data;
 * s.12 — right to correction and erasure of personal data.
 */

import type { DataPrincipalRecords, ErasureRequest, ErasureResult, PageOptions } from '../types.js';
import { DpdpError } from '../errors.js';
import { asObject, dpdpRequest, dpdpUrl, nextCursorOf, num, seg, str, type HttpFailure } from '../http.js';
import { decodeConsentRecord, decodeErasure } from '../decode.js';

function failure(fallback: string, code: string) {
  return (f: HttpFailure) =>
    new DpdpError(f.message ?? `${fallback} (${f.statusCode})`, f.code ?? code, f.statusCode, f.requestId);
}

/**
 * Fetch a page of the consent records belonging to a data principal (DPDP s.11).
 *
 * `GET /v1/dpdp/data-principals/:id/records?limit=&cursor=`
 */
export async function getDataPrincipalRecords(
  principalId: string,
  apiKey: string,
  baseUrl: string,
  page: PageOptions = {},
): Promise<DataPrincipalRecords> {
  const { data } = await dpdpRequest(
    {
      method: 'GET',
      url: dpdpUrl(baseUrl, [seg('data-principals'), principalId, seg('records')], {
        limit: page.limit,
        cursor: page.cursor,
      }),
      apiKey,
    },
    failure(`Failed to fetch records for principal ${principalId}`, 'RIGHTS_ACCESS_FAILED'),
  );

  const raw = asObject(data);
  const dataPrincipalId = str(raw.dataPrincipalId) ?? principalId;
  const records = Array.isArray(raw.records) ? raw.records : [];
  const totalRecords = num(raw.totalRecords) ?? records.length;
  return {
    dataPrincipalId,
    // Older servers omit dataPrincipalId per record: fall back to the top-level one.
    records: records.map((r) => decodeConsentRecord(r, dataPrincipalId)),
    totalRecords,
    totalCount: totalRecords,
    nextCursor: nextCursorOf(raw),
  };
}

/**
 * Erase a data principal's data held by Grantex (DPDP s.12).
 *
 * `POST /v1/dpdp/data-principals/:id/erasure` (no body). Completes
 * synchronously and is idempotent: 201 when something was erased now, 200 with
 * the earlier request when there was nothing left to erase (`created: false`).
 * `retained` lists what was kept and why. 404 `NOT_FOUND` when the principal
 * has no records.
 */
export async function requestDataErasure(
  principalId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ErasureResult> {
  const { status, data } = await dpdpRequest(
    {
      method: 'POST',
      url: dpdpUrl(baseUrl, [seg('data-principals'), principalId, seg('erasure')]),
      apiKey,
    },
    failure(`Failed to submit erasure request for principal ${principalId}`, 'ERASURE_REQUEST_FAILED'),
  );

  const httpStatus = status === 200 ? 200 : 201;
  return { ...decodeErasure(data), httpStatus, created: httpStatus === 201 };
}

/**
 * Fetch a completed erasure request.
 *
 * `GET /v1/dpdp/erasure-requests/:requestId`
 */
export async function getErasureRequest(
  requestId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ErasureRequest> {
  const { data } = await dpdpRequest(
    { method: 'GET', url: dpdpUrl(baseUrl, [seg('erasure-requests'), requestId]), apiKey },
    failure(`Failed to get erasure request ${requestId}`, 'GET_ERASURE_FAILED'),
  );
  return decodeErasure(data);
}
