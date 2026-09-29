// SPDX-License-Identifier: Apache-2.0
/**
 * Per-merchant child grants (PRD §8.5, Appendix B; owner decision 3;
 * spec/passport-binding.md §8).
 *
 * A passport-bound grant may name the merchants it is for: its authorization
 * request carries one urn:grantex:commerce:v1 authorization_details entry
 * (RFC 9396 §2) with `allowed_merchants`, exact origins, and optionally an
 * `amount_range` and a `budget`. With PASSPORT_BOUND_GRANTS_ENABLED=true,
 * POST /v1/token takes an RFC 8693 token exchange (§2.1) whose
 * `subject_token` is that grant's token and whose `resource` or `audience`
 * names one merchant, and issues a child token for it:
 *
 *   - `aud` is the merchant origin, which must be one of the parent's
 *     `allowed_merchants`, compared exactly (decision 3), else
 *     `audience_mismatch`;
 *   - it lives at most CHILD_GRANT_MAX_LIFETIME_SECONDS, and never beyond the
 *     subject token, the grant, the passport or its attestation;
 *   - its constraints are the parent's, attenuated: `allowed_merchants` is
 *     that one merchant, and an `amount_range` or `budget` the request asks
 *     for must lie within the parent's. Anything wider is refused with
 *     `invalid_authorization_details` (RFC 9396 §6: the AS refuses a token
 *     request whose authorization details the grant does not allow);
 *   - `scope` is a subset of the parent's (`invalid_scope`, RFC 6749 §5.2);
 *   - the request carries a DPoP proof (RFC 9449 §4) signed with the key the
 *     subject token is bound to (its `cnf.jkt`): the developer's API key and
 *     a copy of the parent token are not enough (`invalid_dpop_proof`).
 *
 * This module holds the parts that need no database: reading the request and
 * the constraints, the attenuation and the lifetime. The route (token.ts)
 * reads the parent, checks its binding again and records the child.
 */

/** RFC 8693 §2.1 grant_type. */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
/** RFC 8693 §3 token type identifier of an OAuth access token. */
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
/** The longest a child token lives (PRD §8.5), in seconds. */
export const CHILD_GRANT_MAX_LIFETIME_SECONDS = 900;
/** The most merchants one grant may name. */
export const MAX_ALLOWED_MERCHANTS = 50;
/** The longest merchant origin accepted, in characters. */
export const MAX_ORIGIN_LENGTH = 1024;

const COMMERCE_TYPE = 'urn:grantex:commerce:v1';
/** Up to 15 integer digits and 6 decimals: amounts compare exactly as scaled integers. */
const DECIMAL = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;
const CURRENCY = /^[A-Z]{3}$/;
/** A scope token (RFC 6749 §3.3 scope-token). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/;

export interface AmountRange {
  currency: string;
  min?: string;
  max: string;
}

export interface CommerceBudget {
  amount: string;
  currency: string;
}

/** What a grant's urn:grantex:commerce:v1 entry says about where and how much. */
export interface CommerceConstraints {
  allowed_merchants: string[];
  amount_range?: AmountRange;
  budget?: CommerceBudget;
}

export type ChildGrantErrorName =
  | 'invalid_request'
  | 'invalid_target'
  | 'invalid_scope'
  | 'invalid_authorization_details'
  | 'invalid_dpop_proof';

/**
 * A refusal of a child grant request. `error` is the OAuth error code
 * (RFC 8693 §2.2.2, RFC 6749 §5.2, RFC 9396 §5); `code` is the PRD
 * Appendix C code when one applies (audience_mismatch), else `error`.
 */
export class ChildGrantError extends Error {
  readonly error: ChildGrantErrorName;
  readonly code: string;
  readonly reason: string;
  readonly statusCode: number;

  constructor(error: ChildGrantErrorName, reason: string, message: string, options: { code?: string } = {}) {
    super(message);
    this.name = 'ChildGrantError';
    this.error = error;
    this.code = options.code ?? error;
    this.reason = reason;
    // RFC 6749 §5.2: 400 unless specified otherwise, and nothing here is.
    this.statusCode = 400;
  }
}

function refuse(error: ChildGrantErrorName, reason: string, message: string, options?: { code?: string }): never {
  throw new ChildGrantError(error, reason, message, options);
}

function invalidDetails(reason: string, message: string): never {
  refuse('invalid_authorization_details', reason, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An https origin exactly as it serializes (RFC 6454 §6.2): scheme, host and
 * a non-default port, lower case, nothing else. `https://merchant.example/`
 * (a path) and `https://merchant.example:443` (the default port) are not.
 */
export function isMerchantOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.origin === value;
}

/** A decimal amount as a scaled integer (6 decimals), or null when it is not one. */
function scaled(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? '.').slice(1).padEnd(6, '0');
  return BigInt(match[1]!) * 1_000_000n + BigInt(fraction);
}

