import { describe, it, expect, beforeEach } from 'vitest';
import type { McpAuthStorage } from '../src/storage/types.js';
import type {
  AuthorizationCode,
  ClientRegistration,
  ConsentRecord,
  PendingAuthorization,
} from '../src/types.js';
import { hashClientSecret } from '../src/lib/verify.js';

export interface StorageHarness {
  storage: McpAuthStorage;
  /**
   * Returns every persisted row or key as raw text, to prove secrets are not
   * stored in the clear. Omitted for storage with no persisted form.
   */
  dump?: () => Promise<string>;
}

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}-${process.pid}-${Date.now()}-${sequence}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function codeRecord(overrides: Partial<AuthorizationCode> = {}): AuthorizationCode {
  return {
    clientId: 'client-a',
    redirectUri: 'https://app.example.com/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    scopes: ['tool:acme_kyb:read'],
    resource: 'https://mcp.example.com/mcp',
    grantexAuthRequestId: 'areq_01',
    grantexCode: 'upstream-code',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function pendingRecord(overrides: Partial<PendingAuthorization> = {}): PendingAuthorization {
  const { grantexCode: _unused, ...base } = codeRecord();
  return { ...base, clientState: 'client-state', ...overrides };
}

function consentRecord(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    clientId: 'client-a',
    redirectUri: 'https://app.example.com/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    scopes: ['tool:acme_kyb:read'],
    resource: 'https://mcp.example.com/mcp',
    csrfTokenHash: 'csrf-hash',
    browserBindingHash: 'binding-hash',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/**
 * The behaviour every McpAuthStorage implementation must have. Run against
 * the in-memory storage in unit tests and against real Postgres and Redis in
 * the integration suite.
 */
export function describeStorageContract(
  name: string,
  create: () => Promise<StorageHarness>,
  options: { skip?: boolean; noDump?: boolean } = {},
): void {
  const noDump = options.noDump === true;
  (options.skip ? describe.skip : describe)(`McpAuthStorage contract: ${name}`, () => {
    let harness: StorageHarness;
    let storage: McpAuthStorage;

    beforeEach(async () => {
      harness = await create();
      storage = harness.storage;
    });

    describe('clients', () => {
      it('stores, reads, replaces and deletes a registration', async () => {
        const clientId = unique('client');
        const client: ClientRegistration = {
          clientId,
          clientSecretHash: hashClientSecret('s3cret-value'),
          tokenEndpointAuthMethod: 'client_secret_basic',
          redirectUris: ['https://app.example.com/callback'],
          grantTypes: ['authorization_code', 'refresh_token'],
          clientName: 'Contract client',
          createdAt: new Date().toISOString(),
        };
        expect(await storage.getClient(clientId)).toBeUndefined();
        await storage.putClient(client);
        expect(await storage.getClient(clientId)).toEqual(client);

        await storage.putClient({ ...client, clientName: 'Renamed' });
        expect((await storage.getClient(clientId))?.clientName).toBe('Renamed');

        expect(await storage.deleteClient(clientId)).toBe(true);
        expect(await storage.getClient(clientId)).toBeUndefined();
        expect(await storage.deleteClient(clientId)).toBe(false);
      });

      it.skipIf(noDump)('never persists the client secret itself', async () => {
        const clientId = unique('client');
        await storage.putClient({
          clientId,
          clientSecretHash: hashClientSecret('plaintext-secret-marker'),
          redirectUris: ['https://app.example.com/callback'],
          grantTypes: ['authorization_code'],
          createdAt: new Date().toISOString(),
        });
        expect(await harness.dump!()).not.toContain('plaintext-secret-marker');
      });
    });

    describe('authorization codes', () => {
      it('returns a code exactly once', async () => {
        const code = unique('code');
        const record = codeRecord();
        await storage.putAuthorizationCode(code, record);
        expect(await storage.consumeAuthorizationCode(code)).toEqual(record);
        expect(await storage.consumeAuthorizationCode(code)).toBeUndefined();
      });

      it('single use is atomic: 25 concurrent consumers, exactly one winner', async () => {
        const code = unique('code');
        await storage.putAuthorizationCode(code, codeRecord());
        const results = await Promise.all(
          Array.from({ length: 25 }, () => storage.consumeAuthorizationCode(code)),
        );
        expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      });

      it('does not return an expired code', async () => {
        const code = unique('code');
        await storage.putAuthorizationCode(code, codeRecord({ expiresAt: Date.now() + 150 }));
        await sleep(400);
        expect(await storage.consumeAuthorizationCode(code)).toBeUndefined();
      });

      it('does not return a code stored already expired', async () => {
        const code = unique('code');
        await storage.putAuthorizationCode(code, codeRecord({ expiresAt: Date.now() - 1 }));
        expect(await storage.consumeAuthorizationCode(code)).toBeUndefined();
      });

      it('rejects a record without a finite expiry', async () => {
        await expect(
          storage.putAuthorizationCode(unique('code'), codeRecord({ expiresAt: Number.NaN })),
        ).rejects.toThrow(/expiresAt/);
      });

      it.skipIf(noDump)('stores codes (and the PKCE challenge binding) under a hash, not the code', async () => {
        const code = unique('code-plaintext-marker');
        await storage.putAuthorizationCode(code, codeRecord());
        const dump = await harness.dump!();
        expect(dump).not.toContain(code);
        expect(dump).toContain('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
        await storage.consumeAuthorizationCode(code);
      });
    });

    describe('pending authorizations', () => {
      it('takes a pending authorization exactly once, atomically', async () => {
        const id = unique('pending');
        const record = pendingRecord();
        await storage.putPendingAuthorization(id, record);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => storage.takePendingAuthorization(id)),
        );
        const winners = results.filter((result) => result !== undefined);
        expect(winners).toEqual([record]);
        expect(await storage.takePendingAuthorization(id)).toBeUndefined();
      });

      it('does not return an expired pending authorization', async () => {
        const id = unique('pending');
        await storage.putPendingAuthorization(id, pendingRecord({ expiresAt: Date.now() + 150 }));
        await sleep(400);
        expect(await storage.takePendingAuthorization(id)).toBeUndefined();
      });
    });

    describe('refresh token bindings', () => {
      it('takes a binding only for the client it belongs to', async () => {
        const token = unique('refresh');
        const binding = { clientId: 'client-a', resource: 'https://mcp.example.com/mcp', expiresAt: Date.now() + 60_000 };
        await storage.putRefreshTokenBinding(token, binding);

        expect(await storage.takeRefreshTokenBinding(token, 'client-b')).toBeUndefined();
        // The wrong client did not consume it.
        expect(await storage.takeRefreshTokenBinding(token, 'client-a')).toEqual(binding);
        expect(await storage.takeRefreshTokenBinding(token, 'client-a')).toBeUndefined();
      });

      it('two concurrent refreshes of one token: exactly one wins', async () => {
        const token = unique('refresh');
        await storage.putRefreshTokenBinding(token, { clientId: 'client-a', expiresAt: Date.now() + 60_000 });
        const results = await Promise.all(
          Array.from({ length: 10 }, () => storage.takeRefreshTokenBinding(token, 'client-a')),
        );
        expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      });

      it('does not return an expired binding and never stores the token', async () => {
        const token = unique('refresh-plaintext-marker');
        await storage.putRefreshTokenBinding(token, { clientId: 'client-a', expiresAt: Date.now() + 150 });
        if (!noDump) expect(await harness.dump!()).not.toContain(token);
        await sleep(400);
        expect(await storage.takeRefreshTokenBinding(token, 'client-a')).toBeUndefined();
      });
    });

    describe('consents', () => {
      it('takes a consent exactly once, atomically', async () => {
        const id = unique('consent');
        const record = consentRecord();
        await storage.putConsent(id, record);
        const results = await Promise.all(Array.from({ length: 10 }, () => storage.takeConsent(id)));
        expect(results.filter((result) => result !== undefined)).toEqual([record]);
      });

      it('does not return an expired consent', async () => {
        const id = unique('consent');
        await storage.putConsent(id, consentRecord({ expiresAt: Date.now() + 150 }));
        await sleep(400);
        expect(await storage.takeConsent(id)).toBeUndefined();
      });
    });

    describe('revocations', () => {
      it('reports a revoked jti until the token would have expired', async () => {
        const jti = unique('jti');
        expect(await storage.isTokenRevoked(jti)).toBe(false);
        await storage.revokeToken(jti, { clientId: 'client-a', revokedAt: Date.now(), expiresAt: Date.now() + 300 });
        expect(await storage.isTokenRevoked(jti)).toBe(true);
        await sleep(600);
        expect(await storage.isTokenRevoked(jti)).toBe(false);
      });

      it('revoking twice keeps the later expiry', async () => {
        const jti = unique('jti');
        await storage.revokeToken(jti, { revokedAt: Date.now(), expiresAt: Date.now() + 60_000 });
        await storage.revokeToken(jti, { revokedAt: Date.now(), expiresAt: Date.now() + 100 });
        await sleep(400);
        expect(await storage.isTokenRevoked(jti)).toBe(true);
      });
    });
  });
}
