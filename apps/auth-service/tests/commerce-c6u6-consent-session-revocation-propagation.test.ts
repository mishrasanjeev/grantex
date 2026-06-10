import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const mcpRoutePath = join(repoRoot, 'apps', 'auth-service', 'src', 'routes', 'commerce-mcp.ts');
const publicDiscoveryContractPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6u5-public-discovery-state-contract.md',
);

const now = new Date('2026-06-09T00:00:00.000Z');

interface AuthorityEvidence {
  consent_status?: string;
  passport_status?: string;
  session_status?: string;
  merchant_status?: string;
  agent_status?: string;
  policy_decision?: string;
  authority_checked_at?: string;
  passport_expires_at?: string;
  consent_expires_at?: string;
  revoked_at?: string | null;
  expected_merchant_id?: string;
  actual_merchant_id?: string;
  expected_agent_id?: string;
  actual_agent_id?: string;
  expected_buyer_id?: string;
  actual_buyer_id?: string;
  expected_session_id?: string;
  actual_session_id?: string;
}

interface AuthorityDecision {
  protected_action_allowed: false;
  public_discovery_enabled: false;
  checkout_payment_enabled: false;
  live_provider_enabled: false;
  refusal_code: string;
  blockers: string[];
  audit_required: boolean;
}

function baseAuthority(overrides: Partial<AuthorityEvidence> = {}): AuthorityEvidence {
  return {
    consent_status: 'granted',
    passport_status: 'valid',
    session_status: 'active',
    merchant_status: 'enabled',
    agent_status: 'trusted',
    policy_decision: 'allow',
    authority_checked_at: '2026-06-08T23:59:00.000Z',
    passport_expires_at: '2026-06-09T00:10:00.000Z',
    consent_expires_at: '2026-06-09T00:10:00.000Z',
    revoked_at: null,
    expected_merchant_id: 'merchant_synthetic_c6u6',
    actual_merchant_id: 'merchant_synthetic_c6u6',
    expected_agent_id: 'agent_synthetic_c6u6',
    actual_agent_id: 'agent_synthetic_c6u6',
    expected_buyer_id: 'buyer_synthetic_c6u6',
    actual_buyer_id: 'buyer_synthetic_c6u6',
    expected_session_id: 'buyer_session_synthetic_c6u6',
    actual_session_id: 'buyer_session_synthetic_c6u6',
    ...overrides,
  };
}

function classifyGrantexAuthority(evidence: AuthorityEvidence): AuthorityDecision {
  const blockers: string[] = [];
  const consent = evidence.consent_status ?? '';
  const passport = evidence.passport_status ?? '';
  const session = evidence.session_status ?? '';
  const merchant = evidence.merchant_status ?? '';
  const agent = evidence.agent_status ?? '';
  const policy = evidence.policy_decision ?? '';

  if (!consent) blockers.push('consent_missing');
  if (['denied', 'revoked', 'withdrawn', 'expired'].includes(consent)) blockers.push(`consent_${consent}`);
  if (!passport) blockers.push('passport_missing');
  if (['revoked', 'expired', 'not_yet_valid'].includes(passport)) blockers.push(`passport_${passport}`);
  if (!session) blockers.push('session_missing');
  if (['revoked', 'expired', 'disabled'].includes(session)) blockers.push(`session_${session}`);
  if (['disabled', 'blocked', 'suspended', 'inactive'].includes(merchant)) blockers.push('merchant_disabled');
  if (['disabled', 'blocked', 'suspended', 'inactive', 'untrusted'].includes(agent)) blockers.push('agent_disabled');
  if (['deny', 'denied', 'blocked', 'rejected'].includes(policy)) blockers.push('policy_denied');
  if (!evidence.authority_checked_at) blockers.push('authority_freshness_missing');
  if (evidence.authority_checked_at && Date.parse(evidence.authority_checked_at) <= now.getTime() - 5 * 60 * 1000) {
    blockers.push('authority_stale');
  }
  if (evidence.passport_expires_at && Date.parse(evidence.passport_expires_at) <= now.getTime()) {
    blockers.push('passport_expired');
  }
  if (evidence.consent_expires_at && Date.parse(evidence.consent_expires_at) <= now.getTime()) {
    blockers.push('consent_expired');
  }
  if (evidence.revoked_at) blockers.push('passport_revoked');

  for (const [label, expected, actual] of [
    ['merchant', evidence.expected_merchant_id, evidence.actual_merchant_id],
    ['agent', evidence.expected_agent_id, evidence.actual_agent_id],
    ['buyer', evidence.expected_buyer_id, evidence.actual_buyer_id],
    ['session', evidence.expected_session_id, evidence.actual_session_id],
  ] as const) {
    if (expected && actual && expected !== actual) blockers.push(`${label}_mismatch`);
  }

  return {
    protected_action_allowed: false,
    public_discovery_enabled: false,
    checkout_payment_enabled: false,
    live_provider_enabled: false,
    refusal_code: blockers[0] ?? 'checkout_payment_not_enabled_by_c6u6',
    blockers: [...new Set(blockers)],
    audit_required: true,
  };
}

