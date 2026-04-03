import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  createOfflineAuditLog,
  verifyEntrySignature,
} from '../src/audit/offline-audit-log.js';
import { verifyChain, GENESIS_HASH } from '../src/audit/hash-chain.js';
import { syncAuditLog } from '../src/audit/audit-sync.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function generateEdKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    privateKey: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
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
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('OfflineAuditLog', () => {
  let tmpDir: string;
  let logPath: string;
  let signingKey: ReturnType<typeof generateEdKey>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemma-audit-'));
    logPath = join(tmpDir, 'audit.jsonl');
    signingKey = generateEdKey();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends entry with correct Ed25519 signature', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    const entry = await log.append(sampleEntry);

    expect(entry.seq).toBe(1);
    expect(entry.action).toBe('tool:read_calendar');
    expect(entry.signature).toBeTruthy();
    expect(typeof entry.signature).toBe('string');

    // Verify signature
    const valid = verifyEntrySignature(entry, signingKey.publicKey);
    expect(valid).toBe(true);
  });

  it('chains hashes correctly across entries', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });

    const e1 = await log.append(sampleEntry);
    const e2 = await log.append({
      ...sampleEntry,
      action: 'tool:send_email',
    });
    const e3 = await log.append({
      ...sampleEntry,
      action: 'tool:read_docs',
    });

    expect(e1.prevHash).toBe(GENESIS_HASH);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);

    // Full chain verification
    const entries = await log.entries();
    const result = verifyChain(entries);
    expect(result.valid).toBe(true);
  });

  it('detects tampered entry (hash mismatch)', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });

    await log.append(sampleEntry);
    await log.append({ ...sampleEntry, action: 'tool:b' });
    await log.append({ ...sampleEntry, action: 'tool:c' });

    const entries = await log.entries();

    // Tamper with the second entry's action
    entries[1]!.action = 'tool:HACKED';

    const result = verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('rotates log file at maxSizeMB', async () => {
    // Use a tiny limit to trigger rotation.
    const log = createOfflineAuditLog({
      signingKey,
      logPath,
      maxSizeMB: 0.0001, // ~100 bytes
    });

    // Write enough entries to exceed limit
    await log.append(sampleEntry);
    await log.append(sampleEntry);

    // After rotation, the old file should be renamed
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(tmpDir);
    const backups = files.filter((f) => f.endsWith('.bak'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('syncs entries to endpoint in batches', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });

    // Append 5 entries
    for (let i = 0; i < 5; i++) {
      await log.append({ ...sampleEntry, action: `tool:op${i}` });
    }

    // Mock fetch
    const calls: { body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      calls.push({ body: (init as RequestInit).body as string });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'test-key',
        batchSize: 2,
        bundleId: 'bundle_01',
      });

      expect(result.syncedCount).toBe(5);
      expect(result.hasErrors).toBe(false);
      // 5 entries / batch 2 = 3 batches (2 + 2 + 1)
      expect(calls.length).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries failed sync with exponential backoff', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });
    await log.append(sampleEntry);

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Network error');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'key',
        bundleId: 'b1',
      });

      expect(result.syncedCount).toBe(1);
      expect(callCount).toBe(3); // 2 failures + 1 success
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks synced entries to prevent duplicate upload', async () => {
    const log = createOfflineAuditLog({ signingKey, logPath });

    await log.append(sampleEntry);
    await log.append({ ...sampleEntry, action: 'tool:second' });

    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse((init as RequestInit).body as string));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    try {
      // First sync — should send 2 entries
      await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'key',
        bundleId: 'b1',
      });
      expect(calls.length).toBe(1);

      // Add one more entry
      await log.append({ ...sampleEntry, action: 'tool:third' });

      calls.length = 0;

      // Second sync — should only send the new entry
      const result = await syncAuditLog(log, {
        endpoint: 'https://api.grantex.dev',
        apiKey: 'key',
        bundleId: 'b1',
      });
      expect(result.syncedCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
