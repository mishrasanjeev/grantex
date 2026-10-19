// SPDX-License-Identifier: Apache-2.0
/**
 * Commerce scope registries for buyer identity linking (G24) and delegated
 * authentication (G36).
 *
 * UCP identity linking (`dev.ucp.common.identity_linking`, UCP 2026-04-08 and
 * 2026-08-25, `common/identity-linking`): a business-hosted OAuth 2.0
 * authorization server, Authorization Code with PKCE S256, discovered through
 * RFC 9728 protected-resource metadata and RFC 8414 authorization-server
 * metadata, whose platform verifies `state` and `iss` (RFC 9207). Scopes are
 * `{capability}:{scope}` tokens; the well-known ones below are the only
 * `dev.ucp.*` scopes this server accepts. A business lists the ones it offers
 * in its profile's `config.scopes`; listing one means its operations require a
 * user token.
 *
 * ACP (2026-04-17) defines no OAuth scope vocabulary: its checkout, delegate
 * payment and delegate authentication APIs take an opaque bearer token. The
 * `dev.grantex.acp.*` scopes are Grantex extensions in Grantex's own
 * reverse-DNS namespace (grantex.dev), so a merchant can require a linked
 * buyer token on ACP operations. They are not part of ACP.
 */

export const UCP_IDENTITY_LINKING_VERSIONS = ['2026-04-08', '2026-08-25'] as const;
export type UcpIdentityLinkingVersion = typeof UCP_IDENTITY_LINKING_VERSIONS[number];

export interface CommerceScopeDefinition {
  /** The capability or API the scope gates. */
  capability: string;
  /** Who defines the scope. */
  defined_by: 'ucp' | 'grantex';
  /** Plain-text description, suitable for a profile's scope policy or a consent page. */
  description: string;
}

/** Well-known UCP identity-linking scopes (identical at 2026-04-08 and 2026-08-25). */
export const UCP_IDENTITY_LINKING_SCOPES: Readonly<Record<string, CommerceScopeDefinition>> = Object.freeze({
  'dev.ucp.shopping.checkout:manage': {
    capability: 'dev.ucp.shopping.checkout',
    defined_by: 'ucp',
    description: 'Create, update, complete and cancel checkout sessions on the buyer\'s merchant account.',
  },
  'dev.ucp.shopping.cart:manage': {
    capability: 'dev.ucp.shopping.cart',
    defined_by: 'ucp',
    description: 'Create, read, replace and cancel carts on the buyer\'s merchant account.',
  },
  'dev.ucp.shopping.order:read': {
    capability: 'dev.ucp.shopping.order',
    defined_by: 'ucp',
    description: 'Read the buyer\'s orders.',
  },
  'dev.ucp.shopping.order:manage': {
    capability: 'dev.ucp.shopping.order',
    defined_by: 'ucp',
    description: 'Read and change the buyer\'s orders where the merchant allows it.',
  },
  'dev.ucp.shopping.catalog.search:read': {
    capability: 'dev.ucp.shopping.catalog.search',
    defined_by: 'ucp',
    description: 'Search the catalog as the buyer (buyer-specific prices and eligibility).',
  },
  'dev.ucp.shopping.catalog.lookup:read': {
    capability: 'dev.ucp.shopping.catalog.lookup',
    defined_by: 'ucp',
    description: 'Look up catalog items as the buyer (buyer-specific prices and eligibility).',
  },
});

/** Grantex extension scopes for ACP operations on a linked buyer's account. */
export const ACP_DELEGATED_AUTHENTICATION_SCOPES: Readonly<Record<string, CommerceScopeDefinition>> = Object.freeze({
  'dev.grantex.acp.checkout:manage': {
    capability: 'acp.checkout_sessions',
    defined_by: 'grantex',
    description: 'Create, update, complete and cancel ACP checkout sessions as the linked buyer (Buyer.authentication_status authenticated).',
  },
  'dev.grantex.acp.delegate_authentication:manage': {
    capability: 'acp.delegate_authentication',
    defined_by: 'grantex',
    description: 'Create, authenticate and read ACP delegate-authentication (3-D Secure) sessions for the linked buyer\'s checkout.',
  },
  'dev.grantex.acp.order:read': {
    capability: 'acp.orders',
    defined_by: 'grantex',
    description: 'Read the linked buyer\'s ACP orders.',
  },
});

/** `common/identity_linking.json#/$defs/scope_token` per release. */
export const UCP_SCOPE_TOKEN_PATTERNS: Readonly<Record<UcpIdentityLinkingVersion, RegExp>> = Object.freeze({
  '2026-04-08': /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+:[a-z][a-z0-9_]*$/,
  '2026-08-25': /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+:[a-z][a-z0-9_]*$/,
});

