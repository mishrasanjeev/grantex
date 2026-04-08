import type { HttpClient } from '../http.js';
import type {
  CreateConsentRecordParams,
  ConsentRecord,
  ListConsentRecordsResponse,
  WithdrawConsentParams,
  WithdrawConsentResponse,
  PrincipalRecordsResponse,
  ErasureResponse,
  CreateConsentNoticeParams,
  ConsentNotice,
  FileGrievanceParams,
  Grievance,
  CreateDpdpExportParams,
  DpdpExport,
} from '../types.js';

export class DpdpClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  createConsentRecord(params: CreateConsentRecordParams): Promise<ConsentRecord> {
    return this.#http.post<ConsentRecord>('/v1/dpdp/consent-records', params);
  }

  getConsentRecord(recordId: string): Promise<ConsentRecord> {
    return this.#http.get<ConsentRecord>(`/v1/dpdp/consent-records/${recordId}`);
  }

  listConsentRecords(principalId?: string): Promise<ListConsentRecordsResponse> {
    const qs = principalId ? `?dataPrincipalId=${encodeURIComponent(principalId)}` : '';
    return this.#http.get<ListConsentRecordsResponse>(`/v1/dpdp/consent-records${qs}`);
  }

  withdrawConsent(recordId: string, params: WithdrawConsentParams): Promise<WithdrawConsentResponse> {
    return this.#http.post<WithdrawConsentResponse>(`/v1/dpdp/consent-records/${recordId}/withdraw`, params);
  }

  listPrincipalRecords(principalId: string): Promise<PrincipalRecordsResponse> {
    return this.#http.get<PrincipalRecordsResponse>(`/v1/dpdp/data-principals/${encodeURIComponent(principalId)}/records`);
  }

  requestErasure(principalId: string): Promise<ErasureResponse> {
    return this.#http.post<ErasureResponse>(`/v1/dpdp/data-principals/${encodeURIComponent(principalId)}/erasure`, {
      dataPrincipalId: principalId,
    });
  }

  createConsentNotice(params: CreateConsentNoticeParams): Promise<ConsentNotice> {
    return this.#http.post<ConsentNotice>('/v1/dpdp/consent-notices', params);
  }

  fileGrievance(params: FileGrievanceParams): Promise<Grievance> {
    return this.#http.post<Grievance>('/v1/dpdp/grievances', params);
  }

  getGrievance(grievanceId: string): Promise<Grievance> {
    return this.#http.get<Grievance>(`/v1/dpdp/grievances/${grievanceId}`);
  }

  createExport(params: CreateDpdpExportParams): Promise<DpdpExport> {
    return this.#http.post<DpdpExport>('/v1/dpdp/exports', params);
  }

  getExport(exportId: string): Promise<DpdpExport> {
    return this.#http.get<DpdpExport>(`/v1/dpdp/exports/${exportId}`);
  }
}
