/**
 * G18: the UCP business profile rendered from issued OACP artifacts, at
 * 2026-04-08 and 2026-08-25, validated against the saved UCP schemas; only
 * capabilities the host serves and the artifacts back are emitted; the
 * Grantex-private `dev.grantex.commerce.discovery.preview` namespace and the
 * UCP-style / ACP-style preview routes are gone.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UCP_CAPABILITY_BACKING,
  UCP_PROFILE_VERSIONS,
  UCP_RENDERABLE_CAPABILITIES,
  UcpProfileInputError,
  renderUcpBusinessProfile,
  type UcpBackingArtifact,
  type UcpProfileVersion,
} from '../src/lib/commerce/ucp-profile.js';
import { schemaErrors, type ProtocolRelease } from './protocol-schemas.js';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';

const NOW = '2026-10-20T10:00:00.000Z';
const LATER = '2026-10-20T16:00:00.000Z';
const FAMILIES = [
  'merchant_profile', 'seller_agent_card', 'connector_evidence', 'catalog_snapshot', 'offer_price_snapshot',
  'inventory_snapshot', 'policy_scope', 'public_discovery_state', 'mandate_capability', 'protocol_adapter',
  'authority_request_status',
];
const ENDPOINT = 'https://merchant.example/ucp/v1';
const ALL_SCOPES = [
  'dev.ucp.shopping.checkout:manage', 'dev.ucp.shopping.cart:manage', 'dev.ucp.shopping.order:read',
  'dev.ucp.shopping.order:manage', 'dev.ucp.shopping.catalog.search:read', 'dev.ucp.shopping.catalog.lookup:read',
];

function artifacts(overrides: Record<string, Partial<UcpBackingArtifact> | null> = {}): UcpBackingArtifact[] {
  return FAMILIES.flatMap((family, index) => {
    const override = overrides[family];
    if (override === null) return [];
    return [{
      artifact_id: `oacp_art_${String(index).padStart(26, '0')}`,
      family,
      status: 'issued',
      expires_at: LATER,
      payload: family === 'public_discovery_state' ? { public_discovery_publication_allowed: false } : {},
      ...override,
    }];
  });
}

function releaseOf(version: UcpProfileVersion): ProtocolRelease {
  return version === '2026-04-08' ? 'ucp-2026-04-08' : 'ucp-2026-08-25';
}

function profileErrors(version: UcpProfileVersion, profile: unknown): string[] {
  return version === '2026-04-08'
    ? schemaErrors('ucp-2026-04-08', 'https://ucp.dev/discovery/profile.json#/$defs/business_profile', profile)
    : schemaErrors('ucp-2026-08-25', 'https://ucp.dev/schemas/profile.json#/$defs/base', profile)
      .concat(schemaErrors('ucp-2026-08-25', 'https://ucp.dev/schemas/ucp.json#/$defs/business_schema', (profile as { ucp: unknown }).ucp));
}

function renderAll(version: UcpProfileVersion, list = artifacts()) {
  return renderUcpBusinessProfile({
    version,
    artifacts: list,
    served: [...UCP_RENDERABLE_CAPABILITIES],
    rest_endpoint: ENDPOINT,
    identity_linking: { scopes: ALL_SCOPES },
    now_iso: NOW,
  });
}

describe.each(UCP_PROFILE_VERSIONS)('UCP %s business profile from OACP artifacts', (version) => {
  it('validates against the saved UCP profile schema with every capability backed', () => {
    const rendered = renderAll(version);
    expect(profileErrors(version, rendered.profile)).toEqual([]);
    expect(Object.keys(rendered.profile.ucp.capabilities).sort()).toEqual([...UCP_RENDERABLE_CAPABILITIES].sort());
    expect(rendered.withheld).toEqual([]);
    expect(rendered.profile.ucp.payment_handlers).toEqual({});
  });

  it('declares ucp.version on every dev.ucp.* service and capability entry, with ucp.dev spec and schema URLs', () => {
    const { profile } = renderAll(version);
    expect(profile.ucp.version).toBe(version);
    const entries = [...Object.entries(profile.ucp.capabilities), ...Object.entries(profile.ucp.services)];
    for (const [name, list] of entries) {
      expect(name.startsWith('dev.ucp.')).toBe(true);
      for (const entry of list) {
        expect(entry.version).toBe(version);
        expect(entry.spec.startsWith(`https://ucp.dev/${version}/specification/`)).toBe(true);
        expect(entry.schema.startsWith(`https://ucp.dev/${version}/`)).toBe(true);
      }
    }
    expect(profile.ucp.services['dev.ucp.shopping']).toEqual([expect.objectContaining({ transport: 'rest', endpoint: ENDPOINT })]);
  });

  it('renders identity linking config.scopes that validate against the capability business schema', () => {
    const { profile } = renderAll(version);
    const entry = profile.ucp.capabilities['dev.ucp.common.identity_linking']![0]!;
    expect(Object.keys(entry.config!['scopes'] as object).sort()).toEqual([...ALL_SCOPES].sort());
    expect(schemaErrors(releaseOf(version),
      'https://ucp.dev/schemas/common/identity_linking.json#/$defs/dev.ucp.common.identity_linking/business_schema',
      entry)).toEqual([]);
  });

  it('never emits the Grantex-private preview namespace or non-standard names', () => {
    const text = JSON.stringify(renderAll(version));
    expect(text).not.toContain('dev.grantex');
    expect(text).not.toContain('preview');
  });

  it('withholds each capability whose backing artifact is missing, revoked or expired', () => {
    for (const [family, override] of [
      ['inventory_snapshot', null],
      ['inventory_snapshot', { status: 'revoked' }],
      ['inventory_snapshot', { expires_at: NOW }],
    ] as const) {
      const rendered = renderAll(version, artifacts({ [family]: override }));
      const names = Object.keys(rendered.profile.ucp.capabilities);
      for (const capability of UCP_RENDERABLE_CAPABILITIES) {
        const needs = UCP_CAPABILITY_BACKING[capability].includes(family);
        if (needs) expect(names).not.toContain(capability);
      }
      expect(rendered.withheld).toContainEqual({
        name: 'dev.ucp.shopping.checkout', reason: 'missing_backing_artifact', missing_families: ['inventory_snapshot'],
      });
      // Identity linking survives but lists no scope of a withheld capability.
      expect(rendered.profile.ucp.capabilities['dev.ucp.common.identity_linking']).toBeUndefined();
      expect(rendered.withheld).toContainEqual({ name: 'dev.ucp.common.identity_linking', reason: 'no_identity_linking_scopes' });
      expect(profileErrors(version, rendered.profile)).toEqual([]);
    }
  });

  it('withholds checkout and order without a mandate capability artifact but keeps catalog and cart', () => {
    const rendered = renderAll(version, artifacts({ mandate_capability: null }));
    expect(Object.keys(rendered.profile.ucp.capabilities).sort()).toEqual([
      'dev.ucp.common.identity_linking',
      'dev.ucp.shopping.cart',
      'dev.ucp.shopping.catalog.lookup',
      'dev.ucp.shopping.catalog.search',
    ]);
    expect(rendered.withheld).toContainEqual({ name: 'dev.ucp.shopping.order', reason: 'requires_checkout' });
    const scopes = Object.keys(rendered.profile.ucp.capabilities['dev.ucp.common.identity_linking']![0]!.config!['scopes'] as object);
    expect(scopes.some((scope) => scope.startsWith('dev.ucp.shopping.checkout') || scope.startsWith('dev.ucp.shopping.order'))).toBe(false);
  });

  it('emits only what the host serves', () => {
    const rendered = renderUcpBusinessProfile({
      version,
      artifacts: artifacts(),
      served: ['dev.ucp.shopping.catalog.search'],
      rest_endpoint: ENDPOINT,
      now_iso: NOW,
    });
    expect(Object.keys(rendered.profile.ucp.capabilities)).toEqual(['dev.ucp.shopping.catalog.search']);
    expect(rendered.withheld.filter((w) => w.reason === 'not_served')).toHaveLength(UCP_RENDERABLE_CAPABILITIES.length - 1);
    expect(rendered.source_artifacts.map((a) => a.family)).toEqual([...UCP_CAPABILITY_BACKING['dev.ucp.shopping.catalog.search']].sort());
    expect(profileErrors(version, rendered.profile)).toEqual([]);
  });

  it('renders an empty, schema-valid profile when nothing is backed', () => {
    const rendered = renderAll(version, []);
    expect(rendered.profile.ucp).toEqual({ version, services: {}, capabilities: {}, payment_handlers: {} });
    expect(rendered.valid_until).toBeNull();
    expect(profileErrors(version, rendered.profile)).toEqual([]);
  });
});

describe('UCP profile inputs and bookkeeping', () => {
  it('re-renders by the earliest source expiry and reports publication posture from public_discovery_state', () => {
    const soon = '2026-10-20T10:01:00.000Z';
    const rendered = renderAll('2026-04-08', artifacts({ inventory_snapshot: { expires_at: soon } }));
    expect(rendered.valid_until).toBe(soon);
    expect(rendered.publication_allowed).toBe(false);
    const allowed = renderAll('2026-04-08', artifacts({
      public_discovery_state: { payload: { public_discovery_publication_allowed: true } },
    }));
    expect(allowed.publication_allowed).toBe(true);
  });

  it('refuses an unsupported version, an unknown capability, a bad endpoint and a malformed scope', () => {
    const base = { artifacts: artifacts(), served: [] as never[], now_iso: NOW };
    expect(() => renderUcpBusinessProfile({ ...base, version: '2026-01-11' as never })).toThrow(UcpProfileInputError);
    expect(() => renderUcpBusinessProfile({ ...base, version: '2026-04-08', served: ['dev.grantex.commerce.discovery.preview'] as never }))
      .toThrow(/unknown capability/);
    for (const endpoint of ['http://merchant.example/ucp', 'https://merchant.example/ucp/', 'https://merchant.example/ucp?x=1']) {
      expect(() => renderUcpBusinessProfile({ ...base, version: '2026-04-08', rest_endpoint: endpoint })).toThrow(/rest_endpoint|https/);
    }
    expect(() => renderUcpBusinessProfile({
      ...base, version: '2026-04-08', served: ['dev.ucp.common.identity_linking'], identity_linking: { scopes: ['Checkout:Manage'] },
    })).toThrow(/scope token/);
  });

  it('accepts the 2026-08-25 hyphenated scope token that 2026-04-08 refuses', () => {
    const input = {
      artifacts: artifacts(),
      served: ['dev.ucp.shopping.catalog.search', 'dev.ucp.common.identity_linking'] as never,
      identity_linking: { scopes: ['dev.ucp.shopping.catalog.search:read', 'com.merchant-x.loyalty:read'] },
      now_iso: NOW,
    };
    expect(() => renderUcpBusinessProfile({ ...input, version: '2026-04-08' })).toThrow(/scope token/);
    const rendered = renderUcpBusinessProfile({ ...input, version: '2026-08-25' });
    // The vendor scope names a capability this profile does not emit, so it is dropped.
    expect(Object.keys(rendered.profile.ucp.capabilities['dev.ucp.common.identity_linking']![0]!.config!['scopes'] as object))
      .toEqual(['dev.ucp.shopping.catalog.search:read']);
  });
});

describe('GET /v1/commerce/oacp/ucp-profile', () => {
  const SERVICE_TOKEN = 'agenticorg-ucp-profile-fixture-token';
  const TENANT = 'cten_UCPPROFILE';
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  const query = (extra = '') =>
    `/v1/commerce/oacp/ucp-profile?tenant_id=${TENANT}&merchant_id=mch_example&seller_agent_id=seller-01`
    + `&served=${UCP_RENDERABLE_CAPABILITIES.join(',')}&rest_endpoint=${encodeURIComponent(ENDPOINT)}`
    + `&identity_linking_scopes=${ALL_SCOPES.join(',')}${extra}`;
  const get = (url: string, token = SERVICE_TOKEN) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('renders the profile from the scope\'s live artifacts with the service token', async () => {
    const rows = artifacts().map((a) => ({ ...a, tenant_id: TENANT, merchant_id: 'mch_example', seller_agent_id: 'seller-01', created_at: NOW }));
    sqlMock.mockResolvedValueOnce(rows);
    const res = await get(query('&version=2026-08-25'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<ReturnType<typeof renderAll>>();
    expect(body.ucp_version).toBe('2026-08-25');
    expect(profileErrors('2026-08-25', body.profile)).toEqual([]);
    const [statement, ...params] = sqlMock.mock.calls.at(-1) as [string[], ...unknown[]];
    expect(statement[0]).toContain("status = 'issued'");
    expect(params.slice(0, 3)).toEqual([TENANT, 'mch_example', 'seller-01']);
  });

  it('defaults to 2026-04-08', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await get(query());
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ucp_version: string }>().ucp_version).toBe('2026-04-08');
  });

  it('refuses a tenant outside the service allowlist, missing scope fields, unknown capabilities and bad versions', async () => {
    const other = await get(query().replace(TENANT, 'cten_OTHER'));
    expect(other.statusCode).toBe(403);
    expect((await get('/v1/commerce/oacp/ucp-profile?tenant_id=' + TENANT)).statusCode).toBe(422);
    expect((await get(query('&version=2025-01-01'))).statusCode).toBe(422);
    const unknown = await get(query().replace('served=', 'served=dev.grantex.commerce.discovery.preview,'));
    expect(unknown.statusCode).toBe(422);
    const badEndpoint = await get(query().replace(encodeURIComponent(ENDPOINT), encodeURIComponent('http://merchant.example/ucp')));
    expect(badEndpoint.statusCode).toBe(422);
  });

  it('is not reachable with the service token on another method, nor without a credential', async () => {
    expect((await app.inject({ method: 'GET', url: query() })).statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/ucp-profile', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect([401, 404]).toContain(post.statusCode);
  });

  it('no longer serves the UCP-style and ACP-style preview routes', async () => {
    for (const path of ['ucp-capability-profile-preview', 'acp-checkout-shape-preview']) {
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ tenant_id: TENANT, status: 'active', role: 'owner' }]);
      const res = await app.inject({ method: 'GET', url: `/v1/commerce/merchants/mch_SANDBOX/${path}`, headers: authHeader() });
      expect(res.statusCode).toBe(404);
    }
  });
});
