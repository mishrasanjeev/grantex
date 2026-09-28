// SPDX-License-Identifier: Apache-2.0
/**
 * The agent request signing profile of spec/verification.md: the
 * Agent-Passport, Agent-Grant and Agent-Trust headers (section 1),
 * Content-Digest (section 2), sign() (section 3) and verify() (section 4).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentHttpSigError } from './errors.js';
import { jwkThumbprint, privateKeyObject, publicKeyObject, signBytes, verifyBytes } from './keys.js';
import type { AgentJwk, SignatureAlgorithm } from './keys.js';
import { bodyBytes, createSignatureBase, fieldValue, normaliseAuthority, parseTarget } from './message.js';
import type { AgentRequest } from './message.js';
import {
  encodeBase64,
  parseDictionary,
  parseItem,
  serializeDictionary,
  serializeInnerList,
  serializeItem,
} from './structured-fields.js';
import type { BareItem, Dictionary, InnerList, Item, Member } from './structured-fields.js';

export const AGENT_PAYER_AUTH_TAG = 'agent-payer-auth';
export const COVERED_COMPONENTS = [
  '@method',
  '@authority',
  '@path',
  'content-digest',
  'agent-passport',
  'agent-grant',
] as const;
export const SIGNATURE_PARAMETERS = ['created', 'expires', 'nonce', 'keyid', 'tag'] as const;
export const MAX_SIGNATURE_WINDOW_SECONDS = 300;
export const DEFAULT_SIGNATURE_WINDOW_SECONDS = 60;
export const DEFAULT_CLOCK_SKEW_SECONDS = 10;
export const MAX_CLOCK_SKEW_SECONDS = 60;
export const INLINE_PRESENTATION_MAX_OCTETS = 6144;
export const MAX_CONTENT_NESTING_DEPTH = 64;
export const DEFAULT_SIGNATURE_LABEL = 'sig1';

const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const KEYID = /^[A-Za-z0-9_-]{43}$/;
// Compact serializations are printable ASCII without spaces.
const PRESENTATION = /^[\x21-\x7e]+$/;

const PRESENTATIONS = [
  { header: 'Agent-Passport', field: 'agent-passport', member: 'agent_passport', required: true },
  { header: 'Agent-Grant', field: 'agent-grant', member: 'agent_grant', required: true },
  { header: 'Agent-Trust', field: 'agent-trust', member: 'agent_trust', required: false },
] as const;
type PresentationMember = (typeof PRESENTATIONS)[number]['member'];

export type DenialCode = 'request_signature_invalid' | 'request_signature_stale';
export type DenialReason =
  | 'signature_missing'
  | 'signature_malformed'
  | 'signature_not_found'
  | 'signature_ambiguous'
  | 'covered_components_mismatch'
  | 'signature_params_mismatch'
  | 'window_too_long'
  | 'created_in_future'
  | 'expired'
  | 'authority_mismatch'
  | 'content_digest_malformed'
  | 'presentation_malformed'
  | 'key_unknown'
  | 'key_mismatch'
  | 'signature_mismatch'
  | 'content_digest_mismatch'
  | 'presentation_missing'
  | 'presentation_hash_mismatch'
  | 'nonce_replayed';

export interface SignOptions {
  /** The agent's private JWK: P-256 (`kty` EC) or Ed25519 (`kty` OKP). */
  key: AgentJwk;
  agentPassport: string;
  agentGrant: string;
  agentTrust?: string;
  /** Must be the key's RFC 7638 thumbprint when given; computed otherwise. */
  keyid?: string;
  /** UNIX seconds. Defaults to now. */
  created?: number;
  /** UNIX seconds, 1 to 300 seconds after `created`. Defaults to `created` + 60. */
  expires?: number;
  /** Defaults to 32 random octets, base64url. */
  nonce?: string;
  /** Must be `agent-payer-auth` when given. */
  tag?: string;
  label?: string;
}

export interface SignResult {
  /** The fields to set on the request, in this order. */
  headers: Record<string, string>;
  keyid: string;
  alg: SignatureAlgorithm;
  created: number;
  expires: number;
  nonce: string;
  signatureBase: string;
}

