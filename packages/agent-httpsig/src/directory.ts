// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The HTTP Message Signatures key directory of
 * draft-meunier-webbotauth-httpsig-directory-00: a JWK Set served at
 * `/.well-known/http-message-signatures-directory` with media type
 * `application/http-message-signatures-directory+json` (section 3), each
 * key's `kid` its RFC 7638 thumbprint, and the response signed once per key
 * (section 5.2) over `"@authority";req` and `content-digest` with
 * `tag="http-message-signatures-directory"`. Clients SHOULD ignore keys
 * without a valid response signature; `verifyDirectoryResponse` returns only
 * those.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AgentHttpSigError } from './errors.js';
import { jwkThumbprint, privateKeyObject, publicJwk, publicKeyObject, signBytes, verifyBytes } from './keys.js';
import type { AgentJwk } from './keys.js';
import { bodyBytes, createSignatureBase, fieldValue, normaliseAuthority } from './message.js';
import type { AgentRequest, AgentResponse } from './message.js';
import { contentDigest } from './profile.js';
import { encodeBase64, parseDictionary, serializeInnerList } from './structured-fields.js';
import type { BareItem, Dictionary, InnerList } from './structured-fields.js';

export const SIGNATURE_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const SIGNATURE_DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
export const SIGNATURE_DIRECTORY_TAG = 'http-message-signatures-directory';
/** Section 5.2: a directory signature is short-lived; the response is re-signed on each fetch. */
export const DIRECTORY_SIGNATURE_WINDOW_SECONDS = 300;

export interface DirectoryKey extends AgentJwk {
  kid: string;
  use: 'sig';
  /** UNIX seconds (RFC 7517 extension members used by the directory draft's example). */
  nbf?: number;
  exp?: number;
}

export interface SignatureDirectory {
  keys: DirectoryKey[];
}

function fail(message: string): never {
  throw new AgentHttpSigError(message);
}

/** The directory document: each key's public members, `kid` = its thumbprint, `use` = sig. */
export function buildSignatureDirectory(
  keys: readonly (AgentJwk & { nbf?: number; exp?: number })[],
): SignatureDirectory {
  const seen = new Set<string>();
  const out: DirectoryKey[] = [];
  for (const key of keys) {
    const pub = publicJwk(key);
    const kid = jwkThumbprint(pub);
    if (seen.has(kid)) continue;
    seen.add(kid);
    const entry: DirectoryKey = { ...pub, kid, use: 'sig' };
    if (key.nbf !== undefined) entry.nbf = key.nbf;
    if (key.exp !== undefined) entry.exp = key.exp;
    out.push(entry);
  }
  return { keys: out };
}

export interface SignDirectoryOptions {
  /** The authority the directory is served from (the request's @authority). */
  authority: string;
  /** Private JWKs; one signature each. */
  signingKeys: readonly AgentJwk[];
  created?: number;
  expires?: number;
}

/**
 * The response fields for a directory body: Content-Type, Content-Digest,
 * and one signature per signing key (labels `sig1`, `sig2`, ...).
 */
export function signDirectoryResponse(body: string, options: SignDirectoryOptions): Record<string, string> {
  if (options.signingKeys.length === 0) fail('at least one signing key is required');
  const authority = normaliseAuthority(options.authority, null);
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const expires = options.expires ?? created + DIRECTORY_SIGNATURE_WINDOW_SECONDS;
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires) || expires <= created) {
    fail('expires must be after created (UNIX seconds)');
  }
  const headers: Record<string, string> = {
    'Content-Type': SIGNATURE_DIRECTORY_MEDIA_TYPE,
    'Content-Digest': contentDigest(body),
  };
  const request: AgentRequest = { method: 'GET', url: `https://${authority}${SIGNATURE_DIRECTORY_PATH}` };
  const inputs: string[] = [];
  const signatures: string[] = [];
  options.signingKeys.forEach((jwk, i) => {
    const { key, alg } = privateKeyObject(jwk);
    const label = `sig${i + 1}`;
    const params: InnerList = {
      items: [
        { value: { type: 'string', value: '@authority' }, params: new Map([['req', { type: 'boolean', value: true }]]) },
        { value: { type: 'string', value: 'content-digest' }, params: new Map() },
      ],
      params: new Map<string, BareItem>([
        ['created', { type: 'integer', value: created }],
        ['expires', { type: 'integer', value: expires }],
        ['keyid', { type: 'string', value: jwkThumbprint(jwk) }],
        ['tag', { type: 'string', value: SIGNATURE_DIRECTORY_TAG }],
      ]),
    };
    const response: AgentResponse = { status: 200, headers, body };
    const base = createSignatureBase(response, params, {}, request);
    inputs.push(`${label}=${serializeInnerList(params)}`);
    signatures.push(`${label}=:${encodeBase64(signBytes(key, alg, base))}:`);
  });
  headers['Signature-Input'] = inputs.join(', ');
  headers.Signature = signatures.join(', ');
  return headers;
}

