import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { readFile, writeFile, appendFile, stat, rename } from 'node:fs/promises';
import {
  computeEntryHash,
  GENESIS_HASH,
  type SignedAuditEntry,
} from './hash-chain.js';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface OfflineAuditLogOptions {
  /** Ed25519 key pair used to sign each entry. */
  signingKey: { publicKey: string; privateKey: string; algorithm: string };
  /** Path to the JSONL log file. */
  logPath: string;
  /** Maximum log-file size in MB before rotation (default 50). */
  maxSizeMB?: number;
  /** Whether to rotate when `maxSizeMB` is exceeded (default true). */
  rotateOnSize?: boolean;
}

export interface AuditEntry {
  action: string;
  agentDID: string;
  grantId: string;
  scopes: string[];
  result: string;
  metadata?: Record<string, unknown>;
}

export interface OfflineAuditLog {
  /** Append a new signed + hash-chained entry. */
  append(entry: AuditEntry): Promise<SignedAuditEntry>;
  /** Read all entries from the log file. */
  entries(): Promise<SignedAuditEntry[]>;
  /** Return the number of un-synced entries. */
  unsyncedCount(): Promise<number>;
  /** Mark entries up to `seq` as synced. */
  markSynced(upToSeq: number): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Internal state (held inside closure)                               */
/* ------------------------------------------------------------------ */

interface LogState {
  seq: number;
  prevHash: string;
  syncedUpTo: number;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create an append-only, Ed25519-signed, hash-chained offline audit log
 * backed by a JSONL file.
 */
export function createOfflineAuditLog(
  options: OfflineAuditLogOptions,
): OfflineAuditLog {
  const {
    signingKey,
    logPath,
    maxSizeMB = 50,
    rotateOnSize = true,
  } = options;

  // Mutable state — initialised lazily from disk.
  let state: LogState | null = null;

  /** Read existing entries from log file (returns [] if file missing). */
  async function readEntries(): Promise<SignedAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(logPath, 'utf-8');
    } catch {
      return [];
    }
    if (raw.trim() === '') return [];
    return raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SignedAuditEntry);
  }

  /** Ensure `state` is initialised from disk. */
  async function ensureState(): Promise<LogState> {
    if (state) return state;
    const existing = await readEntries();
    if (existing.length === 0) {
      state = { seq: 0, prevHash: GENESIS_HASH, syncedUpTo: -1 };
    } else {
      const last = existing[existing.length - 1]!;
      state = { seq: last.seq, prevHash: last.hash, syncedUpTo: -1 };
    }
    // Read synced marker if present
    try {
      const markerRaw = await readFile(logPath + '.synced', 'utf-8');
      state.syncedUpTo = parseInt(markerRaw.trim(), 10);
    } catch {
      // no marker file yet
    }
    return state;
  }

  /** Sign `data` with the Ed25519 private key. */
  function signData(data: string): string {
    const key = createPrivateKey(signingKey.privateKey);
    const sig = cryptoSign(null, Buffer.from(data, 'utf-8'), key);
    return sig.toString('hex');
  }

  /** Rotate the log file if size exceeds the limit. */
  async function maybeRotate(): Promise<void> {
    if (!rotateOnSize) return;
    try {
      const s = await stat(logPath);
      if (s.size > maxSizeMB * 1024 * 1024) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await rename(logPath, `${logPath}.${ts}.bak`);
      }
    } catch {
      // file doesn't exist yet — nothing to rotate
    }
  }

  return {
    async append(entry: AuditEntry): Promise<SignedAuditEntry> {
      await maybeRotate();
      const s = await ensureState();

      const nextSeq = s.seq + 1;
      const timestamp = new Date().toISOString();

      const partial: Omit<SignedAuditEntry, 'hash' | 'signature'> = {
        seq: nextSeq,
        timestamp,
        action: entry.action,
        agentDID: entry.agentDID,
        grantId: entry.grantId,
        scopes: entry.scopes,
        result: entry.result,
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
        prevHash: s.prevHash,
      };

      const hash = computeEntryHash(partial);
      const signature = signData(hash);

      const signed: SignedAuditEntry = {
        ...partial,
        hash,
        signature,
      };

      await appendFile(logPath, JSON.stringify(signed) + '\n', 'utf-8');

      s.seq = nextSeq;
      s.prevHash = hash;

      return signed;
    },

    async entries(): Promise<SignedAuditEntry[]> {
      return readEntries();
    },

    async unsyncedCount(): Promise<number> {
      const s = await ensureState();
      const all = await readEntries();
      return all.filter((e) => e.seq > s.syncedUpTo).length;
    },

    async markSynced(upToSeq: number): Promise<void> {
      const s = await ensureState();
      s.syncedUpTo = upToSeq;
      await writeFile(logPath + '.synced', String(upToSeq), 'utf-8');
    },
  };
}

/**
 * Verify the Ed25519 signature of a single audit entry.
 */
export function verifyEntrySignature(
  entry: SignedAuditEntry,
  publicKey: string,
): boolean {
  const key = createPublicKey(publicKey);
  return cryptoVerify(
    null,
    Buffer.from(entry.hash, 'utf-8'),
    key,
    Buffer.from(entry.signature, 'hex'),
  );
}
