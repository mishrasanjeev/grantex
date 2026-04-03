import { api } from './client';

export interface ConsentBundle {
  id: string;
  agentId: string;
  userId: string;
  grantId: string;
  scopes: string[];
  deviceId: string | null;
  devicePlatform: string | null;
  offlineTTL: string;
  offlineExpiresAt: string;
  status: 'active' | 'revoked' | 'expired';
  lastSyncAt: string | null;
  auditEntryCount: number;
  checkpointAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface OfflineAuditEntry {
  id: string;
  seq: number;
  timestamp: string;
  action: string;
  agentDID: string;
  grantId: string;
  scopes: string[];
  result: string;
  metadata: Record<string, unknown>;
}

export interface CreateBundleParams {
  agentId: string;
  userId: string;
  scopes: string[];
  offlineTTL?: string;
  deviceId?: string;
  devicePlatform?: string;
}

export interface CreateBundleResponse {
  bundle: ConsentBundle;
  grantToken: string;
  jwks: Record<string, unknown>;
  auditKey: string;
}

export interface RevocationStatus {
  bundleId: string;
  revoked: boolean;
  revokedAt: string | null;
  propagated: boolean;
}

export async function listBundles(params?: { status?: string; agentId?: string }): Promise<ConsentBundle[]> {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.agentId) q.set('agentId', params.agentId);
  const qs = q.toString();
  const res = await api.get<{ bundles: ConsentBundle[] }>(`/v1/bundles${qs ? `?${qs}` : ''}`);
  return res.bundles;
}

export function getBundle(bundleId: string): Promise<ConsentBundle> {
  return api.get<ConsentBundle>(`/v1/bundles/${encodeURIComponent(bundleId)}`);
}

export function createBundle(params: CreateBundleParams): Promise<CreateBundleResponse> {
  return api.post<CreateBundleResponse>('/v1/bundles', params);
}

export function revokeBundle(bundleId: string): Promise<void> {
  return api.post<void>(`/v1/bundles/${encodeURIComponent(bundleId)}/revoke`);
}

export async function getBundleAuditEntries(bundleId: string): Promise<OfflineAuditEntry[]> {
  const res = await api.get<{ entries: OfflineAuditEntry[] }>(
    `/v1/bundles/${encodeURIComponent(bundleId)}/audit`,
  );
  return res.entries;
}

export function getRevocationStatus(bundleId: string): Promise<RevocationStatus> {
  return api.get<RevocationStatus>(`/v1/bundles/${encodeURIComponent(bundleId)}/revocation`);
}
