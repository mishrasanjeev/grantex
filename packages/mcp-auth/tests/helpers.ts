import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { InMemoryStorage } from '../src/storage/memory.js';
import { hashClientSecret } from '../src/lib/verify.js';
import type { ClientRegistration, McpAuthConfig } from '../src/types.js';

export const TEST_CLIENT_ID = 'test-client-id';
export const TEST_CLIENT_SECRET = 'test-secret';
export const TEST_REDIRECT_URI = 'https://app.example.com/callback';
export const TEST_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const TEST_CHALLENGE = createHash('sha256').update(TEST_VERIFIER).digest('base64url');

/**
 * A registration as the server stores it. Pass `clientSecret` to register a
 * confidential client (only its hash is stored) or `publicClient: true` for a
 * PKCE-only client.
 */
export function clientRecord(
  options: Partial<Omit<ClientRegistration, 'clientSecretHash'>> & { clientSecret?: string; publicClient?: boolean } = {},
): ClientRegistration {
  const { clientSecret, publicClient, ...rest } = options;
  return {
    clientId: TEST_CLIENT_ID,
    redirectUris: [TEST_REDIRECT_URI],
    grantTypes: ['authorization_code'],
    createdAt: new Date().toISOString(),
    ...(publicClient
      ? { tokenEndpointAuthMethod: 'none' as const }
      : { tokenEndpointAuthMethod: 'client_secret_basic' as const, clientSecretHash: hashClientSecret(clientSecret ?? TEST_CLIENT_SECRET) }),
    ...rest,
  };
}

/** Storage seeded with the given client registrations. */
export async function seededStorage(...clients: ClientRegistration[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  for (const client of clients) await storage.putClient(client);
  return storage;
}

export function mockGrantex(options: { sandboxCode?: string } = {}) {
  return {
    authorize: vi.fn().mockResolvedValue({
      authRequestId: 'auth-req-1',
      consentUrl: 'https://grantex.example.com/consent',
      agentId: 'agent-1',
      principalId: 'principal-1',
      scopes: ['read', 'write'],
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: options.sandboxCode ? ('approved' as const) : ('pending' as const),
      createdAt: new Date().toISOString(),
      ...(options.sandboxCode ? { sandbox: true, code: options.sandboxCode } : {}),
    }),
    tokens: {
      exchange: vi.fn().mockResolvedValue({
        grantToken: 'gt_test_token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_test_refresh',
        grantId: 'grant-1',
      }),
      refresh: vi.fn().mockResolvedValue({
        grantToken: 'gt_refreshed_token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_new_refresh',
        grantId: 'grant-1',
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
  };
}

export type MockGrantex = ReturnType<typeof mockGrantex>;

export function asGrantex(mock: MockGrantex): McpAuthConfig['grantex'] {
  return mock as unknown as McpAuthConfig['grantex'];
}
