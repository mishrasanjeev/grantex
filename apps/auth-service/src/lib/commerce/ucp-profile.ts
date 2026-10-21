/**
 * UCP business-profile rendering from issued OACP artifacts (G18).
 *
 * Renders the `ucp` member of a UCP business profile (`/.well-known/ucp`) at a
 * pinned release, 2026-04-08 or 2026-08-25, for a merchant / seller-agent
 * scope. A capability is emitted only when
 *   1. the business host says it serves it (`served`), and
 *   2. every artifact family that backs it is currently issued for the scope
 *      (status `issued`, not revoked, not expired).
 * Everything else is listed in `withheld` with the reason, never rendered.
 *
 * Shape (UCP overview, "Profile Structure"; schemas `discovery/profile.json`
 * at 2026-04-08 and `profile.json` at 2026-08-25):
 *   - `ucp.version` is the release date; every `dev.ucp.*` service and
 *     capability entry declares the same `version` (2026-08-25 overview,
 *     "Component Versioning and Release Snapshots").
 *   - `services`, `capabilities` and `payment_handlers` are maps of
 *     reverse-DNS name to an array of entries; `services` and
 *     `payment_handlers` are always present, even when empty.
 *   - capability entries carry `spec` and `schema` on ucp.dev (2026-04-08
 *     binds both origins to the namespace; 2026-08-25 binds `schema`).
 * Signing keys (`signing_keys[]` / `keys[]`) belong to the business host and
 * are not rendered here. No Grantex-private namespace is ever emitted.
 */

export const UCP_PROFILE_VERSIONS = ['2026-04-08', '2026-08-25'] as const;
export type UcpProfileVersion = typeof UCP_PROFILE_VERSIONS[number];

export const UCP_RENDERABLE_CAPABILITIES = [
  'dev.ucp.shopping.catalog.search',
  'dev.ucp.shopping.catalog.lookup',
  'dev.ucp.shopping.cart',
  'dev.ucp.shopping.checkout',
  'dev.ucp.shopping.order',
  'dev.ucp.common.identity_linking',
] as const;
export type UcpRenderableCapability = typeof UCP_RENDERABLE_CAPABILITIES[number];

/** Artifact families every capability needs: who the merchant and seller agent are. */
const BASE_FAMILIES = ['merchant_profile', 'seller_agent_card'] as const;
const CATALOG_FAMILIES = [...BASE_FAMILIES, 'catalog_snapshot', 'offer_price_snapshot', 'inventory_snapshot'] as const;
const CHECKOUT_FAMILIES = [...CATALOG_FAMILIES, 'policy_scope', 'mandate_capability'] as const;

/** The OACP artifact families that back each capability. */
export const UCP_CAPABILITY_BACKING: Readonly<Record<UcpRenderableCapability, readonly string[]>> = {
  'dev.ucp.shopping.catalog.search': CATALOG_FAMILIES,
  'dev.ucp.shopping.catalog.lookup': CATALOG_FAMILIES,
  'dev.ucp.shopping.cart': CATALOG_FAMILIES,
  'dev.ucp.shopping.checkout': CHECKOUT_FAMILIES,
  'dev.ucp.shopping.order': CHECKOUT_FAMILIES,
  // Backed by the authorization server's scope registry, plus the merchant's identity.
  'dev.ucp.common.identity_linking': BASE_FAMILIES,
};

/** Documentation page and JSON Schema of each capability, per release layout. */
const PATHS: Readonly<Record<UcpRenderableCapability, { r08: string; r25: string; schema: string }>> = {
  'dev.ucp.shopping.catalog.search': { r08: 'catalog/search', r25: 'shopping/catalog/search', schema: 'shopping/catalog_search.json' },
  'dev.ucp.shopping.catalog.lookup': { r08: 'catalog/lookup', r25: 'shopping/catalog/lookup', schema: 'shopping/catalog_lookup.json' },
  'dev.ucp.shopping.cart': { r08: 'cart', r25: 'shopping/cart', schema: 'shopping/cart.json' },
  'dev.ucp.shopping.checkout': { r08: 'checkout', r25: 'shopping/checkout', schema: 'shopping/checkout.json' },
  'dev.ucp.shopping.order': { r08: 'order', r25: 'shopping/order', schema: 'shopping/order.json' },
  'dev.ucp.common.identity_linking': { r08: 'identity-linking', r25: 'common/identity-linking', schema: 'common/identity_linking.json' },
};

