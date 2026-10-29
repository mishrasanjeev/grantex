// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * OACP service-tenant enrolment (migration 137).
 *
 * Which tenants the AgenticOrg internal service token may act for. A tenant
 * is allowed when it is
 *   - on COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS (the bootstrap list: any
 *     merchant, exactly as before enrolment existed), or
 *   - enrolled with status `active` in oacp_service_tenant_enrolments: then a
 *     service caller must name one of the enrolled merchants.
 *
 * `serviceTenantAccess` is the one reader of both. Enrolment lookups are
 * cached in process for a few seconds; enrolment and revocation in this
 * process drop the entry at once, and other instances see the change within
 * the TTL.
 */
import type postgres from 'postgres';
import { ulid } from 'ulid';
import type { TxSql } from '../../db/client.js';

type Sql = ReturnType<typeof postgres>;

export const OACP_SERVICE_TENANT_SOURCE_SYSTEMS = ['shopify', 'catalog_upload'] as const;
export type OacpServiceTenantSourceSystem = typeof OACP_SERVICE_TENANT_SOURCE_SYSTEMS[number];

/** The merchant id rule of the other OACP routes (arbiter decisions, settlement evidence). */
export const OACP_MERCHANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MERCHANTS = 1000;

/** How long an enrolment lookup is reused in process. */
export const SERVICE_TENANT_ACCESS_TTL_MS = 15_000;

