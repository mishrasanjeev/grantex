// SPDX-License-Identifier: Apache-2.0
/**
 * Visa Trusted Agent Protocol body objects, and the Grantex consent record
 * that travels beside them.
 *
 * The TAP specification defines two signed objects carried in the request
 * body next to the message signature:
 *
 *   agenticConsumer          consumer recognition: nonce, idToken (an OIDC
 *                            compatible JWT), contextualData {countryCode,
 *                            zip, ipAddress, deviceData}, kid, alg, signature
 *   agenticPaymentContainer  nonce, kid, alg, signature, and optionally
 *                            paymentCredentialsHash, cardMetadata,
 *                            credentialHash, payload, browsingIOU
 *
 * Each object's `nonce` must equal the message signature's nonce and its
 * `kid` should equal the signature's keyid. A consumer object that fails is a
 * soft failure (its content may be inaccurate; the merchant decides). A
 * payment container that fails must not be used to process payment.
 *
 * UNCONFIRMED by the published specification, so configurable here:
 *   - where in the body the objects are posted (`TapBodyMembers`; the
 *     defaults are top-level members named after the objects);
 *   - the canonicalization the object signature is computed over (the
 *     default is RFC 8785 JCS of the object without `signature`, signed with
 *     the agent key and encoded base64url; pass `canonicalize` to change it).
 * TAP's examples sign the objects with PS256; this library signs and
 * verifies ES256 (P-256) and EdDSA (Ed25519) only and reports any other
 * `alg` as unverifiable.
 *
 * The Grantex consent record object (`grantexConsentRecord`) is a Grantex
 * extension, not part of TAP: it names the granted Grantex consent the agent
 * acts under, bound to the same nonce, so a relying party can check it with
 * Grantex. It carries no principal identifier.
 */
import { AgentHttpSigError } from './errors.js';
import { canonicalJson } from './canonical.js';
import { privateKeyObject, publicKeyObject, signBytes, verifyBytes } from './keys.js';
import type { AgentJwk, SignatureAlgorithm } from './keys.js';

/** Where the objects sit in a JSON object body. UNCONFIRMED placement: configurable. */
export interface TapBodyMembers {
  consumer: string;
  paymentContainer: string;
  consentRecord: string;
}

export const DEFAULT_TAP_BODY_MEMBERS: Readonly<TapBodyMembers> = Object.freeze({
  consumer: 'agenticConsumer',
  paymentContainer: 'agenticPaymentContainer',
  consentRecord: 'grantexConsentRecord',
});

/** Bytes an object's signature covers, given the object without `signature`. */
export type TapCanonicalizer = (unsigned: Record<string, unknown>) => Uint8Array;

/** Default (UNCONFIRMED): RFC 8785 JCS, UTF-8. */
export const jcsCanonicalizer: TapCanonicalizer = (unsigned) => new TextEncoder().encode(canonicalJson(unsigned));

const JWS_ALG: Record<SignatureAlgorithm, string> = { 'ecdsa-p256-sha256': 'ES256', ed25519: 'EdDSA' };

