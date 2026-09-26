import { api } from './client';

export interface WebAuthnCredential {
  id: string;
  principalId: string;
  deviceName: string | null;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface EnrollmentSession {
  enrollmentUrl: string;
  expiresAt: string;
}

export function createEnrollmentSession(principalId: string, authRequestId?: string): Promise<EnrollmentSession> {
  return api.post<EnrollmentSession>('/v1/webauthn/enrollment-sessions', {
    principalId,
    ...(authRequestId ? { authRequestId } : {}),
  });
}

export async function listWebAuthnCredentials(principalId: string): Promise<WebAuthnCredential[]> {
  const res = await api.get<{ credentials: WebAuthnCredential[] }>(`/v1/webauthn/credentials?principalId=${encodeURIComponent(principalId)}`);
  return res.credentials;
}

export function deleteWebAuthnCredential(id: string): Promise<void> {
  return api.del(`/v1/webauthn/credentials/${encodeURIComponent(id)}`);
}