export interface OacpServiceTenantEnrolment {
  tenant_id: string;
  status: 'active' | 'revoked';
  merchant_ids: string[];
  source_systems: OacpServiceTenantSourceSystem[];
  evidence_ref: string | null;
  enrolled_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface ServiceTenantAccess {
  tenant_id: string;
  /** On COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS. */
  env_listed: boolean;
  /** The enrolment row, whatever its status, or null. */
  enrolment: OacpServiceTenantEnrolment | null;
  /** env_listed, or an active enrolment. */
  allowed: boolean;
}

export type ServiceTenantDecision =
  | 'allowed'
  | 'tenant_not_allowed'
  | 'tenant_revoked'
  | 'merchant_not_enrolled';

/** The bootstrap allowlist, read on every call so a changed environment takes effect at once. */
export function envServiceTenants(): Set<string> {
  return new Set(
    (process.env['COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function isTenantUuid(value: unknown): value is string {
  return typeof value === 'string' && TENANT_UUID_RE.test(value);
}

const cache = new Map<string, { enrolment: OacpServiceTenantEnrolment | null; expires: number }>();

/** Drop one tenant's cached enrolment, or all of them. */
export function invalidateServiceTenantAccess(tenantId?: string): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId.toLowerCase());
}

interface EnrolmentRow {
  tenant_id: string;
  status: 'active' | 'revoked';
  merchant_ids: string[] | null;
  source_systems: string[] | null;
  evidence_ref: string | null;
  enrolled_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toEnrolment(row: EnrolmentRow): OacpServiceTenantEnrolment {
  return {
    tenant_id: String(row.tenant_id).toLowerCase(),
    status: row.status,
    merchant_ids: [...(row.merchant_ids ?? [])],
    source_systems: [...(row.source_systems ?? [])] as OacpServiceTenantSourceSystem[],
    evidence_ref: row.evidence_ref,
    enrolled_at: iso(row.enrolled_at)!,
    updated_at: iso(row.updated_at)!,
    revoked_at: iso(row.revoked_at),
    revoked_reason: row.revoked_reason,
  };
}

const COLUMNS = 'tenant_id, status, merchant_ids, source_systems, evidence_ref, enrolled_at, updated_at, revoked_at, revoked_reason';

/** The stored enrolment, uncached. Only a UUID can be enrolled; anything else has none. */
export async function getServiceTenantEnrolment(sql: Sql | TxSql, tenantId: string): Promise<OacpServiceTenantEnrolment | null> {
  if (!isTenantUuid(tenantId)) return null;
  const rows = await sql.unsafe(`SELECT ${COLUMNS} FROM oacp_service_tenant_enrolments WHERE tenant_id = $1`, [tenantId.toLowerCase()]);
  const row = (rows as unknown as EnrolmentRow[] | undefined)?.[0];
  return row ? toEnrolment(row) : null;
}

/**
 * The service token's access to `tenantId`: the env list, then an
 * enrolment. Env-listed tenants never touch the database.
 */
export async function serviceTenantAccess(sql: Sql, tenantId: string | null | undefined): Promise<ServiceTenantAccess> {
  const id = typeof tenantId === 'string' ? tenantId : '';
  if (id.length > 0 && envServiceTenants().has(id)) {
    return { tenant_id: id, env_listed: true, enrolment: null, allowed: true };
  }
  if (!isTenantUuid(id)) return { tenant_id: id, env_listed: false, enrolment: null, allowed: false };
  const key = id.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  let enrolment: OacpServiceTenantEnrolment | null;
  if (hit && hit.expires > now) {
    enrolment = hit.enrolment;
  } else {
    enrolment = await getServiceTenantEnrolment(sql, key);
    cache.set(key, { enrolment, expires: now + SERVICE_TENANT_ACCESS_TTL_MS });
  }
  return { tenant_id: id, env_listed: false, enrolment, allowed: enrolment?.status === 'active' };
}

/**
 * Whether the service token may act for this tenant, and for this merchant.
 *
 * `merchantId` undefined: the route names no merchant, so only the tenant is
 * checked. A string (or null for a route whose merchant is optional and was
 * left out): an enrolled tenant needs it to be one of its merchants. An
 * env-listed tenant is never asked for one.
 */
export function decideServiceTenant(access: ServiceTenantAccess, merchantId?: string | null): ServiceTenantDecision {
  if (access.env_listed) return 'allowed';
  if (!access.enrolment) return 'tenant_not_allowed';
  if (access.enrolment.status !== 'active') return 'tenant_revoked';
  if (merchantId === undefined) return 'allowed';
  return typeof merchantId === 'string' && access.enrolment.merchant_ids.includes(merchantId)
    ? 'allowed'
    : 'merchant_not_enrolled';
}

/** May this tenant issue from the merchant's own catalogue upload? */
export function catalogUploadAllowed(access: ServiceTenantAccess | undefined): boolean {
  if (!access) return false;
  if (access.env_listed) return true;
  return access.enrolment?.status === 'active' && access.enrolment.source_systems.includes('catalog_upload');
}

// ── Enrolment ───────────────────────────────────────────────────────────────

export class ServiceTenantEnrolmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ServiceTenantEnrolmentError';
  }
}

export interface EnrolServiceTenantInput {
  tenant_id: string;
  merchant_id: string;
  source_system: OacpServiceTenantSourceSystem;
  evidence_ref: string | null;
}

function invalid(field: string, message: string): never {
  throw new ServiceTenantEnrolmentError(422, 'validation_failed', message, field);
}

/** Validates an enrolment body. Unknown members are refused. */
export function parseEnrolServiceTenantBody(body: unknown): EnrolServiceTenantInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!['tenant_id', 'merchant_id', 'source_system', 'evidence_ref'].includes(key)) {
      invalid('body', `unknown member ${JSON.stringify(key.slice(0, 64))}`);
    }
  }
  if (!isTenantUuid(b['tenant_id'])) invalid('tenant_id', 'must be a UUID');
  if (typeof b['merchant_id'] !== 'string' || !OACP_MERCHANT_ID_RE.test(b['merchant_id'])) {
    invalid('merchant_id', 'must match ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$');
  }
  if (!(OACP_SERVICE_TENANT_SOURCE_SYSTEMS as readonly unknown[]).includes(b['source_system'])) {
    invalid('source_system', `must be one of ${OACP_SERVICE_TENANT_SOURCE_SYSTEMS.join(', ')}`);
  }
  const evidence = b['evidence_ref'];
  if (evidence !== undefined && evidence !== null && (typeof evidence !== 'string' || !EVIDENCE_REF_RE.test(evidence))) {
    invalid('evidence_ref', 'must be an opaque reference of at most 256 characters');
  }
  return {
    tenant_id: (b['tenant_id'] as string).toLowerCase(),
    merchant_id: b['merchant_id'] as string,
    source_system: b['source_system'] as OacpServiceTenantSourceSystem,
    evidence_ref: typeof evidence === 'string' ? evidence : null,
  };
}

export function parseRevocationReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !REASON_RE.test(value)) invalid('reason_code', 'must match ^[a-z][a-z0-9_]{0,63}$');
  return value;
}

