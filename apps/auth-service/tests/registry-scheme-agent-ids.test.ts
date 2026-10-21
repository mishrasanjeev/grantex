// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Scheme agent ids on agent attestations (G51) without a database: the
 * payload member and its refusals, the flag that decides whether it is a
 * member at all, the lookup by (scheme, scheme_agent_id), and what the
 * registry manifest publishes about it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttestationError,
  MAX_SCHEME_AGENT_IDS,
  SCHEME_AGENT_ID_SCHEMES,
  parseAttestationPayload,
} from '../src/lib/registry/attestation-jws.js';
import { LookupRequestError, parseLookupQuery } from '../src/lib/registry/lookup.js';
import { signRegistryManifest } from '../src/lib/registry/manifest.js';
import { buildTestApp } from './helpers.js';

const NOW_S = Math.floor(Date.now() / 1000);

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://issuer.example',
    id: 'att-0001',
    sub: 'did:web:provider.example:agents:shopper-01',
    type: 'urn:grantex:tm:agent.identity',
    iat: NOW_S - 60,
    exp: NOW_S + 86_400,
    key_thumbprint: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
    external_credential_id: 'case-0001',
    external_credential_hash: `sha-256:${'A'.repeat(43)}`,
    level: 'substantial',
    status: { status_list: { uri: 'https://issuer.example/status/1', idx: 7 } },
    ...overrides,
  };
}

function refusal(fn: () => unknown): AttestationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AttestationError);
    return err as AttestationError;
  }
  throw new Error('expected a refusal');
}

const ON = { schemeAgentIds: true };
const IDS = [
  { scheme: 'visa_tap', agent_id: 'tap-agent-0001' },
  { scheme: 'mastercard_agent_pay', agent_id: 'opaque/ID with spaces:42' },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scheme_agent_ids in an attestation', () => {
  it('is an unknown member while the flag is off, exactly as before', () => {
    expect(refusal(() => parseAttestationPayload(payload({ scheme_agent_ids: IDS })))).toMatchObject({
      code: 'attestation_malformed',
      reason: 'unknown_member',
    });
    expect(parseAttestationPayload(payload()).schemeAgentIds).toEqual([]);
  });

  it('with the flag on, carries opaque scheme-scoped ids unchanged', () => {
    expect(parseAttestationPayload(payload({ scheme_agent_ids: IDS }), ON).schemeAgentIds).toEqual(IDS);
    expect(parseAttestationPayload(payload(), ON).schemeAgentIds).toEqual([]);
  });

  it('names only the schemes the registry knows, once each, with nothing else', () => {
    expect(SCHEME_AGENT_ID_SCHEMES).toEqual(['visa_tap', 'mastercard_agent_pay']);
    const bad = (value: unknown) => refusal(() => parseAttestationPayload(payload({ scheme_agent_ids: value }), ON));
    expect(bad([{ scheme: 'other_network', agent_id: 'x' }]).reason).toBe('bad_claim');
    expect(bad([IDS[0], IDS[0]]).message).toMatch(/more than once/);
    expect(bad([{ ...IDS[0], format: 'x' }]).message).toMatch(/exactly scheme and agent_id/);
    expect(bad([]).reason).toBe('bad_claim');
    expect(bad(Array.from({ length: MAX_SCHEME_AGENT_IDS + 1 }, (_, i) => ({ scheme: 'visa_tap', agent_id: `a${i}` }))).reason).toBe('bad_claim');
    expect(bad([{ scheme: 'visa_tap', agent_id: '' }]).reason).toBe('bad_claim');
    expect(bad([{ scheme: 'visa_tap', agent_id: 'x'.repeat(257) }]).reason).toBe('bad_claim');
    expect(bad([{ scheme: 'visa_tap', agent_id: 'line\nbreak' }]).reason).toBe('bad_claim');
    expect(bad({ scheme: 'visa_tap', agent_id: 'x' }).reason).toBe('bad_claim');
  });

  it('is refused on a provider attestation', () => {
    const provider = payload({ type: 'urn:grantex:tm:provider.entity', sub: 'did:web:provider.example', scheme_agent_ids: IDS });
    delete provider['key_thumbprint'];
    expect(refusal(() => parseAttestationPayload(provider, ON)).message).toMatch(/provider attestation has no scheme_agent_ids/);
  });
});

describe('lookup by scheme agent id', () => {
  it('is not a lookup parameter while the flag is off', () => {
    expect(() => parseLookupQuery({ scheme: 'visa_tap', scheme_agent_id: 'tap-agent-0001' }, { schemeAgentIds: false })).toThrow(LookupRequestError);
  });

  it('with the flag on, takes both parameters and nothing else', () => {
    expect(parseLookupQuery({ scheme: 'visa_tap', scheme_agent_id: 'tap-agent-0001' }, ON)).toEqual({
      by: 'scheme_agent_id',
      scheme: 'visa_tap',
      schemeAgentId: 'tap-agent-0001',
    });
    expect(() => parseLookupQuery({ scheme: 'visa_tap' }, ON)).toThrow(/together/);
    expect(() => parseLookupQuery({ scheme: 'visa_tap', scheme_agent_id: 'x', key_thumbprint: 'A'.repeat(43) }, ON)).toThrow(/together/);
    expect(() => parseLookupQuery({ scheme: 'other', scheme_agent_id: 'x' }, ON)).toThrow(/scheme must be one of/);
    expect(() => parseLookupQuery({ scheme: 'visa_tap', scheme_agent_id: 'x'.repeat(257) }, ON)).toThrow(/1 to 256/);
    // The existing lookups are unchanged.
    expect(parseLookupQuery({ key_thumbprint: 'A'.repeat(43) }, ON)).toEqual({ by: 'key_thumbprint', thumbprint: 'A'.repeat(43) });
  });
});

describe('the registry manifest', () => {
  const content = { issuers: [], acceptanceListIds: [], lastChange: null };

  it('says nothing about scheme agent ids while the flag is off', async () => {
    await (await buildTestApp()).close();
    const signed = await signRegistryManifest(content, new Date('2026-10-20T12:00:00Z'));
    expect(signed.claims.scheme_agent_ids).toBeUndefined();
    expect(signed.claims.endpoints.agent_by_scheme_agent_id).toBeUndefined();
  });

  it('with the flag on, names the schemes as opaque and the lookup template', async () => {
    vi.stubEnv('REGISTRY_SCHEME_AGENT_IDS_ENABLED', 'true');
    const signed = await signRegistryManifest(content, new Date('2026-10-20T12:05:00Z'));
    expect(signed.claims.scheme_agent_ids).toEqual([
      { scheme: 'visa_tap', id_format: 'opaque' },
      { scheme: 'mastercard_agent_pay', id_format: 'opaque' },
    ]);
    expect(signed.claims.endpoints.agent_by_scheme_agent_id).toMatch(/\/v1\/registry\/agents\?scheme=\{scheme\}&scheme_agent_id=\{scheme_agent_id\}$/);
  });
});
