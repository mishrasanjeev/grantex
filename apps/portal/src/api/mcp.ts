import { api } from './client';

export interface McpServer {
  id: string;
  name: string;
  description: string | null;
  serverUrl: string | null;
  authEndpoint: string | null;
  npmPackage: string | null;
  category: string;
  scopes: string[];
  certified: boolean;
  certificationLevel: string | null;
  certifiedAt: string | null;
  weeklyActiveAgents: number;
  stars: number;
  status: string;
  createdAt: string;
}

export interface McpCertification {
  id: string;
  serverId: string;
  requestedLevel: string;
  status: string;
  conformancePassed: number;
  conformanceTotal: number;
  createdAt: string;
}

export interface CreateMcpServerParams {
  name: string;
  description?: string;
  serverUrl?: string;
  authEndpoint?: string;
  npmPackage?: string;
  category: string;
  scopes: string[];
}

export interface ListMcpServersParams {
  category?: string;
  certified?: boolean;
}

export async function listMcpServers(params?: ListMcpServersParams): Promise<McpServer[]> {
  const query = new URLSearchParams();
  if (params?.category) query.set('category', params.category);
  if (params?.certified !== undefined) query.set('certified', String(params.certified));
  const qs = query.toString();
  const res = await api.get<{ servers: McpServer[] }>(`/v1/mcp/servers${qs ? `?${qs}` : ''}`);
  return res.servers;
}

export function getMcpServer(id: string): Promise<McpServer> {
  return api.get<McpServer>(`/v1/mcp/servers/${encodeURIComponent(id)}`);
}

export function createMcpServer(params: CreateMcpServerParams): Promise<McpServer> {
  return api.post<McpServer>('/v1/mcp/servers', params);
}

export function applyForCertification(serverId: string, level: string): Promise<McpCertification> {
  return api.post<McpCertification>(`/v1/mcp/servers/${encodeURIComponent(serverId)}/certify`, { level });
}

export function getCertification(certId: string): Promise<McpCertification> {
  return api.get<McpCertification>(`/v1/mcp/certifications/${encodeURIComponent(certId)}`);
}