export interface CommerceAuthorizationOptions {
  /**
   * Offer UCP buyer identity linking: the listed well-known `dev.ucp.*` scopes
   * (default: all six) join `scopes_supported`. `version` is the UCP release
   * the merchant's profile declares; scope tokens are checked against it.
   */
  ucpIdentityLinking?: {
    version: UcpIdentityLinkingVersion;
    scopes?: string[];
  };
  /**
   * Offer the Grantex `dev.grantex.acp.*` extension scopes (default: all
   * three) for ACP operations on a linked buyer's account.
   */
  acpDelegatedAuthentication?: {
    scopes?: string[];
  };
}

function pick(
  label: string,
  registry: Readonly<Record<string, CommerceScopeDefinition>>,
  requested: unknown,
): string[] {
  if (requested === undefined) return Object.keys(registry);
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error(`createMcpAuthServer: ${label}.scopes must list at least one scope`);
  }
  const unknown = requested.filter((scope) => typeof scope !== 'string' || !Object.hasOwn(registry, scope));
  if (unknown.length > 0) {
    throw new Error(`createMcpAuthServer: ${label}.scopes may list only ${Object.keys(registry).join(', ')}; remove ${unknown.map(String).join(', ')}`);
  }
  return [...new Set(requested as string[])];
}

/**
 * The commerce scopes a configuration adds to `scopes_supported`. Throws on an
 * unknown release or scope, and on a configured `dev.ucp.*` or
 * `dev.grantex.acp.*` scope outside the registries: only standards-defined
 * UCP scopes and the documented Grantex extensions are issued.
 */
export function commerceScopes(options: CommerceAuthorizationOptions | undefined, configuredScopes: readonly string[]): string[] {
  if (options === undefined) return [];
  if (options === null || typeof options !== 'object') throw new Error('createMcpAuthServer: commerce must be an object');
  const scopes: string[] = [];
  const ucp = options.ucpIdentityLinking;
  if (ucp !== undefined) {
    if (!(UCP_IDENTITY_LINKING_VERSIONS as readonly string[]).includes(ucp.version)) {
      throw new Error(`createMcpAuthServer: commerce.ucpIdentityLinking.version must be one of ${UCP_IDENTITY_LINKING_VERSIONS.join(', ')}`);
    }
    const picked = pick('commerce.ucpIdentityLinking', UCP_IDENTITY_LINKING_SCOPES, ucp.scopes);
    const pattern = UCP_SCOPE_TOKEN_PATTERNS[ucp.version];
    for (const scope of picked) {
      if (!pattern.test(scope)) throw new Error(`createMcpAuthServer: ${scope} is not a UCP ${ucp.version} scope token`);
    }
    scopes.push(...picked);
  }
  const acp = options.acpDelegatedAuthentication;
  if (acp !== undefined) scopes.push(...pick('commerce.acpDelegatedAuthentication', ACP_DELEGATED_AUTHENTICATION_SCOPES, acp.scopes));
  const invented = configuredScopes.filter((scope) =>
    (scope.startsWith('dev.ucp.') && !Object.hasOwn(UCP_IDENTITY_LINKING_SCOPES, scope))
    || (scope.startsWith('dev.grantex.acp.') && !Object.hasOwn(ACP_DELEGATED_AUTHENTICATION_SCOPES, scope)));
  if (invented.length > 0) {
    throw new Error(`createMcpAuthServer: ${invented.join(', ')} ${invented.length === 1 ? 'is' : 'are'} not a defined UCP or Grantex ACP scope`);
  }
  return scopes;
}

/** The definition of a commerce scope, or undefined. */
export function commerceScopeDefinition(scope: string): CommerceScopeDefinition | undefined {
  return Object.hasOwn(UCP_IDENTITY_LINKING_SCOPES, scope)
    ? UCP_IDENTITY_LINKING_SCOPES[scope]
    : Object.hasOwn(ACP_DELEGATED_AUTHENTICATION_SCOPES, scope) ? ACP_DELEGATED_AUTHENTICATION_SCOPES[scope] : undefined;
}

/**
 * The `config.scopes` map of a business profile's
 * `dev.ucp.common.identity_linking` entry for the UCP scopes this server
 * offers: `{scope: {description: {plain}}}` (scope policy, UCP
 * `common/identity_linking.json#/$defs/scope_policy`). Grantex ACP extension
 * scopes are not UCP scopes and never appear here.
 */
export function ucpIdentityLinkingScopePolicies(scopes: readonly string[]): Record<string, { description: { plain: string } }> {
  const map: Record<string, { description: { plain: string } }> = {};
  for (const scope of [...scopes].sort()) {
    const definition = UCP_IDENTITY_LINKING_SCOPES[scope];
    if (Object.hasOwn(UCP_IDENTITY_LINKING_SCOPES, scope) && definition) map[scope] = { description: { plain: definition.description } };
  }
  return map;
}
