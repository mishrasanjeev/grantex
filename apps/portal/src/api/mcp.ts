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

// Server returns { data: [{ serverId, ... }], meta: { total, cursor? } } —
// normalize to the portal's { id, ... } shape.
interface McpServerWire extends Omit<McpServer, 'id'> {
  serverId: string;
}

function normalizeServer(w: McpServerWire): McpServer {
  const { serverId, ...rest } = w;
  return { id: serverId, ...rest };
}

export async function listMcpServers(params?: ListMcpServersParams): Promise<McpServer[]> {
  const query = new URLSearchParams();
  if (params?.category) query.set('category', params.category);
  if (params?.certified !== undefined) query.set('certified', String(params.certified));
  const qs = query.toString();
  const res = await api.get<{ data: McpServerWire[]; meta: { total: number; cursor?: string } }>(
    `/v1/mcp/servers${qs ? `?${qs}` : ''}`,
  );
  return (res.data ?? []).map(normalizeServer);
}

export async function getMcpServer(id: string): Promise<McpServer> {
  const res = await api.get<McpServerWire>(`/v1/mcp/servers/${encodeURIComponent(id)}`);
  return normalizeServer(res);
}

export async function createMcpServer(params: CreateMcpServerParams): Promise<McpServer> {
  const res = await api.post<McpServerWire>('/v1/mcp/servers', params);
  return normalizeServer(res);
}

export function applyForCertification(serverId: string, level: string): Promise<McpCertification> {
  return api.post<McpCertification>(`/v1/mcp/servers/${encodeURIComponent(serverId)}/certify`, { level });
}

export function getCertification(certId: string): Promise<McpCertification> {
  return api.get<McpCertification>(`/v1/mcp/certifications/${encodeURIComponent(certId)}`);
}