function fail(message: string): never {
  throw new AgentHttpSigError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Signs a TAP body object: adds `kid`, `alg` (JWS name) and `signature` (base64url). */
export function signTapObject(
  fields: Record<string, unknown>,
  options: { key: AgentJwk; kid: string; canonicalize?: TapCanonicalizer | undefined },
): Record<string, unknown> {
  if (!nonEmpty(options.kid)) fail('kid is required');
  if ('signature' in fields) fail('the object is already signed');
  const { key, alg } = privateKeyObject(options.key);
  const unsigned = { ...fields, kid: options.kid, alg: JWS_ALG[alg] };
  const bytes = (options.canonicalize ?? jcsCanonicalizer)(unsigned);
  return { ...unsigned, signature: Buffer.from(signBytes(key, alg, bytes)).toString('base64url') };
}

export interface AgenticConsumerInput {
  key: AgentJwk;
  /** The key's identifier; should equal the message signature's keyid. */
  kid: string;
  /** The message signature's nonce. */
  nonce: string;
  /** An OIDC-compatible ID token (a JWT the issuer signed), passed through. */
  idToken: string;
  contextualData?: {
    /** ISO 3166-1 alpha-2. */
    countryCode?: string;
    /** At most 16 characters. */
    zip?: string;
    ipAddress?: string;
    deviceData?: Record<string, unknown>;
  };
  canonicalize?: TapCanonicalizer;
}

/** The `agenticConsumer` object (consumer recognition). */
export function buildAgenticConsumer(input: AgenticConsumerInput): Record<string, unknown> {
  if (!nonEmpty(input.nonce)) fail('nonce is required');
  if (!nonEmpty(input.idToken) || input.idToken.split('.').length !== 3) fail('idToken must be a compact JWT');
  const ctx = input.contextualData;
  if (ctx?.countryCode !== undefined && !/^[A-Z]{2}$/.test(ctx.countryCode)) fail('countryCode is ISO 3166-1 alpha-2');
  if (ctx?.zip !== undefined && (ctx.zip.length === 0 || ctx.zip.length > 16)) fail('zip is 1 to 16 characters');
  return signTapObject(
    { nonce: input.nonce, idToken: input.idToken, ...(ctx ? { contextualData: ctx } : {}) },
    { key: input.key, kid: input.kid, canonicalize: input.canonicalize },
  );
}

export interface AgenticPaymentContainerInput {
  key: AgentJwk;
  kid: string;
  nonce: string;
  paymentCredentialsHash?: string;
  cardMetadata?: Record<string, unknown>;
  credentialHash?: string;
  /** Already encrypted to the merchant's public key by the caller; passed through. */
  payload?: unknown;
  browsingIOU?: Record<string, unknown>;
  canonicalize?: TapCanonicalizer;
}

/** The `agenticPaymentContainer` object. Raw card data never goes in it unencrypted. */
export function buildAgenticPaymentContainer(input: AgenticPaymentContainerInput): Record<string, unknown> {
  if (!nonEmpty(input.nonce)) fail('nonce is required');
  const fields: Record<string, unknown> = { nonce: input.nonce };
  for (const name of ['paymentCredentialsHash', 'cardMetadata', 'credentialHash', 'payload', 'browsingIOU'] as const) {
    if (input[name] !== undefined) fields[name] = input[name];
  }
  return signTapObject(fields, { key: input.key, kid: input.kid, canonicalize: input.canonicalize });
}

/** The Grantex consent record fields the object is built from (the commerce consent record). */
export interface GrantexConsentSource {
  id: string;
  merchantId: string;
  agentId: string;
  passportType: string;
  status: string;
  approvedScopes: readonly string[] | null;
  maxAmount: number | null;
  currency: string | null;
  consentTextVersion: string;
  presentedPayloadHash: string | null;
  approvedAt: string | null;
  expiresAt: string;
}

export const GRANTEX_CONSENT_RECORD_TYPE = 'grantex-consent-record';

/**
 * The `grantexConsentRecord` object for a granted, unexpired Grantex
 * consent, bound to the message signature's nonce. Refuses (throws) for a
 * consent that is not granted, has no approved scopes, or has expired.
 */
export function buildGrantexConsentRecord(
  consent: GrantexConsentSource,
  options: { nonce: string; now?: Date },
): Record<string, unknown> {
  if (!nonEmpty(options.nonce)) fail('nonce is required');
  if (consent.status !== 'granted') fail('only a granted consent can be presented');
  if (consent.approvedScopes === null || consent.approvedScopes.length === 0) fail('the consent has no approved scopes');
  const expires = Date.parse(consent.expiresAt);
  if (!Number.isFinite(expires)) fail('expiresAt is not a timestamp');
  if (expires <= (options.now ?? new Date()).getTime()) fail('the consent has expired');
  return {
    type: GRANTEX_CONSENT_RECORD_TYPE,
    consent_id: consent.id,
    merchant_id: consent.merchantId,
    agent_id: consent.agentId,
    passport_type: consent.passportType,
    scopes: [...consent.approvedScopes],
    max_amount: consent.maxAmount,
    currency: consent.currency,
    consent_text_version: consent.consentTextVersion,
    presented_payload_hash: consent.presentedPayloadHash,
    approved_at: consent.approvedAt,
    expires_at: new Date(expires).toISOString(),
    nonce: options.nonce,
  };
}

/** Places the objects in a JSON object body under the configured members. */
export function withTapBodyObjects(
  body: Record<string, unknown>,
  objects: { consumer?: Record<string, unknown>; paymentContainer?: Record<string, unknown>; consentRecord?: Record<string, unknown> },
  members: TapBodyMembers = DEFAULT_TAP_BODY_MEMBERS,
): Record<string, unknown> {
  const out = { ...body };
  for (const name of ['consumer', 'paymentContainer', 'consentRecord'] as const) {
    const object = objects[name];
    if (object === undefined) continue;
    if (members[name] in out) fail(`the body already has a ${members[name]} member`);
    out[members[name]] = object;
  }
  return out;
}

export type TapObjectProblem =
  | 'missing_fields'
  | 'nonce_mismatch'
  | 'kid_mismatch'
  | 'algorithm_unsupported'
  | 'key_unavailable'
  | 'signature_invalid';

export interface TapObjectCheck {
  present: boolean;
  /** Every check passed. */
  verified: boolean;
  problems: TapObjectProblem[];
}

export interface TapBodyVerification {
  /** Soft: a consumer object that is not verified may be inaccurate; the merchant decides. */
  consumer: TapObjectCheck;
  /** Hard: false means the container must not be used to process payment. */
  paymentContainer: TapObjectCheck & { usableForPayment: boolean };
  /** The Grantex consent record, when present and bound to the nonce. */
  consentRecord: { present: boolean; nonceMatches: boolean; consentId: string | null };
}

export interface VerifyTapBodyOptions {
  /** The verified message signature's nonce. */
  nonce: string;
  /** The verified message signature's keyid. */
  keyid: string;
  /** The public JWK for a body object's kid, or null. A thrown error propagates. */
  resolveKey: (kid: string) => AgentJwk | null | undefined | Promise<AgentJwk | null | undefined>;
  members?: TapBodyMembers;
  canonicalize?: TapCanonicalizer;
}

const ALG_FOR_JWS: Record<string, SignatureAlgorithm> = { ES256: 'ecdsa-p256-sha256', EdDSA: 'ed25519' };

async function checkObject(
  value: unknown,
  required: readonly string[],
  options: VerifyTapBodyOptions,
): Promise<TapObjectCheck> {
  if (value === undefined) return { present: false, verified: false, problems: [] };
  const problems: TapObjectProblem[] = [];
  if (!isObject(value) || required.some((name) => !(name in value)) || !nonEmpty(value['kid']) || !nonEmpty(value['signature'])) {
    return { present: true, verified: false, problems: ['missing_fields'] };
  }
  if (value['nonce'] !== options.nonce) problems.push('nonce_mismatch');
  if (value['kid'] !== options.keyid) problems.push('kid_mismatch');
  const expected = typeof value['alg'] === 'string' ? ALG_FOR_JWS[value['alg']] : undefined;
  if (expected === undefined) {
    problems.push('algorithm_unsupported');
    return { present: true, verified: false, problems };
  }
  const jwk = await options.resolveKey(value['kid'] as string);
  const pub = jwk === null || jwk === undefined ? null : publicKeyObject(jwk);
  if (pub === null || pub.alg !== expected) {
    problems.push('key_unavailable');
    return { present: true, verified: false, problems };
  }
  const { signature, ...unsigned } = value;
  let sig: Buffer;
  try {
    sig = Buffer.from(signature as string, 'base64url');
  } catch {
    // Not base64url: not a signature.
    sig = Buffer.alloc(0);
  }
  const bytes = (options.canonicalize ?? jcsCanonicalizer)(unsigned);
  if (!verifyBytes(pub.key, pub.alg, bytes, new Uint8Array(sig))) problems.push('signature_invalid');
  return { present: true, verified: problems.length === 0, problems };
}

/**
 * Checks the TAP body objects of a parsed JSON body against the verified
 * message signature. Call it only after the message signature verified
 * under the `tap` profile.
 */
export async function verifyTapBodyObjects(body: unknown, options: VerifyTapBodyOptions): Promise<TapBodyVerification> {
  const members = options.members ?? DEFAULT_TAP_BODY_MEMBERS;
  const root = isObject(body) ? body : {};
  const consumer = await checkObject(root[members.consumer], ['nonce', 'idToken', 'kid', 'alg', 'signature'], options);
  const container = await checkObject(root[members.paymentContainer], ['nonce', 'kid', 'alg', 'signature'], options);
  const record = root[members.consentRecord];
  const consentRecord = isObject(record)
    ? {
        present: true,
        nonceMatches: record['nonce'] === options.nonce,
        consentId: typeof record['consent_id'] === 'string' ? record['consent_id'] : null,
      }
    : { present: record !== undefined, nonceMatches: false, consentId: null };
  return {
    consumer,
    // A key that cannot be retrieved makes the container "may be inaccurate"
    // in TAP's words; for payment that is still not usable (fail closed).
    paymentContainer: { ...container, usableForPayment: container.present && container.verified },
    consentRecord,
  };
}
