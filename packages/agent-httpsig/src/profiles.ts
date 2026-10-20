// SPDX-License-Identifier: Apache-2.0
/**
 * Signature profiles: one RFC 9421 signer and verifier for the three
 * profiles an agent request can carry, chosen by name.
 *
 *   grantex       spec/verification.md: `tag="agent-payer-auth"`, exactly
 *                 ("@method" "@authority" "@path" "content-digest"
 *                 "agent-passport" "agent-grant"), at most 300 seconds.
 *                 `sign()` and `verify()` in profile.ts, unchanged; this
 *                 module delegates to them.
 *   tap           Visa Trusted Agent Protocol message signature:
 *                 `tag` is `agent-browser-auth` (browsing) or
 *                 `agent-payer-auth` (payment), at least ("@authority"
 *                 "@path"), `created`, `expires` at most 8 minutes later,
 *                 `keyid` (an identifier from the network's key store, not a
 *                 thumbprint), `alg`, and a `nonce` that is equal in every
 *                 signature of the message and refused when seen in the last
 *                 8 minutes.
 *   web-bot-auth  draft-ietf-webbotauth-httpsig-protocol-00 section 5:
 *                 `tag="web-bot-auth"`, `@authority` or `@target-uri`, the
 *                 `"signature-agent";key="<label>"` member of the
 *                 Signature-Agent Dictionary (section 5.2.1), `created`,
 *                 `expires` (at most 24 hours later, section 5.2), `keyid`
 *                 the key's RFC 7638 thumbprint, and keys looked up by the
 *                 (Signature-Agent URL, keyid) pair (section 5.4).
 *
 * The grantex profile and the TAP payer profile share the tag
 * `agent-payer-auth`; the verifier is configured with the profile it
 * enforces, so a request is never read under a profile the relying party
 * did not choose.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentHttpSigError } from './errors.js';
import { jwkThumbprint, privateKeyObject, publicKeyObject, signBytes, verifyBytes } from './keys.js';
import type { AgentJwk, SignatureAlgorithm } from './keys.js';
import { bodyBytes, createSignatureBase, fieldValue, normaliseAuthority, parseTarget } from './message.js';
import type { AgentRequest } from './message.js';
import {
  AGENT_PAYER_AUTH_TAG,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_SIGNATURE_LABEL,
  MAX_CLOCK_SKEW_SECONDS,
  contentDigest,
  sign,
  verify,
} from './profile.js';
import type { DenialCode, DenialReason, NonceStore, SignOptions, VerifyOptions, VerifySuccess } from './profile.js';
import {
  encodeBase64,
  parseDictionary,
  serializeDictionary,
  serializeInnerList,
} from './structured-fields.js';
import type { BareItem, Dictionary, InnerList, Item, Member } from './structured-fields.js';

export type ProfileName = 'grantex' | 'tap' | 'web-bot-auth';

/** TAP tags (Visa TAP specification, message signature parameters). */
export const TAP_BROWSER_TAG = 'agent-browser-auth';
export const TAP_PAYER_TAG = AGENT_PAYER_AUTH_TAG;
/** draft-ietf-webbotauth-httpsig-protocol-00 section 5.2. */
export const WEB_BOT_AUTH_TAG = 'web-bot-auth';
/** TAP: `expires - created` at most 8 minutes, and a nonce is refused when seen in the last 8 minutes. */
export const TAP_MAX_WINDOW_SECONDS = 480;
export const TAP_NONCE_REPLAY_WINDOW_SECONDS = 480;
/** Web Bot Auth: expiry RECOMMENDED at most 24 hours after creation (section 5.2). */
export const WEB_BOT_AUTH_MAX_WINDOW_SECONDS = 86_400;
export const SIGNATURE_AGENT_FIELD = 'signature-agent';
/** Signature-Agent member types (draft-meunier-webbotauth-httpsig-directory-00 section 4.1). */
export const SIGNATURE_AGENT_TYPES = ['directory', 'jwks_uri', 'cimd'] as const;
export type SignatureAgentType = (typeof SIGNATURE_AGENT_TYPES)[number];

