import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import {
  resolveTenantForDeveloper,
  resolveOrCreateTenantForDeveloper,
  isAutoTenantAllowed,
} from '../lib/commerce/tenant.js';
import { commerceErrorHandler, CommerceHttpError } from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import {
  newMerchantId,
  newCommerceAgentId,
  newCommerceProductId,
  newCommerceVariantId,
} from '../lib/commerce/ids.js';
import { isCommerceCategoryPreset } from '../lib/commerce/presets.js';

declare module 'fastify' {
  interface FastifyRequest {
    commerceTenantId: string;
  }
}

function isCommerceV1Enabled(): boolean {
  return process.env['COMMERCE_V1_ENABLED'] === 'true';
}

type Sql = ReturnType<typeof postgres>;

interface MerchantCreateBody {
  legal_name?: unknown;
  display_name?: unknown;
  category_preset?: unknown;
  country_code?: unknown;
  default_currency?: unknown;
  support_email?: unknown;
}

interface AgentCreateBody {
  display_name?: unknown;
  agent_type?: unknown;
  public_key_jwk?: unknown;
  api_key_hash?: unknown;
  trust_status?: unknown;
}

interface VariantInput {
  sku?: unknown;
  parent_sku?: unknown;
  model?: unknown;
  variant_title?: unknown;
  attributes?: unknown;
  price_amount?: unknown;
  currency?: unknown;
  tax_inclusive?: unknown;
  gst_slab?: unknown;
  tax_rate?: unknown;
  hsn_code?: unknown;
  availability_status?: unknown;
  warranty_summary?: unknown;
  return_policy_summary?: unknown;
  source_system?: unknown;
}

interface ProductCreateBody {
  product_id?: unknown;
  title?: unknown;
  brand?: unknown;
  description?: unknown;
  image_url?: unknown;
  category_preset?: unknown;
  source_system?: unknown;
  manually_maintained?: unknown;
  merchant_id?: unknown;
  variants?: unknown;
}

const TRUST_STATUS = new Set(['pending', 'trusted', 'suspended', 'disabled']);
const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && Math.trunc(v) === v) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

