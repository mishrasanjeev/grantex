import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/client.js';
import { newVaultCredentialId, newVaultCredentialReferenceId } from '../lib/ids.js';
import { getRedis } from '../redis/client.js';
import { encrypt, decrypt } from '../lib/vault-crypto.js';
import { checkActiveGrantToken } from '../lib/active-grant-token.js';
import { config } from '../config.js';
import { DpopError, verifyDpopProof } from '../lib/dpop.js';
import { emitEvent } from '../lib/events.js';

interface StoreCredentialBody {
  principalId: string;
  service: string;
  credentialType?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  metadata?: Record<string, unknown>;
}

interface ExchangeCredentialBody {
  service: string;
  /** `token` (the default) returns the credential; `reference` returns a handle the relying party resolves. */
  delivery?: string;
}

interface ResolveCredentialBody {
  credentialRef: string;
  grantId: string;
}

const CREDENTIAL_REFERENCE_PATTERN = /^vcr_[0-9A-HJKMNP-TV-Z]{26}$/;

function toCredentialResponse(row: Record<string, unknown>) {
  return {
    id: row['id'],
    principalId: row['principal_id'],
    service: row['service'],
    credentialType: row['credential_type'],
    tokenExpiresAt: row['token_expires_at'] ?? null,
    metadata: row['metadata'] ?? {},
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}

function isValidServiceName(service: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(service);
}

/**
 * Releasing the raw upstream OAuth token is strictly more powerful than any
 * `<service>:read` grant, so it needs its own explicit, exactly-matched scope
 * (the tree moved to exact-match scopes; wildcards and `<service>:read` no
 * longer unlock exchange).
 */
export function vaultExchangeScope(service: string): string {
  return `vault:${service.toLowerCase()}:exchange`;
}

function canExchangeCredential(scopes: string[], service: string): boolean {
  const required = vaultExchangeScope(service);
  return scopes.some((scope) => scope.toLowerCase() === required);
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/vault/credentials — store encrypted credential
  app.post<{ Body: StoreCredentialBody }>('/v1/vault/credentials', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { principalId, service, credentialType, accessToken, refreshToken, tokenExpiresAt, metadata } = request.body;

    if (!principalId || !service || !accessToken) {
      return reply.status(400).send({
        message: 'principalId, service, and accessToken are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (!isValidServiceName(service)) {
      return reply.status(400).send({
        message: 'service must be 1-64 characters and contain only letters, numbers, dot, underscore, or dash',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    const id = newVaultCredentialId();

    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;

    const rows = await sql`
      INSERT INTO vault_credentials (id, developer_id, principal_id, service, credential_type, access_token, refresh_token, token_expires_at, metadata)
      VALUES (
        ${id}, ${developerId}, ${principalId}, ${service},
        ${credentialType ?? 'oauth2'}, ${encryptedAccess}, ${encryptedRefresh},
        ${tokenExpiresAt ?? null}, ${JSON.stringify(metadata ?? {})}
      )
      ON CONFLICT (developer_id, principal_id, service) DO UPDATE SET
        access_token = ${encryptedAccess},
        refresh_token = ${encryptedRefresh},
        credential_type = ${credentialType ?? 'oauth2'},
        token_expires_at = ${tokenExpiresAt ?? null},
        metadata = ${JSON.stringify(metadata ?? {})},
        updated_at = NOW()
      RETURNING id, principal_id, service, credential_type, created_at
    `;

    const row = rows[0]!;

    emitEvent(developerId, 'vault.credential.stored', {
      credentialId: row['id'],
      principalId,
      service,
    }).catch(() => {});

    return reply.status(201).send({
      id: row['id'],
      principalId: row['principal_id'],
      service: row['service'],
      credentialType: row['credential_type'],
      createdAt: row['created_at'],
    });
  });

  // GET /v1/vault/credentials — list credentials (metadata only)
  app.get('/v1/vault/credentials', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;

    const principalId = query['principalId'] ?? null;
    const service = query['service'] ?? null;

    const rows = await sql`
      SELECT id, principal_id, service, credential_type, token_expires_at, metadata, created_at, updated_at
      FROM vault_credentials
      WHERE developer_id = ${developerId}
        AND (${principalId}::text IS NULL OR principal_id = ${principalId ?? ''})
        AND (${service}::text IS NULL OR service = ${service ?? ''})
      ORDER BY created_at DESC
    `;

    return reply.send({ credentials: rows.map(toCredentialResponse) });
  });

  // GET /v1/vault/credentials/:id — get credential metadata (no raw token)
  app.get<{ Params: { id: string } }>('/v1/vault/credentials/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, principal_id, service, credential_type, token_expires_at, metadata, created_at, updated_at
      FROM vault_credentials
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    const cred = rows[0];
    if (!cred) {
      return reply.status(404).send({
        message: 'Credential not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }
    return reply.send(toCredentialResponse(cred));
  });

  // DELETE /v1/vault/credentials/:id — delete credential
  app.delete<{ Params: { id: string } }>('/v1/vault/credentials/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM vault_credentials
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id, principal_id, service
    `;
    if (!rows[0]) {
      return reply.status(404).send({
        message: 'Credential not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }
    emitEvent(request.developer.id, 'vault.credential.deleted', {
      credentialId: rows[0]['id'],
      principalId: rows[0]['principal_id'],
      service: rows[0]['service'],
    }).catch(() => {});
    return reply.status(204).send();
  });

  // POST /v1/vault/credentials/exchange — exchange grant token for upstream credential
  app.post<{ Body: ExchangeCredentialBody }>(
    '/v1/vault/credentials/exchange',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = request.headers.authorization;
      const authMatch = typeof auth === 'string' ? /^(?:Bearer|DPoP)[ \t]+([^\s]+)$/i.exec(auth) : null;
      if (!authMatch) {
        return reply.status(401).send({
          message: 'Missing grant token',
          code: 'UNAUTHORIZED',
          requestId: request.id,
        });
      }

      const grantToken = authMatch[1]!;
      const result = await checkActiveGrantToken(grantToken);
      if (!result.ok) {
        return reply.status(401).send({
          message: 'Invalid or expired grant token',
          code: 'UNAUTHORIZED',
          requestId: request.id,
        });
      }
      const { claims } = result;

      // Key-bound grant tokens (cnf.jkt) must prove possession of the bound
      // key: a bare bearer presentation of a stolen token must not release
      // the upstream credential (mirrors /oauth/resource).
      if (claims.cnf?.jkt) {
        try {
          const proof = await verifyDpopProof(request.headers.dpop, {
            method: 'POST',
            targetUri: `${config.publicBaseUrl.replace(/\/$/, '')}/v1/vault/credentials/exchange`,
            accessToken: grantToken,
          });
          if (proof.thumbprint !== claims.cnf.jkt) {
            reply.header('WWW-Authenticate', 'DPoP error="invalid_token"');
            return reply.status(401).send({
              message: 'The DPoP key does not match the grant token binding',
              code: 'DPOP_KEY_MISMATCH',
              requestId: request.id,
            });
          }
        } catch (error) {
          if (error instanceof DpopError) {
            reply.header('WWW-Authenticate', 'DPoP error="invalid_dpop_proof"');
            return reply.status(401).send({
              message: `Key-bound grant token requires a valid DPoP proof: ${error.message}`,
              code: 'INVALID_DPOP_PROOF',
              requestId: request.id,
            });
          }
          throw error;
        }
      }

      const { service } = request.body;
      if (!service) {
        return reply.status(400).send({
          message: 'service is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (!isValidServiceName(service)) {
        return reply.status(400).send({
          message: 'service must be 1-64 characters and contain only letters, numbers, dot, underscore, or dash',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (!canExchangeCredential(claims.scp, service)) {
        return reply.status(403).send({
          message: `Grant token is not scoped for ${service} credential exchange; the exact scope ${vaultExchangeScope(service)} is required (wildcards and ${service}:read do not unlock exchange)`,
          code: 'FORBIDDEN',
          requestId: request.id,
        });
      }
      const delivery = request.body.delivery ?? 'token';
      if (delivery !== 'token' && delivery !== 'reference') {
        return reply.status(400).send({
          message: 'delivery must be "token" or "reference"',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      if (delivery === 'reference' && !config.vaultCredentialReferencesEnabled) {
        // The agent asked not to receive the credential; handing it over anyway
        // would defeat the request, so the exchange is refused instead.
        return reply.status(400).send({
          message: 'Credential references are not enabled on this auth service (VAULT_CREDENTIAL_REFERENCES_ENABLED)',
          code: 'CREDENTIAL_REFERENCE_DISABLED',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const rows = await sql`
        SELECT id, access_token, refresh_token, token_expires_at, credential_type, metadata
        FROM vault_credentials
        WHERE developer_id = ${claims.dev}
          AND principal_id = ${claims.sub}
          AND service = ${service}
      `;

      const cred = rows[0];
      if (!cred) {
        return reply.status(404).send({
          message: 'No credential found for this principal and service',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      if (delivery === 'reference') {
        // By reference: the agent gets a handle bound to its grant; the relying
        // party that holds the developer's API key (the gateway) resolves it and
        // injects the credential upstream, so the agent never holds the secret.
        const referenceId = newVaultCredentialReferenceId();
        const expiresAt = new Date(Date.now() + config.vaultCredentialReferenceTtlSeconds * 1000);
        await sql`
          INSERT INTO vault_credential_references
            (id, developer_id, vault_credential_id, grant_id, principal_id, agent_did, service, expires_at)
          VALUES (
            ${referenceId}, ${claims.dev}, ${cred['id'] as string}, ${claims.grnt},
            ${claims.sub}, ${claims.agt}, ${service}, ${expiresAt.toISOString()}
          )
        `;
        emitEvent(claims.dev, 'vault.credential.reference_issued', {
          credentialId: cred['id'],
          referenceId,
          grantId: claims.grnt,
          principalId: claims.sub,
          service,
        }).catch(() => {});
        return reply.send({
          credentialRef: referenceId,
          service,
          credentialType: cred['credential_type'],
          tokenExpiresAt: cred['token_expires_at'] ?? null,
          metadata: cred['metadata'] ?? {},
          referenceExpiresAt: expiresAt.toISOString(),
        });
      }

      const accessToken = decrypt(cred['access_token'] as string);

      emitEvent(claims.dev, 'vault.credential.exchanged', {
        credentialId: cred['id'],
        grantId: claims.grnt,
        principalId: claims.sub,
        service,
      }).catch(() => {});

      return reply.send({
        accessToken,
        service,
        credentialType: cred['credential_type'],
        tokenExpiresAt: cred['token_expires_at'] ?? null,
        metadata: cred['metadata'] ?? {},
      });
    },
  );

  // POST /v1/vault/credentials/resolve — redeem a credential reference (developer API key: the relying party)
  app.post<{ Body: ResolveCredentialBody }>(
    '/v1/vault/credentials/resolve',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<ResolveCredentialBody>;
      const credentialRef = typeof body.credentialRef === 'string' ? body.credentialRef : '';
      const grantId = typeof body.grantId === 'string' ? body.grantId.trim() : '';
      if (!CREDENTIAL_REFERENCE_PATTERN.test(credentialRef) || !grantId || grantId.length > 128) {
        return reply.status(400).send({
          message: 'credentialRef (vcr_...) and grantId are required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const sql = getSql();
      const developerId = request.developer.id;
      const rows = await sql`
        SELECT r.id, r.grant_id, r.principal_id, r.agent_did, r.service, r.expires_at,
               c.access_token, c.credential_type, c.token_expires_at, c.metadata
        FROM vault_credential_references r
        JOIN vault_credentials c ON c.id = r.vault_credential_id
        WHERE r.id = ${credentialRef} AND r.developer_id = ${developerId}
      `;
      const ref = rows[0];
      if (!ref) {
        return reply.status(404).send({
          message: 'Credential reference not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }
      if (ref['grant_id'] !== grantId) {
        return reply.status(403).send({
          message: 'The credential reference was issued to another grant',
          code: 'GRANT_MISMATCH',
          requestId: request.id,
        });
      }
      if (new Date(ref['expires_at'] as string) <= new Date()) {
        return reply.status(410).send({
          message: 'The credential reference has expired; the agent must exchange again',
          code: 'CREDENTIAL_REFERENCE_EXPIRED',
          requestId: request.id,
        });
      }

      // Current authority: the grant must still be active. A revocation or an
      // emergency stop ends the reference with it, so a stopped agent's
      // credential is never injected again. The revocation cache is consulted
      // first; the grant row decides when the cache cannot be read.
      let revokedInCache = false;
      try {
        revokedInCache = Boolean(await getRedis().get(`revoked:grant:${grantId}`));
      } catch {
        revokedInCache = false;
      }
      const grantRows = await sql`
        SELECT status FROM grants WHERE id = ${grantId} AND developer_id = ${developerId}
      `;
      const grantStatus = grantRows[0]?.['status'];
      if (revokedInCache || grantStatus !== 'active') {
        return reply.status(403).send({
          message: 'The grant behind this credential reference is no longer active',
          code: 'GRANT_INACTIVE',
          requestId: request.id,
        });
      }

      const accessToken = decrypt(ref['access_token'] as string);
      await sql`
        UPDATE vault_credential_references
        SET resolved_count = resolved_count + 1, last_resolved_at = NOW()
        WHERE id = ${credentialRef}
      `;
      emitEvent(developerId, 'vault.credential.resolved', {
        referenceId: credentialRef,
        grantId,
        principalId: ref['principal_id'],
        service: ref['service'],
      }).catch(() => {});

      return reply.send({
        accessToken,
        service: ref['service'],
        credentialType: ref['credential_type'],
        tokenExpiresAt: ref['token_expires_at'] ?? null,
        metadata: ref['metadata'] ?? {},
        grantId,
        principalId: ref['principal_id'],
        agentDid: ref['agent_did'],
      });
    },
  );
}