function onlyMembers(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(record).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) invalidDetails('unknown_member', `${where} has members this type does not define: ${unknown.join(', ')}`);
}

function parseAmountRange(value: unknown): AmountRange {
  if (!isObject(value)) invalidDetails('amount_range_invalid', 'amount_range must be an object');
  onlyMembers(value, ['currency', 'min', 'max'], 'amount_range');
  if (typeof value['currency'] !== 'string' || !CURRENCY.test(value['currency'])) {
    invalidDetails('amount_range_invalid', 'amount_range.currency must be an ISO 4217 code');
  }
  const max = scaled(value['max']);
  if (max === null) invalidDetails('amount_range_invalid', 'amount_range.max must be a decimal string');
  const min = value['min'] === undefined ? null : scaled(value['min']);
  if (value['min'] !== undefined && min === null) invalidDetails('amount_range_invalid', 'amount_range.min must be a decimal string');
  if (min !== null && min > max) invalidDetails('amount_range_invalid', 'amount_range.min must not exceed amount_range.max');
  return {
    currency: value['currency'],
    ...(value['min'] !== undefined ? { min: value['min'] as string } : {}),
    max: value['max'] as string,
  };
}

function parseBudget(value: unknown): CommerceBudget {
  if (!isObject(value)) invalidDetails('budget_invalid', 'budget must be an object');
  onlyMembers(value, ['amount', 'currency'], 'budget');
  if (scaled(value['amount']) === null) invalidDetails('budget_invalid', 'budget.amount must be a decimal string');
  if (typeof value['currency'] !== 'string' || !CURRENCY.test(value['currency'])) {
    invalidDetails('budget_invalid', 'budget.currency must be an ISO 4217 code');
  }
  return { amount: value['amount'] as string, currency: value['currency'] };
}

function parseMerchants(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_MERCHANTS) {
    invalidDetails('allowed_merchants_invalid', `allowed_merchants must list 1 to ${MAX_ALLOWED_MERCHANTS} origins`);
  }
  if (!value.every(isMerchantOrigin)) {
    invalidDetails('allowed_merchants_invalid', 'allowed_merchants must be https origins, exactly as they serialize (no path, no trailing slash)');
  }
  if (new Set(value).size !== value.length) invalidDetails('allowed_merchants_invalid', 'allowed_merchants must not repeat an origin');
  return [...value] as string[];
}

/**
 * The single urn:grantex:commerce:v1 entry of an authorization_details value.
 * RFC 9396 §5: an unknown type, an unknown member, or a malformed value is
 * refused. The registry sets `passport` and `acceptance_status` itself, so a
 * request may not.
 */
function singleCommerceEntry(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isObject(value[0])) {
    invalidDetails('not_one_entry', `authorization_details must be an array with one ${COMMERCE_TYPE} entry`);
  }
  const entry = value[0];
  if (entry['type'] !== COMMERCE_TYPE) {
    invalidDetails('unknown_type', `authorization_details accepts only the ${COMMERCE_TYPE} type here`);
  }
  onlyMembers(entry, ['type', 'allowed_merchants', 'amount_range', 'budget'], COMMERCE_TYPE);
  return entry;
}

/**
 * The commerce constraints of a POST /v1/authorize request with a passport
 * (decision 3: allowed_merchants holds exact origins). Throws ChildGrantError
 * (invalid_authorization_details).
 */
export function parseAuthorizeCommerceDetails(value: unknown): CommerceConstraints {
  const entry = singleCommerceEntry(value);
  return {
    allowed_merchants: parseMerchants(entry['allowed_merchants']),
    ...(entry['amount_range'] !== undefined ? { amount_range: parseAmountRange(entry['amount_range']) } : {}),
    ...(entry['budget'] !== undefined ? { budget: parseBudget(entry['budget']) } : {}),
  };
}

/**
 * Constraints as stored (auth_requests.passport_binding.commerce,
 * grant_passport_bindings.commerce_constraints, grant_child_tokens), or null
 * when the grant has none. Anything the registry did not write throws: the
 * caller refuses to issue rather than issue unconstrained.
 */
