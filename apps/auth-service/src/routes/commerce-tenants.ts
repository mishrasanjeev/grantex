import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { newCommerceTenantId } from '../lib/commerce/ids.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';

type Sql = ReturnType<typeof postgres>;

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function operatorFromRequest(request: FastifyRequest): Extract<CommerceCaller, { kind: 'operator' }> {
  if (request.commerceCaller.kind !== 'operator') {
    throw new CommerceHttpError(403, 'operator_required',
      'Tenant provisioning requires operator (developer API key or platform admin) credentials');
  }
  return request.commerceCaller;
}

/**
 * Decision C — hybrid tenant authorization model:
 *   - createTenant: requires platform admin (ADMIN_API_KEY)
 *   - bindDeveloperToTenant: requires admin OR commerce_tenant_operators.role='owner'
 *     of that specific tenant
 *   - listTenants / patchTenant: requires admin OR owner of THAT tenant
 *
 * Tenant owners cannot create unrelated tenants, preserving the
 * separation of concerns the M1 acceptance report flagged.
 */
export async function commerceTenantsRoutes(app: FastifyInstance): Promise<void> {
  // POST /tenants — admin only
  app.post('/tenants', async (request, reply) => {
    const op = operatorFromRequest(request);
    if (!op.isPlatformAdmin) {
      throw new CommerceHttpError(403, 'admin_required',
        'Creating commerce tenants requires the platform admin key');
    }
    const body = (request.body ?? {}) as { display_name?: unknown; metadata?: unknown };
    if (!isString(body.display_name)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: { display_name: 'required string' } }, retryable: false,
      });
    }
    const sql = getSql();
    const id = newCommerceTenantId();

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_tenants (id, display_name, metadata)
        VALUES (
          ${id}, ${body.display_name as string},
          ${JSON.stringify(isPlainObject(body.metadata) ? body.metadata : {})}::jsonb
        )
        RETURNING id, display_name, status, metadata, created_at, updated_at
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId: id,
        eventType: 'tenant.created',
        resourceType: 'commerce_tenant',
        resourceId: id,
        requestId: request.id,
        metadata: { display_name: body.display_name, created_by_admin: true },
      });
      return { tenant: rows[0], auditEventId: audit.id };
    });
    return reply.status(201).send({ data: result.tenant, audit_event_id: result.auditEventId });
  });

  // GET /tenants — admin sees all; owner sees their own
  app.get('/tenants', async (request, reply) => {
    const op = operatorFromRequest(request);
    const sql = getSql();
    const rows = op.isPlatformAdmin
      ? await sql<Record<string, unknown>[]>`
          SELECT id, display_name, status, metadata, created_at, updated_at
            FROM commerce_tenants
           ORDER BY created_at DESC
           LIMIT 100
        `
      : await sql<Record<string, unknown>[]>`
          SELECT t.id, t.display_name, t.status, t.metadata, t.created_at, t.updated_at
            FROM commerce_tenants t
            JOIN commerce_tenant_operators op ON op.tenant_id = t.id
           WHERE op.developer_id = ${op.developerId}
           ORDER BY t.created_at DESC
           LIMIT 100
        `;
    return reply.status(200).send({ items: rows, next_cursor: null });
  });

  // PATCH /tenants/:tenant_id — admin or owner; mutable: display_name, status
  app.patch<{ Params: { tenant_id: string }; Body: { display_name?: unknown; status?: unknown } }>(
    '/tenants/:tenant_id',
    async (request, reply) => {
      const op = operatorFromRequest(request);
      const tenantId = request.params.tenant_id;
      if (!op.isPlatformAdmin) {
        const sql = getSql();
        const owns = await sql<{ ok: boolean }[]>`
          SELECT TRUE AS ok FROM commerce_tenant_operators
           WHERE developer_id = ${op.developerId} AND tenant_id = ${tenantId} AND role = 'owner'
           LIMIT 1
        `;
        if (!owns[0]) {
          throw new CommerceHttpError(403, 'tenant_owner_required',
            'Updating a commerce tenant requires admin or owner role on that tenant');
        }
      }
      const body = request.body ?? {};
      const fieldErrors: Record<string, string> = {};
      if (body.display_name !== undefined && !isString(body.display_name)) {
        fieldErrors['display_name'] = 'must be a non-empty string when provided';
      }
      if (body.status !== undefined
        && (typeof body.status !== 'string' || !['active', 'disabled'].includes(body.status))) {
        fieldErrors['status'] = 'must be "active" or "disabled" when provided';
      }
      if (Object.keys(fieldErrors).length) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: fieldErrors }, retryable: false });
      }

      const sql = getSql();
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const newDisplay = body.display_name as string | undefined;
        const newStatus = body.status as string | undefined;
        const rows = await tx<Record<string, unknown>[]>`
          UPDATE commerce_tenants
             SET display_name = COALESCE(${newDisplay ?? null}::text, display_name),
                 status = COALESCE(${newStatus ?? null}::text, status),
                 updated_at = NOW()
           WHERE id = ${tenantId}
           RETURNING id, display_name, status, metadata, created_at, updated_at
        `;
        if (!rows[0]) return null;
        const eventType = newStatus === 'disabled' ? 'tenant.disabled' : 'tenant.updated';
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          eventType,
          resourceType: 'commerce_tenant',
          resourceId: tenantId,
          requestId: request.id,
          metadata: {
            ...(newDisplay !== undefined ? { display_name: newDisplay } : {}),
            ...(newStatus !== undefined ? { status: newStatus } : {}),
          },
        });
        return { tenant: rows[0], auditEventId: audit.id };
      });
      if (!result) {
        throw new CommerceHttpError(404, 'tenant_not_found', 'Tenant not found');
      }
      return reply.status(200).send({ data: result.tenant, audit_event_id: result.auditEventId });
    },
  );

  // POST /developer-tenants — admin or owner
  app.post('/developer-tenants', async (request, reply) => {
    const op = operatorFromRequest(request);
    const body = (request.body ?? {}) as {
      developer_id?: unknown;
      tenant_id?: unknown;
      is_default?: unknown;
    };
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.developer_id)) fieldErrors['developer_id'] = 'required string';
    if (!isString(body.tenant_id)) fieldErrors['tenant_id'] = 'required string';
    const isDefault = body.is_default === true;
    if (Object.keys(fieldErrors).length) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }
    const developerId = body.developer_id as string;
    const tenantId = body.tenant_id as string;

    const sql = getSql();

    if (!op.isPlatformAdmin) {
      const owns = await sql<{ ok: boolean }[]>`
        SELECT TRUE AS ok FROM commerce_tenant_operators
         WHERE developer_id = ${op.developerId} AND tenant_id = ${tenantId} AND role = 'owner'
         LIMIT 1
      `;
      if (!owns[0]) {
        throw new CommerceHttpError(403, 'tenant_owner_required',
          'Binding a developer to a tenant requires admin or owner role on that tenant');
      }
    }

    // Validate the tenant exists (FK alone allows orphaned devs to be bound).
    const tenant = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM commerce_tenants WHERE id = ${tenantId} LIMIT 1
    `;
    if (!tenant[0]) {
      throw new CommerceHttpError(404, 'tenant_not_found', 'Tenant not found');
    }
    if (tenant[0].status === 'disabled') {
      throw new CommerceHttpError(409, 'tenant_disabled',
        'Cannot bind developers to a disabled tenant');
    }

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      // If is_default=true, clear the existing default first.
      if (isDefault) {
        await tx`
          UPDATE commerce_developer_tenants SET is_default = FALSE
           WHERE developer_id = ${developerId} AND is_default = TRUE
        `;
      }
      const rows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_developer_tenants (developer_id, tenant_id, is_default)
        VALUES (${developerId}, ${tenantId}, ${isDefault})
        ON CONFLICT (developer_id, tenant_id)
          DO UPDATE SET is_default = EXCLUDED.is_default
        RETURNING developer_id, tenant_id, is_default, created_at
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        eventType: 'developer_tenant.bound',
        resourceType: 'commerce_developer_tenant',
        resourceId: `${developerId}:${tenantId}`,
        requestId: request.id,
        metadata: { developer_id: developerId, is_default: isDefault },
      });
      return { mapping: rows[0], auditEventId: audit.id };
    });
    return reply.status(201).send({ data: result.mapping, audit_event_id: result.auditEventId });
  });
}
