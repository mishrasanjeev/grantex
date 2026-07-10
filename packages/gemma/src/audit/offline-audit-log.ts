import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  randomUUID,
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

interface PersistedChainHead {
  seq: number;
  prevHash: string;
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

  if (!Number.isFinite(maxSizeMB) || maxSizeMB <= 0) {
    throw new RangeError('maxSizeMB must be a finite positive number');
  }
  if (
    typeof signingKey.algorithm !== 'string' ||
    signingKey.algorithm.toLowerCase() !== 'ed25519'
  ) {
    throw new TypeError('signingKey.algorithm must be Ed25519');
  }

  // Mutable state — initialised lazily from disk.
  let state: LogState | null = null;
  let appendQueue: Promise<void> = Promise.resolve();

  /** Read existing entries from log file (returns [] if file missing). */
  async function readEntries(): Promise<SignedAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(logPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
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
    const hasEntries = existing.length > 0;
    if (existing.length === 0) {
      state = { seq: 0, prevHash: GENESIS_HASH, syncedUpTo: -1 };
    } else {
      const last = existing[existing.length - 1]!;
      state = { seq: last.seq, prevHash: last.hash, syncedUpTo: -1 };
    }
    if (!hasEntries) {
      try {
        const rawHead = await readFile(logPath + '.head', 'utf-8');
        const head = JSON.parse(rawHead) as Partial<PersistedChainHead>;
        if (
          !Number.isSafeInteger(head.seq) ||
          head.seq! < 1 ||
          typeof head.prevHash !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(head.prevHash)
        ) {
          throw new Error('Invalid offline audit chain-head file');
        }
        state.seq = head.seq!;
        state.prevHash = head.prevHash;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    // Read synced marker if present
    try {
      const markerRaw = await readFile(logPath + '.synced', 'utf-8');
      const marker = Number(markerRaw.trim());
      if (
        Number.isSafeInteger(marker) &&
        marker >= -1 &&
        (!hasEntries || marker <= state.seq)
      ) {
        state.syncedUpTo = marker;
      }
    } catch {
      // no marker file yet
    }
    // After a rotation there can be a marker but no current log if the
    // process stopped between the rename and its next append. Preserve the
    // monotonic sequence in that case.
    if (!hasEntries) {
      state.seq = Math.max(state.seq, state.syncedUpTo);
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
  async function maybeRotate(s: LogState): Promise<void> {
    if (!rotateOnSize) return;
    try {
      const file = await stat(logPath);
      if (file.size > maxSizeMB * 1024 * 1024) {
        // Rotating an un-synced file would make its entries invisible to the
        // sync client. Defer rotation until the complete segment is durable
        // in the cloud.
        if (s.syncedUpTo < s.seq) return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // Persist the cloud chain anchor before renaming. If the process stops
        // after the rename but before the next append, a new instance can
        // still continue with the server's expected previous hash.
        await writeFile(
          logPath + '.head',
          JSON.stringify({ seq: s.seq, prevHash: s.prevHash } satisfies PersistedChainHead),
          'utf-8',
        );
        await rename(logPath, `${logPath}.${ts}.${randomUUID()}.bak`);
        // Rotation is only a storage boundary. Keep both the monotonic
        // sequence and the previous hash so the cloud's per-bundle chain can
        // validate the first entry written to the new file.
      }
    } catch {
      // file doesn't exist yet — nothing to rotate
    }
  }

  return {
    append(entry: AuditEntry): Promise<SignedAuditEntry> {
      const operation = appendQueue.then(async () => {
      const s = await ensureState();
      await maybeRotate(s);

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
      });

      // Keep the queue usable after an individual append fails.
      appendQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
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
      if (
        !Number.isSafeInteger(upToSeq) ||
        upToSeq < s.syncedUpTo ||
        upToSeq > s.seq
      ) {
        throw new RangeError(
          `upToSeq must be a safe integer between ${s.syncedUpTo} and ${s.seq}`,
        );
      }
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
  try {
    const key = createPublicKey(publicKey);
    return cryptoVerify(
      null,
      Buffer.from(entry.hash, 'utf-8'),
      key,
      Buffer.from(entry.signature, 'hex'),
    );
  } catch {
    return false;
  }
}
