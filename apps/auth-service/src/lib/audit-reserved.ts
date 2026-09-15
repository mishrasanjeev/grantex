/**
 * Audit actions and metadata only the platform may write.
 *
 * Evidence packages (PRD G-5) and decision grants (G-3) rely on audit entries
 * the auth service writes itself: evidence records, package anchors and
 * decision records. If a tenant could write an entry with the same action or
 * the platform marker through POST /v1/audit/log, it could anchor a fabricated
 * package or pass off its own entry as a platform decision. Those names are
 * therefore refused on the tenant-facing endpoint.
 */
export const RESERVED_AUDIT_ACTION_PREFIXES = ['evidence.', 'decision.', 'grantex.'] as const;
export const RESERVED_METADATA_PREFIX = 'grantex:';

export interface ReservedAuditError {
  code: 'AUDIT_ACTION_RESERVED' | 'AUDIT_METADATA_RESERVED';
  message: string;
}

export function reservedAuditError(action: string, metadata: Record<string, unknown>): ReservedAuditError | null {
  const lowered = action.toLowerCase();
  const prefix = RESERVED_AUDIT_ACTION_PREFIXES.find((p) => lowered.startsWith(p));
  if (prefix) {
    return { code: 'AUDIT_ACTION_RESERVED', message: `actions starting with "${prefix}" are written only by the platform` };
  }
  const member = Object.keys(metadata).find((name) => name.toLowerCase().startsWith(RESERVED_METADATA_PREFIX));
  if (member !== undefined) {
    return { code: 'AUDIT_METADATA_RESERVED', message: `metadata members starting with "${RESERVED_METADATA_PREFIX}" are written only by the platform` };
  }
  return null;
}
