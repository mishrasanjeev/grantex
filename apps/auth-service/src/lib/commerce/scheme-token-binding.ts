// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Scheme token binding (G52): the adapter shape a payment capability carries
 * when a buyer agent's payment is bound to a scheme token,
 *
 *   { scheme, token_ref, agent_id, merchant_scope, limits }
 *
 * on the OACP `mandate_capability` artifact payload as `token_binding`.
 * Grantex describes and checks the binding; it never executes it. The
 * scheme or provider (a network token service, UPI AutoPay, a payment
 * provider) executes, through the relying party's own executor; Grantex holds no
 * token, no card data and no provider credential.
 *
 *   scheme          `visa` | `mastercard` (network tokens), `upi_autopay`,
 *                   `provider_token` (a payment provider's tokenised
 *                   instrument, held behind the provider-neutral interface)
 *   token_ref       an opaque reference to the token the scheme or provider
 *                   holds: 1 to 128 characters from A-Z a-z 0-9 . _ : -,
 *                   never a primary account number (13 to 19 digits are
 *                   refused) and never the token itself
 *   agent_id        the buyer agent the token is bound to
 *   merchant_scope  the merchant ids it may be used with (1 to 32)
 *   limits          { max_amount (integer minor units), currency (ISO 4217),
 *                     expires_at? (RFC 3339) }
 *
 * The shared TypeScript type is mirrored in @grantex/sdk
 * (`packages/sdk-ts/src/oacp/token-binding.ts`); both parse the same way, and
 * a test keeps the two files equal below this comment.
 */

export const TOKEN_BINDING_SCHEMES = ['visa', 'mastercard', 'upi_autopay', 'provider_token'] as const;
export type TokenBindingScheme = (typeof TOKEN_BINDING_SCHEMES)[number];
export const MAX_TOKEN_BINDING_MERCHANTS = 32;

export interface TokenBindingLimits {
  /** Integer minor units. */
  max_amount: number;
  /** ISO 4217 alphabetic code. */
  currency: string;
  /** RFC 3339; the binding is not usable at or after it. */
  expires_at?: string;
}

export interface SchemeTokenBinding {
  scheme: TokenBindingScheme;
  token_ref: string;
  agent_id: string;
  merchant_scope: string[];
  limits: TokenBindingLimits;
}

export class TokenBindingError extends Error {
  readonly code = 'token_binding_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'TokenBindingError';
  }
}

const TOKEN_REF = /^[A-Za-z0-9._:-]{1,128}$/;
/** A run of 13 to 19 digits anywhere: a primary account number is refused, however it is wrapped. */
const PAN_LIKE = /\d{13,19}/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CURRENCY = /^[A-Z]{3}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message: string): never {
  throw new TokenBindingError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactly(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], what: string) {
  for (const name of Object.keys(value)) {
    if (!required.includes(name) && !optional.includes(name)) fail(`${what} has no member ${name}`);
  }
  for (const name of required) if (!(name in value)) fail(`${what}.${name} is required`);
}

/** Parses a token binding; every failure is a TokenBindingError (`token_binding_invalid`). */
export function parseSchemeTokenBinding(value: unknown): SchemeTokenBinding {
  if (!isObject(value)) fail('token_binding must be an object');
  exactly(value, ['scheme', 'token_ref', 'agent_id', 'merchant_scope', 'limits'], [], 'token_binding');
  const { scheme, token_ref: tokenRef, agent_id: agentId, merchant_scope: scope, limits } = value;
  if (typeof scheme !== 'string' || !(TOKEN_BINDING_SCHEMES as readonly string[]).includes(scheme)) {
    fail(`token_binding.scheme must be one of ${TOKEN_BINDING_SCHEMES.join(', ')}`);
  }
  if (typeof tokenRef !== 'string' || !TOKEN_REF.test(tokenRef)) {
    fail('token_binding.token_ref must be an opaque reference of 1 to 128 characters from A-Z a-z 0-9 . _ : -');
  }
  if (PAN_LIKE.test(tokenRef)) fail('token_binding.token_ref must be a reference, never an account number');
  if (typeof agentId !== 'string' || !ID.test(agentId)) fail('token_binding.agent_id must be an agent id');
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > MAX_TOKEN_BINDING_MERCHANTS) {
    fail(`token_binding.merchant_scope must list 1 to ${MAX_TOKEN_BINDING_MERCHANTS} merchant ids`);
  }
  for (const merchant of scope) if (typeof merchant !== 'string' || !ID.test(merchant)) fail('token_binding.merchant_scope holds merchant ids');
  if (new Set(scope).size !== scope.length) fail('token_binding.merchant_scope lists a merchant twice');
  if (!isObject(limits)) fail('token_binding.limits must be an object');
  exactly(limits, ['max_amount', 'currency'], ['expires_at'], 'token_binding.limits');
  const { max_amount: maxAmount, currency, expires_at: expiresAt } = limits;
  if (typeof maxAmount !== 'number' || !Number.isSafeInteger(maxAmount) || maxAmount <= 0) {
    fail('token_binding.limits.max_amount must be a positive integer in minor units');
  }
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) fail('token_binding.limits.currency must be an ISO 4217 code');
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !RFC3339.test(expiresAt) || Number.isNaN(Date.parse(expiresAt)))) {
    fail('token_binding.limits.expires_at must be an RFC 3339 timestamp');
  }
  return {
    scheme: scheme as TokenBindingScheme,
    token_ref: tokenRef,
    agent_id: agentId,
    merchant_scope: [...scope] as string[],
    limits: { max_amount: maxAmount, currency, ...(expiresAt !== undefined ? { expires_at: expiresAt as string } : {}) },
  };
}

/**
 * The binding must sit inside the payment capability that carries it: the
 * same buyer agent, merchants within its scope, the same currency, a limit
 * no higher than its cap, and no expiry after the artifact's.
 */
export function checkTokenBindingWithinCapability(
  binding: SchemeTokenBinding,
  capability: { buyer_agent_id: unknown; merchant_scope: unknown; max_amount: unknown; currency: unknown },
  artifactExpiresAt?: string,
): void {
  if (binding.agent_id !== capability.buyer_agent_id) fail('token_binding.agent_id must be the capability buyer_agent_id');
  const scope = Array.isArray(capability.merchant_scope) ? capability.merchant_scope : [];
  for (const merchant of binding.merchant_scope) {
    if (!scope.includes(merchant)) fail('token_binding.merchant_scope must be within the capability merchant_scope');
  }
  if (binding.limits.currency !== capability.currency) fail('token_binding.limits.currency must be the capability currency');
  if (typeof capability.max_amount !== 'number' || binding.limits.max_amount > capability.max_amount) {
    fail('token_binding.limits.max_amount must not exceed the capability max_amount');
  }
  if (binding.limits.expires_at !== undefined && artifactExpiresAt !== undefined
      && Date.parse(binding.limits.expires_at) > Date.parse(artifactExpiresAt)) {
    fail('token_binding.limits.expires_at must not be after the artifact expires_at');
  }
}
