/** Hashes used by evidence packages (spec/evidence-package.md, "Hash chain"). */
import { createHash, createHmac } from 'node:crypto';
import { canonicalize } from './canonical.js';

/** Classes of identifier that are pseudonymised unless disclosed. */
export const IDENTIFIER_CLASSES = ['approver', 'principal', 'subject'] as const;
export type IdentifierClass = (typeof IDENTIFIER_CLASSES)[number];

const PSEUDONYM = /^pz:[A-Za-z0-9_-]{43}$/;
const HEADER_MEMBERS = ['case', 'format', 'privacy', 'version'] as const;
const CHAIN_MEMBERS = ['alg', 'canonicalization', 'genesis', 'head', 'length'] as const;

type Json = Record<string, unknown>;

/** `sha256:` followed by the lower-case hex SHA-256 of `data`. */
export function digestBytes(data: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** Digest of the RFC 8785 canonical form of a JSON value. */
export function digest(value: unknown): string {
  return digestBytes(Buffer.from(canonicalize(value), 'utf8'));
}

function pick(source: Json, names: readonly string[]): Json {
  const out: Json = {};
  for (const name of names) out[name] = source[name];
  return out;
}

/** `chain.genesis`: digest of `{case, format, privacy, version}`. */
export function headerHash(pkg: Json): string {
  return digest(pick(pkg, HEADER_MEMBERS));
}

/** Digest of an entry with its `hash` member removed. */
export function entryHash(entry: Json): string {
  const copy: Json = {};
  for (const [name, value] of Object.entries(entry)) if (name !== 'hash') copy[name] = value;
  return digest(copy);
}

/** `chain.root`: digest of `{alg, canonicalization, genesis, head, length}`. */
export function chainRoot(chain: Json): string {
  return digest(pick(chain, CHAIN_MEMBERS));
}

/**
 * The decision-grant `action_hash` of a semantic action (PRD G-3):
 * `"sha256:" + base64url(SHA-256(JCS(action)))`, unpadded.
 */
export function decisionActionHash(action: Json): string {
  return `sha256:${createHash('sha256').update(Buffer.from(canonicalize(action), 'utf8')).digest('base64url')}`;
}

/**
 * Hash of an auth-service audit entry as the audit chain stores it: SHA-256
 * (lower-case hex) of a JSON object with members in a fixed order, metadata
 * members sorted, and no whitespace.
 */
export function auditEntryHash(entry: Json): string {
  const c = (value: unknown): string => canonicalize(value);
  const text = '{'
    + `"id":${c(entry['id'])},`
    + `"agentId":${c(entry['agentId'])},`
    + `"agentDid":${c(entry['agentDid'])},`
    + `"grantId":${c(entry['grantId'])},`
    + `"principalId":${c(entry['principalId'])},`
    + `"developerId":${c(entry['developerId'])},`
    + `"action":${c(entry['action'])},`
    + `"metadata":${c(entry['metadata'])},`
    + `"timestamp":${c(entry['timestamp'])},`
    + `"prevHash":${c(entry['prevHash'] ?? null)},`
    + `"status":${c(entry['status'])}`
    + '}';
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Stable per-case pseudonym for an identifier:
 * `caseKey = HMAC-SHA256(tenantKey, "grantex-evidence-v1:" + tenantId + ":" + caseId)`,
 * `pseudonym = "pz:" + base64url(HMAC-SHA256(caseKey, class + ":" + value))`.
 */
export function pseudonymise(
  tenantKey: Uint8Array,
  tenantId: string,
  caseId: string,
  identifierClass: IdentifierClass,
  value: string,
): string {
  if (!(IDENTIFIER_CLASSES as readonly string[]).includes(identifierClass)) {
    throw new Error(`unknown identifier class ${String(identifierClass)}`);
  }
  if (tenantKey.length < 32) throw new Error('pseudonymisation key must be at least 32 bytes');
  const caseKey = createHmac('sha256', tenantKey)
    .update(Buffer.from(`grantex-evidence-v1:${tenantId}:${caseId}`, 'utf8'))
    .digest();
  const mac = createHmac('sha256', caseKey).update(Buffer.from(`${identifierClass}:${value}`, 'utf8')).digest('base64url');
  return `pz:${mac}`;
}

/** Whether `value` has the pseudonym form `pz:` + 43 base64url characters. */
export function isPseudonym(value: unknown): boolean {
  return typeof value === 'string' && PSEUDONYM.test(value);
}
