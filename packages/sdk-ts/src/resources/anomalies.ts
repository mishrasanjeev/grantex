import type { HttpClient } from '../http.js';
import type {
  Anomaly,
  DetectAnomaliesResponse,
  ListAnomaliesResponse,
} from '../types.js';

export class AnomaliesClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Run anomaly detection across all agents and return detected anomalies. */
  detect(): Promise<DetectAnomaliesResponse> {
    return this.#http.post<DetectAnomaliesResponse>('/v1/anomalies/detect', {});
  }

  /** List stored anomalies. Pass `{ unacknowledged: true }` to filter to open ones only. */
  list(params?: { unacknowledged?: boolean }): Promise<ListAnomaliesResponse> {
    const qs = params?.unacknowledged ? '?unacknowledged=true' : '';
    return this.#http.get<ListAnomaliesResponse>(`/v1/anomalies${qs}`);
  }

  /** Acknowledge an anomaly by ID. */
  acknowledge(anomalyId: string): Promise<Anomaly> {
    return this.#http.patch<Anomaly>(`/v1/anomalies/${anomalyId}/acknowledge`, {});
  }
}
