import type postgres from 'postgres';
import { newCommerceAuditId } from './ids.js';
import { commerceAuditWriteFailuresTotal } from '../metrics.js';

type Sql = ReturnType<typeof postgres>;

export type CommerceAuditEventType =
  | 'merchant.created'
  | 'merchant.updated'
  | 'merchant.disabled'
  | 'merchant.credentials.updated'
  | 'merchant.feature_flag.updated'
  | 'merchant.provider_credentials.validated'
  | 'merchant.webhook_source.created'
  | 'merchant.webhook_source.secret_rotated'
  | 'commerce_agent.created'
  | 'agent.updated'
  | 'commerce_agent.trust_status.updated'
  | 'commerce_agent.disabled'
  | 'product.created'
  | 'product.updated'
  | 'catalog.bulk_ingested'
  | 'product.archived'
  | 'policy.created'
  | 'policy.activated'
  | 'consent.requested'
  | 'consent.granted'
  | 'consent.denied'
  | 'consent.expired'
  | 'consent.challenge.requested'
  | 'consent.challenge.verified'
  | 'consent.challenge.failed'
  | 'consent.challenge.expired'
  | 'consent.challenge.used'
  | 'passport.issued'
  | 'passport.verified'
  | 'passport.revoked'
  | 'passport.expired'
  | 'passport.verification_failed'
  | 'policy.evaluated'
  | 'cart.created'
  | 'payment_intent.created'
  | 'payment_intent.cancelled'
  | 'payment_intent.expired'
  | 'checkout_link.created'
  | 'provider.webhook.received'
  | 'provider.webhook.signature_failed'
  | 'payment_intent.paid'
  | 'payment_intent.failed'
  | 'protected_action.denied'
  | 'idempotency.conflict'
  | 'rate_limit.exceeded'
  | 'meter.passport_issued'
  | 'meter.payment_intent_created'
  // M2 — tenant operator + provisioning lifecycle
  | 'tenant.created'
  | 'tenant.updated'
  | 'tenant.disabled'
  | 'developer_tenant.bound'
  | 'developer_tenant.unbound'
  | 'commerce_passport_key.rotated';

export interface AppendCommerceAuditInput {
  tenantId: string;
  merchantId?: string | null;
  agentId?: string | null;
  userPrincipalId?: string | null;
  eventType: CommerceAuditEventType;
  resourceType?: string | null;
  resourceId?: string | null;
  passportJti?: string | null;
  policyVersion?: string | null;
  decisionId?: string | null;
  idempotencyKeyHash?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CommerceAuditWriteResult {
  id: string;
  occurredAt: string;
}

/**
 * Append a row to commerce_audit_events. The table is database-level
 * append-only (BEFORE UPDATE/DELETE trigger blocks mutations regardless
 * of role; production additionally restricts via GRANT/REVOKE).
 *
 * Pass a `tx` from sql.begin when the audit must be transactional with
 * the originating action — required for any state-changing endpoint.
 */
export async function appendCommerceAudit(
  sql: Sql,
  input: AppendCommerceAuditInput,
): Promise<CommerceAuditWriteResult> {
  const id = newCommerceAuditId();
  try {
    const rows = await sql<{ id: string; occurred_at: string }[]>`
      INSERT INTO commerce_audit_events (
        id, tenant_id, merchant_id, agent_id, user_principal_id,
        event_type, resource_type, resource_id,
        passport_jti, policy_version, decision_id,
        idempotency_key_hash, request_id, metadata
      ) VALUES (
        ${id},
        ${input.tenantId},
        ${input.merchantId ?? null},
        ${input.agentId ?? null},
        ${input.userPrincipalId ?? null},
        ${input.eventType},
        ${input.resourceType ?? null},
        ${input.resourceId ?? null},
        ${input.passportJti ?? null},
        ${input.policyVersion ?? null},
        ${input.decisionId ?? null},
        ${input.idempotencyKeyHash ?? null},
        ${input.requestId ?? null},
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING id, occurred_at
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('commerce audit insert returned no row');
    }
    return { id: row.id, occurredAt: new Date(row.occurred_at).toISOString() };
  } catch (err) {
    commerceAuditWriteFailuresTotal.labels(input.eventType).inc();
    throw err;
  }
}

// Intentionally NOT exported: updateCommerceAudit, deleteCommerceAudit.
// Audit corrections must be new compensating events, never row edits.
