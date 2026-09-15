/**
 * Hashes and keyed pseudonyms used by evidence packages (spec/evidence-package.md,
 * "Identifiers and privacy" and "Hash chain"). Every keyed value is an
 * HMAC-SHA256 under a per-case key over the RFC 8785 form of a JSON array.
 * Mirrors `grantex.evidence._hashing` in the Python SDK.
 */
import { createHash, createHmac } from 'node:crypto';
import { canonicalize } from './canonical.js';

/** Classes of value that are keyed per case unless disclosed (sorted). */
export const IDENTIFIER_CLASSES = ['approver', 'content', 'principal', 'record', 'subject'] as const;
export type IdentifierClass = (typeof IDENTIFIER_CLASSES)[number];
export type PseudonymClass = Exclude<IdentifierClass, 'content'>;

/** Metadata member only the auth service writes; `/v1/audit/log` refuses it. */
export const PLATFORM_MARKER = 'grantex:platform';

const PSEUDONYM = /^pz:[A-Za-z0-9_-]{43}$/;
const ACTION_REF = /^ak:[A-Za-z0-9_-]{43}$/;
const HEADER_MEMBERS = ['case', 'format', 'privacy', 'version'] as const;
const CHAIN_MEMBERS = ['alg', 'canonicalization', 'genesis', 'head', 'length'] as const;

type Json = Record<string, unknown>;

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

/** `sha256:` followed by the lower-case hex SHA-256 of `data`. */
export function digestBytes(data: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** Digest of the RFC 8785 canonical form of a JSON value. */
export function digest(value: unknown): string {
  return digestBytes(utf8(canonicalize(value)));
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

/** The decision-grant `action_hash`: `"sha256:" + base64url(SHA-256(JCS(action)))`. */
export function decisionActionHash(action: Json): string {
  return `sha256:${createHash('sha256').update(utf8(canonicalize(action))).digest('base64url')}`;
}

/** Hash of an auth-service audit entry, exactly as the audit chain stores it. */
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
  return createHash('sha256').update(utf8(text)).digest('hex');
}

/** `HMAC-SHA256(tenantKey, JCS(["grantex-evidence-case-v1", tenantId, caseId]))`. */
export function caseKey(tenantKey: Uint8Array, tenantId: string, caseId: string): Buffer {
  if (tenantKey.length < 32) throw new Error('pseudonymisation key must be at least 32 bytes');
  return createHmac('sha256', tenantKey).update(utf8(canonicalize(['grantex-evidence-case-v1', tenantId, caseId]))).digest();
}

function mac(key: Uint8Array, parts: unknown[]): Buffer {
  return createHmac('sha256', key).update(utf8(canonicalize(parts))).digest();
}

/** `"pz:" + base64url(HMAC(caseKey, JCS(["pseudonym-v1", class, value])))`. */
export function pseudonym(key: Uint8Array, identifierClass: PseudonymClass, value: string): string {
  if (!['approver', 'principal', 'record', 'subject'].includes(identifierClass)) {
    throw new Error(`not an identifier class: ${String(identifierClass)}`);
  }
  return `pz:${mac(key, ['pseudonym-v1', identifierClass, value]).toString('base64url')}`;
}

/** Stable per-case pseudonym for an identifier (derives the case key first). */
export function pseudonymise(tenantKey: Uint8Array, tenantId: string, caseId: string, identifierClass: PseudonymClass, value: string): string {
  return pseudonym(caseKey(tenantKey, tenantId, caseId), identifierClass, value);
}

/** `"hmac-sha256:" + hex(HMAC(caseKey, JCS(["content-v1", digest])))`: tool input/output digests. */
export function keyedContentDigest(key: Uint8Array, valueDigest: string): string {
  return `hmac-sha256:${mac(key, ['content-v1', valueDigest]).toString('hex')}`;
}

/** `"ak:" + base64url(HMAC(caseKey, JCS(["action-v1", action_hash])))`: replaces `action_hash` while the subject is pseudonymised. */
export function actionReference(key: Uint8Array, actionHash: string): string {
  return `ak:${mac(key, ['action-v1', actionHash]).toString('base64url')}`;
}

/** Whether `value` has the pseudonym form `pz:` + 43 base64url characters. */
export function isPseudonym(value: unknown): boolean {
  return typeof value === 'string' && PSEUDONYM.test(value);
}

/** Whether `value` has the form `ak:` + 43 base64url characters. */
export function isActionReference(value: unknown): boolean {
  return typeof value === 'string' && ACTION_REF.test(value);
}
