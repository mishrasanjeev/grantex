/**
 * E2E: Scope Enforcement Integration
 * Full flow: load manifest -> create agent -> get token -> enforce -> revoke -> enforce
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex, ToolManifest, Permission } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-enforce-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  // Load manifest
  grantex.loadManifest(new ToolManifest({
    connector: 'salesforce',
    tools: {
      query: Permission.READ,
      create_lead: Permission.WRITE,
      delete_contact: Permission.DELETE,
    },
  }));
});

describe('E2E: Scope Enforcement Integration', () => {
  let grantToken: string;
  let grantId: string;

  it('creates agent and gets grant token with write scope', async () => {
    const agent = await grantex.agents.register({
      name: `enforce-e2e-${Date.now()}`,
      scopes: ['tool:salesforce:write:contacts'],
      description: 'e2e test',
    });

    const auth = await grantex.authorize({
      agentId: agent.agentId,
      userId: 'test@enforce-e2e.com',
      scopes: ['tool:salesforce:write:contacts'],
    });

    let code = (auth as any).code;
    if (!code) {
      const resp = await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      code = ((await resp.json()) as any).code;
    }

    const token = await grantex.tokens.exchange({ code, agentId: agent.agentId });
    grantToken = token.grantToken;
    grantId = token.grantId;
    expect(grantToken).toBeTruthy();
  });

  it('enforce allows read tool with write scope', async () => {
    const result = await grantex.enforce({ grantToken, connector: 'salesforce', tool: 'query' });
    expect(result.allowed).toBe(true);
    expect(result.permission).toBe('read');
  });

  it('enforce allows write tool with write scope', async () => {
    const result = await grantex.enforce({ grantToken, connector: 'salesforce', tool: 'create_lead' });
    expect(result.allowed).toBe(true);
  });

  it('enforce denies delete tool with write scope', async () => {
    const result = await grantex.enforce({ grantToken, connector: 'salesforce', tool: 'delete_contact' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('write scope does not permit delete');
  });

  it('revoke grant token', async () => {
    await grantex.grants.revoke(grantId);
  });

  it('online verify denies after revocation', async () => {
    const result = await grantex.tokens.verify(grantToken);
    expect(result.valid).toBe(false);
  });

  it('offline enforce still passes (no revocation check)', async () => {
    // enforce() is offline-only (JWKS signature + manifest) — it does not
    // query the server for revocation status, so the JWT remains valid locally.
    const result = await grantex.enforce({ grantToken, connector: 'salesforce', tool: 'query' });
    expect(result.allowed).toBe(true);
  });
});
