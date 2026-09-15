/** Building evidence packages from case records. */
import { CanonicalizationError, canonicalize } from './canonical.js';
import { IDENTIFIER_CLASSES, auditEntryHash, chainRoot, entryHash, headerHash, pseudonymise, type IdentifierClass } from './hashing.js';
import { EvidenceBuildError, VerificationFailure } from './result.js';
import { FORMAT, checkDocument } from './verify.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ENTRY_INPUT_MEMBERS = new Set(['type', 'at', 'data', 'source', 'ext']);

/**
 * How identifiers appear in a package. Every identifier class not in
 * `disclosed` is replaced by a per-case pseudonym computed with `key` (at least
 * 32 bytes, never written to the package; `keyId` names it). Disclosing every
 * class needs no key and produces scheme `none`.
 */
export interface PrivacySettings {
  key?: Uint8Array;
  keyId?: string;
  disclosed?: readonly string[];
}

export interface BuiltPackage {
  document: Json;
  data: Uint8Array;
  root: string;
}

export interface EvidenceRecord {
  type: string;
  at: string;
  data: Json;
  source?: { audit_entry_id: string; audit_hash: string };
  ext?: Json;
}

/** The canonical bytes of a package document. */
export function serializePackage(document: Json): Uint8Array {
  return new TextEncoder().encode(canonicalize(document));
}

function privacyMember(privacy: PrivacySettings): Json {
  const disclosed = [...new Set(privacy.disclosed ?? [])].sort();
  const unknown = disclosed.filter((c) => !(IDENTIFIER_CLASSES as readonly string[]).includes(c));
  if (unknown.length) throw new EvidenceBuildError('privacy_violation', `unknown identifier classes ${unknown.join(', ')}`);
  if (disclosed.join('\n') === IDENTIFIER_CLASSES.join('\n')) return { disclosed, scheme: 'none' };
  if (!privacy.key || privacy.key.length < 32 || !privacy.keyId) {
    throw new EvidenceBuildError(
      'privacy_violation',
      'pseudonymising identifiers requires a key of at least 32 bytes and a keyId',
    );
  }
  return { disclosed, key_id: privacy.keyId, scheme: 'hmac-sha256-v1' };
}

/**
 * Build a package from a case header and entry records. Identifiers are given
 * in the clear and pseudonymised here according to `privacy`. The result is
 * checked with the same rules as verification, so an invalid package is
 * refused with `EvidenceBuildError`.
 */
export function buildPackage(input: { case: Json; entries: readonly EvidenceRecord[] | readonly Json[]; privacy: PrivacySettings }): BuiltPackage {
  const privacy = privacyMember(input.privacy);
  const disclosed = new Set(privacy['disclosed'] as string[]);
  const kase = structuredClone(input.case);
  const tenantId = kase['tenant_id'];
  const caseId = kase['case_id'];

  const protect = (cls: IdentifierClass, value: unknown): unknown => {
    if (disclosed.has(cls) || typeof value !== 'string') return value;
    if (typeof tenantId !== 'string' || typeof caseId !== 'string') {
      throw new EvidenceBuildError('schema_violation', 'case_id and tenant_id must be strings', 'case');
    }
    return pseudonymise(input.privacy.key!, tenantId, caseId, cls, value);
  };

  if ('subject' in kase) kase['subject'] = protect('subject', kase['subject']);
  const document: Json = { case: kase, format: FORMAT, privacy, version: '1.0' };
  let previous: string;
  try {
    previous = headerHash(document);
  } catch (err) {
    if (err instanceof CanonicalizationError) throw new EvidenceBuildError('schema_violation', err.message, 'case');
    throw err;
  }
  const genesis = previous;

  const entries = input.entries.map((record, index) => {
    const unknown = Object.keys(record).filter((name) => !ENTRY_INPUT_MEMBERS.has(name)).sort();
    if (unknown.length) {
      throw new EvidenceBuildError('schema_violation', `unknown record members ${unknown.join(', ')}`, `entries[${index}]`);
    }
    const entry = structuredClone(record) as Json;
    const data = entry['data'];
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      if (entry['type'] === 'grant' && 'principal' in data) {
        data['principal'] = protect('principal', data['principal']);
      } else if (entry['type'] === 'decision') {
        if ('approver' in data) data['approver'] = protect('approver', data['approver']);
        const action = data['action'];
        if (action !== null && typeof action === 'object' && !Array.isArray(action) && 'subject' in action) {
          action['subject'] = protect('subject', action['subject']);
        }
      }
    }
    entry['seq'] = index;
    entry['prev'] = previous;
    try {
      entry['hash'] = entryHash(entry);
    } catch (err) {
      if (err instanceof CanonicalizationError) throw new EvidenceBuildError('schema_violation', err.message, `entries[${index}]`);
      throw err;
    }
    previous = entry['hash'] as string;
    return entry;
  });

  const chain: Json = { alg: 'sha256', canonicalization: 'RFC8785', genesis, head: previous, length: entries.length };
  chain['root'] = chainRoot(chain);
  document['entries'] = entries;
  document['chain'] = chain;
  try {
    checkDocument(document);
  } catch (err) {
    if (err instanceof VerificationFailure) throw new EvidenceBuildError(err.code, err.message, err.fieldPath);
    throw err;
  }
  return { document, data: serializePackage(document), root: chain['root'] as string };
}

/**
 * The auth-service audit entry that records a package's root. The auth service
 * appends it to the tenant's audit hash chain on export and embeds it as the
 * package `anchor`.
 */
export function anchorAuditEntry(
  document: Json,
  options: {
    auditEntryId: string;
    timestamp: string;
    prevHash: string | null;
    agentId?: string;
    agentDid?: string;
    grantId?: string;
    principalId?: string;
  },
): Json {
  const chain = document['chain'] as Json;
  const kase = document['case'] as Json;
  const audit: Json = {
    action: 'evidence.package_exported',
    agentDid: options.agentDid ?? '',
    agentId: options.agentId ?? '',
    developerId: kase['tenant_id'],
    grantId: options.grantId ?? '',
    id: options.auditEntryId,
    metadata: {
      case_id: kase['case_id'],
      entry_count: chain['length'],
      format: document['format'],
      package_root: chain['root'],
      version: document['version'],
    },
    prevHash: options.prevHash,
    principalId: options.principalId ?? 'platform',
    status: 'success',
    timestamp: options.timestamp,
  };
  audit['hash'] = auditEntryHash(audit);
  return audit;
}

/** A copy of `document` with `anchor` set; the root is unchanged. */
export function attachAnchor(document: Json, auditEntry: Json): Json {
  const out = structuredClone(document);
  out['anchor'] = { audit_entry: structuredClone(auditEntry), type: 'grantex-audit-entry' };
  return out;
}

/** A copy of `document` with `signature` set; the root is unchanged. */
export function attachSignature(document: Json, signature: Json | { alg: string; jws: string; kid: string }): Json {
  const out = structuredClone(document);
  out['signature'] = { ...signature };
  return out;
}
