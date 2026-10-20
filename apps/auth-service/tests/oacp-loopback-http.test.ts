// SPDX-License-Identifier: Apache-2.0
/**
 * A local stack (PUBLIC_BASE_URL http://localhost:<port>) could not issue a
 * single OACP artifact: issuance demanded an https status list URI, so the
 * live conformance run and the SDK verifiers' `allowLoopbackHttp` mode had
 * nothing to verify. OACP_ALLOW_LOOPBACK_HTTP=true (ignored in production)
 * now allows http on a loopback host only; https stays the only scheme
 * everywhere else.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOacpStatusUriAllowed,
  issueOacpArtifact,
  verifyOacpArtifact,
  type OacpSigningKey,
} from '../src/lib/commerce/oacp-jws.js';
import type { OacpArtifactSafety } from '../src/lib/commerce/oacp-trust-artifacts.js';

const NOW = '2026-06-11T00:00:00.000Z';
const LOCAL_URI = 'http://localhost:3001/status/oacp/oacpl_01J0000000000000000000000A';

const safety: OacpArtifactSafety = {
  public_safe: true,
  contains_private_data: false,
  allowed_agent_uses: ['browse', 'compare'],
  forbidden_agent_uses: ['payment_capture'],
  commitment_allowed: false,
  offline_commitment_allowed: false,
  requires_online_confirmation: true,
  requires_provider_direct_verification: false,
  requires_merchant_system_confirmation: true,
  stale_behavior: 'refuse_final_commitment',
  refusal_code_if_invalid: 'artifact_invalid',
};

function newSigner(kid = 'oacp-20260611-0123456789abcdef'): OacpSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } };
}

function issue(signer: OacpSigningKey, uri: string) {
  return issueOacpArtifact({
    artifact_id: 'oacp_art_01J00000000000000000LOOPBK',
    artifact_type: 'price',
    issuer: 'http://localhost:3001',
    signer,
    subject_type: 'price',
    subject_id: 'prod_1:var_1',
    tenant_id: 'cten_LOOP',
    merchant_id: 'mch_LOOP',
    seller_agent_id: 'seller_LOOP',
    buyer_agent_id: '',
    issued_at: NOW,
    expires_at: '2026-06-11T00:05:00.000Z',
    policy_version: 'policy_LOOP',
    status_list: { uri, idx: 7 },
    payload: { product_id: 'prod_1', amount_minor_units: 100, currency: 'INR' },
    safety,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('OACP status URIs on a loopback host', () => {
  it('refuses http by default: issuance throws and the verifier fails closed', () => {
    vi.stubEnv('OACP_ALLOW_LOOPBACK_HTTP', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(isOacpStatusUriAllowed(LOCAL_URI)).toBe(false);
    expect(() => issue(newSigner(), LOCAL_URI)).toThrow(/https/);
  });

  it('allows http on localhost, 127.0.0.0/8 and ::1 when OACP_ALLOW_LOOPBACK_HTTP=true', () => {
    vi.stubEnv('OACP_ALLOW_LOOPBACK_HTTP', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    expect(isOacpStatusUriAllowed(LOCAL_URI)).toBe(true);
    expect(isOacpStatusUriAllowed('http://127.0.0.1:55502/status/oacp/x')).toBe(true);
    expect(isOacpStatusUriAllowed('http://[::1]:3001/status/oacp/x')).toBe(true);
    expect(isOacpStatusUriAllowed('https://issuer.example/status/oacp/x')).toBe(true);
    // Never a non-loopback host, a look-alike, or another scheme.
    expect(isOacpStatusUriAllowed('http://issuer.example/status/oacp/x')).toBe(false);
    expect(isOacpStatusUriAllowed('http://localhost.issuer.example/status/oacp/x')).toBe(false);
    expect(isOacpStatusUriAllowed('http://10.0.0.1/status/oacp/x')).toBe(false);
    expect(isOacpStatusUriAllowed('ftp://localhost/status/oacp/x')).toBe(false);
    expect(isOacpStatusUriAllowed('HTTP://localhost/status/oacp/x')).toBe(false);

    const signer = newSigner();
    const envelope = issue(signer, LOCAL_URI);
    const result = verifyOacpArtifact({
      envelope,
      payload: { product_id: 'prod_1', amount_minor_units: 100, currency: 'INR' },
      jwks: { keys: [signer.publicJwk] },
      now_iso: NOW,
      status: 0,
    });
    expect(result.valid).toBe(true);
  });

  it('is ignored when NODE_ENV is production', () => {
    vi.stubEnv('OACP_ALLOW_LOOPBACK_HTTP', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isOacpStatusUriAllowed(LOCAL_URI)).toBe(false);
    expect(() => issue(newSigner(), LOCAL_URI)).toThrow(/https/);
  });

  it('lets a loopback PUBLIC_BASE_URL issue only with the flag', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:3001');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OACP_ALLOW_LOOPBACK_HTTP', '');
    vi.resetModules();
    let status = await import('../src/lib/commerce/oacp-status.js');
    expect(() => status.assertOacpStatusBaseUsable()).toThrow(/https PUBLIC_BASE_URL/);

    vi.stubEnv('OACP_ALLOW_LOOPBACK_HTTP', 'true');
    vi.resetModules();
    status = await import('../src/lib/commerce/oacp-status.js');
    expect(() => status.assertOacpStatusBaseUsable()).not.toThrow();

    vi.stubEnv('PUBLIC_BASE_URL', 'http://grantex.example');
    vi.resetModules();
    status = await import('../src/lib/commerce/oacp-status.js');
    expect(() => status.assertOacpStatusBaseUsable()).toThrow(/https PUBLIC_BASE_URL/);
  });
});
