import type { HttpClient } from '../http.js';
import type {
  Agent,
  ListAgentsResponse,
  RegisterAgentParams,
  UpdateAgentParams,
} from '../types.js';

type AgentResponse = Omit<Agent, 'id' | 'agentId'> & {
  id?: string;
  agentId?: string;
};

interface ListAgentsApiResponse extends Omit<ListAgentsResponse, 'agents'> {
  agents: AgentResponse[];
}

export class AgentsClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async register(params: RegisterAgentParams): Promise<Agent> {
    return normalizeAgent(await this.#http.post<AgentResponse>('/v1/agents', params));
  }

  async get(agentId: string): Promise<Agent> {
    return normalizeAgent(await this.#http.get<AgentResponse>(`/v1/agents/${agentId}`));
  }

  async list(): Promise<ListAgentsResponse> {
    const response = await this.#http.get<ListAgentsApiResponse>('/v1/agents');
    return { ...response, agents: response.agents.map(normalizeAgent) };
  }

  async update(agentId: string, params: UpdateAgentParams): Promise<Agent> {
    return normalizeAgent(
      await this.#http.patch<AgentResponse>(`/v1/agents/${agentId}`, params),
    );
  }

  delete(agentId: string): Promise<void> {
    return this.#http.delete<void>(`/v1/agents/${agentId}`);
  }
}

function normalizeAgent(response: AgentResponse): Agent {
  if (response.id && response.agentId && response.id !== response.agentId) {
    throw new TypeError('Invalid agent response: conflicting id and agentId');
  }
  const id = response.id ?? response.agentId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('Invalid agent response: missing agentId');
  }
  return { ...response, id, agentId: id };
}
