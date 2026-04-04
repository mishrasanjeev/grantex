import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolManifest, Permission } from '../src/manifest.js';
import type { VerifiedGrant } from '../src/types.js';

// Mock verifyGrantToken before importing client
vi.mock('../src/verify.js', () => ({
  verifyGrantToken: vi.fn(),
  mapOnlineVerifyToVerifiedGrant: vi.fn(),
}));

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function makeGrant(overrides: Partial<VerifiedGrant> = {}): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grant_01',
    principalId: 'user_abc',
    agentDid: 'did:grantex:ag_01',
    developerId: 'org_test',
    scopes: ['tool:salesforce:write'],
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  };
}

const salesforceManifest = new ToolManifest({
  connector: 'salesforce',
  tools: {
    query: Permission.READ,
    create_lead: Permission.WRITE,
    delete_contact: Permission.DELETE,
    manage_org: Permission.ADMIN,
  },
});

const hubspotManifest = new ToolManifest({
  connector: 'hubspot',
  tools: {
    search: Permission.READ,
    create_deal: Permission.WRITE,
  },
});

describe('enforce()', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns allowed when scope matches tool permission', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      makeGrant({ scopes: ['tool:salesforce:write'] }),
    );
    vi.stubGlobal('fetch', makeFetch(200, {}));

    const grantex = new Grantex({ apiKey: 'test_key' });
    grantex.loadManifest(salesforceManifest);

    const result = await grantex.enforce({
      grantToken: 'fake.token',
      connector: 'salesforce',
      tool: 'create_lead',
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('');
    expect(result.grantId).toBe('grant_01');
    expect(result.agentDid).toBe('did:grantex:ag_01');
    expect(result.connector).toBe('salesforce');
    expect(result.tool).toBe('create_lead');
    expect(result.permission).toBe(Permission.WRITE);
  });

  it('returns denied when scope is insufficient (read scope, write tool)', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      makeGrant({ scopes: ['tool:salesforce:read'] }),
    );
    vi.stubGlobal('fetch', makeFetch(200, {}));

    const grantex = new Grantex({ apiKey: 'test_key' });
    grantex.loadManifest(salesforceManifest);

    const result = await grantex.enforce({
      grantToken: 'fake.token',
      connector: 'salesforce',
      tool: 'create_lead',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('read scope does not permit write');
  });

  it('returns denied for unknown connector (no manifest loaded)', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      makeGrant({ scopes: ['tool:unknown:write'] }),
    );
    vi.stubGlobal('fetch', makeFetch(200, {}));

    const grantex = new Grantex({ apiKey: 'test_key' });
    // No manifest loaded for "unknown"

    const result = await grantex.enforce({
      grantToken: 'fake.token',
      connector: 'unknown',
      tool: 'some_tool',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No manifest loaded for connector 'unknown'");
  });

  it('returns denied for unknown tool', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(
      makeGrant({ scopes: ['tool:salesforce:admin'] }),
    );
    vi.stubGlobal('fetch', makeFetch(200, {}));

    const grantex = new Grantex({ apiKey: 'test_key' });
    grantex.loadManifest(salesforceManifest);

    const result = await grantex.enforce({
      grantToken: 'fake.token',
      connector: 'salesforce',
      tool: 'nonexistent_tool',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Unknown tool 'nonexistent_tool'");
    expect(result.reason).toContain("connector 'salesforce'");
  });

  describe('permission hierarchy', () => {
    it('write scope allows read tool', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'query',
      });

      expect(result.allowed).toBe(true);
    });

    it('delete scope allows write tool', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:delete'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'create_lead',
      });

      expect(result.allowed).toBe(true);
    });

    it('admin scope allows delete tool', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:admin'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'delete_contact',
      });

      expect(result.allowed).toBe(true);
    });

    it('read scope cannot access delete tool', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:read'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'delete_contact',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read scope does not permit delete');
    });

    it('write scope cannot access admin tool', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'manage_org',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('write scope does not permit admin');
    });
  });

  describe('token failures', () => {
    it('returns denied for expired token', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(
        new Error('JWTExpired: token has expired'),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'expired.token',
        connector: 'salesforce',
        tool: 'query',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Token verification failed');
      expect(result.reason).toContain('expired');
      expect(result.grantId).toBe('');
      expect(result.agentDid).toBe('');
      expect(result.scopes).toEqual([]);
    });

    it('returns denied for invalid token', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(
        new Error('JWSInvalid: invalid signature'),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'bad.token',
        connector: 'salesforce',
        tool: 'query',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Token verification failed');
      expect(result.reason).toContain('invalid signature');
    });

    it('handles non-Error rejection from verifyGrantToken', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue('unexpected string error');
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'weird.token',
        connector: 'salesforce',
        tool: 'query',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Token verification failed');
      expect(result.reason).toContain('unexpected string error');
    });
  });

  describe('capped scopes', () => {
    it('allows when amount is under the cap', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write:leads:capped:500'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'create_lead',
        amount: 100,
      });

      expect(result.allowed).toBe(true);
    });

    it('allows when amount equals the cap', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write:leads:capped:500'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'create_lead',
        amount: 500,
      });

      expect(result.allowed).toBe(true);
    });

    it('denies when amount exceeds the cap', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write:leads:capped:500'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'create_lead',
        amount: 1000,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Amount 1000 exceeds budget cap of 500');
    });

    it('allows any amount when no cap is specified', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'create_lead',
        amount: 999999,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('scope resolution', () => {
    it('returns denied when token has no scope for the connector', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:hubspot:admin'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'query',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("No scope grants access to connector 'salesforce'");
    });

    it('resolves highest permission when multiple scopes match', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({
          scopes: ['tool:salesforce:read', 'tool:salesforce:admin'],
        }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'manage_org',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('loadManifest and loadManifests', () => {
    it('loadManifest makes connector available for enforce', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:hubspot:write'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });

      // Before loading, enforce denies
      const before = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'hubspot',
        tool: 'create_deal',
      });
      expect(before.allowed).toBe(false);
      expect(before.reason).toContain("No manifest loaded for connector 'hubspot'");

      // After loading, enforce allows
      grantex.loadManifest(hubspotManifest);
      const after = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'hubspot',
        tool: 'create_deal',
      });
      expect(after.allowed).toBe(true);
    });

    it('loadManifests loads multiple manifests at once', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({
          scopes: ['tool:salesforce:write', 'tool:hubspot:read'],
        }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifests([salesforceManifest, hubspotManifest]);

      const sfResult = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'create_lead',
      });
      expect(sfResult.allowed).toBe(true);

      const hsResult = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'hubspot',
        tool: 'search',
      });
      expect(hsResult.allowed).toBe(true);
    });

    it('loadManifest overwrites previous manifest for same connector', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({ scopes: ['tool:salesforce:write'] }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      // manage_org requires admin, so write scope should deny it
      const before = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'manage_org',
      });
      expect(before.allowed).toBe(false);

      // Replace manifest: now manage_org only requires write
      const relaxedManifest = new ToolManifest({
        connector: 'salesforce',
        tools: { manage_org: Permission.WRITE },
      });
      grantex.loadManifest(relaxedManifest);

      const after = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'manage_org',
      });
      expect(after.allowed).toBe(true);
    });
  });

  describe('EnforceResult fields', () => {
    it('populates all fields on allowed result', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(
        makeGrant({
          grantId: 'grant_42',
          agentDid: 'did:grantex:ag_42',
          scopes: ['tool:salesforce:admin'],
        }),
      );
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });
      grantex.loadManifest(salesforceManifest);

      const result = await grantex.enforce({
        grantToken: 'fake.token',
        connector: 'salesforce',
        tool: 'manage_org',
      });

      expect(result).toEqual({
        allowed: true,
        reason: '',
        grantId: 'grant_42',
        agentDid: 'did:grantex:ag_42',
        scopes: ['tool:salesforce:admin'],
        permission: Permission.ADMIN,
        connector: 'salesforce',
        tool: 'manage_org',
      });
    });

    it('populates connector and tool fields even on denial', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('bad token'));
      vi.stubGlobal('fetch', makeFetch(200, {}));

      const grantex = new Grantex({ apiKey: 'test_key' });

      const result = await grantex.enforce({
        grantToken: 'bad.token',
        connector: 'salesforce',
        tool: 'query',
      });

      expect(result.connector).toBe('salesforce');
      expect(result.tool).toBe('query');
      expect(result.allowed).toBe(false);
    });
  });

  describe('wrapTool()', () => {
    it('calls original invoke when scope is sufficient', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:write'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const original = { name: 'test', description: 'test', invoke: vi.fn().mockResolvedValue('result') };
      const gx = new Grantex({ apiKey: 'k' });
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      const wrapped = gx.wrapTool(original, { connector: 'salesforce', tool: 'create_lead', grantToken: 'token' });
      const result = await wrapped.invoke('arg1');
      expect(result).toBe('result');
      expect(original.invoke).toHaveBeenCalledWith('arg1');
    });

    it('throws when scope is insufficient', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:read'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const original = { name: 'test', description: 'test', invoke: vi.fn() };
      const gx = new Grantex({ apiKey: 'k' });
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      const wrapped = gx.wrapTool(original, { connector: 'salesforce', tool: 'create_lead', grantToken: 'token' });
      await expect(wrapped.invoke()).rejects.toThrow('Grantex scope denied');
      expect(original.invoke).not.toHaveBeenCalled();
    });

    it('supports dynamic grant token getter', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:write'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const original = { name: 'test', description: 'test', invoke: vi.fn().mockResolvedValue('ok') };
      const gx = new Grantex({ apiKey: 'k' });
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      let token = 'token-1';
      const wrapped = gx.wrapTool(original, { connector: 'salesforce', tool: 'create_lead', grantToken: () => token });
      await wrapped.invoke();
      expect(vi.mocked(verifyGrantToken)).toHaveBeenCalledWith('token-1', expect.anything());
      token = 'token-2';
      await wrapped.invoke();
      expect(vi.mocked(verifyGrantToken)).toHaveBeenCalledWith('token-2', expect.anything());
    });
  });

  describe('enforceMiddleware()', () => {
    it('calls next when scope is sufficient', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:write'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const gx = new Grantex({ apiKey: 'k' });
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      const mw = gx.enforceMiddleware({
        extractToken: (req) => req['token'] as string,
        extractConnector: () => 'salesforce',
        extractTool: () => 'create_lead',
      });
      const req = { token: 'jwt' };
      const next = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await new Promise<void>((resolve) => { mw(req, res, (err?: unknown) => { next(err); resolve(); }); });
      expect(next).toHaveBeenCalledWith(undefined);
      expect(req).toHaveProperty('grantexEnforce');
    });

    it('returns 403 when scope is insufficient', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:read'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const gx = new Grantex({ apiKey: 'k' });
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      const mw = gx.enforceMiddleware({
        extractToken: (req) => req['token'] as string,
        extractConnector: () => 'salesforce',
        extractTool: () => 'create_lead',
      });
      const req = { token: 'jwt' };
      const json = vi.fn();
      const res = { status: vi.fn().mockReturnValue({ json }) };
      const next = vi.fn();
      mw(req, res, next);
      await vi.waitFor(() => expect(json).toHaveBeenCalled());
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no token', () => {
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const gx = new Grantex({ apiKey: 'k' });
      const mw = gx.enforceMiddleware({
        extractToken: () => undefined,
        extractConnector: () => 'salesforce',
        extractTool: () => 'query',
      });
      const json = vi.fn();
      const res = { status: vi.fn().mockReturnValue({ json }) };
      mw({}, res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('permissive enforce_mode', () => {
    it('allows denied results in permissive mode with warning', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:read'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const gx = new Grantex({ apiKey: 'k', enforceMode: 'permissive' } as any);
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      const result = await gx.enforce({ grantToken: 'tok', connector: 'salesforce', tool: 'create_lead' });
      expect(result.allowed).toBe(true); // permissive overrides
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('strict mode denies normally (default)', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant({ scopes: ['tool:salesforce:read'] }));
      vi.stubGlobal('fetch', makeFetch(200, {}));
      const gx = new Grantex({ apiKey: 'k' });
      gx.loadManifest(new ToolManifest({ connector: 'salesforce', tools: { create_lead: Permission.WRITE } }));
      const result = await gx.enforce({ grantToken: 'tok', connector: 'salesforce', tool: 'create_lead' });
      expect(result.allowed).toBe(false);
    });
  });
});
