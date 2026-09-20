/**
 * The replay store. Every verified delivery claims `(source_id, event_id)`
 * before anything acts on it, so an event is acted on at most once however
 * often it is delivered.
 *
 * - `new`: first delivery; the caller processes it and finalises the receipt.
 * - `retry`: an earlier delivery of the same bytes failed, or stopped
 *   processing more than STALE_PROCESSING_MS ago; it is processed again
 *   (every action is idempotent).
 * - `duplicate`: the same bytes were already received; not acted on again.
 * - `conflict`: the id was already used for a different payload. Refused.
 */
import type postgres from 'postgres';
import type { NormalizedEvent } from './normalize.js';

type Sql = ReturnType<typeof postgres>;

export type ReceiptClaim = 'new' | 'retry' | 'duplicate' | 'conflict';
export type ReceiptStatus = 'processing' | 'unmapped' | 'applied' | 'observed' | 'failed';

const STALE_PROCESSING_MS = 60_000;

export interface ClaimInput {
  sourceId: string;
  eventId: string;
  developerId: string;
  bodySha256: string;
  eventTypes: string[];
}

export async function claimReceipt(sql: Sql, input: ClaimInput): Promise<ReceiptClaim> {
  const inserted = await sql<{ event_id: string }[]>`
    INSERT INTO event_bridge_receipts (source_id, event_id, developer_id, body_sha256, event_types, status)
    VALUES (${input.sourceId}, ${input.eventId}, ${input.developerId}, ${input.bodySha256}, ${input.eventTypes}, 'processing')
    ON CONFLICT (source_id, event_id) DO NOTHING
    RETURNING event_id
  `;
  if (inserted[0]) return 'new';

  // Reclaim a failed or abandoned delivery of the same bytes atomically, so
  // two concurrent retries cannot both process it.
  const reclaimed = await sql<{ event_id: string }[]>`
    UPDATE event_bridge_receipts
       SET status = 'processing', received_at = NOW(), processed_at = NULL
     WHERE source_id = ${input.sourceId}
       AND event_id = ${input.eventId}
       AND body_sha256 = ${input.bodySha256}
       AND (status = 'failed'
            OR (status = 'processing' AND received_at < NOW() - make_interval(secs => ${STALE_PROCESSING_MS / 1000})))
    RETURNING event_id
  `;
  if (reclaimed[0]) return 'retry';

  const existing = await sql<{ body_sha256: string }[]>`
    SELECT body_sha256 FROM event_bridge_receipts
     WHERE source_id = ${input.sourceId} AND event_id = ${input.eventId}
  `;
  if (!existing[0]) {
    // The row vanished between statements (source deleted). Refuse rather
    // than process an event whose receipt cannot be recorded.
    return 'conflict';
  }
  return existing[0].body_sha256 === input.bodySha256 ? 'duplicate' : 'conflict';
}

export async function finaliseReceipt(
  sql: Sql,
  sourceId: string,
  eventId: string,
  status: Exclude<ReceiptStatus, 'processing'>,
  result: Record<string, unknown>,
): Promise<void> {
  await sql`
    UPDATE event_bridge_receipts
       SET status = ${status}, result = ${sql.json(result as postgres.JSONValue)}, processed_at = NOW()
     WHERE source_id = ${sourceId} AND event_id = ${eventId}
  `;
}

export interface ProcessOutcome {
  status: Exclude<ReceiptStatus, 'processing'>;
  result: Record<string, unknown>;
}

/**
 * Acts on verified events. The event bridge ships with the unmapped
 * processor: every event is logged, counted and ignored. Mapping rules
 * replace it.
 */
export type EventProcessor = (events: NormalizedEvent[]) => Promise<ProcessOutcome>;
