import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  computeEntryHash,
  verifyChain,
  GENESIS_HASH,
  type SignedAuditEntry,
} from '../src/audit/hash-chain.js';
import {
  createOfflineAuditLog,
  verifyEntrySignature,
} from '../src/audit/offline-audit-log.js';
import { syncAuditLog, type SyncOptions } from '../src/audit/audit-sync.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function generateEdKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    algorithm: 'Ed25519',
  };
}

const sampleEntry = {
  action: 'tool:read_calendar',
  agentDID: 'did:key:z6MkAgent',
  grantId: 'grant_01',
  scopes: ['calendar:read'],
  result: 'success',
};

/* ------------------------------------------------------------------ */
/*  audit-sync tests                                                   */
/* ------------------------------------------------------------------ */

describe('audit-sync', () => {
  let tmpDir: string;
  let logPath: string;
  let signingKey: ReturnType<typeof generateEdKey>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemma-sync-'));
    logPath = join(tmpDir, 'audit.jsonl');
    signingKey = generateEdKey();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns zero synced when there are no entries', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });

    const result = await syncAuditLog(log, {
      endpoint: 'https://api.grantex.dev',
      apiKey: 'key',
      bundleId: 'b1',
    });

    expect(result.syncedCount).toBe(0);
    expect(result.hasErrors).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('sends correct Authorization header and bundleId', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);

    const fetchCalls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const parsed = JSON.parse((init as RequestInit).body as string);
      const headers = (init as RequestInit).headers as Record<string, string>;
      fetchCalls.push({ url: url as string, headers, body: parsed });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'my-api-key',
        bundleId: 'bundle_42',
      });

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]!.url).toBe('https://api.grantex.dev/v1/audit/offline-sync');
      expect(fetchCalls[0]!.headers['Authorization']).toBe('Bearer my-api-key');
      expect(fetchCalls[0]!.body.bundleId).toBe('bundle_42');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('strips trailing slash from endpoint URL', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);

    let calledUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      calledUrl = url as string;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev/',
        apiKey: 'key',
        bundleId: 'b1',
      });

      expect(calledUrl).toBe('https://api.grantex.dev/v1/audit/offline-sync');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports errors after max retries exhausted', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as typeof fetch;

    try {
      const result = await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'key',
        bundleId: 'b1',
      });

      expect(result.syncedCount).toBe(0);
      expect(result.hasErrors).toBe(true);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Connection refused');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles HTTP error responses', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401 }),
    ) as typeof fetch;

    try {
      const result = await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'bad-key',
        bundleId: 'b1',
      });

      expect(result.syncedCount).toBe(0);
      expect(result.hasErrors).toBe(true);
      expect(result.errors[0]).toContain('401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('respects custom batchSize option', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    for (let i = 0; i < 7; i++) {
      await log.append({ ...sampleEntry, action: `tool:op${i}` });
    }

    let batchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      batchCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'key',
        batchSize: 3,
        bundleId: 'b1',
      });

      expect(result.syncedCount).toBe(7);
      // 7 entries / batch 3 = 3 batches (3 + 3 + 1)
      expect(batchCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses default batchSize of 100 when not specified', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    // Add just a few entries — they should all go in one batch
    for (let i = 0; i < 5; i++) {
      await log.append({ ...sampleEntry, action: `tool:op${i}` });
    }

    let batchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      batchCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'key',
        bundleId: 'b1',
      });

      // All 5 entries in one batch (< 100)
      expect(batchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/* ------------------------------------------------------------------ */
/*  hash-chain additional tests                                        */
/* ------------------------------------------------------------------ */

describe('hash-chain (additional)', () => {
  it('computeEntryHash includes metadata when present', () => {
    const base = {
      seq: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      action: 'tool:test',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['a'],
      result: 'success',
      prevHash: GENESIS_HASH,
    };

    const hashWithout = computeEntryHash(base);
    const hashWith = computeEntryHash({ ...base, metadata: { key: 'value' } });

    expect(hashWithout).not.toBe(hashWith);
  });

  it('produces different hashes for different scopes', () => {
    const base = {
      seq: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      action: 'tool:test',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
      prevHash: GENESIS_HASH,
    };

    const h1 = computeEntryHash(base);
    const h2 = computeEntryHash({ ...base, scopes: ['read', 'write'] });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different seq numbers', () => {
    const base = {
      seq: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      action: 'tool:test',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
      prevHash: GENESIS_HASH,
    };

    const h1 = computeEntryHash(base);
    const h2 = computeEntryHash({ ...base, seq: 2 });
    expect(h1).not.toBe(h2);
  });

  it('verifyChain detects non-consecutive sequence numbers', () => {
    const e1 = makeChainEntry(1, GENESIS_HASH);
    const e2 = makeChainEntry(3, e1.hash); // skips seq 2

    const result = verifyChain([e1, e2]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('GENESIS_HASH is the expected sentinel value', () => {
    expect(GENESIS_HASH).toBe('0000000000000000');
  });
});

/* Chain entry helper */
function makeChainEntry(seq: number, prevHash: string): SignedAuditEntry {
  const partial = {
    seq,
    timestamp: new Date(Date.now() + seq * 1000).toISOString(),
    action: `tool:op${seq}`,
    agentDID: 'did:key:z6MkTest',
    grantId: 'grant_01',
    scopes: ['read'],
    result: 'success',
    prevHash,
  };
  const hash = computeEntryHash(partial);
  return { ...partial, hash, signature: 'fake-sig' };
}

/* ------------------------------------------------------------------ */
/*  offline-audit-log additional tests                                 */
/* ------------------------------------------------------------------ */

describe('offline-audit-log (additional)', () => {
  let tmpDir: string;
  let logPath: string;
  let signingKey: ReturnType<typeof generateEdKey>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemma-audit2-'));
    logPath = join(tmpDir, 'audit.jsonl');
    signingKey = generateEdKey();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends entry with metadata', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    const entry = await log.append({
      ...sampleEntry,
      metadata: { toolInput: 'test' },
    });

    expect(entry.metadata).toEqual({ toolInput: 'test' });
    const entries = await log.entries();
    expect(entries[0]!.metadata).toEqual({ toolInput: 'test' });
  });

  it('entries are persisted to disk as JSONL', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);
    await log.append({ ...sampleEntry, action: 'tool:write' });

    const raw = await readFile(logPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(2);

    const parsed = lines.map((l) => JSON.parse(l) as SignedAuditEntry);
    expect(parsed[0]!.action).toBe('tool:read_calendar');
    expect(parsed[1]!.action).toBe('tool:write');
  });

  it('initialises from existing log on disk', async () => {
    // Write some entries with first log instance
    const log1 = createOfflineAuditLog({ signingKey, logPath });
    await log1.append(sampleEntry);
    await log1.append({ ...sampleEntry, action: 'tool:second' });

    // Create a new log instance (simulates process restart)
    const log2 = createOfflineAuditLog({ signingKey, logPath });
    const e3 = await log2.append({ ...sampleEntry, action: 'tool:third' });

    expect(e3.seq).toBe(3);

    // Full chain should be valid
    const entries = await log2.entries();
    expect(entries.length).toBe(3);
    expect(verifyChain(entries).valid).toBe(true);
  });

  it('unsyncedCount tracks sync state correctly', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);
    await log.append({ ...sampleEntry, action: 'tool:b' });
    await log.append({ ...sampleEntry, action: 'tool:c' });

    expect(await log.unsyncedCount()).toBe(3);

    await log.markSynced(2);
    expect(await log.unsyncedCount()).toBe(1);

    await log.markSynced(3);
    expect(await log.unsyncedCount()).toBe(0);
  });

  it('markSynced persists sync marker to disk', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);
    await log.markSynced(1);

    const markerContent = await readFile(logPath + '.synced', 'utf-8');
    expect(markerContent.trim()).toBe('1');
  });

  it('returns empty entries array for missing log file', async () => {
    const missingPath = join(tmpDir, 'missing.jsonl');
    const log = createOfflineAuditLog({ signingKey, logPath: missingPath });
    const entries = await log.entries();
    expect(entries).toEqual([]);
  });

  it('verifyEntrySignature rejects with wrong public key', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    const entry = await log.append(sampleEntry);

    const otherKey = generateEdKey();
    expect(verifyEntrySignature(entry, otherKey.publicKey)).toBe(false);
  });

  it('does not rotate when rotateOnSize is false', async () => {
    const log = createOfflineAuditLog({
      signingKey,
      logPath,
      maxSizeMB: 0.0001,
      rotateOnSize: false,
    });

    await log.append(sampleEntry);
    await log.append(sampleEntry);
    await log.append(sampleEntry);

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(tmpDir);
    const backups = files.filter((f) => f.endsWith('.bak'));
    expect(backups.length).toBe(0);
  });
});
