import type { HttpClient, RequestOptions } from '../http.js';
import type {
  CreateConsentRecordParams,
  CreateConsentRecordResponse,
  ConsentRecord,
  ListConsentRecordsParams,
  ListConsentRecordsResponse,
  WithdrawConsentParams,
  WithdrawConsentResponse,
  PrincipalRecordsResponse,
  ErasureResponse,
  CreateConsentNoticeParams,
  ConsentNotice,
  ConsentNoticeDetail,
  ListConsentNoticesResponse,
  FileGrievanceParams,
  Grievance,
  ListGrievancesParams,
  ListGrievancesResponse,
  UpdateGrievanceParams,
  CreateDpdpExportParams,
  DpdpExport,
  DpdpPageParams,
} from '../types.js';

// DPDP writes are not idempotent (a replayed create, withdrawal, grievance,
// notice or export duplicates it or fails with a spurious 409), so they are
// sent exactly once. Reads keep the client's normal retry behaviour.
const NO_RETRY: RequestOptions = { retry: false };

function seg(value: string): string {
  return encodeURIComponent(value);
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/**
 * DPDP Act 2023 endpoints: consent records and withdrawal (s.6(4)), consent
 * notices (s.5), the rights to access (s.11) and erasure (s.12), grievance
 * redressal (s.13) and compliance exports.
 */
export class DpdpClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Record consent for a grant. The response carries the signed consent proof. */
  createConsentRecord(params: CreateConsentRecordParams): Promise<CreateConsentRecordResponse> {
    return this.#http.post<CreateConsentRecordResponse>('/v1/dpdp/consent-records', params, NO_RETRY);
  }

  getConsentRecord(recordId: string): Promise<ConsentRecord> {
    return this.#http.get<ConsentRecord>(`/v1/dpdp/consent-records/${seg(recordId)}`);
  }

  /**
   * List consent records, newest first. Pass a data principal id (the original
   * form) or `{ dataPrincipalId?, limit?, cursor? }`.
   */
  listConsentRecords(params?: string | ListConsentRecordsParams): Promise<ListConsentRecordsResponse> {
    const p: ListConsentRecordsParams = typeof params === 'string' ? { dataPrincipalId: params } : (params ?? {});
    const qs = query({ dataPrincipalId: p.dataPrincipalId, limit: p.limit, cursor: p.cursor });
    return this.#http.get<ListConsentRecordsResponse>(`/v1/dpdp/consent-records${qs}`);
  }

  /** Withdraw consent (DPDP Act s.6(4)). */
  withdrawConsent(recordId: string, params: WithdrawConsentParams): Promise<WithdrawConsentResponse> {
    return this.#http.post<WithdrawConsentResponse>(
      `/v1/dpdp/consent-records/${seg(recordId)}/withdraw`,
      params,
      NO_RETRY,
    );
  }

  /** A data principal's consent records (right to access, DPDP Act s.11). */
  async listPrincipalRecords(principalId: string, params?: DpdpPageParams): Promise<PrincipalRecordsResponse> {
    const qs = query({ limit: params?.limit, cursor: params?.cursor });
    const res = await this.#http.get<PrincipalRecordsResponse>(
      `/v1/dpdp/data-principals/${seg(principalId)}/records${qs}`,
    );
    // Older servers omit the per-record dataPrincipalId; it is the top-level one.
    if (res && Array.isArray(res.records)) {
      res.records = res.records.map((r) =>
        r.dataPrincipalId === undefined ? { ...r, dataPrincipalId: res.dataPrincipalId } : r,
      );
    }
    return res;
  }

  /**
   * Erase a data principal's personal data (right to erasure, DPDP Act s.12).
   * Idempotent on the server: a repeat returns the earlier request.
   */
  requestErasure(principalId: string): Promise<ErasureResponse> {
    return this.#http.post<ErasureResponse>(
      `/v1/dpdp/data-principals/${seg(principalId)}/erasure`,
      undefined,
      NO_RETRY,
    );
  }

  getErasureRequest(requestId: string): Promise<ErasureResponse> {
    return this.#http.get<ErasureResponse>(`/v1/dpdp/erasure-requests/${seg(requestId)}`);
  }

  /** Register a consent notice version (DPDP Act s.5). */
  createConsentNotice(params: CreateConsentNoticeParams): Promise<ConsentNotice> {
    return this.#http.post<ConsentNotice>('/v1/dpdp/consent-notices', params, NO_RETRY);
  }

  listConsentNotices(params?: DpdpPageParams): Promise<ListConsentNoticesResponse> {
    const qs = query({ limit: params?.limit, cursor: params?.cursor });
    return this.#http.get<ListConsentNoticesResponse>(`/v1/dpdp/consent-notices${qs}`);
  }

  /** Every version of a notice, newest first. */
  getConsentNotice(noticeId: string): Promise<ConsentNoticeDetail> {
    return this.#http.get<ConsentNoticeDetail>(`/v1/dpdp/consent-notices/${seg(noticeId)}`);
  }

  /** File a grievance (DPDP Act s.13). */
  fileGrievance(params: FileGrievanceParams): Promise<Grievance> {
    return this.#http.post<Grievance>('/v1/dpdp/grievances', params, NO_RETRY);
  }

  getGrievance(grievanceId: string): Promise<Grievance> {
    return this.#http.get<Grievance>(`/v1/dpdp/grievances/${seg(grievanceId)}`);
  }

  /** List grievances, newest first. Items omit description and evidence. */
  listGrievances(params?: ListGrievancesParams): Promise<ListGrievancesResponse> {
    const qs = query({
      status: params?.status,
      dataPrincipalId: params?.dataPrincipalId,
      limit: params?.limit,
      cursor: params?.cursor,
    });
    return this.#http.get<ListGrievancesResponse>(`/v1/dpdp/grievances${qs}`);
  }

  /** Move a grievance: submitted -> in_review -> resolved | rejected. */
  updateGrievance(grievanceId: string, params: UpdateGrievanceParams): Promise<Grievance> {
    return this.#http.patch<Grievance>(`/v1/dpdp/grievances/${seg(grievanceId)}`, params, NO_RETRY);
  }

  createExport(params: CreateDpdpExportParams): Promise<DpdpExport> {
    return this.#http.post<DpdpExport>('/v1/dpdp/exports', params, NO_RETRY);
  }

  /** Fetch an export. An expired export fails with 410 `GONE`. */
  getExport(exportId: string): Promise<DpdpExport> {
    return this.#http.get<DpdpExport>(`/v1/dpdp/exports/${seg(exportId)}`);
  }
}
