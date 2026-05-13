import type postgres from 'postgres';
import { sha256hex } from '../hash.js';
import { newCommerceIdempotencyRecordId } from './ids.js';
import type { CommerceEnvironment } from './payment-providers/types.js';

type Sql = ReturnType<typeof postgres>;

export interface CommerceIdempotencyScope {
  tenantId: string;
  merchantId: string;
  endpoint: string;
  environment: CommerceEnvironment;
  idempotencyKey: string;
  requestBody: unknown;
}

export type CommerceIdempotencyCheck =
  | { kind: 'proceed'; recordId: string; keyHash: string; requestBodyHash: string }
  | { kind: 'replay'; statusCode: number; responseBody: unknown; recordId: string }
  | { kind: 'conflict'; recordId: string; expectedBodyHash: string; actualBodyHash: string };

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export function hashIdempotencyKey(idempotencyKey: string): string {
  return sha256hex(idempotencyKey);
}

export function hashRequestBody(requestBody: unknown): string {
  return sha256hex(stableJson(requestBody));
}

export async function beginCommerceIdempotency(
  sql: Sql,
  scope: CommerceIdempotencyScope,
): Promise<CommerceIdempotencyCheck> {
  const keyHash = hashIdempotencyKey(scope.idempotencyKey);
  const requestBodyHash = hashRequestBody(scope.requestBody);
  const rows = await sql<Array<{
    id: string;
    request_body_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>>`
    SELECT id, request_body_hash, response_status, response_body
      FROM commerce_idempotency_records
     WHERE tenant_id = ${scope.tenantId}
       AND merchant_id = ${scope.merchantId}
       AND endpoint = ${scope.endpoint}
       AND environment = ${scope.environment}
       AND idempotency_key_hash = ${keyHash}
       AND expires_at > NOW()
     LIMIT 1
  `;
  const existing = rows[0];
  if (!existing) {
    return {
      kind: 'proceed',
      recordId: newCommerceIdempotencyRecordId(),
      keyHash,
      requestBodyHash,
    };
  }
  if (existing.request_body_hash !== requestBodyHash) {
    return {
      kind: 'conflict',
      recordId: existing.id,
      expectedBodyHash: existing.request_body_hash,
      actualBodyHash: requestBodyHash,
    };
  }
  return {
    kind: 'replay',
    recordId: existing.id,
    statusCode: existing.response_status ?? 200,
    responseBody: existing.response_body,
  };
}

export async function commitCommerceIdempotencyResult(
  sql: Sql,
  input: {
    recordId: string;
    scope: CommerceIdempotencyScope;
    keyHash: string;
    requestBodyHash: string;
    statusCode: number;
    responseBody: unknown;
    retentionHours?: number;
  },
): Promise<void> {
  const retentionHours = input.retentionHours ?? 24;
  await sql`
    INSERT INTO commerce_idempotency_records (
      id, tenant_id, merchant_id, endpoint, environment,
      idempotency_key_hash, request_body_hash,
      response_status, response_body, expires_at
    ) VALUES (
      ${input.recordId},
      ${input.scope.tenantId},
      ${input.scope.merchantId},
      ${input.scope.endpoint},
      ${input.scope.environment},
      ${input.keyHash},
      ${input.requestBodyHash},
      ${input.statusCode},
      ${JSON.stringify(input.responseBody)}::jsonb,
      NOW() + (${retentionHours} || ' hours')::interval
    )
    ON CONFLICT (tenant_id, merchant_id, endpoint, environment, idempotency_key_hash)
    DO UPDATE SET
      response_status = EXCLUDED.response_status,
      response_body = EXCLUDED.response_body,
      updated_at = NOW()
  `;
}

