import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensureCommerceLiveMode,
  getCommerceLiveModeStatus,
} from '../src/lib/commerce/live-mode-guard.js';
import { CommerceHttpError } from '../src/lib/commerce/errors.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6u10-live-provider-readiness-packet.md',
);

function packet(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function expectCommerceError(fn: () => void, code: string, reason: string): void {
  let captured: unknown;
  try {
    fn();
  } catch (err) {
    captured = err;
  }

  expect(captured).toBeInstanceOf(CommerceHttpError);
  const err = captured as CommerceHttpError;
  expect(err.statusCode).toBe(403);
  expect(err.code).toBe(code);
  expect(err.options.retryable).toBe(false);
  expect(err.options.details).toMatchObject({ reason });
}

describe('C6U10 live provider readiness packet', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('documents the required packet sections without adding runtime enablement', () => {
    const doc = packet();

    for (const section of [
      'Live Provider Prerequisites',
      'Legal, Partner, Security, And Operator Checklist',
      'Feature Flag And Config Checklist',
      'Credential Handling Checklist',
      'Provider Adapter Contract Checklist',
      'Webhook Signature Checklist',
      'Webhook Replay Checklist',
      'Idempotency Checklist',
      'Reconciliation Checklist',
      'Settlement And Payout Non-Enablement',
      'Refund Non-Enablement',
      'Support, Incident, And Rollback Stop Conditions',
      'Data Retention, Privacy, And Audit Evidence',
      'Evidence Required Before Later Live-Mode Review',
      'AgenticOrg Future-Consumption Note',
      'API, OpenAPI, Migration, And Workflow Note',
      'Future Slices',
    ]) {
      expect(doc).toContain(`## ${section}`);
    }

    expect(doc).toContain('C6U10 adds no endpoint, route, OpenAPI schema, migration, workflow');
    expect(doc).toContain('OpenAPI is unchanged because this packet exposes no API surface');
  });

  it('keeps current live mode and provider execution flags fail-closed', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', '');
    vi.stubEnv('PLURAL_LIVE_ENABLED', '');
    vi.stubEnv('PLURAL_SANDBOX_ENABLED', '');

    expect(getCommerceLiveModeStatus()).toEqual({
      liveModeEnabled: false,
      pluralLiveEnabled: false,
      pluralSandboxEnabled: false,
    });
    expectCommerceError(
      () => ensureCommerceLiveMode({ environment: 'live' }),
      'commerce_live_mode_disabled',
      'live_mode_disabled',
    );
    expectCommerceError(
      () => ensureCommerceLiveMode({ environment: 'live', providerKey: 'plural' }),
      'plural_live_disabled',
      'plural_live_disabled',
    );
    expectCommerceError(
      () => ensureCommerceLiveMode({ environment: 'sandbox', providerKey: 'plural' }),
      'plural_live_disabled',
      'plural_sandbox_disabled',
    );
  });

  it('allows only local mock sandbox flow while blocking provider-specific rails', () => {
    vi.stubEnv('COMMERCE_LIVE_MODE_ENABLED', '');
    vi.stubEnv('PLURAL_LIVE_ENABLED', '');
    vi.stubEnv('PLURAL_SANDBOX_ENABLED', '');

    expect(() => ensureCommerceLiveMode({
      environment: 'sandbox',
      providerKey: 'mock',
    })).not.toThrow();
    expectCommerceError(
      () => ensureCommerceLiveMode({ providerKey: 'plural' }),
      'plural_live_disabled',
      'plural_live_disabled',
    );
  });

  it('contains explicit non-approval wording and no concrete secret/config values', () => {
    const doc = packet();

    expect(doc).toContain(
      'This packet is a review checklist only. It does not approve live provider use',
    );
    expect(doc).toContain('C6U10 does not change runtime code, routes, OpenAPI, workflows');
    expect(doc).toContain('This C6U10 slice does not run those commands');
    expect(doc).toContain('C6U10 does not execute refunds');
    expect(doc).toContain('C6U10 does not add settlement or payout fields');

    expect(doc).not.toMatch(/COMMERCE_LIVE_MODE_ENABLED\s*=\s*true/i);
    expect(doc).not.toMatch(/PLURAL_LIVE_ENABLED\s*=\s*true/i);
    expect(doc).not.toMatch(/PLURAL_SANDBOX_ENABLED\s*=\s*true/i);
    expect(doc).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true/i);
    expect(doc).not.toMatch(/-----BEGIN [A-Z ]+PRIVATE KEY-----/i);
    expect(doc).not.toMatch(/\b(sk_live_|pk_live_|whsec_)/i);
    expect(doc).not.toMatch(/\b(postgres|postgresql|redis):\/\//i);
    expect(doc).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{20,}/i);
  });

  it('preserves AgenticOrg refusal guidance and C6U9 blocker separation', () => {
    const doc = packet();

    expect(doc).toContain('Post-C6U9 MPP E2E failed in the client-side verification step');
    expect(doc).toContain('C6U9 changed only sandbox checkout helper, test, and documentation files');
    expect(doc).toContain('This packet does not request or perform those diagnostics');
    expect(doc).toContain('AgenticOrg must continue refusing checkout, order, payment, fulfillment');
    expect(doc).toContain('AgenticOrg must not infer provider state from sandbox fixtures');
  });
});
