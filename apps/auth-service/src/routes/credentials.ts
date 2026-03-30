import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { verifyAgentGrantVC, buildStatusListCredential } from '../lib/vc.js';
import { verifySDJWT } from '../lib/sd-jwt.js';
import { newPresentationId } from '../lib/ids.js';
import { emitEvent } from '../lib/events.js';

export async function credentialsRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/credentials/:id — retrieve a VC (protected)
  app.get<{ Params: { id: string } }>(
    '/v1/credentials/:id',
    async (request, reply) => {
      const { id } = request.params;
      const sql = getSql();
      const developerId = request.developer.id;

      const rows = await sql`
        SELECT id, grant_id, developer_id, principal_id, agent_did,
               credential_type, format, credential_jwt, status,
               status_list_idx, issued_at, expires_at, revoked_at
        FROM verifiable_credentials
        WHERE id = ${id} AND developer_id = ${developerId}
      `;

      const vc = rows[0];
      if (!vc) {
        return reply.status(404).send({
          message: 'Credential not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send({
        id: vc['id'],
        grantId: vc['grant_id'],
        developerId: vc['developer_id'],
        principalId: vc['principal_id'],
        agentDid: vc['agent_did'],
        credentialType: vc['credential_type'],
        format: vc['format'],
        credentialJwt: vc['credential_jwt'],
        status: vc['status'],
        statusListIdx: vc['status_list_idx'],
        issuedAt: (vc['issued_at'] as Date).toISOString(),
        expiresAt: (vc['expires_at'] as Date).toISOString(),
        revokedAt: vc['revoked_at'] ? (vc['revoked_at'] as Date).toISOString() : null,
      });
    },
  );

  // GET /v1/credentials — list VCs with filters (protected)
  app.get<{ Querystring: { grantId?: string; principalId?: string; status?: string } }>(
    '/v1/credentials',
    async (request, reply) => {
      const sql = getSql();
      const developerId = request.developer.id;
      const { grantId, principalId, status } = request.query;

      const rows = await sql`
        SELECT id, grant_id, developer_id, principal_id, agent_did,
               credential_type, format, credential_jwt, status,
               status_list_idx, issued_at, expires_at, revoked_at
        FROM verifiable_credentials
        WHERE developer_id = ${developerId}
          AND (${grantId ?? null}::TEXT IS NULL OR grant_id = ${grantId ?? null})
          AND (${principalId ?? null}::TEXT IS NULL OR principal_id = ${principalId ?? null})
          AND (${status ?? null}::TEXT IS NULL OR status = ${status ?? null})
        ORDER BY issued_at DESC
        LIMIT 100
      `;

      const credentials = rows.map((vc) => ({
        id: vc['id'],
        grantId: vc['grant_id'],
        developerId: vc['developer_id'],
        principalId: vc['principal_id'],
        agentDid: vc['agent_did'],
        credentialType: vc['credential_type'],
        format: vc['format'],
        credentialJwt: vc['credential_jwt'],
        status: vc['status'],
        statusListIdx: vc['status_list_idx'],
        issuedAt: (vc['issued_at'] as Date).toISOString(),
        expiresAt: (vc['expires_at'] as Date).toISOString(),
        revokedAt: vc['revoked_at'] ? (vc['revoked_at'] as Date).toISOString() : null,
      }));

      return reply.send({ credentials });
    },
  );

  // POST /v1/credentials/verify — verify a VC-JWT (public, skipAuth)
  app.post<{ Body: { credential: string } }>(
    '/v1/credentials/verify',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { credential } = request.body;
      if (!credential) {
        return reply.status(400).send({
          message: 'credential is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const result = await verifyAgentGrantVC(credential);
      return reply.send(result);
    },
  );

  // GET /v1/credentials/status/:listId — StatusList2021 credential (public, skipAuth)
  app.get<{ Params: { listId: string } }>(
    '/v1/credentials/status/:listId',
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { listId } = request.params;
      const statusListCredential = await buildStatusListCredential(listId);

      if (!statusListCredential) {
        return reply.status(404).send({
          message: 'Status list not found',
          code: 'NOT_FOUND',
          requestId: request.id,
        });
      }

      return reply.send(statusListCredential);
    },
  );

  // POST /v1/credentials/present — verify an SD-JWT presentation (public, skipAuth)
  app.post<{ Body: { sdJwt: string; nonce?: string; audience?: string } }>(
    '/v1/credentials/present',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { sdJwt } = request.body;
      if (!sdJwt) {
        return reply.status(400).send({
          message: 'sdJwt is required',
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }

      const result = await verifySDJWT(sdJwt);

      if (result.valid) {
        const presentationId = newPresentationId();

        // Extract developerId from disclosed claims for event emission (best-effort)
        const developerId = result.disclosedClaims?.['developerId'] as string | undefined;
        if (developerId) {
          emitEvent(developerId, 'sd-jwt.presented', {
            presentationId,
            vcId: result.vcId,
          }).catch(() => {});
        }
      }

      return reply.send(result);
    },
  );
}
