import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolManifest, Permission } from '../src/manifest.js';
import { DenialReason, RevocationSubReason } from '../src/denials.js';
import { RevokedSet, type RevocationEntry } from '../src/revocations/index.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', () => ({
  verifyGrantToken: vi.fn(),
  mapOnlineVerifyToVerifiedGrant: vi.fn(),
}));

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

const manifest = new ToolManifest({
  connector: 'acme_kyb',
  tools: { resolve_business: Permission.READ },
});

function grant(overrides: Partial<VerifiedGrant> = {}): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_child',
    principalId: 'user_1',
    agentDid: 'did:grantex:ag_01',
    developerId: 'dev_1',
    scopes: ['tool:acme_kyb:read'],
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    ...overrides,
  };
}

function entry(overrides: Partial<RevocationEntry> = {}): RevocationEntry {
  return {
    seq: 1,
    action: 'revoked',
    grantId: 'grnt_child',
    jti: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    at: new Date().toISOString(),
    ...overrides,
  };
}

/** A fetch that serves a snapshot, then a stream that stays open with heartbeats. */
function feedFetch(options: {
  snapshot?: RevocationEntry[];
  streamEvents?: string[];
  snapshotStatus?: number;
  streamStatus?: number;
  withBody?: boolean;
} = {}) {
  const snapshot = options.snapshot ?? [];
  const events = options.streamEvents ?? [`event: heartbeat\ndata: {"cursor":0}\n\n`];
  return vi.fn(async (url: string) => {
    if (String(url).includes('/v1/revocations/stream')) {
      if ((options.streamStatus ?? 200) !== 200) {
        return { ok: false, status: options.streamStatus, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
      }
      if (options.withBody === false) {
        return { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({}), text: async () => '' };
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          // Left open: a live feed does not end.
        },
      });
      return { ok: true, status: 200, headers: { get: () => null }, body: stream, json: async () => ({}), text: async () => '' };
    }
    const status = options.snapshotStatus ?? 200;
    const body = String(url).includes('/v1/revocations/status')
      ? { status: 'active', revoked: false }
      : { entries: snapshot, cursor: 5, nextPageToken: null, snapshot: true };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
}

describe('the revoked set', () => {
  it('remembers revocations and suspensions, and forgets a resumed grant', () => {
    const set = new RevokedSet();
    set.apply(entry({ grantId: 'grnt_a' }));
    set.apply(entry({ seq: 2, action: 'suspended', grantId: 'grnt_b' }));
    set.apply(entry({ seq: 3, action: 'token_revoked', grantId: 'grnt_c', jti: 'tok_c' }));
    expect(set.match({ grantId: 'grnt_a' })).toMatchObject({ kind: 'grant', action: 'revoked' });
    expect(set.match({ grantId: 'grnt_b' })).toMatchObject({ action: 'suspended' });
    expect(set.match({ tokenId: 'tok_c' })).toMatchObject({ kind: 'token' });
    // The token's grant itself is not revoked.
    expect(set.match({ grantId: 'grnt_c' })).toBeNull();

    set.apply(entry({ seq: 4, action: 'resumed', grantId: 'grnt_b' }));
    expect(set.match({ grantId: 'grnt_b' })).toBeNull();
  });

  it('denies a child whose parent grant is revoked', () => {
    const set = new RevokedSet();
    set.apply(entry({ grantId: 'grnt_parent' }));
    expect(set.match({ grantId: 'grnt_child', parentGrantId: 'grnt_parent' }))
      .toMatchObject({ kind: 'parent_grant', id: 'grnt_parent' });
  });

  it('forgets entries whose credential has expired', () => {
    const set = new RevokedSet();
    const expired = new Date(Date.now() - 1_000).toISOString();
    set.apply(entry({ grantId: 'grnt_old', expiresAt: expired }));
    expect(set.match({ grantId: 'grnt_old' })).toBeNull();
    expect(set.size).toBe(1);
    set.prune();
    expect(set.size).toBe(0);
  });
});

describe('enforce() with revocationCheck: feed', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('allows a call while the feed is fresh and knows nothing against the grant', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', feedFetch());
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'feed' });
    grantex.loadManifest(manifest);
    try {
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.allowed).toBe(true);
      expect(grantex.revocationFeedState()).toMatchObject({ synced: true, unavailable: null });
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('denies a grant the snapshot says is revoked, with grant_revoked', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', feedFetch({ snapshot: [entry({ grantId: 'grnt_child' })] }));
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'feed' });
    grantex.loadManifest(manifest);
    try {
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(DenialReason.GRANT_REVOKED);
      expect(result.subReason).toBe(RevocationSubReason.REVOKED);
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('denies a child grant when the feed carries only its parent revocation', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant({ parentGrantId: 'grnt_parent' }));
    vi.stubGlobal('fetch', feedFetch({ snapshot: [entry({ grantId: 'grnt_parent' })] }));
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'feed' });
    grantex.loadManifest(manifest);
    try {
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.allowed).toBe(false);
      expect(result.subReason).toBe(RevocationSubReason.PARENT_REVOKED);
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('denies a suspended grant with its own sub-reason', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', feedFetch({ snapshot: [entry({ action: 'suspended' })] }));
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'feed' });
    grantex.loadManifest(manifest);
    try {
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.subReason).toBe(RevocationSubReason.SUSPENDED);
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('fails closed when the deployment does not serve the feed', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', feedFetch({ snapshotStatus: 404 }));
    const grantex = new Grantex({
      apiKey: 'test_key', revocationCheck: 'feed', revocationFeed: { staleAfterMs: 200 },
    });
    grantex.loadManifest(manifest);
    try {
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(DenialReason.GRANT_REVOKED);
      expect(result.subReason).toBe(RevocationSubReason.FEED_UNAVAILABLE);
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('fails closed when the feed cannot be reached at all', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    const grantex = new Grantex({
      apiKey: 'test_key', revocationCheck: 'feed', revocationFeed: { staleAfterMs: 200 },
    });
    grantex.loadManifest(manifest);
    try {
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.allowed).toBe(false);
      expect([RevocationSubReason.FEED_STALE, RevocationSubReason.FEED_UNAVAILABLE]).toContain(result.subReason);
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('applies a revocation that arrives on the live stream', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', feedFetch({
      streamEvents: [
        `event: ready\ndata: {"cursor":5}\n\n`,
        `event: revocation\ndata: ${JSON.stringify(entry({ seq: 6 }))}\n\n`,
      ],
    }));
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'feed' });
    grantex.loadManifest(manifest);
    try {
      const feed = grantex.revocationFeed();
      await feed.ready();
      for (let attempt = 0; attempt < 50 && feed.state().known === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
      expect(result.allowed).toBe(false);
      expect(result.subReason).toBe(RevocationSubReason.REVOKED);
      expect(feed.state().cursor).toBe(6);
    } finally {
      await grantex.stopRevocationFeed();
    }
  });

  it('is off by default: the same client without the option allows the call', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    const fetchMock = feedFetch({ snapshot: [entry()] });
    vi.stubGlobal('fetch', fetchMock);
    const grantex = new Grantex({ apiKey: 'test_key' });
    grantex.loadManifest(manifest);
    const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
    expect(result.allowed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enforce() with revocationCheck: online', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function statusFetch(body: unknown, status = 200) {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  it('asks the auth service and allows an active grant', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    const fetchMock = statusFetch({ status: 'active', revoked: false });
    vi.stubGlobal('fetch', fetchMock);
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'online' });
    grantex.loadManifest(manifest);
    const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
    expect(result.allowed).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/revocations/status?grantId=grnt_child&jti=tok_01');
  });

  it('denies a revoked grant and an unknown one', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', statusFetch({ status: 'revoked', revoked: true }));
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'online' });
    grantex.loadManifest(manifest);
    const revoked = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
    expect(revoked.reasonCode).toBe(DenialReason.GRANT_REVOKED);
    expect(revoked.subReason).toBe(RevocationSubReason.REVOKED);

    vi.stubGlobal('fetch', statusFetch({ status: 'unknown', revoked: true }));
    const unknown = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
    expect(unknown.subReason).toBe(RevocationSubReason.STATUS_UNAVAILABLE);
  });

  it('denies when the check cannot be made', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    const grantex = new Grantex({ apiKey: 'test_key', revocationCheck: 'online', maxRetries: 0 });
    grantex.loadManifest(manifest);
    const result = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
    expect(result.allowed).toBe(false);
    expect(result.subReason).toBe(RevocationSubReason.STATUS_UNAVAILABLE);
  });

  it('can be chosen per call, overriding the client default', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant());
    vi.stubGlobal('fetch', statusFetch({ status: 'revoked', revoked: true }));
    const grantex = new Grantex({ apiKey: 'test_key' });
    grantex.loadManifest(manifest);
    const offline = await grantex.enforce({ grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business' });
    expect(offline.allowed).toBe(true);
    const online = await grantex.enforce({
      grantToken: 'jwt', connector: 'acme_kyb', tool: 'resolve_business', revocationCheck: 'online',
    });
    expect(online.allowed).toBe(false);
  });
});
