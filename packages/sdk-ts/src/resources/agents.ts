import type { HttpClient } from '../http.js';
import type {
  Agent,
  ListAgentsResponse,
  RegisterAgentParams,
  UpdateAgentParams,
} from '../types.js';

export class AgentsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  register(params: RegisterAgentParams): Promise<Agent> {
    return this.#http.post<Agent>('/v1/agents', params);
  }

  get(agentId: string): Promise<Agent> {
    return this.#http.get<Agent>(`/v1/agents/${agentId}`);
  }

  list(): Promise<ListAgentsResponse> {
    return this.#http.get<ListAgentsResponse>('/v1/agents');
  }

  update(agentId: string, params: UpdateAgentParams): Promise<Agent> {
    return this.#http.post<Agent>(`/v1/agents/${agentId}`, params);
  }

  delete(agentId: string): Promise<void> {
    return this.#http.delete<void>(`/v1/agents/${agentId}`);
  }
}