export function parseStoredConstraints(value: unknown): CommerceConstraints | null {
  if (value === null || value === undefined) return null;
  const stored = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!isObject(stored)) throw new Error('stored commerce constraints are not an object');
  try {
    return parseAuthorizeCommerceDetails([{ type: COMMERCE_TYPE, ...stored }]);
  } catch (err) {
    if (err instanceof ChildGrantError) throw new Error(`stored commerce constraints are invalid: ${err.message}`);
    throw err;
  }
}

/** The authorization_details members that carry constraints, in their order. */
export function constraintMembers(constraints: CommerceConstraints): Record<string, unknown> {
  return {
    allowed_merchants: constraints.allowed_merchants,
    ...(constraints.amount_range !== undefined ? { amount_range: constraints.amount_range } : {}),
    ...(constraints.budget !== undefined ? { budget: constraints.budget } : {}),
  };
}

export interface TokenExchangeRequest {
  subjectToken: string;
  merchant: string;
  /** The requested scope, or undefined for the parent's. */
  scopes?: string[];
  /** The requested authorization_details, parsed from JSON, or undefined. */
  authorizationDetails?: unknown;
}

/** A parameter that occurs at most once (RFC 6749 §3.2: parameters MUST NOT be repeated). */
function single(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') refuse('invalid_request', 'repeated_parameter', `${name} must occur exactly once, as a string`);
  return value;
}

/** resource and audience may each occur more than once (RFC 8693 §2.1). */
function targets(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) refuse('invalid_request', 'target_invalid', `${name} must be a string`);
  return values as string[];
}

/**
 * The RFC 8693 §2.1 parameters of a child grant request, before anything is
 * read. Throws ChildGrantError.
 */
export function parseTokenExchangeRequest(body: Record<string, unknown>): TokenExchangeRequest {
  const subjectToken = single(body, 'subject_token');
  if (!subjectToken) refuse('invalid_request', 'subject_token_missing', 'subject_token is required');
  if (subjectToken.length > 16_384) refuse('invalid_request', 'subject_token_invalid', 'subject_token is too long');
  if (single(body, 'subject_token_type') !== ACCESS_TOKEN_TYPE) {
    refuse('invalid_request', 'subject_token_type_unsupported', `subject_token_type must be ${ACCESS_TOKEN_TYPE}: the parent grant token`);
  }
  const requested = single(body, 'requested_token_type');
  if (requested !== undefined && requested !== ACCESS_TOKEN_TYPE) {
    refuse('invalid_request', 'requested_token_type_unsupported', `requested_token_type must be ${ACCESS_TOKEN_TYPE}`);
  }
  // An actor token asks for delegation to another party (RFC 8693 §1.1), a
  // sub-agent in PRD §8.6: not available for passport-bound grants yet.
  if (body['actor_token'] !== undefined || body['actor_token_type'] !== undefined) {
    refuse('invalid_request', 'actor_token_unsupported',
      'actor_token is not accepted: a child grant is for the same agent; delegation of a passport-bound grant is not supported');
  }

  // RFC 8693 §2.1.1: the token is asked for at every target named. A child is
  // for exactly one merchant, named by resource or audience or both.
  const named = [...new Set([...targets(body, 'resource'), ...targets(body, 'audience')])];
  if (named.length === 0) refuse('invalid_request', 'target_missing', 'resource or audience must name the merchant');
  if (named.length > 1) refuse('invalid_target', 'several_targets', 'a child grant is for exactly one merchant');
  const merchant = named[0]!;
  if (!isMerchantOrigin(merchant)) {
    refuse('invalid_target', 'not_an_origin', 'the merchant must be an https origin, exactly as it serializes (no path, no trailing slash)');
  }

  let scopes: string[] | undefined;
  const scope = single(body, 'scope');
  if (scope !== undefined) {
    scopes = scope.split(' ');
    if (scopes.length > 100 || scopes.some((token) => !SCOPE_TOKEN.test(token))) {
      refuse('invalid_scope', 'scope_invalid', 'scope must be 1 to 100 space-delimited scope tokens');
    }
    if (new Set(scopes).size !== scopes.length) refuse('invalid_scope', 'scope_invalid', 'scope must not repeat a value');
  }

  // RFC 9396 §2: a JSON array, carried as a JSON string in a form body; a
  // JSON body may carry the array itself.
  let authorizationDetails: unknown;
  const rawDetails = body['authorization_details'];
  if (typeof rawDetails === 'string') {
    try {
      authorizationDetails = JSON.parse(rawDetails) as unknown;
    } catch {
      invalidDetails('not_json', 'authorization_details must be a JSON array');
    }
  } else if (rawDetails !== undefined) {
    authorizationDetails = rawDetails;
  }
  if (authorizationDetails !== undefined && !Array.isArray(authorizationDetails)) {
    invalidDetails('not_an_array', 'authorization_details must be a JSON array');
  }

  return {
    subjectToken,
    merchant,
    ...(scopes !== undefined ? { scopes } : {}),
    ...(authorizationDetails !== undefined ? { authorizationDetails } : {}),
  };
}

