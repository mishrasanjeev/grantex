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

export type StoredAuditHashFields = Omit<AuditHashFields, 'metadata'> & {
  metadata: unknown;
};

export type AuditHashFormat = 'A' | 'B' | 'C' | 'B/C';

interface DecodedAuditMetadata {
  value: Record<string, unknown>;
  /** Exact JSON.stringify(metadata) bytes retained by the legacy JSONB string. */
  legacyJson: string | null;
}

function isMetadataObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode the historical JSONB-string representation without mutating storage.
 *
 * audit.ts passed JSON.stringify(metadata) to a JSONB parameter from the first
 * release through the Era-C canonicalization change. postgres.js serialized
 * that string again, so the column contains a JSONB string whose value is the
 * original JSON text. Keeping `legacyJson` lets Eras A/B be verified byte for
 * byte while `value` supplies the logical object needed by Era C and API reads.
 */
function decodeAuditMetadata(value: unknown): DecodedAuditMetadata | null {
  if (value === null || value === undefined) return { value: {}, legacyJson: null };
  if (isMetadataObject(value)) return { value, legacyJson: null };
  if (typeof value !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isMetadataObject(parsed) ? { value: parsed, legacyJson: value } : null;
  } catch {
    return null;
  }
}

/** Return the logical metadata object for API responses, preserving corrupt data verbatim. */
export function auditMetadataForResponse(value: unknown): unknown {
  return decodeAuditMetadata(value)?.value ?? value;
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

function auditPrefix(fields: Omit<AuditHashFields, 'metadata'>): string {
  return '{'
    + `"id":${JSON.stringify(fields.id)},`
    + `"agentId":${JSON.stringify(fields.agentId)},`
    + `"agentDid":${JSON.stringify(fields.agentDid)},`
    + `"grantId":${JSON.stringify(fields.grantId)},`
    + `"principalId":${JSON.stringify(fields.principalId)},`
    + `"developerId":${JSON.stringify(fields.developerId)},`
    + `"action":${JSON.stringify(fields.action)},`;
}

function computeAuditHashWithMetadataJson(
  fields: Omit<AuditHashFields, 'metadata'>,
  metadataJson: string,
): string {
  return sha256hex(auditPrefix(fields)
    + `"metadata":${metadataJson},`
    + `"timestamp":${JSON.stringify(fields.timestamp)},`
    + `"prevHash":${JSON.stringify(fields.prevHash)},`
    + `"status":${JSON.stringify(fields.status)}`
    + '}');
}

function computeEraAAuditHash(
  fields: Omit<AuditHashFields, 'metadata'>,
  metadataJson: string,
): string {
  return sha256hex(auditPrefix(fields)
    + `"metadata":${metadataJson},`
    + `"timestamp":${JSON.stringify(fields.timestamp)},`
    + `"previousHash":${JSON.stringify(fields.prevHash)}`
    + '}');
}

export function computeAuditHash(fields: AuditHashFields): string {
  // Built field-by-field rather than via JSON.stringify on a literal so that
  // only `metadata` gains canonical ordering. The scalar fields keep their
  // existing serialization, so hashes of entries with empty, single-key, or
  // already-sorted metadata are byte-identical to those written before this
  // change and continue to verify.
  const { metadata, ...scalars } = fields;
  return computeAuditHashWithMetadataJson(scalars, canonicalJson(metadata ?? {}));
}

/**
 * Match a stored row against every hash layout the service has emitted.
 *
 * This is deliberately read-only compatibility logic. It never rewrites
 * metadata or hashes. Eras A/B are attempted only when the exact historical
 * JSON text survived in the legacy JSONB string; object-encoded rows are
 * checked canonically as Era C without an unbounded permutation search.
 */
export function matchStoredAuditHash(
  fields: StoredAuditHashFields,
  storedHash: string,
): AuditHashFormat | null {
  const decoded = decodeAuditMetadata(fields.metadata);
  if (!decoded) return null;

  const { metadata: _metadata, ...scalars } = fields;
  const currentMatches = computeAuditHash({ ...scalars, metadata: decoded.value }) === storedHash;

  let eraBMatches = false;
  let eraAMatches = false;
  if (decoded.legacyJson !== null) {
    eraBMatches = computeAuditHashWithMetadataJson(scalars, decoded.legacyJson) === storedHash;
    eraAMatches = computeEraAAuditHash(scalars, decoded.legacyJson) === storedHash;
  }

  if (eraAMatches) return 'A';
  if (eraBMatches && currentMatches) return 'B/C';
  if (currentMatches) return 'C';
  if (eraBMatches) return 'B';
  return null;
}
