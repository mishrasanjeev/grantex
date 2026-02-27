import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/client.js';
import { hashApiKey } from '../lib/hash.js';
import { newScimTokenId, newScimUserId } from '../lib/ids.js';

// ─── SCIM response helpers ─────────────────────────────────────────────────

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA  = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

function scimError(detail: string, scimType: string, status: number) {
  return { schemas: [ERROR_SCHEMA], detail, scimType, status };
}

function rowToScimUser(r: Record<string, unknown>) {
  return {
    schemas: [USER_SCHEMA],
    id: r['id'],
    externalId: r['external_id'] ?? undefined,
    userName: r['user_name'],
    displayName: r['display_name'] ?? undefined,
    active: r['active'] ?? true,
    emails: (r['emails'] as Array<{ value: string; primary?: boolean }>) ?? [],
    meta: {
      resourceType: 'User',
      created: r['created_at'],
      lastModified: r['updated_at'],
    },
  };
}

// ─── SCIM bearer token auth (used by SCIM 2.0 routes) ─────────────────────

async function validateScimBearer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const authHeader = request.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    await reply.status(401).send(scimError('Missing or invalid Bearer token', 'unauthorized', 401));
    return null;
  }
  const token = authHeader.slice(7);
  const tokenHash = hashApiKey(token);
  const sql = getSql();
  const rows = await sql<{ id: string; developer_id: string }[]>`
    SELECT id, developer_id FROM scim_tokens WHERE token_hash = ${tokenHash} LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    await reply.status(401).send(scimError('Invalid SCIM token', 'unauthorized', 401));
    return null;
  }
  return row.developer_id;
}

// ─── Routes ───────────────────────────────────────────────────────────────

export async function scimRoutes(app: FastifyInstance): Promise<void> {
  // ── SCIM token management (API-key auth, /v1/scim/tokens) ─────────────

  /** POST /v1/scim/tokens — create a new SCIM bearer token */
  app.post<{ Body: { label: string } }>('/v1/scim/tokens', async (request, reply) => {
    const { label } = request.body ?? {};
    if (!label) {
      return reply.status(400).send({ message: 'label is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashApiKey(rawToken);
    const id = newScimTokenId();
    const sql = getSql();
    const rows = await sql<{ id: string; label: string; created_at: string }[]>`
      INSERT INTO scim_tokens (id, developer_id, token_hash, label)
      VALUES (${id}, ${request.developer.id}, ${tokenHash}, ${label})
      RETURNING id, label, created_at
    `;
    const row = rows[0]!;
    return reply.status(201).send({
      id: row.id,
      label: row.label,
      token: rawToken,  // returned only on creation
      createdAt: row.created_at,
    });
  });

  /** GET /v1/scim/tokens — list SCIM tokens for this developer */
  app.get('/v1/scim/tokens', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<{ id: string; label: string; created_at: string; last_used_at: string | null }[]>`
      SELECT id, label, created_at, last_used_at
      FROM scim_tokens
      WHERE developer_id = ${request.developer.id}
      ORDER BY created_at DESC
    `;
    return reply.send({
      tokens: (rows as Array<Record<string, unknown>>).map((r) => ({
        id: r['id'],
        label: r['label'],
        createdAt: r['created_at'],
        lastUsedAt: r['last_used_at'] ?? null,
      })),
    });
  });

  /** DELETE /v1/scim/tokens/:id — revoke a SCIM token */
  app.delete<{ Params: { id: string } }>('/v1/scim/tokens/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      DELETE FROM scim_tokens
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send({ message: 'SCIM token not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.status(204).send();
  });

  // ── SCIM 2.0 Users (SCIM-token auth, /scim/v2/) ────────────────────────

  /** GET /scim/v2/ServiceProviderConfig — capabilities (public) */
  app.get(
    '/scim/v2/ServiceProviderConfig',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      return reply.send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: false, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            name: 'OAuth Bearer Token',
            description: 'Authentication scheme using the Bearer token',
            type: 'oauthbearertoken',
            primary: true,
          },
        ],
        meta: { resourceType: 'ServiceProviderConfig' },
      });
    },
  );

  /** GET /scim/v2/Users — list users */
  app.get('/scim/v2/Users', async (request, reply) => {
    const developerId = await validateScimBearer(request, reply);
    if (!developerId) return;

    const query = request.query as Record<string, string>;
    const startIndex = Math.max(1, Number(query['startIndex'] ?? 1));
    const count = Math.min(200, Math.max(1, Number(query['count'] ?? 100)));
    const offset = startIndex - 1;

    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, external_id, user_name, display_name, active, emails, created_at, updated_at
      FROM scim_users
      WHERE developer_id = ${developerId}
      ORDER BY created_at
      LIMIT ${count} OFFSET ${offset}
    `;

    const totalRows = await sql<{ total: string }[]>`
      SELECT COUNT(*) AS total FROM scim_users WHERE developer_id = ${developerId}
    `;
    const total = Number(totalRows[0]?.['total'] ?? 0);

    return reply.send({
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: count,
      Resources: (rows as Array<Record<string, unknown>>).map(rowToScimUser),
    });
  });

  /** POST /scim/v2/Users — provision a user */
  app.post<{
    Body: {
      userName: string;
      displayName?: string;
      externalId?: string;
      active?: boolean;
      emails?: Array<{ value: string; primary?: boolean }>;
    };
  }>('/scim/v2/Users', async (request, reply) => {
    const developerId = await validateScimBearer(request, reply);
    if (!developerId) return;

    const { userName, displayName, externalId, active = true, emails = [] } = request.body ?? {};
    if (!userName) {
      return reply.status(400).send(scimError('userName is required', 'invalidValue', 400));
    }

    const id = newScimUserId();
    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      INSERT INTO scim_users (id, developer_id, external_id, user_name, display_name, active, emails)
      VALUES (
        ${id}, ${developerId},
        ${externalId ?? null}, ${userName}, ${displayName ?? null},
        ${active}, ${JSON.stringify(emails)}
      )
      RETURNING id, external_id, user_name, display_name, active, emails, created_at, updated_at
    `;

    return reply.status(201).send(rowToScimUser(rows[0]!));
  });

  /** GET /scim/v2/Users/:id — get a user */
  app.get<{ Params: { id: string } }>('/scim/v2/Users/:id', async (request, reply) => {
    const developerId = await validateScimBearer(request, reply);
    if (!developerId) return;

    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, external_id, user_name, display_name, active, emails, created_at, updated_at
      FROM scim_users
      WHERE id = ${request.params.id} AND developer_id = ${developerId}
    `;
    if (!rows[0]) {
      return reply.status(404).send(scimError('User not found', 'noTarget', 404));
    }
    return reply.send(rowToScimUser(rows[0]));
  });

  /** PUT /scim/v2/Users/:id — full replace */
  app.put<{
    Params: { id: string };
    Body: {
      userName: string;
      displayName?: string;
      externalId?: string;
      active?: boolean;
      emails?: Array<{ value: string; primary?: boolean }>;
    };
  }>('/scim/v2/Users/:id', async (request, reply) => {
    const developerId = await validateScimBearer(request, reply);
    if (!developerId) return;

    const { userName, displayName, externalId, active = true, emails = [] } = request.body ?? {};
    if (!userName) {
      return reply.status(400).send(scimError('userName is required', 'invalidValue', 400));
    }

    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      UPDATE scim_users
      SET user_name    = ${userName},
          display_name = ${displayName ?? null},
          external_id  = ${externalId ?? null},
          active       = ${active},
          emails       = ${JSON.stringify(emails)},
          updated_at   = NOW()
      WHERE id = ${request.params.id} AND developer_id = ${developerId}
      RETURNING id, external_id, user_name, display_name, active, emails, created_at, updated_at
    `;
    if (!rows[0]) {
      return reply.status(404).send(scimError('User not found', 'noTarget', 404));
    }
    return reply.send(rowToScimUser(rows[0]));
  });

  /** PATCH /scim/v2/Users/:id — partial update via Operations */
  app.patch<{
    Params: { id: string };
    Body: { Operations: Array<{ op: string; path?: string; value: unknown }> };
  }>('/scim/v2/Users/:id', async (request, reply) => {
    const developerId = await validateScimBearer(request, reply);
    if (!developerId) return;

    const operations = request.body?.Operations ?? [];
    const patch: Record<string, unknown> = {};

    for (const op of operations) {
      const opLower = op.op.toLowerCase();
      if (opLower === 'replace' || opLower === 'add') {
        if (op.path === 'active' || op.path === 'userName' || op.path === 'displayName') {
          patch[op.path] = op.value;
        } else if (!op.path && typeof op.value === 'object' && op.value !== null) {
          Object.assign(patch, op.value);
        }
      }
    }

    const sql = getSql();
    const rows = await sql<Array<Record<string, unknown>>>`
      UPDATE scim_users
      SET user_name    = COALESCE(${(patch['userName'] as string | undefined) ?? null}, user_name),
          display_name = COALESCE(${(patch['displayName'] as string | undefined) ?? null}, display_name),
          active       = COALESCE(${(patch['active'] as boolean | undefined) ?? null}, active),
          updated_at   = NOW()
      WHERE id = ${request.params.id} AND developer_id = ${developerId}
      RETURNING id, external_id, user_name, display_name, active, emails, created_at, updated_at
    `;
    if (!rows[0]) {
      return reply.status(404).send(scimError('User not found', 'noTarget', 404));
    }
    return reply.send(rowToScimUser(rows[0]));
  });

  /** DELETE /scim/v2/Users/:id — deprovision a user */
  app.delete<{ Params: { id: string } }>('/scim/v2/Users/:id', async (request, reply) => {
    const developerId = await validateScimBearer(request, reply);
    if (!developerId) return;

    const sql = getSql();
    const rows = await sql`
      DELETE FROM scim_users
      WHERE id = ${request.params.id} AND developer_id = ${developerId}
      RETURNING id
    `;
    if (!rows[0]) {
      return reply.status(404).send(scimError('User not found', 'noTarget', 404));
    }
    return reply.status(204).send();
  });
}
