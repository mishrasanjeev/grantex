import { api } from './client';

export interface VerifiableCredentialRecord {
  id: string;
  type: string[];
  issuer: string;
  subject: string;
  grantId: string;
  status: string;
  issuanceDate: string;
  jwt: string;
}

export async function listCredentials(params?: { grantId?: string; status?: string }): Promise<VerifiableCredentialRecord[]> {
  const query = new URLSearchParams();
  if (params?.grantId) query.set('grantId', params.grantId);
  if (params?.status) query.set('status', params.status);
  const qs = query.toString();
  const res = await api.get<{ credentials: VerifiableCredentialRecord[] }>(`/v1/credentials${qs ? '?' + qs : ''}`);
  return res.credentials;
}

export async function getCredential(id: string): Promise<VerifiableCredentialRecord> {
  return api.get<VerifiableCredentialRecord>(`/v1/credentials/${encodeURIComponent(id)}`);
}