/**
 * Release-specific `scope_token` patterns (`common/identity_linking.json#/$defs/scope_token`).
 */
export const UCP_SCOPE_TOKEN_PATTERNS: Readonly<Record<UcpProfileVersion, RegExp>> = {
  '2026-04-08': /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+:[a-z][a-z0-9_]*$/,
  '2026-08-25': /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+:[a-z][a-z0-9_]*$/,
};

export interface UcpBackingArtifact {
  artifact_id: string;
  family: string;
  status: string;
  expires_at: string | null;
  payload?: Record<string, unknown>;
}

export interface UcpIdentityLinkingInput {
  /** `{capability}:{scope}` tokens the authorization server issues; only those of emitted capabilities are kept. */
  scopes: readonly string[];
}

export interface UcpProfileRenderInput {
  version: UcpProfileVersion;
  artifacts: readonly UcpBackingArtifact[];
  /** Capabilities the business host serves. */
  served: readonly UcpRenderableCapability[];
  /** The host's UCP REST base URL (https, no query, fragment or trailing slash). */
  rest_endpoint?: string | undefined;
  identity_linking?: UcpIdentityLinkingInput | undefined;
  now_iso: string;
}

export type UcpWithheldReason =
  | 'not_served'
  | 'missing_backing_artifact'
  | 'requires_checkout'
  | 'mandate_capability_unverified'
  | 'no_identity_linking_scopes';

export interface UcpWithheldCapability {
  name: UcpRenderableCapability;
  reason: UcpWithheldReason;
  missing_families?: string[];
}

export interface UcpCapabilityEntry {
  version: UcpProfileVersion;
  spec: string;
  schema: string;
  config?: Record<string, unknown>;
}

export interface UcpServiceEntry {
  version: UcpProfileVersion;
  transport: 'rest';
  endpoint: string;
  spec: string;
  schema: string;
}

export interface UcpProfileRender {
  ucp_version: UcpProfileVersion;
  /** The `ucp` member and nothing else; the host adds its signing keys. */
  profile: {
    ucp: {
      version: UcpProfileVersion;
      services: Record<string, UcpServiceEntry[]>;
      capabilities: Record<string, UcpCapabilityEntry[]>;
      payment_handlers: Record<string, never[]>;
    };
  };
  withheld: UcpWithheldCapability[];
  /** The artifacts the emitted capabilities rest on. */
  source_artifacts: Array<{ artifact_id: string; family: string; expires_at: string | null }>;
  /** Re-render at or before this instant: the earliest expiry among the source artifacts. */
  valid_until: string | null;
  /**
   * True only when the live `public_discovery_state` artifact says `enabled`
   * with `public_discovery_publication_allowed: true` and, when a
   * `rest_endpoint` is given, its host equals the attested `serving_host`.
   * The host must not publish the profile while false.
   */
  publication_allowed: boolean;
  /** The attested serving host and attestation reference bound into that artifact, when enabled. */
  public_discovery: { serving_host: string; namespace_attestation_ref: string } | null;
  /**
   * Present, and `true`, only when a live artifact of the scope was issued
   * from the synthetic demo source (`synthetic_data: true` in its signed
   * payload): the profile describes a demonstration catalogue, not a
   * merchant's system of record. A host serving the profile must say so.
   */
  synthetic_data?: true;
}

export class UcpProfileInputError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'UcpProfileInputError';
  }
}

