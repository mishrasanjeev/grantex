// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Who may suspend or reinstate OACP mandates and artifacts: the platform
 * admin, or the authority service token with the suspension scope for an
 * allow-listed tenant. A tenant operator may revoke its own tenant's mandates
 * but never suspend them.
 */
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callerMaySuspend } from '../src/routes/commerce-oacp-mandates.js';
import { OACP_MANDATES_REVOKE_SCOPE, OACP_MANDATES_SUSPEND_SCOPE } from '../src/lib/commerce/caller.js';

function request(caller: unknown, tenantId = 'cten_SUSPEND'): FastifyRequest {
  return { commerceCaller: caller, commerceTenantId: tenantId } as unknown as FastifyRequest;
}

const operator = (isPlatformAdmin: boolean) => ({
  kind: 'operator', developerId: 'dev_1', developerName: 'd', tenantId: 'cten_SUSPEND',
  tenantStatus: 'active', isOwnerOfTenant: true, isPlatformAdmin,
});
const service = (scope: string) => ({ kind: 'service', serviceId: 'svc', tenantId: '', scopes: [scope] });

describe('suspension authorisation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a tenant operator, even for its own tenant', () => {
    expect(callerMaySuspend(request(operator(false)), 'cten_SUSPEND', OACP_MANDATES_SUSPEND_SCOPE)).toBe(false);
  });

  it('allows the platform admin', () => {
    expect(callerMaySuspend(request(operator(true)), 'cten_SUSPEND', OACP_MANDATES_SUSPEND_SCOPE)).toBe(true);
  });

  it('allows the service token only with the suspension scope for an allow-listed tenant', () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_SUSPEND');
    expect(callerMaySuspend(request(service(OACP_MANDATES_SUSPEND_SCOPE)), 'cten_SUSPEND', OACP_MANDATES_SUSPEND_SCOPE)).toBe(true);
    expect(callerMaySuspend(request(service(OACP_MANDATES_REVOKE_SCOPE)), 'cten_SUSPEND', OACP_MANDATES_SUSPEND_SCOPE)).toBe(false);
    expect(callerMaySuspend(request(service(OACP_MANDATES_SUSPEND_SCOPE)), 'cten_OTHER', OACP_MANDATES_SUSPEND_SCOPE)).toBe(false);
  });

  it('refuses agents and merchants', () => {
    expect(callerMaySuspend(request({ kind: 'agent', agentId: 'cag', tenantId: 'cten_SUSPEND', authMethod: 'jwt' }), 'cten_SUSPEND', OACP_MANDATES_SUSPEND_SCOPE)).toBe(false);
    expect(callerMaySuspend(request(undefined), 'cten_SUSPEND', OACP_MANDATES_SUSPEND_SCOPE)).toBe(false);
  });
});