type EventType =
  | 'oacp.service_tenant.enrolled'
  | 'oacp.service_tenant.reactivated'
  | 'oacp.service_tenant.enrolment_refused'
  | 'oacp.service_tenant.revoked'
  | 'oacp.service_tenant.read';

export interface EnrolmentEventInput {
  tenant_id: string;
  event_type: EventType;
  actor: string;
  merchant_id?: string | null;
  source_system?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append one row to the enrolment audit trail. Returns its id. */
export async function appendServiceTenantEvent(sql: TxSql, input: EnrolmentEventInput): Promise<string> {
  const id = `osten_${ulid()}`;
  await sql`
    INSERT INTO oacp_service_tenant_enrolment_events
      (id, tenant_id, event_type, actor, merchant_id, source_system, request_id, metadata)
    VALUES (
      ${id}, ${input.tenant_id}, ${input.event_type}, ${input.actor}, ${input.merchant_id ?? null},
      ${input.source_system ?? null}, ${input.request_id ?? null}, ${sql.json((input.metadata ?? {}) as never)}
    )
  `;
  return id;
}

export interface EnrolmentOutcome {
  enrolment: OacpServiceTenantEnrolment;
  /** Whether this call created, widened or reactivated the enrolment. */
  changed: boolean;
  audit_event_id: string;
}

/**
 * Enrol `merchant_id` and `source_system` for a tenant, idempotently: the
 * arrays are unions, so the same call again changes nothing. A revoked
 * enrolment is refused (`service_tenant_revoked`, recorded) unless the
 * platform admin enrols, which reactivates it.
 */
export async function enrolServiceTenant(
  sql: Sql,
  input: EnrolServiceTenantInput,
  actor: { id: string; platformAdmin: boolean; requestId: string | null },
): Promise<EnrolmentOutcome> {
  const outcome = await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const rows = await tx.unsafe(
      `SELECT ${COLUMNS} FROM oacp_service_tenant_enrolments WHERE tenant_id = $1 FOR UPDATE`,
      [input.tenant_id],
    );
    const existing = (rows as unknown as EnrolmentRow[])[0];
    const event = { tenant_id: input.tenant_id, actor: actor.id, merchant_id: input.merchant_id,
      source_system: input.source_system, request_id: actor.requestId };

    if (!existing) {
      const inserted = await tx.unsafe(
        `INSERT INTO oacp_service_tenant_enrolments (tenant_id, status, merchant_ids, source_systems, evidence_ref)
         VALUES ($1, 'active', ARRAY[$2]::TEXT[], ARRAY[$3]::TEXT[], $4)
         RETURNING ${COLUMNS}`,
        [input.tenant_id, input.merchant_id, input.source_system, input.evidence_ref],
      );
      const enrolment = toEnrolment((inserted as unknown as EnrolmentRow[])[0]!);
      const audit_event_id = await appendServiceTenantEvent(tx, { ...event, event_type: 'oacp.service_tenant.enrolled',
        metadata: { created: true, evidence_ref: input.evidence_ref } });
      return { refused: false as const, enrolment, changed: true, audit_event_id };
    }

    const current = toEnrolment(existing);
    if (current.status === 'revoked' && !actor.platformAdmin) {
      const audit_event_id = await appendServiceTenantEvent(tx, { ...event, event_type: 'oacp.service_tenant.enrolment_refused',
        metadata: { refusal: 'service_tenant_revoked' } });
      return { refused: true as const, audit_event_id };
    }
    const reactivating = current.status === 'revoked';
    const merchantNew = !current.merchant_ids.includes(input.merchant_id);
    const sourceNew = !current.source_systems.includes(input.source_system);
    const evidenceNew = input.evidence_ref !== null && input.evidence_ref !== current.evidence_ref;
    if (merchantNew && current.merchant_ids.length >= MAX_MERCHANTS) {
      throw new ServiceTenantEnrolmentError(409, 'service_tenant_merchant_limit',
        `A tenant may enrol at most ${MAX_MERCHANTS} merchants`);
    }
    if (!reactivating && !merchantNew && !sourceNew && !evidenceNew) {
      const audit_event_id = await appendServiceTenantEvent(tx, { ...event, event_type: 'oacp.service_tenant.enrolled',
        metadata: { created: false, changed: false } });
      return { refused: false as const, enrolment: current, changed: false, audit_event_id };
    }
    const updated = await tx.unsafe(
      `UPDATE oacp_service_tenant_enrolments
          SET status = 'active',
              merchant_ids = ARRAY(SELECT DISTINCT m FROM unnest(merchant_ids || ARRAY[$2]::TEXT[]) AS m ORDER BY m),
              source_systems = ARRAY(SELECT DISTINCT s FROM unnest(source_systems || ARRAY[$3]::TEXT[]) AS s ORDER BY s),
              evidence_ref = COALESCE($4, evidence_ref),
              updated_at = NOW(),
              revoked_at = NULL,
              revoked_reason = NULL
        WHERE tenant_id = $1
        RETURNING ${COLUMNS}`,
      [input.tenant_id, input.merchant_id, input.source_system, input.evidence_ref],
    );
    const enrolment = toEnrolment((updated as unknown as EnrolmentRow[])[0]!);
    const audit_event_id = await appendServiceTenantEvent(tx, {
      ...event,
      event_type: reactivating ? 'oacp.service_tenant.reactivated' : 'oacp.service_tenant.enrolled',
      metadata: { created: false, changed: true, merchant_added: merchantNew, source_added: sourceNew,
        evidence_ref: input.evidence_ref, ...(reactivating ? { previous_revoked_reason: current.revoked_reason } : {}) },
    });
    return { refused: false as const, enrolment, changed: true, audit_event_id };
  });
  invalidateServiceTenantAccess(input.tenant_id);
  if (outcome.refused) {
    throw new ServiceTenantEnrolmentError(403, 'service_tenant_revoked',
      'This tenant\'s OACP service enrolment is revoked; only the platform admin can re-enrol it');
  }
  return { enrolment: outcome.enrolment, changed: outcome.changed, audit_event_id: outcome.audit_event_id };
}