export async function commerceRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(commerceErrorHandler);

  // Single preHandler: feature-flag gate + tenant resolution.
  // Auth (request.developer) is already populated by the global authPlugin.
  app.addHook('preHandler', async (request) => {
    if (!isCommerceV1Enabled()) {
      throw new CommerceHttpError(
        503,
        'commerce_disabled',
        'Grantex Commerce V1 is not enabled in this environment',
        { retryable: false },
      );
    }
    const sql = getSql();
    const resolution = await resolveTenantForDeveloper(sql, request.developer.id);

    if (resolution.kind === 'resolved') {
      request.commerceTenantId = resolution.tenantId;
      return;
    }
    if (resolution.kind === 'disabled') {
      throw new CommerceHttpError(
        403,
        'tenant_disabled',
        'The commerce tenant mapped to this developer is disabled',
        {
          remediation:
            'Contact Grantex support to re-enable the tenant or to provision a replacement mapping.',
          retryable: false,
        },
      );
    }
    // resolution.kind === 'not_provisioned'
    if (isAutoTenantAllowed()) {
      request.commerceTenantId = await resolveOrCreateTenantForDeveloper(
        sql,
        request.developer.id,
        request.developer.name,
      );
      return;
    }
    throw new CommerceHttpError(
      422,
      'tenant_not_provisioned',
      'No commerce tenant is mapped to this developer in this environment',
      {
        remediation:
          'In staging/production, an operator must provision a commerce tenant and bind ' +
          'this developer to it via the M2 admin endpoints (POST /v1/commerce/tenants then ' +
          'POST /v1/commerce/developer-tenants). For local/sandbox testing only, ' +
          'set COMMERCE_ALLOW_AUTO_TENANT=true to enable auto-provisioning.',
        retryable: false,
      },
    );
  });

  // ----------------------------------------------------------------------
  // POST /merchants
  // ----------------------------------------------------------------------
  app.post<{ Body: MerchantCreateBody }>('/merchants', async (request, reply) => {
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.legal_name)) fieldErrors['legal_name'] = 'required string';
    if (!isString(body.display_name)) fieldErrors['display_name'] = 'required string';
    if (!isCommerceCategoryPreset(body.category_preset)) {
      fieldErrors['category_preset'] = 'must be a known commerce category preset';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors }, retryable: false,
      });
    }

    const sql = getSql();
    const id = newMerchantId();
    const tenantId = request.commerceTenantId;

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_merchants (
          id, tenant_id, legal_name, display_name, category_preset,
          default_currency, country_code, support_email
        ) VALUES (
          ${id}, ${tenantId},
          ${body.legal_name as string},
          ${body.display_name as string},
          ${body.category_preset as string},
          ${isString(body.default_currency) ? (body.default_currency as string) : 'INR'},
          ${isString(body.country_code) ? (body.country_code as string) : 'IN'},
          ${isString(body.support_email) ? (body.support_email as string) : null}
        )
        RETURNING id, tenant_id, legal_name, display_name, category_preset,
                  verification_status, environment, agentic_commerce_enabled,
                  default_currency, country_code, support_email,
                  created_at, updated_at
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId: id,
        eventType: 'merchant.created',
        resourceType: 'merchant',
        resourceId: id,
        requestId: request.id,
        metadata: { display_name: body.display_name },
      });
      return { merchant: rows[0], auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: result.merchant,
      audit_event_id: result.auditEventId,
    });
  });

  // ----------------------------------------------------------------------
  // GET /merchants/:merchantId
  // ----------------------------------------------------------------------
  app.get<{ Params: { merchantId: string } }>('/merchants/:merchantId', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, legal_name, display_name, category_preset,
             verification_status, environment, agentic_commerce_enabled,
             default_currency, country_code, support_email,
             disabled_at, created_at, updated_at
      FROM commerce_merchants
      WHERE id = ${request.params.merchantId}
        AND tenant_id = ${request.commerceTenantId}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    return reply.status(200).send({ data: rows[0] });
  });

  // ----------------------------------------------------------------------
  // POST /agents
  // ----------------------------------------------------------------------
  app.post<{ Body: AgentCreateBody }>('/agents', async (request, reply) => {
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.display_name)) fieldErrors['display_name'] = 'required string';
    const agentType = isString(body.agent_type) ? body.agent_type : 'sales';
    const trustStatus = isString(body.trust_status) ? body.trust_status : 'pending';
    if (!TRUST_STATUS.has(trustStatus)) {
      fieldErrors['trust_status'] = 'must be one of: pending, trusted, suspended, disabled';
    }
    const hasJwk = isPlainObject(body.public_key_jwk);
    const hasKeyHash = isString(body.api_key_hash);
    if (!hasJwk && !hasKeyHash) {
      fieldErrors['public_key_jwk'] = 'either public_key_jwk or api_key_hash is required';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors }, retryable: false,
      });
    }

    const sql = getSql();
    const id = newCommerceAgentId();
    const tenantId = request.commerceTenantId;

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_agents (
          id, tenant_id, display_name, agent_type,
          public_key_jwk, api_key_hash, trust_status
        ) VALUES (
          ${id}, ${tenantId},
          ${body.display_name as string},
          ${agentType},
          ${hasJwk ? JSON.stringify(body.public_key_jwk) : null}::jsonb,
          ${hasKeyHash ? (body.api_key_hash as string) : null},
          ${trustStatus}
        )
        RETURNING id, tenant_id, display_name, agent_type,
                  public_key_jwk, trust_status,
                  disabled_at, created_at, updated_at
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        agentId: id,
        eventType: 'commerce_agent.created',
        resourceType: 'commerce_agent',
        resourceId: id,
        requestId: request.id,
        metadata: { agent_type: agentType, trust_status: trustStatus },
      });
      return { agent: rows[0], auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: result.agent,
      audit_event_id: result.auditEventId,
    });
  });

  // ----------------------------------------------------------------------
  // GET /agents/:agentId
  // ----------------------------------------------------------------------
  app.get<{ Params: { agentId: string } }>('/agents/:agentId', async (request, reply) => {
    const sql = getSql();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, display_name, agent_type,
             public_key_jwk, trust_status,
             disabled_at, created_at, updated_at
      FROM commerce_agents
      WHERE id = ${request.params.agentId}
        AND tenant_id = ${request.commerceTenantId}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new CommerceHttpError(404, 'agent_not_found', 'Agent not found in this tenant');
    }
    return reply.status(200).send({ data: rows[0] });
  });

  // ----------------------------------------------------------------------
  // POST /catalog/products  — creates product + variants atomically
  // ----------------------------------------------------------------------
  app.post<{ Body: ProductCreateBody }>('/catalog/products', async (request, reply) => {
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.merchant_id)) fieldErrors['merchant_id'] = 'required string';
    if (!isString(body.product_id)) fieldErrors['product_id'] = 'required string';
    if (!isString(body.title)) fieldErrors['title'] = 'required string';
    if (!isCommerceCategoryPreset(body.category_preset)) {
      fieldErrors['category_preset'] = 'must be a known commerce category preset';
    }
    if (!Array.isArray(body.variants) || body.variants.length === 0) {
      fieldErrors['variants'] = 'at least one variant is required';
    } else {
      body.variants.forEach((v, i) => {
        const variant = v as VariantInput;
        if (!isString(variant.sku)) fieldErrors[`variants[${i}].sku`] = 'required string';
        if (asInt(variant.price_amount) === null || (asInt(variant.price_amount) as number) < 0) {
          fieldErrors[`variants[${i}].price_amount`] = 'required non-negative integer (minor units)';
        }
        const avail = isString(variant.availability_status) ? variant.availability_status : 'unknown';
        if (!AVAILABILITY.has(avail)) {
          fieldErrors[`variants[${i}].availability_status`] =
            'must be one of: in_stock, out_of_stock, pre_order, back_order, unknown';
        }
      });
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
        details: { fields: fieldErrors }, retryable: false,
      });
    }

    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const merchantId = body.merchant_id as string;

    // Tenant boundary: refuse cross-tenant merchant access up front.
    const merchantRows = await sql<{ id: string }[]>`
      SELECT id FROM commerce_merchants
      WHERE id = ${merchantId} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (!merchantRows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const productId = newCommerceProductId();
    const variants = body.variants as VariantInput[];

    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const productRows = await tx<Record<string, unknown>[]>`
        INSERT INTO commerce_products (
          id, tenant_id, merchant_id, product_id, title, brand, description,
          image_url, category_preset, source_system, manually_maintained
        ) VALUES (
          ${productId}, ${tenantId}, ${merchantId},
          ${body.product_id as string},
          ${body.title as string},
          ${isString(body.brand) ? (body.brand as string) : null},
          ${isString(body.description) ? (body.description as string) : null},
          ${isString(body.image_url) ? (body.image_url as string) : null},
          ${body.category_preset as string},
          ${isString(body.source_system) ? (body.source_system as string) : 'manual'},
          ${typeof body.manually_maintained === 'boolean' ? body.manually_maintained : false}
        )
        RETURNING id, tenant_id, merchant_id, product_id, title, brand,
                  description, image_url, category_preset, source_system,
                  manually_maintained, archived_at, created_at, updated_at
      `;

      const variantRows: Record<string, unknown>[] = [];
      for (const v of variants) {
        const vid = newCommerceVariantId();
        const inserted = await tx<Record<string, unknown>[]>`
          INSERT INTO commerce_product_variants (
            id, tenant_id, merchant_id, product_id, sku, parent_sku, model,
            variant_title, attributes, price_amount, currency, tax_inclusive,
            gst_slab, tax_rate, hsn_code, availability_status,
            warranty_summary, return_policy_summary, source_system
          ) VALUES (
            ${vid}, ${tenantId}, ${merchantId}, ${productId},
            ${v.sku as string},
            ${isString(v.parent_sku) ? (v.parent_sku as string) : null},
            ${isString(v.model) ? (v.model as string) : null},
            ${isString(v.variant_title) ? (v.variant_title as string) : null},
            ${JSON.stringify(isPlainObject(v.attributes) ? v.attributes : {})}::jsonb,
            ${asInt(v.price_amount) as number},
            ${isString(v.currency) ? (v.currency as string) : 'INR'},
            ${typeof v.tax_inclusive === 'boolean' ? v.tax_inclusive : true},
            ${isString(v.gst_slab) ? (v.gst_slab as string) : null},
            ${typeof v.tax_rate === 'number' ? v.tax_rate : null},
            ${isString(v.hsn_code) ? (v.hsn_code as string) : null},
            ${isString(v.availability_status) ? (v.availability_status as string) : 'unknown'},
            ${isString(v.warranty_summary) ? (v.warranty_summary as string) : null},
            ${isString(v.return_policy_summary) ? (v.return_policy_summary as string) : null},
            ${isString(v.source_system) ? (v.source_system as string) : 'manual'}
          )
          RETURNING id, sku, price_amount, currency, tax_inclusive, gst_slab,
                    tax_rate, hsn_code, availability_status, archived_at
        `;
        if (inserted[0]) variantRows.push(inserted[0]);
      }

      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'product.created',
        resourceType: 'product',
        resourceId: productId,
        requestId: request.id,
        metadata: { product_id: body.product_id, variant_count: variantRows.length },
      });
      return { product: productRows[0], variants: variantRows, auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: { ...result.product, variants: result.variants },
      audit_event_id: result.auditEventId,
    });
  });

  // ----------------------------------------------------------------------
  // GET /catalog/products/:productId
  // ----------------------------------------------------------------------
  app.get<{ Params: { productId: string } }>('/catalog/products/:productId', async (request, reply) => {
    const sql = getSql();
    const productRows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, merchant_id, product_id, title, brand, description,
             image_url, category_preset, source_system, manually_maintained,
             archived_at, created_at, updated_at
      FROM commerce_products
      WHERE id = ${request.params.productId}
        AND tenant_id = ${request.commerceTenantId}
      LIMIT 1
    `;
    if (!productRows[0]) {
      throw new CommerceHttpError(404, 'product_not_found', 'Product not found in this tenant');
    }
    const variantRows = await sql<Record<string, unknown>[]>`
      SELECT id, sku, parent_sku, model, variant_title, attributes,
             price_amount, currency, tax_inclusive, gst_slab, tax_rate,
             hsn_code, availability_status, warranty_summary,
             return_policy_summary, source_system, last_synced_at,
             archived_at
      FROM commerce_product_variants
      WHERE product_id = ${request.params.productId}
        AND tenant_id = ${request.commerceTenantId}
      ORDER BY created_at ASC
    `;
    return reply.status(200).send({
      data: { ...productRows[0], variants: variantRows },
    });
  });

  // ----------------------------------------------------------------------
  // DELETE /catalog/products/:productId  — soft-delete (archive)
  // ----------------------------------------------------------------------
  app.delete<{ Params: { productId: string } }>('/catalog/products/:productId', async (request, reply) => {
    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const updated = await tx<Record<string, unknown>[]>`
        UPDATE commerce_products
           SET archived_at = NOW(), updated_at = NOW()
         WHERE id = ${request.params.productId}
           AND tenant_id = ${tenantId}
           AND archived_at IS NULL
         RETURNING id, merchant_id, archived_at
      `;
      if (!updated[0]) return null;
      // Archive all active variants of this product.
      await tx`
        UPDATE commerce_product_variants
           SET archived_at = NOW(), updated_at = NOW()
         WHERE product_id = ${request.params.productId}
           AND tenant_id = ${tenantId}
           AND archived_at IS NULL
      `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId: updated[0]['merchant_id'] as string,
        eventType: 'product.archived',
        resourceType: 'product',
        resourceId: request.params.productId,
        requestId: request.id,
      });
      return { product: updated[0], auditEventId: audit.id };
    });
    if (!result) {
      throw new CommerceHttpError(404, 'product_not_found',
        'Product not found in this tenant or already archived');
    }
    return reply.status(200).send({
      data: result.product,
      audit_event_id: result.auditEventId,
    });
  });

  // ----------------------------------------------------------------------
  // GET /audit/events
  // ----------------------------------------------------------------------
  app.get<{
    Querystring: {
      merchant_id?: string;
      agent_id?: string;
      event_type?: string;
      passport_jti?: string;
      from?: string;
      to?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/audit/events', async (request, reply) => {
    const sql = getSql();
    const tenantId = request.commerceTenantId;
    const limit = Math.min(Math.max(asInt(request.query.limit) ?? 25, 1), 100);
    // Cursor: opaque base64 of "<occurred_at_iso>|<id>". Tail-only paging.
    let cursorOccurred: string | null = null;
    let cursorId: string | null = null;
    if (request.query.cursor) {
      try {
        const decoded = Buffer.from(request.query.cursor, 'base64url').toString('utf8');
        const [occ, id] = decoded.split('|');
        if (occ && id) { cursorOccurred = occ; cursorId = id; }
      } catch { /* ignore malformed cursor */ }
    }
    const merchantId = isString(request.query.merchant_id) ? request.query.merchant_id : null;
    const agentId = isString(request.query.agent_id) ? request.query.agent_id : null;
    const eventType = isString(request.query.event_type) ? request.query.event_type : null;
    const passportJti = isString(request.query.passport_jti) ? request.query.passport_jti : null;
    const fromTs = isString(request.query.from) ? request.query.from : null;
    const toTs = isString(request.query.to) ? request.query.to : null;

    // Single tagged template: NULL-checks on each optional filter keep the
    // shape stable (no SQL fragment composition required by the test mock).
    const rows = await sql<Record<string, unknown>[]>`
      SELECT id, tenant_id, merchant_id, agent_id, user_principal_id,
             event_type, resource_type, resource_id, passport_jti,
             policy_version, decision_id, idempotency_key_hash, request_id,
             occurred_at, metadata
        FROM commerce_audit_events
       WHERE tenant_id = ${tenantId}
         AND (${merchantId}::text IS NULL OR merchant_id = ${merchantId})
         AND (${agentId}::text IS NULL OR agent_id = ${agentId})
         AND (${eventType}::text IS NULL OR event_type = ${eventType})
         AND (${passportJti}::text IS NULL OR passport_jti = ${passportJti})
         AND (${fromTs}::timestamptz IS NULL OR occurred_at >= ${fromTs}::timestamptz)
         AND (${toTs}::timestamptz IS NULL OR occurred_at <= ${toTs}::timestamptz)
         AND (
           ${cursorOccurred}::timestamptz IS NULL
           OR (occurred_at, id) < (${cursorOccurred}::timestamptz, ${cursorId}::text)
         )
       ORDER BY occurred_at DESC, id DESC
       LIMIT ${limit + 1}
    `;
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      if (last) {
        const occVal = last['occurred_at'];
        const occIso = occVal instanceof Date
          ? occVal.toISOString()
          : String(occVal);
        const enc = `${occIso}|${last['id'] as string}`;
        nextCursor = Buffer.from(enc, 'utf8').toString('base64url');
      }
      rows.length = limit;
    }
    return reply.status(200).send({ items: rows, next_cursor: nextCursor });
  });
}
