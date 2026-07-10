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

export interface JwksSnapshot {
  keys: Record<string, unknown>[];
  fetchedAt: string;
  validUntil: string;
}

export interface OfflineAuditKey {
  publicKey: string;
  privateKey: string;
  algorithm: string;
}

export interface CreateBundleResponse {
  bundleId: string;
  grantToken: string;
  jwksSnapshot: JwksSnapshot;
  offlineAuditKey: OfflineAuditKey;
  checkpointAt: number;
  syncEndpoint: string;
  offlineExpiresAt: string;
}

export interface RevocationStatus {
  bundleId: string;
  status: 'active' | 'revoked' | 'expired';
  revokedAt: string | null;
  revokedBy: string | null;
  grantRevoked: boolean;
  checkpointAt: number | null;
}

export async function listBundles(params?: { status?: string; agentId?: string }): Promise<ConsentBundle[]> {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.agentId) q.set('agentId', params.agentId);
  const qs = q.toString();
  const res = await api.get<{ bundles: ConsentBundle[] }>(`/v1/consent-bundles${qs ? `?${qs}` : ''}`);
  return res.bundles;
}

export function getBundle(bundleId: string): Promise<ConsentBundle> {
  return api.get<ConsentBundle>(`/v1/consent-bundles/${encodeURIComponent(bundleId)}`);
}

export async function createBundle(params: CreateBundleParams): Promise<CreateBundleResponse> {
  const res = await api.post<CreateBundleResponse | { data: CreateBundleResponse }>(
    '/v1/consent-bundles',
    params,
  );
  return 'data' in res ? res.data : res;
}

export function revokeBundle(bundleId: string): Promise<void> {
  return api.post<void>(`/v1/consent-bundles/${encodeURIComponent(bundleId)}/revoke`);
}

export async function getBundleAuditEntries(bundleId: string): Promise<OfflineAuditEntry[]> {
  const res = await api.get<{ entries: OfflineAuditEntry[] }>(
    `/v1/consent-bundles/${encodeURIComponent(bundleId)}/audit`,
  );
  return res.entries;
}

export async function getRevocationStatus(bundleId: string): Promise<RevocationStatus> {
  const res = await api.get<{ data: RevocationStatus }>(
    `/v1/consent-bundles/${encodeURIComponent(bundleId)}/revocation-status`,
  );
  return res.data;
}