/** Revoke an enrolment. Idempotent: an already revoked one is returned unchanged. */
export async function revokeServiceTenant(
  sql: Sql,
  tenantId: string,
  reason: string | null,
  actor: { id: string; requestId: string | null },
): Promise<{ enrolment: OacpServiceTenantEnrolment; already_revoked: boolean; audit_event_id: string }> {
  const outcome = await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const rows = await tx.unsafe(
      `SELECT ${COLUMNS} FROM oacp_service_tenant_enrolments WHERE tenant_id = $1 FOR UPDATE`,
      [tenantId],
    );
    const existing = (rows as unknown as EnrolmentRow[])[0];
    if (!existing) return null;
    const current = toEnrolment(existing);
    if (current.status === 'revoked') {
      const audit_event_id = await appendServiceTenantEvent(tx, { tenant_id: tenantId, event_type: 'oacp.service_tenant.revoked',
        actor: actor.id, request_id: actor.requestId, metadata: { already_revoked: true, reason_code: reason } });
      return { enrolment: current, already_revoked: true, audit_event_id };
    }
    const updated = await tx.unsafe(
      `UPDATE oacp_service_tenant_enrolments
          SET status = 'revoked', revoked_at = NOW(), revoked_reason = $2, updated_at = NOW()
        WHERE tenant_id = $1
        RETURNING ${COLUMNS}`,
      [tenantId, reason ?? 'revoked_by_platform_admin'],
    );
    const enrolment = toEnrolment((updated as unknown as EnrolmentRow[])[0]!);
    const audit_event_id = await appendServiceTenantEvent(tx, { tenant_id: tenantId, event_type: 'oacp.service_tenant.revoked',
      actor: actor.id, request_id: actor.requestId,
      metadata: { already_revoked: false, reason_code: enrolment.revoked_reason, merchant_ids: enrolment.merchant_ids } });
    return { enrolment, already_revoked: false, audit_event_id };
  });
  invalidateServiceTenantAccess(tenantId);
  if (!outcome) throw new ServiceTenantEnrolmentError(404, 'service_tenant_not_found', 'No OACP service enrolment for this tenant');
  return outcome;
}

/**
 * The best-effort merchant claim of a compact JWT, read without verification.
 * Used only to refuse early: the routes verify the token afterwards, so a
 * forged claim can never widen access, only be refused sooner.
 */
export function unverifiedMerchantClaim(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    if (typeof claims !== 'object' || claims === null) return null;
    const merchant = (claims as Record<string, unknown>)['merchant_id'];
    return typeof merchant === 'string' ? merchant : null;
  } catch {
    return null;
  }
}