describe('C6U6 Grantex consent/session/passport authority contract', () => {
  it.each([
    ['missing consent', { consent_status: '' }, 'consent_missing'],
    ['missing passport', { passport_status: '' }, 'passport_missing'],
    ['expired passport', { passport_status: 'expired' }, 'passport_expired'],
    ['revoked passport', { passport_status: 'revoked' }, 'passport_revoked'],
    ['expired passport time', { passport_expires_at: '2026-06-08T23:59:00.000Z' }, 'passport_expired'],
    ['revoked timestamp', { revoked_at: '2026-06-08T23:55:00.000Z' }, 'passport_revoked'],
    ['disabled merchant', { merchant_status: 'disabled' }, 'merchant_disabled'],
    ['disabled agent', { agent_status: 'disabled' }, 'agent_disabled'],
    ['policy denial', { policy_decision: 'deny' }, 'policy_denied'],
    ['stale authority', { authority_checked_at: '2026-06-08T23:40:00.000Z' }, 'authority_stale'],
    ['merchant mismatch', { actual_merchant_id: 'merchant_other' }, 'merchant_mismatch'],
    ['agent mismatch', { actual_agent_id: 'agent_other' }, 'agent_mismatch'],
    ['buyer mismatch', { actual_buyer_id: 'buyer_other' }, 'buyer_mismatch'],
    ['session mismatch', { actual_session_id: 'buyer_session_other' }, 'session_mismatch'],
  ])('fails closed for %s', (_label, overrides, refusalCode) => {
    const decision = classifyGrantexAuthority(baseAuthority(overrides));

    expect(decision.protected_action_allowed).toBe(false);
    expect(decision.public_discovery_enabled).toBe(false);
    expect(decision.checkout_payment_enabled).toBe(false);
    expect(decision.live_provider_enabled).toBe(false);
    expect(decision.blockers).toContain(refusalCode);
    expect(decision.audit_required).toBe(true);
  });

  it('keeps even fresh authority non-enabling in C6U6', () => {
    const decision = classifyGrantexAuthority(baseAuthority());

    expect(decision).toMatchObject({
      protected_action_allowed: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      refusal_code: 'checkout_payment_not_enabled_by_c6u6',
      blockers: [],
      audit_required: true,
    });
  });

  it('pins Commerce MCP passport verification and mismatch gates to Grantex authority', () => {
    const route = readFileSync(mcpRoutePath, 'utf8');

    expect(route).toContain('async function requireAgentPassportScope');
    expect(route).toContain('expectedTenantId: input.tenantId');
    expect(route).toContain('expectedMerchantId: input.merchantId');
    expect(route).toContain("throw new CommerceHttpError(403, 'agent_mismatch'");
    expect(route).toContain("throw new CommerceHttpError(403, 'passport_scope_missing'");
    expect(route).toContain("revocation_unavailable: 'revocation_unavailable'");
    expect(route).toContain("revoked: 'passport_revoked'");
    expect(route).toContain("expired: 'passport_expired'");
  });

  it('keeps the public discovery contract hidden and future-public inactive', () => {
    const doc = readFileSync(publicDiscoveryContractPath, 'utf8');

    expect(doc).toContain('buyer-facing public discovery hidden or refused');
    expect(doc).toContain('future_public_enabled');
    expect(doc).toContain('not active');
    expect(doc).toContain('not a production or merchant approval');
  });

  it('does not expose private evidence in authority decisions', () => {
    const decision = classifyGrantexAuthority(baseAuthority({
      passport_status: 'revoked',
      revoked_at: '2026-06-08T23:55:00.000Z',
    }));
    const serialized = JSON.stringify(decision).toLowerCase();

    expect(serialized).not.toContain('passport.jwt');
    expect(serialized).not.toContain('jwt=');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('redis://');
    expect(serialized).not.toContain('merchant-private');
    expect(serialized).not.toContain('raw_payload');
  });
});