export function isUcpProfileVersion(value: unknown): value is UcpProfileVersion {
  return typeof value === 'string' && (UCP_PROFILE_VERSIONS as readonly string[]).includes(value);
}

export function isUcpRenderableCapability(value: unknown): value is UcpRenderableCapability {
  return typeof value === 'string' && (UCP_RENDERABLE_CAPABILITIES as readonly string[]).includes(value);
}

function specUrl(version: UcpProfileVersion, name: UcpRenderableCapability): string {
  const path = version === '2026-04-08' ? PATHS[name].r08 : PATHS[name].r25;
  return `https://ucp.dev/${version}/specification/${path}`;
}

function schemaUrl(version: UcpProfileVersion, name: UcpRenderableCapability): string {
  return `https://ucp.dev/${version}/schemas/${PATHS[name].schema}`;
}

function assertRestEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UcpProfileInputError('rest_endpoint', 'must be an absolute https URL');
  }
  // UCP overview, "Endpoint Resolution": https, no trailing slash.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || endpoint.endsWith('/')) {
    throw new UcpProfileInputError('rest_endpoint', 'must be an https URL without credentials, query, fragment or trailing slash');
  }
}

/** The usable artifact per family: issued, unexpired, latest expiry wins. */
function liveArtifactsByFamily(artifacts: readonly UcpBackingArtifact[], nowMs: number): Map<string, UcpBackingArtifact> {
  const byFamily = new Map<string, UcpBackingArtifact>();
  for (const artifact of artifacts) {
    if (artifact.status !== 'issued' || artifact.expires_at === null) continue;
    const expires = Date.parse(artifact.expires_at);
    if (!Number.isFinite(expires) || expires <= nowMs) continue;
    const current = byFamily.get(artifact.family);
    if (!current || Date.parse(current.expires_at as string) < expires) byFamily.set(artifact.family, artifact);
  }
  return byFamily;
}