export interface ProfileDefinition {
  name: ProfileName;
  /** The tags a signature of the profile carries; the first is the signer's default. */
  tags: readonly string[];
  /** What the signer covers by default (the grantex set is fixed). */
  defaultComponents: readonly string[];
  maxWindowSeconds: number;
  defaultWindowSeconds: number;
  nonce: 'required' | 'optional';
  /** `thumbprint`: keyid is the key's RFC 7638 thumbprint. `opaque`: an identifier from a key store. */
  keyid: 'thumbprint' | 'opaque';
}

export const SIGNATURE_PROFILES: Readonly<Record<ProfileName, ProfileDefinition>> = Object.freeze({
  grantex: {
    name: 'grantex',
    tags: [AGENT_PAYER_AUTH_TAG],
    defaultComponents: ['@method', '@authority', '@path', 'content-digest', 'agent-passport', 'agent-grant'],
    maxWindowSeconds: 300,
    defaultWindowSeconds: 60,
    nonce: 'required',
    keyid: 'thumbprint',
  },
  tap: {
    name: 'tap',
    tags: [TAP_PAYER_TAG, TAP_BROWSER_TAG],
    defaultComponents: ['@authority', '@path'],
    maxWindowSeconds: TAP_MAX_WINDOW_SECONDS,
    defaultWindowSeconds: TAP_MAX_WINDOW_SECONDS,
    nonce: 'required',
    keyid: 'opaque',
  },
  'web-bot-auth': {
    name: 'web-bot-auth',
    tags: [WEB_BOT_AUTH_TAG],
    defaultComponents: ['@authority', SIGNATURE_AGENT_FIELD],
    maxWindowSeconds: WEB_BOT_AUTH_MAX_WINDOW_SECONDS,
    defaultWindowSeconds: 300,
    nonce: 'optional',
    keyid: 'thumbprint',
  },
});

/** A Signature-Agent member: an https URL and how to read it. */
export interface SignatureAgent {
  /** The Dictionary member key. */
  label: string;
  url: string;
  type: SignatureAgentType;
}

const OPAQUE_KEYID = /^[!#-[\]-~]{1,256}$/;
const THUMBPRINT_KEYID = /^[A-Za-z0-9_-]{43}$/;
const TAP_NONCE = /^[!#-[\]-~]{1,256}$/;
const B64URL_NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const LABEL = /^[a-z*][a-z0-9_\-.*]*$/;
const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Components a profile signature may cover: derived ones this library implements, and fields. */
const DERIVED = new Set(['@method', '@target-uri', '@authority', '@scheme', '@path', '@query']);
const FIELD = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

function fail(message: string): never {
  throw new AgentHttpSigError(message);
}

const item = (value: BareItem, params: Map<string, BareItem> = new Map()): Item => ({ value, params });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const sha = (alg: 'sha256' | 'sha512', data: Uint8Array) => new Uint8Array(createHash(alg).update(data).digest());
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

// ── Signature-Agent ──────────────────────────────────────────────────────────

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    // Not a URL at all.
    return false;
  }
}

/**
 * The Signature-Agent field for the given members, in the Dictionary form
 * signers MUST use (draft-ietf-webbotauth-httpsig-protocol-00 section
 * 5.2.1). `type` is omitted when it is `directory`, the default.
 */
export function serializeSignatureAgent(agents: readonly SignatureAgent[]): string {
  const dictionary: Dictionary = new Map();
  for (const agent of agents) {
    if (!LABEL.test(agent.label)) fail('invalid Signature-Agent label');
    if (!isHttpsUrl(agent.url)) fail('a Signature-Agent value must be an https URL');
    if (!(SIGNATURE_AGENT_TYPES as readonly string[]).includes(agent.type)) fail('unsupported Signature-Agent type');
    const params = new Map<string, BareItem>();
    if (agent.type !== 'directory') params.set('type', { type: 'token', value: agent.type });
    dictionary.set(agent.label, item({ type: 'string', value: agent.url }, params));
  }
  return serializeDictionary(dictionary);
}