export interface NonceStore {
  /**
   * Records (keyid, nonce) until `expiresAt` (UNIX seconds) and returns true,
   * or returns false when the pair is already recorded. Must be atomic.
   */
  checkAndStore(keyid: string, nonce: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface VerifyOptions {
  /** The public JWK trusted for `keyid`, or null/undefined when there is none. */
  resolveKey: (keyid: string) => AgentJwk | null | undefined | Promise<AgentJwk | null | undefined>;
  /** The verifier's own authority: host, and port when it is not the default. */
  expectedAuthority: string;
  nonceStore: NonceStore;
  /** UNIX seconds. Defaults to now. */
  now?: number;
  /** 0 to 60. Defaults to 10. */
  clockSkewSeconds?: number;
}

export interface VerifySuccess {
  ok: true;
  keyid: string;
  alg: SignatureAlgorithm;
  label: string;
  created: number;
  expires: number;
  nonce: string;
  agentPassport: string;
  agentGrant: string;
  agentTrust: string | null;
}

export interface VerifyFailure {
  ok: false;
  code: DenialCode;
  reason: DenialReason;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

function fail(message: string): never {
  throw new AgentHttpSigError(message);
}

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
const nowSeconds = () => Math.floor(Date.now() / 1000);
const item = (value: BareItem, params: Map<string, BareItem> = new Map()): Item => ({ value, params });

/** RFC 9530 section 2: `sha-256=:<digest>:` for the content. */
export function contentDigest(body: string | Uint8Array | null | undefined): string {
  const dictionary: Dictionary = new Map([['sha-256', item({ type: 'binary', value: sha256(bodyBytes(body)) })]]);
  return serializeDictionary(dictionary);
}

function octets(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Section 1.1: inline up to 6144 octets, by reference above. */
function presentationField(presentation: string): string {
  const bytes = new TextEncoder().encode(presentation);
  if (bytes.length > INLINE_PRESENTATION_MAX_OCTETS) {
    const params = new Map<string, BareItem>([['sha-256', { type: 'binary', value: sha256(bytes) }]]);
    return serializeItem(item({ type: 'token', value: 'body' }, params));
  }
  return serializeItem(item({ type: 'binary', value: bytes }));
}

/**
 * Section 1.2: the content is read only when it nests arrays and objects at
 * most 64 deep. Counted outside strings; exact for JSON, and content that is
 * not JSON fails to parse whatever this returns.
 */
function nestedWithinLimit(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > MAX_CONTENT_NESTING_DEPTH) return false;
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return true;
}

/**
 * Section 1.2: `agent_credentials` of a JSON object content, or why the
 * content carries no presentations. The caller denies (or refuses to sign)
 * when it needs one.
 */
function readCredentials(body: Uint8Array): { credentials: Record<string, unknown> } | { problem: string } {
  let text: string;
  try {
    // ignoreBOM keeps a byte order mark, which JSON (RFC 8259 section 8.1) does not allow.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    // Not UTF-8, so not JSON (RFC 8259 section 8.1): no presentations.
    return { problem: 'the content is not UTF-8' };
  }
  if (!nestedWithinLimit(text)) {
    return { problem: `the content is nested more than ${MAX_CONTENT_NESTING_DEPTH} deep` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Content that is not JSON carries no presentations.
    return { problem: 'the content is not JSON' };
  }
  const credentials =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).agent_credentials
      : undefined;
  if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials)) {
    return { problem: 'the content is not a JSON object with an agent_credentials object' };
  }
  return { credentials: credentials as Record<string, unknown> };
}

function checkInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer (UNIX seconds)`);
}

/**
 * Signs a request with the profile of spec/verification.md section 3 and
 * returns the Content-Digest, Agent-Passport, Agent-Grant, Agent-Trust (when
 * given), Signature-Input and Signature fields to set on it. `request.url`
 * must be absolute. A presentation over 6144 octets must already be in the
 * JSON content under `agent_credentials` (section 1.2).
 */
export function sign(request: AgentRequest, options: SignOptions): SignResult {
  const { key, alg } = privateKeyObject(options.key);
  const keyid = jwkThumbprint(options.key);
  if (options.keyid !== undefined && options.keyid !== keyid) fail('keyid must be the RFC 7638 thumbprint of the key');
  if (options.tag !== undefined && options.tag !== AGENT_PAYER_AUTH_TAG) fail(`tag must be ${AGENT_PAYER_AUTH_TAG}`);
  const created = options.created ?? nowSeconds();
  const expires = options.expires ?? created + DEFAULT_SIGNATURE_WINDOW_SECONDS;
  checkInteger(created, 'created');
  checkInteger(expires, 'expires');
  if (expires <= created || expires - created > MAX_SIGNATURE_WINDOW_SECONDS) {
    fail(`expires must be 1 to ${MAX_SIGNATURE_WINDOW_SECONDS} seconds after created`);
  }
  const nonce = options.nonce ?? randomBytes(32).toString('base64url');
  if (!NONCE.test(nonce)) fail('nonce must be 22 to 128 base64url characters');
  const label = options.label ?? DEFAULT_SIGNATURE_LABEL;
  if (!/^[a-z*][a-z0-9_\-.*]*$/.test(label)) fail('invalid signature label');
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(request.method)) fail('invalid method');
  const target = parseTarget(request.url);
  if (target.authority === null) fail('sign() needs an absolute URL');

  const body = bodyBytes(request.body);
  const values: Record<PresentationMember, string | undefined> = {
    agent_passport: options.agentPassport,
    agent_grant: options.agentGrant,
    agent_trust: options.agentTrust,
  };
  const headers: Record<string, string> = { 'Content-Digest': contentDigest(body) };
  let content: ReturnType<typeof readCredentials> | undefined;
  for (const p of PRESENTATIONS) {
    const presentation = values[p.member];
    if (presentation === undefined) continue;
    if (!PRESENTATION.test(presentation)) fail(`${p.header} must be non-empty printable ASCII without spaces`);
    if (octets(presentation) > INLINE_PRESENTATION_MAX_OCTETS) {
      content ??= readCredentials(body);
      if ('problem' in content) {
        fail(`${p.header} is over ${INLINE_PRESENTATION_MAX_OCTETS} octets and goes in the content, but ${content.problem}`);
      }
      if (content.credentials[p.member] !== presentation) {
        fail(`${p.header} is over ${INLINE_PRESENTATION_MAX_OCTETS} octets: put it in the JSON content at agent_credentials.${p.member}`);
      }
    }
    headers[p.header] = presentationField(presentation);
  }

  const params = signatureParams(created, expires, nonce, keyid, AGENT_PAYER_AUTH_TAG);
  const message: AgentRequest = { method: request.method, url: request.url, headers, body };
  const signatureBase = createSignatureBase(message, params);
  const signature = signBytes(key, alg, signatureBase);
  headers['Signature-Input'] = `${label}=${serializeInnerList(params)}`;
  headers.Signature = `${label}=:${encodeBase64(signature)}:`;
  return { headers, keyid, alg, created, expires, nonce, signatureBase };
}

function signatureParams(created: number, expires: number, nonce: string, keyid: string, tag: string): InnerList {
  return {
    items: COVERED_COMPONENTS.map((c) => item({ type: 'string', value: c })),
    params: new Map<string, BareItem>([
      ['created', { type: 'integer', value: created }],
      ['expires', { type: 'integer', value: expires }],
      ['nonce', { type: 'string', value: nonce }],
      ['keyid', { type: 'string', value: keyid }],
      ['tag', { type: 'string', value: tag }],
    ]),
  };
}

/** In-memory nonce store for one process and for tests (spec/verification.md section 4.4). */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();
  constructor(private readonly clock: () => number = nowSeconds) {}

  checkAndStore(keyid: string, nonce: string, expiresAt: number): boolean {
    const now = this.clock();
    for (const [k, until] of this.seen) if (until < now) this.seen.delete(k);
    const key = `${keyid} ${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
}

type Presentation = { inline: string } | { reference: Uint8Array };

/** Section 1.1: one of the two forms, or null. */
function parsePresentation(value: string): Presentation | null {
  let parsed: Item;
  try {
    parsed = parseItem(value);
  } catch {
    // A field that does not parse is malformed; the caller denies.
    return null;
  }
  const v = parsed.value;
  if (v.type === 'binary' && parsed.params.size === 0) {
    const text = Buffer.from(v.value).toString('latin1');
    if (v.value.length > INLINE_PRESENTATION_MAX_OCTETS || !PRESENTATION.test(text)) return null;
    return { inline: text };
  }
  if (v.type === 'token' && v.value === 'body' && parsed.params.size === 1) {
    const hash = parsed.params.get('sha-256');
    if (hash?.type === 'binary' && hash.value.length === 32) return { reference: hash.value };
  }
  return null;
}

/** Section 2: exactly one member, sha-256, a 32-octet Byte Sequence. */
function parseContentDigest(value: string | null): Uint8Array | null {
  if (value === null) return null;
  let dictionary: Dictionary;
  try {
    dictionary = parseDictionary(value);
  } catch {
    // Unparseable Content-Digest is malformed; the caller denies.
    return null;
  }
  const member = dictionary.get('sha-256');
  if (dictionary.size !== 1 || member === undefined || 'items' in member) return null;
  if (member.value.type !== 'binary' || member.params.size !== 0 || member.value.value.length !== 32) return null;
  return member.value.value;
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Verifies a request against the profile of spec/verification.md section 4,
 * applying its steps in order. A request that fails is answered with a
 * denial; a failure of `resolveKey` or `nonceStore` is thrown, and the
 * caller must refuse the request.
 */
export async function verify(request: AgentRequest, options: VerifyOptions): Promise<VerifyResult> {
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_SECONDS) {
    fail(`clockSkewSeconds must be an integer from 0 to ${MAX_CLOCK_SKEW_SECONDS}`);
  }
  if (typeof options.expectedAuthority !== 'string' || options.expectedAuthority === '') fail('expectedAuthority is required');
  // The verifier's authority is compared as RFC 9421 section 2.2.3 normalises
  // it; a URL or a value with a path is a configuration error.
  const expectedAuthority = normaliseAuthority(options.expectedAuthority, null);
  // @authority omits the default port (RFC 9421 section 2.2.3), so a
  // configured :80 or :443 would deny every request; refuse it here.
  if (/:(?:80|443)$/.test(expectedAuthority)) fail('expectedAuthority must omit the default port (80 or 443)');
  // NaN compares false with everything, so both time checks below would
  // pass a stale signature, and an infinity makes the window meaningless. A
  // clock that is not a finite, non-negative number is a configuration
  // error: refuse to answer rather than decide on it (fail closed).
  const clock: unknown = options.now ?? nowSeconds();
  if (typeof clock !== 'number' || !Number.isFinite(clock) || clock < 0) {
    fail('now must be a finite, non-negative number (UNIX seconds)');
  }
  const now = Math.floor(clock);
  const deny = (reason: DenialReason, code: DenialCode = 'request_signature_invalid'): VerifyFailure => ({
    ok: false,
    code,
    reason,
  });
  const headers = request.headers;

  // 1-2. Both fields, both Dictionaries (RFC 9421 sections 4.1, 4.2).
  const inputField = fieldValue(headers, 'signature-input');
  const signatureField = fieldValue(headers, 'signature');
  if (inputField === null || signatureField === null) return deny('signature_missing');
  let inputs: Dictionary;
  let signatures: Dictionary;
  try {
    inputs = parseDictionary(inputField);
    signatures = parseDictionary(signatureField);
  } catch {
    // RFC 9651 section 4.2: a field that fails to parse is treated as
    // malformed; the request is denied.
    return deny('signature_malformed');
  }

  // 3. Exactly one signature carries the profile tag (RFC 9421 section 7.2.7).
  const tagged = [...inputs].filter(([, m]) => {
    const tag = 'items' in m ? m.params.get('tag') : undefined;
    return tag?.type === 'string' && tag.value === AGENT_PAYER_AUTH_TAG;
  });
  if (tagged.length === 0) return deny('signature_not_found');
  if (tagged.length > 1) return deny('signature_ambiguous');
  const [label, member] = tagged[0]! as [string, InnerList];

  // 4. Its Signature value (RFC 9421 section 3.2 step 1.2).
  const signatureMember: Member | undefined = signatures.get(label);
  if (
    signatureMember === undefined ||
    'items' in signatureMember ||
    signatureMember.value.type !== 'binary' ||
    signatureMember.params.size !== 0
  ) {
    return deny('signature_malformed');
  }
  const signature = signatureMember.value.value;

  // 5. Exactly the covered components, in order, without parameters.
  const components = member.items;
  if (
    components.length !== COVERED_COMPONENTS.length ||
    components.some((c, i) => c.value.type !== 'string' || c.value.value !== COVERED_COMPONENTS[i] || c.params.size !== 0)
  ) {
    return deny('covered_components_mismatch');
  }

  // 6. Exactly the parameters, in order, with their types and formats.
  const names = [...member.params.keys()];
  const p = member.params;
  const created = p.get('created');
  const expires = p.get('expires');
  const nonce = p.get('nonce');
  const keyid = p.get('keyid');
  if (
    names.length !== SIGNATURE_PARAMETERS.length ||
    names.some((n, i) => n !== SIGNATURE_PARAMETERS[i]) ||
    created?.type !== 'integer' ||
    expires?.type !== 'integer' ||
    nonce?.type !== 'string' ||
    keyid?.type !== 'string' ||
    created.value < 0 ||
    expires.value <= created.value ||
    !NONCE.test(nonce.value) ||
    !KEYID.test(keyid.value)
  ) {
    return deny('signature_params_mismatch');
  }

  // 7-9. Time (spec section 4.3).
  if (expires.value - created.value > MAX_SIGNATURE_WINDOW_SECONDS) return deny('window_too_long');
  if (created.value > now + skew) return deny('created_in_future');
  if (now >= expires.value + skew) return deny('expired', 'request_signature_stale');

  // 10. An absolute target must name this verifier.
  let target;
  try {
    target = parseTarget(request.url);
  } catch {
    // A target that cannot be read cannot be matched to this verifier.
    return deny('authority_mismatch');
  }
  if (target.authority !== null && target.authority !== expectedAuthority) return deny('authority_mismatch');

  // 11. Content-Digest shape (spec section 2).
  const digest = parseContentDigest(fieldValue(headers, 'content-digest'));
  if (digest === null) return deny('content_digest_malformed');

  // 12. The presentation fields (spec section 1.1).
  const presentations = new Map<PresentationMember, Presentation>();
  for (const pres of PRESENTATIONS) {
    const value = fieldValue(headers, pres.field);
    if (value === null) {
      if (pres.required) return deny('presentation_malformed');
      continue;
    }
    const parsed = parsePresentation(value);
    if (parsed === null) return deny('presentation_malformed');
    presentations.set(pres.member, parsed);
  }

  // 13-14. The key for keyid, whose thumbprint must be keyid. A resolver
  // failure propagates: the request is not answered as if it were forged.
  const resolved = await options.resolveKey(keyid.value);
  if (resolved === null || resolved === undefined) return deny('key_unknown');
  const pub = publicKeyObject(resolved);
  if (pub === null || jwkThumbprint(resolved) !== keyid.value) return deny('key_mismatch');

  // 15. The signature over the recreated base, with this verifier's authority.
  let base: string;
  try {
    base = createSignatureBase(request, member, { '@authority': expectedAuthority });
  } catch {
    // A base that cannot be built (RFC 9421 section 2.5) cannot be verified.
    return deny('signature_mismatch');
  }
  if (!verifyBytes(pub.key, pub.alg, base, signature)) return deny('signature_mismatch');

  // 16. The content matches its digest.
  const body = bodyBytes(request.body);
  if (!equalBytes(sha256(body), digest)) return deny('content_digest_mismatch');

  // 17. Presentations by reference (spec section 1.2).
  const out: Partial<Record<PresentationMember, string>> = {};
  let content: ReturnType<typeof readCredentials> | undefined;
  for (const [name, pres] of presentations) {
    if ('inline' in pres) {
      out[name] = pres.inline;
      continue;
    }
    content ??= readCredentials(body);
    const value = 'credentials' in content ? content.credentials[name] : undefined;
    if (typeof value !== 'string') return deny('presentation_missing');
    if (octets(value) <= INLINE_PRESENTATION_MAX_OCTETS || !PRESENTATION.test(value)) return deny('presentation_malformed');
    if (!equalBytes(sha256(new TextEncoder().encode(value)), pres.reference)) return deny('presentation_hash_mismatch');
    out[name] = value;
  }

  // 18. The nonce, last, so only a request that passed everything else uses it up.
  const fresh = await options.nonceStore.checkAndStore(keyid.value, nonce.value, expires.value + skew);
  if (fresh !== true) return deny('nonce_replayed');

  return {
    ok: true,
    keyid: keyid.value,
    alg: pub.alg,
    label,
    created: created.value,
    expires: expires.value,
    nonce: nonce.value,
    agentPassport: out.agent_passport!,
    agentGrant: out.agent_grant!,
    agentTrust: out.agent_trust ?? null,
  };
}