export function renderUcpBusinessProfile(input: UcpProfileRenderInput): UcpProfileRender {
  if (!isUcpProfileVersion(input.version)) {
    throw new UcpProfileInputError('version', `must be one of ${UCP_PROFILE_VERSIONS.join(', ')}`);
  }
  for (const name of input.served) {
    if (!isUcpRenderableCapability(name)) {
      throw new UcpProfileInputError('served', `unknown capability ${String(name)}`);
    }
  }
  if (input.rest_endpoint !== undefined) assertRestEndpoint(input.rest_endpoint);
  const nowMs = Date.parse(input.now_iso);
  if (!Number.isFinite(nowMs)) throw new UcpProfileInputError('now_iso', 'must be an RFC 3339 timestamp');

  const version = input.version;
  const served = new Set(input.served);
  const live = liveArtifactsByFamily(input.artifacts, nowMs);
  const capabilities: Record<string, UcpCapabilityEntry[]> = {};
  const withheld: UcpWithheldCapability[] = [];
  const used = new Map<string, UcpBackingArtifact>();

  const backed = (name: UcpRenderableCapability): boolean => {
    const missing = UCP_CAPABILITY_BACKING[name].filter((family) => !live.has(family));
    if (missing.length > 0) {
      withheld.push({ name, reason: 'missing_backing_artifact', missing_families: missing });
      return false;
    }
    return true;
  };
  const emit = (name: UcpRenderableCapability, config?: Record<string, unknown>): void => {
    capabilities[name] = [{
      version,
      spec: specUrl(version, name),
      schema: schemaUrl(version, name),
      ...(config !== undefined ? { config } : {}),
    }];
    for (const family of UCP_CAPABILITY_BACKING[name]) used.set(family, live.get(family)!);
  };

  for (const name of UCP_RENDERABLE_CAPABILITIES) {
    if (name === 'dev.ucp.common.identity_linking') continue;
    if (!served.has(name)) {
      withheld.push({ name, reason: 'not_served' });
      continue;
    }
    if (name === 'dev.ucp.shopping.order' && capabilities['dev.ucp.shopping.checkout'] === undefined) {
      withheld.push({ name, reason: 'requires_checkout' });
      continue;
    }
    if (!backed(name)) continue;
    // G43: checkout is backed only by provider-verified mandate capability
    // evidence, never by an `unverified` or `unavailable` artifact.
    if (name === 'dev.ucp.shopping.checkout'
      && live.get('mandate_capability')?.payload?.['mandate_capability_status'] !== 'verified') {
      withheld.push({ name, reason: 'mandate_capability_unverified' });
      continue;
    }
    emit(name);
  }

  // Identity linking last: its scope map lists only capabilities this profile emits.
  const identity: UcpRenderableCapability = 'dev.ucp.common.identity_linking';
  if (!served.has(identity) || input.identity_linking === undefined) {
    withheld.push({ name: identity, reason: 'not_served' });
  } else if (backed(identity)) {
    const pattern = UCP_SCOPE_TOKEN_PATTERNS[version];
    const scopes: Record<string, Record<string, never>> = {};
    for (const scope of [...new Set(input.identity_linking.scopes)].sort()) {
      if (!pattern.test(scope)) throw new UcpProfileInputError('identity_linking.scopes', `${scope} is not a ${version} scope token`);
      const capability = scope.slice(0, scope.indexOf(':'));
      if (capabilities[capability] !== undefined) scopes[scope] = {};
    }
    if (Object.keys(scopes).length === 0) {
      withheld.push({ name: identity, reason: 'no_identity_linking_scopes' });
    } else {
      emit(identity, { scopes });
    }
  }

  const services: Record<string, UcpServiceEntry[]> = {};
  const shoppingEmitted = Object.keys(capabilities).some((name) => name.startsWith('dev.ucp.shopping.'));
  if (input.rest_endpoint !== undefined && shoppingEmitted) {
    services['dev.ucp.shopping'] = [{
      version,
      transport: 'rest',
      endpoint: input.rest_endpoint,
      spec: version === '2026-04-08'
        ? 'https://ucp.dev/2026-04-08/specification/overview'
        : 'https://ucp.dev/2026-08-25/specification/overview',
      schema: `https://ucp.dev/${version}/services/shopping/rest.openapi.json`,
    }];
  }

  const sources = [...used.values()]
    .sort((a, b) => a.family.localeCompare(b.family))
    .map((artifact) => ({ artifact_id: artifact.artifact_id, family: artifact.family, expires_at: artifact.expires_at }));
  const expiries = sources.map((source) => Date.parse(source.expires_at as string));
  const discovery = live.get('public_discovery_state')?.payload;
  const servingHost = discovery?.['serving_host'];
  const attestationRef = discovery?.['namespace_attestation_ref'];
  const discoveryEnabled = discovery?.['public_discovery_state'] === 'enabled'
    && discovery['public_discovery_publication_allowed'] === true
    && typeof servingHost === 'string' && servingHost.length > 0
    && typeof attestationRef === 'string' && attestationRef.length > 0;
  const hostMatches = input.rest_endpoint === undefined || new URL(input.rest_endpoint).hostname === servingHost;
  const synthetic = [...live.values()].some((artifact) => artifact.payload?.['synthetic_data'] === true);

  return {
    ucp_version: version,
    profile: { ucp: { version, services, capabilities, payment_handlers: {} } },
    withheld,
    source_artifacts: sources,
    valid_until: expiries.length > 0 ? new Date(Math.min(...expiries)).toISOString() : null,
    publication_allowed: discoveryEnabled && hostMatches,
    public_discovery: discoveryEnabled
      ? { serving_host: servingHost as string, namespace_attestation_ref: attestationRef as string }
      : null,
    // Only a synthetic scope gains the member, so other renders are unchanged.
    ...(synthetic ? { synthetic_data: true as const } : {}),
  };
}
