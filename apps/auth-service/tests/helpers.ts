/**
 * Shared test helpers — builds the Fastify app and provides seed data.
 * Mock objects (sqlMock, mockRedis) are defined in setup.ts, which is
 * registered as a Vitest setupFile and properly hoisted.
 */
import { initKeys } from '../src/lib/crypto.js';
import { buildApp } from '../src/server.js';
import { sqlMock, mockRedis } from './setup.js';

export { sqlMock, mockRedis };

// ------------------------------------------------------------------
// Seed data
// ------------------------------------------------------------------
export const TEST_API_KEY = 'test-api-key-1234';
export const TEST_DEVELOPER = { id: 'dev_TEST', name: 'Test Developer', mode: 'live' };
export const TEST_SANDBOX_DEVELOPER = { ...TEST_DEVELOPER, mode: 'sandbox' };

export const TEST_AGENT = {
  id: 'ag_TEST01AGENTID',
  did: 'did:grantex:ag_TEST01AGENTID',
  developer_id: TEST_DEVELOPER.id,
  name: 'Test Agent',
  description: 'A test agent',
  scopes: ['read', 'write'],
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const TEST_GRANT = {
  id: 'grnt_TEST01',
  agent_id: TEST_AGENT.id,
  principal_id: 'user_123',
  developer_id: TEST_DEVELOPER.id,
  scopes: ['read'],
  status: 'active',
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  revoked_at: null,
};

// ------------------------------------------------------------------
// App factory — keys initialized once per test file
// ------------------------------------------------------------------
let keysInitialized = false;

export async function buildTestApp() {
  if (!keysInitialized) {
    await initKeys();
    keysInitialized = true;
  }
  return buildApp({ logger: false });
}

// ------------------------------------------------------------------
// Auth header
// ------------------------------------------------------------------
export function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

// ------------------------------------------------------------------
// seedAuth — prime the next SQL call to return [TEST_DEVELOPER].
// The auth preHandler is always the first SQL call in a request.
// ------------------------------------------------------------------
export function seedAuth() {
  sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
}

export function seedSandboxAuth() {
  sqlMock.mockResolvedValueOnce([TEST_SANDBOX_DEVELOPER]);
}
