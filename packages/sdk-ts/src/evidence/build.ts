/** Building evidence packages from case records (mirrors `grantex.evidence._build`). */
import { CanonicalizationError, canonicalize } from './canonical.js';
import {
  IDENTIFIER_CLASSES, PLATFORM_MARKER, actionReference, auditEntryHash, caseKey, chainRoot, entryHash, headerHash,
  keyedContentDigest, pseudonym, type PseudonymClass,
} from './hashing.js';
import { EvidenceBuildError, VerificationFailure } from './result.js';
import { FORMAT, checkDocument } from './verify.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ENTRY_INPUT_MEMBERS = new Set(['type', 'at', 'data', 'source', 'ext']);

/**
 * How identifiers and content digests appear in a package. Every class not in
 * `disclosed` (`approver`, `content`, `principal`, `record`, `subject`) is keyed
 * per case with `key` (at least 32 bytes, never written to the package; `keyId`
 * names it). Disclosing every class needs no key and produces scheme `none`.
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
  source: { authority: 'platform' | 'tenant'; recorded_at: string; audit_entry_id?: string; audit_hash?: string; late?: true };
  ext?: Json;
}

/** The canonical bytes of a package document. */
export function serializePackage(document: Json): Uint8Array {
  return new TextEncoder().encode(canonicalize(document));
}

function privacyMember(privacy: PrivacySettings): Json {
  const disclosed = [...new Set(privacy.disclosed ?? [])].sort();
  const unknown = disclosed.filter((c) => !(IDENTIFIER_CLASSES as readonly string[]).includes(c));
  if (unknown.length) throw new EvidenceBuildError('privacy_violation', `unknown classes ${unknown.join(', ')}`);
  if (disclosed.join('\n') === IDENTIFIER_CLASSES.join('\n')) return { disclosed, scheme: 'none' };
  if (!privacy.key || privacy.key.length < 32 || !privacy.keyId) {
    throw new EvidenceBuildError('privacy_violation', 'keying undisclosed classes requires a key of at least 32 bytes and a keyId');
  }
  return { disclosed, key_id: privacy.keyId, scheme: 'hmac-sha256-v1' };
}

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

class Protector {
  private readonly disclosed: Set<string>;
  private readonly key: Buffer | null = null;

  constructor(privacy: PrivacySettings, disclosed: string[], kase: Json) {
    this.disclosed = new Set(disclosed);
    if (privacy.key && this.disclosed.size !== IDENTIFIER_CLASSES.length) {
      if (typeof kase['tenant_id'] !== 'string' || typeof kase['case_id'] !== 'string') {
        throw new EvidenceBuildError('schema_violation', 'case_id and tenant_id must be strings', 'case');
      }
      this.key = caseKey(privacy.key, kase['tenant_id'], kase['case_id']);
    }
  }

  identifier(cls: PseudonymClass, holder: unknown, name: string): void {
    if (this.disclosed.has(cls) || !isObject(holder) || typeof holder[name] !== 'string') return;
    holder[name] = pseudonym(this.key!, cls, holder[name]);
  }

  content(holder: Json, name: string): void {
    if (this.disclosed.has('content') || typeof holder[name] !== 'string') return;
    holder[name] = keyedContentDigest(this.key!, holder[name]);
  }

  action(data: Json): void {
    if (this.disclosed.has('subject') || typeof data['action_hash'] !== 'string') return;
    const actionHash = data['action_hash'] as string;
    delete data['action_hash'];
    data['action_ref'] = actionReference(this.key!, actionHash);
  }

  refs(refs: unknown): void {
    for (const ref of list(refs)) {
      this.identifier('record', ref, 'record_id');
      this.identifier('record', ref, 'excerpt_ref');
    }
  }

  entry(entry: Json): void {
    const data = entry['data'];
    if (!isObject(data)) return;
    switch (entry['type']) {
      case 'grant':
        this.identifier('principal', data, 'principal');
        break;
      case 'tool_call':
        this.content(data, 'input_hash');
        this.content(data, 'output_hash');
        for (const record of list(data['upstream_records'])) this.identifier('record', record, 'record_id');
        break;
      case 'policy_evaluation':
        for (const item of list(data['inputs'])) if (isObject(item)) this.refs(item['evidence']);
        break;
      case 'recommendation':
        for (const section of list(data['sections'])) if (isObject(section)) this.refs(section['evidence']);
        break;
      case 'disposition':
        for (const comparison of list(data['comparisons'])) if (isObject(comparison)) this.refs(comparison['evidence']);
        this.refs([data['hit']]);
        break;
      case 'decision':
        this.identifier('subject', data['action'], 'subject');
        this.identifier('approver', data, 'approver');
        this.action(data);
        break;
      case 'decision_consumption':
        this.action(data);
        break;
      default:
        break;
    }
  }
}

/**
 * Build a package from a case header and entry records. Values are given in the
 * clear (decisions carry the token's `action_hash`) and keyed here according to
 * `privacy`. The result is checked with the verification rules, so an invalid
 * package is refused with `EvidenceBuildError`.
 */
export function buildPackage(input: { case: Json; entries: readonly EvidenceRecord[] | readonly Json[]; privacy: PrivacySettings }): BuiltPackage {
  const privacy = privacyMember(input.privacy);
  const kase = structuredClone(input.case);
  const protect = new Protector(input.privacy, privacy['disclosed'] as string[], kase);
  protect.identifier('subject', kase, 'subject');
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
    if (unknown.length) throw new EvidenceBuildError('schema_violation', `unknown record members ${unknown.join(', ')}`, `entries[${index}]`);
    const entry = structuredClone(record) as Json;
    protect.entry(entry);
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
 * The platform audit entry that records a package's root. Its agent, DID and
 * grant are empty, its principal is `platform` and its metadata carries the
 * platform marker, none of which a tenant can write through `/v1/audit/log`.
 */
export function anchorAuditEntry(document: Json, options: { auditEntryId: string; timestamp: string; prevHash: string | null }): Json {
  const chain = document['chain'] as Json;
  const kase = document['case'] as Json;
  const audit: Json = {
    action: 'evidence.package_exported',
    agentDid: '',
    agentId: '',
    developerId: kase['tenant_id'],
    grantId: '',
    id: options.auditEntryId,
    metadata: {
      case_id: kase['case_id'],
      entry_count: chain['length'],
      format: document['format'],
      [PLATFORM_MARKER]: true,
      package_root: chain['root'],
      version: document['version'],
    },
    prevHash: options.prevHash,
    principalId: 'platform',
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
