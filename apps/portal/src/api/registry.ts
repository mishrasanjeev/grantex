import { api } from './client';

// ── Types ────────────────────────────────────────────────────────────────

export interface RegistryOrg {
  did: string;
  name: string;
  description: string | null;
  verificationLevel: string;
  badges: string[];
  stats: { totalAgents: number; weeklyActiveGrants: number; averageRating: number };
  website: string | null;
  logoUrl: string | null;
}

export interface RegistryOrgDetail extends RegistryOrg {
  agents: RegistryAgent[];
  publicKeys: Record<string, unknown>[];
  compliance: { soc2: boolean; iso27001: boolean; dpdp: boolean; gdpr: boolean };
  contact: { security: string; dpo?: string };
  verifiedAt: string | null;
  verificationMethod: string | null;
}

export interface RegistryAgent {
  agentDid: string;
  name: string;
  description: string | null;
  category: string;
  scopes: string[];
  weeklyActiveGrants: number;
  rating: number;
  npmPackage: string | null;
}

export interface RegisterOrgParams {
  did: string;
  name: string;
  description?: string;
  website?: string;
  contact: { security: string; dpo?: string };
  requestVerification?: boolean;
  verificationMethod?: string;
}

// ── API calls ────────────────────────────────────────────────────────────

export async function searchRegistryOrgs(params?: {
  q?: string;
  verified?: boolean;
  badge?: string;
}): Promise<{ data: RegistryOrg[]; meta: { total: number } }> {
  const query = new URLSearchParams();
  if (params?.q) query.set('q', params.q);
  if (params?.verified !== undefined) query.set('verified', String(params.verified));
  if (params?.badge) query.set('badge', params.badge);
  const qs = query.toString();
  return api.get<{ data: RegistryOrg[]; meta: { total: number } }>(
    `/v1/registry/orgs${qs ? `?${qs}` : ''}`,
  );
}

export function getRegistryOrg(did: string): Promise<RegistryOrgDetail> {
  return api.get<RegistryOrgDetail>(`/v1/registry/orgs/${encodeURIComponent(did)}`);
}

export function registerOrg(params: RegisterOrgParams): Promise<RegistryOrgDetail> {
  return api.post<RegistryOrgDetail>('/v1/registry/orgs', params);
}

export function verifyOrgDns(orgId: string): Promise<{ verified: boolean }> {
  return api.post<{ verified: boolean }>(`/v1/registry/orgs/${encodeURIComponent(orgId)}/verify-dns`);
}
