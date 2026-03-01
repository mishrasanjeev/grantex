import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/client.js';
import { newVaultCredentialId } from '../lib/ids.js';
import { encrypt, decrypt } from '../lib/vault-crypto.js';
import { verifyGrantToken } from '../lib/crypto.js';

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
}

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

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/vault/credentials — store encrypted credential
  app.post<{ Body: StoreCredentialBody }>('/v1/vault/credentials', async (request, reply) => {
    const { principalId, service, credentialType, accessToken, refreshToken, tokenExpiresAt, metadata } = request.body;

    if (!principalId || !service || !accessToken) {
      return reply.status(400).send({
        message: 'principalId, service, and accessToken are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    const id = newVaultCredentialId();

    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;

    await sql`
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
    `;

    return reply.status(201).send({
      id,
      principalId,
      service,
      credentialType: credentialType ?? 'oauth2',
      createdAt: new Date().toISOString(),
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
  app.delete<{ Params: { id: string } }>('/v1/vault/credentials/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM vault_credentials
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send({
        message: 'Credential not found',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }
    return reply.status(204).send();
  });

  // POST /v1/vault/credentials/exchange — exchange grant token for upstream credential
  app.post<{ Body: ExchangeCredentialBody }>(
    '/v1/vault/credentials/exchange',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.status(401).send({
          message: 'Missing grant token',
          code: 'UNAUTHORIZED',
          requestId: request.id,
        });
      }

      const grantToken = auth.slice(7);
      let claims: { sub: string; dev: string; scp: string[] };
      try {
        claims = await verifyGrantToken(grantToken);
      } catch {
        return reply.status(401).send({
          message: 'Invalid or expired grant token',
          code: 'UNAUTHORIZED',
          requestId: request.id,
        });
      }

      const { service } = request.body;
      if (!service) {
        return reply.status(400).send({
          message: 'service is required',
          code: 'BAD_REQUEST',
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

      const accessToken = decrypt(cred['access_token'] as string);

      return reply.send({
        accessToken,
        service,
        credentialType: cred['credential_type'],
        tokenExpiresAt: cred['token_expires_at'] ?? null,
        metadata: cred['metadata'] ?? {},
      });
    },
  );
}
