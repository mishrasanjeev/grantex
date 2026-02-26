import type { HttpClient } from '../http.js';
import type {
  AuditEntry,
  ListAuditParams,
  ListAuditResponse,
  LogAuditParams,
} from '../types.js';

export class AuditClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  log(params: LogAuditParams): Promise<AuditEntry> {
    return this.#http.post<AuditEntry>('/v1/audit/log', params);
  }

  list(params?: ListAuditParams): Promise<ListAuditResponse> {
    const query = buildQuery(params);
    const path = query ? `/v1/audit/entries?${query}` : '/v1/audit/entries';
    return this.#http.get<ListAuditResponse>(path);
  }

  get(entryId: string): Promise<AuditEntry> {
    return this.#http.get<AuditEntry>(`/v1/audit/${entryId}`);
  }
}

function buildQuery(params?: ListAuditParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null,
  ) as Array<[string, string | number]>;
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