export interface VerifyDirectoryOptions {
  /** The authority the client fetched the directory from. */
  authority: string;
  now?: number;
  clockSkewSeconds?: number;
}

export interface VerifiedDirectory {
  /** Keys with a valid, current response signature; the only ones to use. */
  keys: DirectoryKey[];
  /** Keys present without a valid signature (ignored, section 5.2). */
  ignored: string[];
}

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

/**
 * Reads a directory response: the media type, the JWK Set, a Content-Digest
 * that matches, and for each key a signature by that key under the
 * directory tag. Throws when the response is not a directory at all.
 */
export function verifyDirectoryResponse(response: AgentResponse, options: VerifyDirectoryOptions): VerifiedDirectory {
  if (response.status !== 200) fail('a directory is read from a 200 response only');
  const contentType = fieldValue(response.headers, 'content-type');
  if (contentType === null || contentType.split(';')[0]!.trim().toLowerCase() !== SIGNATURE_DIRECTORY_MEDIA_TYPE) {
    fail(`the directory media type is ${SIGNATURE_DIRECTORY_MEDIA_TYPE}`);
  }
  const body = bodyBytes(response.body);
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return fail('the directory is not JSON');
  }
  const keys = (document as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) fail('the directory is not a JWK Set');
  const authority = normaliseAuthority(options.authority, null);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 10;
  const request: AgentRequest = { method: 'GET', url: `https://${authority}${SIGNATURE_DIRECTORY_PATH}` };

  const digestField = fieldValue(response.headers, 'content-digest');
  let digestOk = false;
  if (digestField !== null) {
    try {
      const member = parseDictionary(digestField).get('sha-256');
      digestOk = member !== undefined && !('items' in member) && member.value.type === 'binary'
        && member.value.value.length === 32 && timingSafeEqual(member.value.value, sha256(body));
    } catch {
      // An unparseable digest verifies nothing.
      digestOk = false;
    }
  }

  let inputs: Dictionary = new Map();
  let signatures: Dictionary = new Map();
  const inputField = fieldValue(response.headers, 'signature-input');
  const signatureField = fieldValue(response.headers, 'signature');
  if (inputField !== null && signatureField !== null) {
    try {
      inputs = parseDictionary(inputField);
      signatures = parseDictionary(signatureField);
    } catch {
      // Unparseable signatures sign nothing; every key is ignored.
      inputs = new Map();
    }
  }
  const signedKids = new Set<string>();
  if (digestOk) {
    for (const [label, member] of inputs) {
      if (!('items' in member)) continue;
      const p = member.params;
      const tag = p.get('tag');
      const keyid = p.get('keyid');
      const created = p.get('created');
      const expires = p.get('expires');
      if (tag?.type !== 'string' || tag.value !== SIGNATURE_DIRECTORY_TAG || keyid?.type !== 'string') continue;
      if (created?.type !== 'integer' || expires?.type !== 'integer') continue;
      if (created.value > now + skew || now >= expires.value + skew) continue;
      const covered = member.items.map((c) => `${c.value.type === 'string' ? c.value.value : ''}${c.params.has('req') ? ';req' : ''}`);
      if (!covered.includes('@authority;req') || !covered.includes('content-digest')) continue;
      const jwk = keys.find((k) => {
        try {
          return jwkThumbprint(k as AgentJwk) === keyid.value;
        } catch {
          // A key the library cannot read has no thumbprint to match.
          return false;
        }
      }) as AgentJwk | undefined;
      const pub = jwk === undefined ? null : publicKeyObject(publicJwk(jwk));
      const sig = signatures.get(label);
      if (pub === null || sig === undefined || 'items' in sig || sig.value.type !== 'binary') continue;
      let base: string;
      try {
        base = createSignatureBase(response, member, {}, request);
      } catch {
        // A base that cannot be built is not a valid signature.
        continue;
      }
      if (verifyBytes(pub.key, pub.alg, base, sig.value.value)) signedKids.add(keyid.value);
    }
  }
  const valid: DirectoryKey[] = [];
  const ignored: string[] = [];
  for (const k of keys) {
    let kid: string;
    try {
      kid = jwkThumbprint(k as AgentJwk);
    } catch {
      // Not a key type this library reads.
      ignored.push(String((k as { kid?: unknown })?.kid ?? ''));
      continue;
    }
    // Section 3: a kid, when present, MUST equal the thumbprint.
    const declared = (k as { kid?: unknown }).kid;
    if (signedKids.has(kid) && (declared === undefined || declared === kid)) {
      valid.push({ ...publicJwk(k as AgentJwk), kid, use: 'sig' });
    } else {
      ignored.push(kid);
    }
  }
  return { keys: valid, ignored };
}
