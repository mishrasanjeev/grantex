/**
 * Append-only audit log for GDT lifecycle events.
 *
 * Logs all issuance, verification, revocation, payment, and rejection events.
 */

import { randomUUID } from 'node:crypto';
import type { AuditEntry, AuditEventType, AuditLog } from './types.js';

/**
 * In-memory audit log implementation.
 * In production, this would write to a durable store (database, S3, etc.).
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    const full: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    return full;
  }

  async query(opts?: {
    eventType?: AuditEventType;
    agentDID?: string;
    limit?: number;
  }): Promise<AuditEntry[]> {
    let results = [...this.entries];

    if (opts?.eventType) {
      results = results.filter((e) => e.eventType === opts.eventType);
    }
    if (opts?.agentDID) {
      results = results.filter((e) => e.agentDID === opts.agentDID);
    }

    // newest first
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (opts?.limit) {
      results = results.slice(0, opts.limit);
    }

    return results;
  }

  async export(): Promise<AuditEntry[]> {
    return [...this.entries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /** Number of entries (testing helper). */
  get size(): number {
    return this.entries.length;
  }

  /** Clear all entries (testing helper). */
  clear(): void {
    this.entries.length = 0;
  }
}

/** Singleton default audit log. */
let defaultAuditLog: AuditLog = new InMemoryAuditLog();

/** Get the current default audit log. */
export function getAuditLog(): AuditLog {
  return defaultAuditLog;
}

/** Replace the default audit log (e.g. with a persistent implementation). */
export function setAuditLog(auditLog: AuditLog): void {
  defaultAuditLog = auditLog;
}