function narrowRange(parent: AmountRange | undefined, requested: AmountRange | undefined): AmountRange | undefined {
  if (requested === undefined) return parent;
  if (parent === undefined) return requested;
  if (requested.currency !== parent.currency) invalidDetails('wider_amount_range', 'amount_range.currency must be the parent grant\'s');
  if (scaled(requested.max)! > scaled(parent.max)!) invalidDetails('wider_amount_range', 'amount_range.max exceeds the parent grant\'s');
  if (parent.min !== undefined && (requested.min === undefined || scaled(requested.min)! < scaled(parent.min)!)) {
    invalidDetails('wider_amount_range', 'amount_range.min is below the parent grant\'s');
  }
  return requested;
}

function narrowBudget(parent: CommerceBudget | undefined, requested: CommerceBudget | undefined): CommerceBudget | undefined {
  if (requested === undefined) return parent;
  if (parent === undefined) return requested;
  if (requested.currency !== parent.currency) invalidDetails('wider_budget', 'budget.currency must be the parent grant\'s');
  if (scaled(requested.amount)! > scaled(parent.amount)!) invalidDetails('wider_budget', 'budget.amount exceeds the parent grant\'s');
  return requested;
}

/**
 * RFC 9449 §4.3, and §6.1 for a bound subject: the proof's key must be the
 * one the subject token is bound to (cnf.jkt). A subject without cnf.jkt is
 * refused as well: there is no key to prove. Throws ChildGrantError
 * (invalid_dpop_proof).
 */
export function requireProofOfBoundKey(proofThumbprint: string, boundThumbprint: string | undefined): void {
  if (boundThumbprint === undefined || proofThumbprint !== boundThumbprint) {
    refuse('invalid_dpop_proof', 'dpop_key_mismatch',
      'The DPoP proof is not signed with the key the subject token is bound to (cnf.jkt)');
  }
}

/**
 * The child's constraints: the merchant must be one of the parent's
 * allowed_merchants, compared exactly (decision 3; audience_mismatch), and
 * whatever the request asks for must lie within the parent's (RFC 9396 §6;
 * invalid_authorization_details). A limit the request leaves out is the
 * parent's; a limit the parent does not set may be set by the child, which
 * only narrows it.
 */
export function attenuateConstraints(
  parent: CommerceConstraints | null,
  merchant: string,
  requested: unknown,
): CommerceConstraints {
  if (parent === null || !parent.allowed_merchants.includes(merchant)) {
    refuse('invalid_target', 'merchant_not_allowed', 'the merchant is not one of the parent grant\'s allowed_merchants',
      { code: 'audience_mismatch' });
  }
  if (requested === undefined) {
    return {
      allowed_merchants: [merchant],
      ...(parent.amount_range !== undefined ? { amount_range: parent.amount_range } : {}),
      ...(parent.budget !== undefined ? { budget: parent.budget } : {}),
    };
  }
  const entry = singleCommerceEntry(requested);
  if (entry['allowed_merchants'] !== undefined) {
    const listed = parseMerchants(entry['allowed_merchants']);
    if (listed.length !== 1 || listed[0] !== merchant) {
      invalidDetails('wider_allowed_merchants', 'a child grant\'s allowed_merchants is exactly the merchant it is for');
    }
  }
  const amountRange = narrowRange(parent.amount_range,
    entry['amount_range'] !== undefined ? parseAmountRange(entry['amount_range']) : undefined);
  const budget = narrowBudget(parent.budget, entry['budget'] !== undefined ? parseBudget(entry['budget']) : undefined);
  return {
    allowed_merchants: [merchant],
    ...(amountRange !== undefined ? { amount_range: amountRange } : {}),
    ...(budget !== undefined ? { budget } : {}),
  };
}

/**
 * The child's exp, in seconds: at most CHILD_GRANT_MAX_LIFETIME_SECONDS after
 * now, and never after the subject token, the grant, or the earlier of the
 * passport's and the attestation's exp (`notAfter`, from the recheck).
 */
export function childGrantExpiry(input: { now: number; subjectExp: number; grantExpiresAt: number; notAfter: number }): number {
  return Math.min(input.now + CHILD_GRANT_MAX_LIFETIME_SECONDS, input.subjectExp, input.grantExpiresAt, input.notAfter);
}
