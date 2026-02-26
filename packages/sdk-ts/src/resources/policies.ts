import type { HttpClient } from '../http.js';
import type {
  CreatePolicyParams,
  ListPoliciesResponse,
  Policy,
  UpdatePolicyParams,
} from '../types.js';

export class PoliciesClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Create a new policy. */
  create(params: CreatePolicyParams): Promise<Policy> {
    return this.#http.post<Policy>('/v1/policies', params);
  }

  /** List all policies for the authenticated developer. */
  list(): Promise<ListPoliciesResponse> {
    return this.#http.get<ListPoliciesResponse>('/v1/policies');
  }

  /** Get a single policy by ID. */
  get(policyId: string): Promise<Policy> {
    return this.#http.get<Policy>(`/v1/policies/${policyId}`);
  }

  /** Update a policy. */
  update(policyId: string, params: UpdatePolicyParams): Promise<Policy> {
    return this.#http.patch<Policy>(`/v1/policies/${policyId}`, params);
  }

  /** Delete a policy. */
  delete(policyId: string): Promise<void> {
    return this.#http.delete<void>(`/v1/policies/${policyId}`);
  }
}
