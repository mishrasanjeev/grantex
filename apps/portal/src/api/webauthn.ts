import { api } from './client';

export interface WebAuthnCredential {
  id: string;
  principalId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: string;
}

export async function listWebAuthnCredentials(principalId: string): Promise<WebAuthnCredential[]> {
  const res = await api.get<{ credentials: WebAuthnCredential[] }>(`/v1/webauthn/credentials?principalId=${encodeURIComponent(principalId)}`);
  return res.credentials;
}

export function deleteWebAuthnCredential(id: string): Promise<void> {
  return api.del(`/v1/webauthn/credentials/${encodeURIComponent(id)}`);
}