/**
 * The members of a Signature-Agent field that a verifier can use: String
 * values holding an https URL, with a `type` of directory (the default),
 * jwks_uri or cimd. Members of another type are ignored, as section 5.2.1
 * requires; a field that does not parse as a Dictionary throws.
 */
export function parseSignatureAgent(value: string): Map<string, SignatureAgent> {
  const out = new Map<string, SignatureAgent>();
  for (const [label, member] of parseDictionary(value)) {
    if ('items' in member || member.value.type !== 'string') continue;
    const type = member.params.get('type');
    let agentType: SignatureAgentType = 'directory';
    if (type !== undefined) {
      if (type.type !== 'token' || !(SIGNATURE_AGENT_TYPES as readonly string[]).includes(type.value)) continue;
      agentType = type.value as SignatureAgentType;
    }
    if (!isHttpsUrl(member.value.value)) continue;
    out.set(label, { label, url: member.value.value, type: agentType });
  }
  return out;
}

// ── Signing ──────────────────────────────────────────────────────────────────

interface CommonSignOptions {
  key: AgentJwk;
  /** UNIX seconds. Defaults to now. */
  created?: number;
  expires?: number;
  label?: string;
  /**
   * Covered components, in order. Field components must be in the request,
   * except `content-digest` (computed when absent) and `signature-agent`
   * (set from `signatureAgent`).
   */
  components?: readonly string[];
}

export interface TapSignOptions extends CommonSignOptions {
  profile: 'tap';
  /** The key's identifier in the network's key store. Defaults to the RFC 7638 thumbprint. */
  keyid?: string;
  /** `agent-payer-auth` (default) or `agent-browser-auth`. */
  tag?: string;
  /** Defaults to a random UUID. Put the same value in the TAP body objects. */
  nonce?: string;
  /** Adds the `alg` parameter (RFC 9421 section 2.3). Defaults to true. */
  includeAlg?: boolean;
}

export interface WebBotAuthSignOptions extends CommonSignOptions {
  profile: 'web-bot-auth';
  /** Where the key can be found: the signer's origin (directory), a JWK Set URL, or a CIMD. */
  signatureAgent: { url: string; type?: SignatureAgentType };
  /** Defaults to 32 random octets, base64url; null sends no nonce. */
  nonce?: string | null;
}

export type GrantexProfileSignOptions = SignOptions & { profile?: 'grantex' };
export type ProfileSignOptions = GrantexProfileSignOptions | TapSignOptions | WebBotAuthSignOptions;

export interface ProfileSignResult {
  profile: ProfileName;
  /** The fields to set on the request. */
  headers: Record<string, string>;
  label: string;
  tag: string;
  keyid: string;
  alg: SignatureAlgorithm;
  created: number;
  expires: number;
  nonce: string | null;
  components: string[];
  signatureBase: string;
}

/** A covered component as an Inner List member; signature-agent carries its `key` (RFC 9421 section 2.1.2). */
function componentItem(component: string, signatureAgentLabel: string | null): Item {
  if (component === SIGNATURE_AGENT_FIELD) {
    if (signatureAgentLabel === null) fail('signature-agent is covered but no Signature-Agent is sent');
    return item({ type: 'string', value: component }, new Map([['key', { type: 'string', value: signatureAgentLabel }]]));
  }
  if (!DERIVED.has(component) && !FIELD.test(component)) fail(`unsupported covered component ${component}`);
  return item({ type: 'string', value: component });
}

/**
 * Signs a request under a profile and returns the fields to set on it.
 * For `grantex` (or no profile) this is `sign()`.
 */
