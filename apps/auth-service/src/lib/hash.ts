import { createHash, randomBytes } from 'node:crypto';

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashApiKey(key: string): string {
  return sha256hex(key);
}

export function generateApiKey(mode: 'live' | 'sandbox' = 'live'): string {
  const prefix = mode === 'sandbox' ? 'gx_test_' : 'gx_live_';
  return prefix + randomBytes(32).toString('base64url');
}

export interface AuditHashFields {
  id: string;
  agentId: string;
  agentDid: string;
  grantId: string;
  principalId: string;
  developerId: string;
  action: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  prevHash: string | null;
  status: string;
}

/**
 * Deterministic JSON with object keys sorted.
 *
 * `metadata` is stored in a JSONB column, and Postgres normalizes JSONB key
 * order on write. A hash taken over insertion-ordered JSON therefore cannot be
 * recomputed from the stored row, which makes the audit chain unverifiable —
 * the one property a tamper-evident log exists to provide.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeAuditHash(fields: AuditHashFields): string {
  // Built field-by-field rather than via JSON.stringify on a literal so that
  // only `metadata` gains canonical ordering. The scalar fields keep their
  // existing serialization, so hashes of entries with empty, single-key, or
  // already-sorted metadata are byte-identical to those written before this
  // change and continue to verify.
  const canonical = '{'
    + `"id":${JSON.stringify(fields.id)},`
    + `"agentId":${JSON.stringify(fields.agentId)},`
    + `"agentDid":${JSON.stringify(fields.agentDid)},`
    + `"grantId":${JSON.stringify(fields.grantId)},`
    + `"principalId":${JSON.stringify(fields.principalId)},`
    + `"developerId":${JSON.stringify(fields.developerId)},`
    + `"action":${JSON.stringify(fields.action)},`
    + `"metadata":${canonicalJson(fields.metadata ?? {})},`
    + `"timestamp":${JSON.stringify(fields.timestamp)},`
    + `"prevHash":${JSON.stringify(fields.prevHash)},`
    + `"status":${JSON.stringify(fields.status)}`
    + '}';
  return sha256hex(canonical);
}