export function signWithProfile(request: AgentRequest, input: ProfileSignOptions): ProfileSignResult {
  if (input.profile === undefined || input.profile === 'grantex') {
    const options = input as GrantexProfileSignOptions;
    const result = sign(request, options);
    return {
      profile: 'grantex',
      headers: result.headers,
      label: options.label ?? DEFAULT_SIGNATURE_LABEL,
      tag: AGENT_PAYER_AUTH_TAG,
      keyid: result.keyid,
      alg: result.alg,
      created: result.created,
      expires: result.expires,
      nonce: result.nonce,
      components: [...SIGNATURE_PROFILES.grantex.defaultComponents],
      signatureBase: result.signatureBase,
    };
  }
  const options = input as TapSignOptions | WebBotAuthSignOptions;
  const definition = SIGNATURE_PROFILES[options.profile];
  if (definition === undefined) fail('unknown signature profile');
  const { key, alg } = privateKeyObject(options.key);
  const thumbprint = jwkThumbprint(options.key);
  const label = options.label ?? DEFAULT_SIGNATURE_LABEL;
  if (!LABEL.test(label)) fail('invalid signature label');
  if (!METHOD.test(request.method)) fail('invalid method');
  const target = parseTarget(request.url);
  if (target.authority === null) fail('signWithProfile() needs an absolute URL');

  const created = options.created ?? nowSeconds();
  const expires = options.expires ?? created + definition.defaultWindowSeconds;
  for (const [name, value] of [['created', created], ['expires', expires]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer (UNIX seconds)`);
  }
  if (expires <= created || expires - created > definition.maxWindowSeconds) {
    fail(`expires must be 1 to ${definition.maxWindowSeconds} seconds after created`);
  }

  let keyid: string;
  let tag: string;
  let nonce: string | null;
  let signatureAgent: SignatureAgent | null = null;
  let includeAlg = false;
  if (options.profile === 'tap') {
    keyid = options.keyid ?? thumbprint;
    if (!OPAQUE_KEYID.test(keyid)) fail('a TAP keyid is 1 to 256 printable characters without quotes or backslashes');
    tag = options.tag ?? TAP_PAYER_TAG;
    if (!definition.tags.includes(tag)) fail(`a TAP tag is one of ${definition.tags.join(', ')}`);
    nonce = options.nonce ?? randomUUID();
    if (!TAP_NONCE.test(nonce)) fail('a TAP nonce is 1 to 256 printable characters without quotes or backslashes');
    includeAlg = options.includeAlg ?? true;
  } else {
    keyid = thumbprint;
    tag = WEB_BOT_AUTH_TAG;
    nonce = options.nonce === undefined ? randomBytes(32).toString('base64url') : options.nonce;
    if (nonce !== null && !B64URL_NONCE.test(nonce)) fail('nonce must be 22 to 128 base64url characters');
    signatureAgent = { label, url: options.signatureAgent.url, type: options.signatureAgent.type ?? 'directory' };
  }

  const components = [...(options.components ?? definition.defaultComponents)];
  checkProfileComponents(options.profile, components, signatureAgent !== null);

  const headers: Record<string, string> = {};
  const signedHeaders: [string, string][] = [];
  const copy = request.headers;
  if (copy !== undefined) {
    if (typeof Headers !== 'undefined' && copy instanceof Headers) copy.forEach((v, n) => signedHeaders.push([n, v]));
    else if (Array.isArray(copy)) for (const [n, v] of copy as ReadonlyArray<readonly [string, string]>) signedHeaders.push([n, v]);
    else {
      for (const [n, v] of Object.entries(copy as Record<string, string | readonly string[] | undefined>)) {
        if (v === undefined) continue;
        for (const line of typeof v === 'string' ? [v] : v) signedHeaders.push([n, line]);
      }
    }
  }
  if (components.includes('content-digest') && fieldValue(signedHeaders, 'content-digest') === null) {
    headers['Content-Digest'] = contentDigest(request.body);
  }
  if (signatureAgent !== null) {
    headers['Signature-Agent'] = serializeSignatureAgent([signatureAgent]);
  }
  for (const [n, v] of Object.entries(headers)) signedHeaders.push([n, v]);

  const params = new Map<string, BareItem>([
    ['created', { type: 'integer', value: created }],
    ['expires', { type: 'integer', value: expires }],
    ['keyid', { type: 'string', value: keyid }],
  ]);
  if (includeAlg) params.set('alg', { type: 'string', value: alg });
  if (nonce !== null) params.set('nonce', { type: 'string', value: nonce });
  params.set('tag', { type: 'string', value: tag });
  const inner: InnerList = {
    items: components.map((c) => componentItem(c, signatureAgent?.label ?? null)),
    params,
  };
  const signatureBase = createSignatureBase(
    { method: request.method, url: request.url, headers: signedHeaders, body: request.body ?? null },
    inner,
  );
  const signature = signBytes(key, alg, signatureBase);
  headers['Signature-Input'] = `${label}=${serializeInnerList(inner)}`;
  headers.Signature = `${label}=:${encodeBase64(signature)}:`;
  return { profile: options.profile, headers, label, tag, keyid, alg, created, expires, nonce, components, signatureBase };
}

/** The minimum covered set of a profile (TAP specification; WBA section 5.2). */
function checkProfileComponents(profile: 'tap' | 'web-bot-auth', components: readonly string[], hasAgent: boolean) {
  if (new Set(components).size !== components.length) fail('a component is listed twice');
  if (profile === 'tap') {
    if (!components.includes('@authority') || !components.includes('@path')) fail('a TAP signature covers @authority and @path');
    if (components.includes(SIGNATURE_AGENT_FIELD)) fail('TAP does not use Signature-Agent');
  } else {
    if (!components.includes('@authority') && !components.includes('@target-uri')) {
      fail('a Web Bot Auth signature covers @authority or @target-uri');
    }
    if (hasAgent && !components.includes(SIGNATURE_AGENT_FIELD)) fail('a Web Bot Auth signature covers signature-agent');
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

export type ProfileDenialReason =
  | DenialReason
  | 'tag_not_accepted'
  | 'nonce_missing'
  | 'nonce_mismatch'
  | 'algorithm_mismatch'
  | 'signature_agent_missing'
  | 'signature_agent_unsupported';

/** What a profile verifier hands its key resolver. */
export interface KeyReference {
  profile: ProfileName;
  tag: string;
  keyid: string;
  /** Web Bot Auth: the Signature-Agent member the signature covers. Look keys up by (url, keyid), never keyid alone. */
  signatureAgent: SignatureAgent | null;
}

export interface TapVerifyOptions {
  profile: 'tap';
  /** The public JWK the relying party trusts for the key store's keyid, or null. */
  resolveKey: (ref: KeyReference) => AgentJwk | null | undefined | Promise<AgentJwk | null | undefined>;
  expectedAuthority: string;
  nonceStore: NonceStore;
  /** The tags accepted. Defaults to both TAP tags. */
  tags?: readonly string[];
  /** Components that must be covered beyond @authority and @path, e.g. `@method` or `content-digest`. */
  requiredComponents?: readonly string[];
  now?: number;
  clockSkewSeconds?: number;
  /** Selects the signature by label when the message carries several with an accepted tag. */
  label?: string;
}

export interface WebBotAuthVerifyOptions {
  profile: 'web-bot-auth';
  resolveKey: (ref: KeyReference) => AgentJwk | null | undefined | Promise<AgentJwk | null | undefined>;
  expectedAuthority: string;
  /** For `@target-uri`. Defaults to `https`. */
  expectedScheme?: 'https' | 'http';
  nonceStore: NonceStore;
  requiredComponents?: readonly string[];
  /** Defaults to 86400 (24 hours), the most section 5.2 recommends. */
  maxWindowSeconds?: number;
  /** Requires a covered Signature-Agent member. Defaults to true. */
  requireSignatureAgent?: boolean;
  now?: number;
  clockSkewSeconds?: number;
  label?: string;
}

export type GrantexProfileVerifyOptions = VerifyOptions & { profile?: 'grantex' };
export type ProfileVerifyOptions = GrantexProfileVerifyOptions | TapVerifyOptions | WebBotAuthVerifyOptions;

export interface ProfileVerifySuccess {
  ok: true;
  profile: ProfileName;
  tag: string;
  label: string;
  keyid: string;
  alg: SignatureAlgorithm;
  created: number;
  expires: number;
  nonce: string | null;
  components: string[];
  signatureAgent: SignatureAgent | null;
  /** For the grantex profile: the presentations `verify()` returns. */
  grantex?: VerifySuccess;
}

export interface ProfileVerifyFailure {
  ok: false;
  profile: ProfileName;
  code: DenialCode;
  reason: ProfileDenialReason;
}

export type ProfileVerifyResult = ProfileVerifySuccess | ProfileVerifyFailure;

/** RFC 9530: the first sha-512 or sha-256 member, checked against the content. */
function contentDigestMatches(value: string | null, body: Uint8Array): boolean | null {
  if (value === null) return null;
  let dictionary: Dictionary;
  try {
    dictionary = parseDictionary(value);
  } catch {
    // A Content-Digest that does not parse cannot match.
    return null;
  }
  let checked = false;
  for (const [alg, hash] of [['sha-512', 'sha512'], ['sha-256', 'sha256']] as const) {
    const member = dictionary.get(alg);
    if (member === undefined) continue;
    if ('items' in member || member.value.type !== 'binary') return null;
    if (!equalBytes(sha(hash, body), member.value.value)) return false;
    checked = true;
  }
  return checked ? true : null;
}

function componentName(c: Item): string | null {
  return c.value.type === 'string' ? c.value.value : null;
}

/**
 * Verifies a request under a profile. For `grantex` (or no profile) this is
 * `verify()`. A request that fails is answered with a denial; a failure of
 * `resolveKey` or `nonceStore` is thrown, and the caller must refuse.
 */
export async function verifyWithProfile(request: AgentRequest, input: ProfileVerifyOptions): Promise<ProfileVerifyResult> {
  if (input.profile === undefined || input.profile === 'grantex') {
    const result = await verify(request, input as GrantexProfileVerifyOptions);
    if (!result.ok) return { ok: false, profile: 'grantex', code: result.code, reason: result.reason };
    return {
      ok: true,
      profile: 'grantex',
      tag: AGENT_PAYER_AUTH_TAG,
      label: result.label,
      keyid: result.keyid,
      alg: result.alg,
      created: result.created,
      expires: result.expires,
      nonce: result.nonce,
      components: [...SIGNATURE_PROFILES.grantex.defaultComponents],
      signatureAgent: null,
      grantex: result,
    };
  }
  const options = input as TapVerifyOptions | WebBotAuthVerifyOptions;
  const profile = options.profile;
  const definition = SIGNATURE_PROFILES[profile];
  if (definition === undefined) fail('unknown signature profile');
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_SECONDS) {
    fail(`clockSkewSeconds must be an integer from 0 to ${MAX_CLOCK_SKEW_SECONDS}`);
  }
  if (typeof options.expectedAuthority !== 'string' || options.expectedAuthority === '') fail('expectedAuthority is required');
  const expectedAuthority = normaliseAuthority(options.expectedAuthority, null);
  if (/:(?:80|443)$/.test(expectedAuthority)) fail('expectedAuthority must omit the default port (80 or 443)');
  const clock: unknown = options.now ?? nowSeconds();
  if (typeof clock !== 'number' || !Number.isFinite(clock) || clock < 0) {
    fail('now must be a finite, non-negative number (UNIX seconds)');
  }
  const now = Math.floor(clock);
  let maxWindow = definition.maxWindowSeconds;
  if (profile === 'web-bot-auth' && options.maxWindowSeconds !== undefined) {
    if (!Number.isInteger(options.maxWindowSeconds) || options.maxWindowSeconds < 1 || options.maxWindowSeconds > WEB_BOT_AUTH_MAX_WINDOW_SECONDS) {
      fail(`maxWindowSeconds must be an integer from 1 to ${WEB_BOT_AUTH_MAX_WINDOW_SECONDS}`);
    }
    maxWindow = options.maxWindowSeconds;
  }
  const tags = profile === 'tap' ? (options.tags ?? definition.tags) : definition.tags;
  for (const t of tags) if (!definition.tags.includes(t)) fail(`tag ${t} is not a ${profile} tag`);
  const deny = (reason: ProfileDenialReason, code: DenialCode = 'request_signature_invalid'): ProfileVerifyFailure => ({
    ok: false,
    profile,
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
    // RFC 9651 section 4.2: a field that fails to parse is malformed.
    return deny('signature_malformed');
  }

  // 3. The signature with an accepted tag (RFC 9421 section 7.2.7).
  const profileTagged = [...inputs].filter(([, m]) => {
    const tag = 'items' in m ? m.params.get('tag') : undefined;
    return tag?.type === 'string' && definition.tags.includes(tag.value);
  }) as [string, InnerList][];
  if (profileTagged.length === 0) return deny('signature_not_found');
  let candidates = profileTagged;
  if (options.label !== undefined) candidates = candidates.filter(([l]) => l === options.label);
  if (candidates.length === 0) return deny('signature_not_found');
  if (candidates.length > 1) return deny('signature_ambiguous');
  const [label, member] = candidates[0]!;
  const tagParam = member.params.get('tag') as { type: 'string'; value: string };
  if (!tags.includes(tagParam.value)) return deny('tag_not_accepted');

  // 4. Its Signature value.
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

  // 5. Covered components: implemented ones only, and the profile minimum.
  const names: string[] = [];
  let agentKey: string | null = null;
  for (const c of member.items) {
    const name = componentName(c);
    if (name === null) return deny('covered_components_mismatch');
    if (name === SIGNATURE_AGENT_FIELD && profile === 'web-bot-auth') {
      const key = c.params.get('key');
      if (c.params.size !== 1 || key?.type !== 'string' || agentKey !== null) return deny('covered_components_mismatch');
      agentKey = key.value;
    } else if (c.params.size !== 0 || (!DERIVED.has(name) && (name.startsWith('@') || !FIELD.test(name)))) {
      return deny('covered_components_mismatch');
    }
    names.push(name);
  }
  if (new Set(names).size !== names.length) return deny('covered_components_mismatch');
  if (profile === 'tap') {
    if (!names.includes('@authority') || !names.includes('@path')) return deny('covered_components_mismatch');
  } else if (!names.includes('@authority') && !names.includes('@target-uri')) {
    return deny('covered_components_mismatch');
  }
  for (const required of options.requiredComponents ?? []) {
    if (!names.includes(required)) return deny('covered_components_mismatch');
  }

  // 6. Parameters.
  const p = member.params;
  const created = p.get('created');
  const expires = p.get('expires');
  const keyid = p.get('keyid');
  const nonce = p.get('nonce');
  const algParam = p.get('alg');
  if (
    created?.type !== 'integer' ||
    expires?.type !== 'integer' ||
    keyid?.type !== 'string' ||
    created.value < 0 ||
    expires.value <= created.value ||
    (nonce !== undefined && nonce.type !== 'string') ||
    (algParam !== undefined && algParam.type !== 'string')
  ) {
    return deny('signature_params_mismatch');
  }
  const keyidPattern = definition.keyid === 'thumbprint' ? THUMBPRINT_KEYID : OPAQUE_KEYID;
  if (!keyidPattern.test(keyid.value)) return deny('signature_params_mismatch');
  const nonceValue = nonce?.type === 'string' ? nonce.value : null;
  if (definition.nonce === 'required' && nonceValue === null) return deny('nonce_missing');
  if (nonceValue !== null && !(profile === 'tap' ? TAP_NONCE : B64URL_NONCE).test(nonceValue)) {
    return deny('signature_params_mismatch');
  }
  if (profile === 'tap') {
    // TAP: the nonce is the same in every signature of the message.
    for (const [, m] of inputs) {
      const other = 'items' in m ? m.params.get('nonce') : undefined;
      if (other !== undefined && (other.type !== 'string' || other.value !== nonceValue)) return deny('nonce_mismatch');
    }
  }

  // 7-9. Time.
  if (expires.value - created.value > maxWindow) return deny('window_too_long');
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

  // 11. Web Bot Auth: the Signature-Agent member the signature covers.
  let signatureAgent: SignatureAgent | null = null;
  if (profile === 'web-bot-auth') {
    if (agentKey === null) {
      if (options.requireSignatureAgent ?? true) return deny('signature_agent_missing');
    } else {
      const field = fieldValue(headers, SIGNATURE_AGENT_FIELD);
      if (field === null) return deny('signature_agent_missing');
      let agents: Map<string, SignatureAgent>;
      try {
        agents = parseSignatureAgent(field);
      } catch {
        // A Signature-Agent that does not parse names no key source.
        return deny('signature_malformed');
      }
      const agent = agents.get(agentKey);
      if (agent === undefined) return deny('signature_agent_unsupported');
      signatureAgent = agent;
    }
  }

  // 12. The key, looked up by keyid (and Signature-Agent for Web Bot Auth).
  const resolveKey = options.resolveKey as (ref: KeyReference) => ReturnType<TapVerifyOptions['resolveKey']>;
  const resolved = await resolveKey({ profile, tag: tagParam.value, keyid: keyid.value, signatureAgent });
  if (resolved === null || resolved === undefined) return deny('key_unknown');
  const pub = publicKeyObject(resolved);
  if (pub === null) return deny('key_mismatch');
  if (definition.keyid === 'thumbprint' && jwkThumbprint(resolved) !== keyid.value) return deny('key_mismatch');
  // RFC 9421 section 3.2 step 6.5: an alg parameter must agree with the key.
  // TAP's own example spells Ed25519 with a capital E; accepted for TAP only.
  if (algParam?.type === 'string') {
    const accepted = profile === 'tap' && pub.alg === 'ed25519' ? ['ed25519', 'Ed25519'] : [pub.alg];
    if (!accepted.includes(algParam.value)) return deny('algorithm_mismatch');
  }

  // 13. The signature over the recreated base, with this verifier's view of the target.
  const scheme = profile === 'web-bot-auth' ? (options.expectedScheme ?? 'https') : 'https';
  const overrides: Record<string, string> = {
    '@authority': expectedAuthority,
    '@target-uri': `${scheme}://${expectedAuthority}${target.path === '' ? '/' : target.path}${target.query ?? ''}`,
  };
  let base: string;
  try {
    base = createSignatureBase(request, member, overrides);
  } catch {
    // A base that cannot be built (RFC 9421 section 2.5) cannot be verified.
    return deny('signature_mismatch');
  }
  if (!verifyBytes(pub.key, pub.alg, base, signature)) return deny('signature_mismatch');

  // 14. A covered Content-Digest must match the content.
  if (names.includes('content-digest')) {
    const match = contentDigestMatches(fieldValue(headers, 'content-digest'), bodyBytes(request.body));
    if (match === null) return deny('content_digest_malformed');
    if (!match) return deny('content_digest_mismatch');
  }

  // 15. The nonce, last. TAP: refused when seen in the last 8 minutes.
  if (nonceValue !== null) {
    const until = profile === 'tap'
      ? Math.max(expires.value + skew, now + TAP_NONCE_REPLAY_WINDOW_SECONDS)
      : expires.value + skew;
    // Web Bot Auth keys are scoped to their Signature-Agent (section 5.4), and so is the nonce.
    const scope = signatureAgent === null ? keyid.value : `${signatureAgent.url} ${keyid.value}`;
    const fresh = await options.nonceStore.checkAndStore(scope, nonceValue, until);
    if (fresh !== true) return deny('nonce_replayed');
  }

  return {
    ok: true,
    profile,
    tag: tagParam.value,
    label,
    keyid: keyid.value,
    alg: pub.alg,
    created: created.value,
    expires: expires.value,
    nonce: nonceValue,
    components: names,
    signatureAgent,
  };
}
